import { describe, expect, it } from "vitest";
import { calculateCalibration, CALIBRATION_MIN_SAMPLES, getCalibrationTargets, isCalibrationSignalValid, type CalibrationSamples } from "./calibration";
import { defaultAttentionProfile } from "./profile";
import type { AttentionMode, RawAttentionSignals } from "./types";

function signal(overrides: Partial<RawAttentionSignals> = {}): RawAttentionSignals {
  return {
    sampledAt: 1,
    facePresent: true,
    landmarkCount: 478,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    gazeX: 0,
    gazeY: 0,
    faceWidth: 0.25,
    brightness: 0.5,
    eyeBlinkLeft: 0,
    eyeBlinkRight: 0,
    ...overrides,
  };
}

function makeSamples(mode: AttentionMode, overrides: Record<string, Partial<RawAttentionSignals>> = {}): CalibrationSamples {
  const targets = getCalibrationTargets(mode);
  return Object.fromEntries(targets.map((target) => [
    target.id,
    Array.from({ length: CALIBRATION_MIN_SAMPLES }, (_, index) => signal({
      sampledAt: index + 1,
      ...overrides[target.id],
    })),
  ]));
}

describe("Attention Guard calibration", () => {
  it("uses the requested per-mode target sets", () => {
    const screen = getCalibrationTargets("screen");
    expect(screen.map((target) => target.id)).toEqual(["center", "top-left", "top-right", "bottom-left", "bottom-right"]);
    expect(screen.every((target) => target.kind === "positive")).toBe(true);

    const book = getCalibrationTargets("book");
    expect(book).toHaveLength(9);
    expect(book.filter((target) => target.kind === "positive").map((target) => target.id)).toEqual(["center", "top", "bottom", "left", "right"]);
    expect(book.filter((target) => target.kind === "negative").map((target) => target.id)).toEqual(["negative-top", "negative-bottom", "negative-left", "negative-right"]);
  });

  it("does not produce a profile until every required target has enough valid frames", () => {
    const samples = makeSamples("screen");
    samples["bottom-right"] = samples["bottom-right"].slice(0, CALIBRATION_MIN_SAMPLES - 1);
    expect(calculateCalibration("screen", samples, 20, "rectangle")).toBeNull();
  });

  it("uses robust medians and produces a zone that contains the on-task directions", () => {
    const samples = makeSamples("screen", {
      "top-left": { yawDeg: -7, pitchDeg: -5, gazeX: -0.25, gazeY: -0.3 },
      "top-right": { yawDeg: 7, pitchDeg: -5, gazeX: 0.25, gazeY: -0.3 },
      "bottom-left": { yawDeg: -7, pitchDeg: 5, gazeX: -0.25, gazeY: 0.3 },
      "bottom-right": { yawDeg: 7, pitchDeg: 5, gazeX: 0.25, gazeY: 0.3 },
    });
    samples.center[0] = signal({ yawDeg: 120, pitchDeg: -120, gazeX: 1.4, gazeY: -1.4 });

    const result = calculateCalibration("screen", samples, 20, "rectangle");
    expect(result).not.toBeNull();
    expect(result!.baseline.yawDeg).toBe(0);
    expect(result!.baseline.gazeX).toBe(0);
    expect(result!.zone.yawDeg).toBeGreaterThan(7);
    expect(result!.zone.gazeX).toBeGreaterThan(0.25);
    expect(result!.sampleCount).toBe(5 * CALIBRATION_MIN_SAMPLES);
    expect(result!.targetDiagnostics.find((target) => target.id === "top-right")?.gazeXDelta).toBe(0.25);
    expect(result!.positiveOutside).toBeLessThan(0.2);
  });

  it("measures overlap with explicit negative book samples", () => {
    const samples = makeSamples("book", {
      top: { pitchDeg: -4, gazeY: -0.18 },
      bottom: { pitchDeg: 4, gazeY: 0.18 },
      left: { yawDeg: -4, gazeX: -0.18 },
      right: { yawDeg: 4, gazeX: 0.18 },
      "negative-top": { pitchDeg: -30, gazeY: -1.2 },
      "negative-bottom": { pitchDeg: 30, gazeY: 1.2 },
      "negative-left": { yawDeg: -30, gazeX: -1.2 },
      "negative-right": { yawDeg: 30, gazeX: 1.2 },
    });
    const result = calculateCalibration("book", samples, 20, "rectangle");
    expect(result?.negativeOverlap).toBe(0);

    for (const id of ["negative-top", "negative-bottom", "negative-left", "negative-right"]) {
      samples[id] = Array.from({ length: CALIBRATION_MIN_SAMPLES }, (_, index) => signal({ sampledAt: index + 1 }));
    }
    const overlapped = calculateCalibration("book", samples, 20, "rectangle");
    expect(overlapped?.negativeOverlap).toBe(1);
    expect(overlapped?.warnings.some((warning) => warning.includes("off-page samples overlap"))).toBe(true);
  });

  it("uses the profile's feature weights when estimating negative overlap", () => {
    const samples = makeSamples("book", {
      top: { pitchDeg: -4, gazeY: -0.18 },
      bottom: { pitchDeg: 4, gazeY: 0.18 },
      left: { yawDeg: -4, gazeX: -0.18 },
      right: { yawDeg: 4, gazeX: 0.18 },
      "negative-top": { gazeY: -1.2 },
      "negative-bottom": { gazeY: 1.2 },
      "negative-left": { gazeX: -1.2 },
      "negative-right": { gazeX: 1.2 },
    });
    const tuning = { ...defaultAttentionProfile("book").tuning, poseWeight: 1, gazeWeight: 0 };
    const result = calculateCalibration("book", samples, 20, "rectangle", tuning);
    expect(result?.negativeOverlap).toBe(1);
  });

  it("widens the calibrated region with margin and records the selected shape", () => {
    const samples = makeSamples("book", {
      top: { pitchDeg: -4, gazeY: -0.18 },
      bottom: { pitchDeg: 4, gazeY: 0.18 },
      left: { yawDeg: -4, gazeX: -0.18 },
      right: { yawDeg: 4, gazeX: 0.18 },
    });
    const narrow = calculateCalibration("book", samples, 0, "rectangle")!;
    const wide = calculateCalibration("book", samples, 50, "ellipse")!;
    expect(wide.zone.yawDeg).toBeGreaterThan(narrow.zone.yawDeg);
    expect(wide.zone.gazeX).toBeGreaterThan(narrow.zone.gazeX);
    expect(wide.zoneShape).toBe("ellipse");
    expect(wide.marginPercent).toBe(50);
  });

  it("rejects calibration frames that fail face, lighting, distance, or signal checks", () => {
    const profile = defaultAttentionProfile("screen");
    expect(isCalibrationSignalValid(signal(), profile)).toBe(true);
    expect(isCalibrationSignalValid(signal({ facePresent: false }), profile)).toBe(false);
    expect(isCalibrationSignalValid(signal({ brightness: 0.01 }), profile)).toBe(false);
    expect(isCalibrationSignalValid(signal({ faceWidth: 0.01 }), profile)).toBe(false);
    expect(isCalibrationSignalValid(signal({ gazeX: null }), profile)).toBe(false);
  });
});
