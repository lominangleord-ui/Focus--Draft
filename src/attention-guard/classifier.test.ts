import { describe, expect, it } from "vitest";
import { computeAttentionScore, createClassifierMemory, updateAttentionClassifier } from "./classifier";
import { defaultAttentionProfile } from "./profile";
import type { RawAttentionSignals } from "./types";

function calibratedProfile() {
  const profile = defaultAttentionProfile("screen", "desk", 1);
  return {
    ...profile,
    calibratedAt: 2,
    calibrationSamples: 20,
    baseline: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, gazeX: 0, gazeY: 0 },
  };
}

function sample(overrides: Partial<RawAttentionSignals> = {}): RawAttentionSignals {
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

describe("local Attention Guard classifier", () => {
  it("requires a completed calibration and scores the calibrated center as zero", () => {
    const profile = calibratedProfile();
    expect(computeAttentionScore(sample(), profile)).toBe(0);
    const needsCalibration = updateAttentionClassifier(createClassifierMemory(), sample(), defaultAttentionProfile("screen"), 100);
    expect(needsCalibration.classification.phase).toBe("needs-calibration");
    expect(needsCalibration.classification.warningLevel).toBe(0);
  });

  it("uses a deterministic hold before emitting level 1", () => {
    const profile = calibratedProfile();
    const drift = sample({ yawDeg: 40 });
    const first = updateAttentionClassifier(createClassifierMemory(), drift, profile, 1_000);
    expect(first.classification.phase).toBe("drifting");
    expect(first.classification.warningLevel).toBe(0);
    expect(first.intervention).toBeNull();

    const held = updateAttentionClassifier(first.memory, drift, profile, 4_499);
    expect(held.classification.warningLevel).toBe(0);
    const triggered = updateAttentionClassifier(held.memory, drift, profile, 4_500);
    expect(triggered.classification.warningLevel).toBe(1);
    expect(triggered.intervention).toMatchObject({ level: 1, triggeredAt: 4_500, reason: "looking-away" });
  });

  it("escalates to level 2 only after its longer dwell period", () => {
    const profile = calibratedProfile();
    const far = sample({ yawDeg: 90 });
    const first = updateAttentionClassifier(createClassifierMemory(), far, profile, 1_000);
    expect(first.classification.warningLevel).toBe(0);
    const before = updateAttentionClassifier(first.memory, far, profile, 6_999);
    expect(before.classification.warningLevel).toBe(0);
    const triggered = updateAttentionClassifier(before.memory, far, profile, 7_000);
    expect(triggered.classification.warningLevel).toBe(2);
    expect(triggered.intervention?.level).toBe(2);
  });

  it("uses hysteresis and a recovery hold to clear a warning", () => {
    const profile = calibratedProfile();
    profile.tuning.smoothingAlpha = 0.9;
    const drift = sample({ yawDeg: 40 });
    const first = updateAttentionClassifier(createClassifierMemory(), drift, profile, 1_000);
    const warned = updateAttentionClassifier(first.memory, drift, profile, 4_500);
    expect(warned.classification.warningLevel).toBe(1);

    const returned = updateAttentionClassifier(warned.memory, sample(), profile, 4_600);
    expect(returned.classification.warningLevel).toBe(1);
    const cleared = updateAttentionClassifier(returned.memory, sample(), profile, 6_200);
    expect(cleared.classification.warningLevel).toBe(0);
    expect(cleared.classification.phase).toBe("attentive");
  });

  it("treats a sustained missing face as level 2 and low light as low quality", () => {
    const profile = calibratedProfile();
    const missing = sample({ facePresent: false, landmarkCount: 0, yawDeg: null, pitchDeg: null, rollDeg: null, gazeX: null, gazeY: null, faceWidth: null });
    const first = updateAttentionClassifier(createClassifierMemory(), missing, profile, 1_000);
    expect(first.classification.phase).toBe("face-missing");
    expect(first.classification.warningLevel).toBe(0);
    const triggered = updateAttentionClassifier(first.memory, missing, profile, 5_500);
    expect(triggered.classification.warningLevel).toBe(2);
    expect(triggered.intervention?.reason).toBe("face-not-detected");

    const dim = updateAttentionClassifier(createClassifierMemory(), sample({ brightness: 0.01 }), profile, 1_000);
    expect(dim.classification.phase).toBe("low-quality");
    expect(dim.classification.reason).toBe("lighting-too-low");
    expect(dim.intervention).toBeNull();
  });

  it("does not move its clock backward when timestamps arrive out of order", () => {
    const profile = calibratedProfile();
    const first = updateAttentionClassifier(createClassifierMemory(), sample(), profile, 1_000);
    const second = updateAttentionClassifier(first.memory, sample(), profile, 500);
    expect(second.memory.lastUpdatedAt).toBe(1_000);
  });
});
