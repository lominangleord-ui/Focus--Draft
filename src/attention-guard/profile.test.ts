import { describe, expect, it } from "vitest";
import { defaultAttentionProfile, normalizeAttentionProfile, parseAttentionProfileFile, serializeAttentionProfile } from "./profile";

const calibrated = () => {
  const profile = defaultAttentionProfile("screen", "desk", 100);
  return {
    ...profile,
    name: "Desk monitor",
    calibratedAt: 120,
    calibrationSamples: 30,
    baseline: { yawDeg: 2, pitchDeg: -3, rollDeg: 0, gazeX: 0.1, gazeY: -0.2 },
  };
};

describe("Attention Guard profile files", () => {
  it("round-trips a versioned profile without other local data", () => {
    const text = serializeAttentionProfile(calibrated(), "2026-11-05T12:00:00.000Z");
    const file = JSON.parse(text) as { format: string; schemaVersion: number; exportedAt: string; profile: { name: string } };
    expect(file).toMatchObject({ format: "focus-draft-attention-profile", schemaVersion: 1, profile: { name: "Desk monitor" } });
    expect(parseAttentionProfileFile(text)).toMatchObject({ id: "desk", calibratedAt: 120, calibrationSamples: 30 });
    expect(text).not.toContain("statsByDay");
  });

  it("rejects malformed JSON, unrelated JSON, and unsupported versions", () => {
    expect(() => parseAttentionProfileFile("{" )).toThrow("valid JSON");
    expect(() => parseAttentionProfileFile(JSON.stringify({ profile: {} }))).toThrow("not a Focus Draft");
    expect(() => parseAttentionProfileFile(JSON.stringify({ format: "focus-draft-attention-profile", schemaVersion: 2, profile: calibrated() }))).toThrow("Unsupported");
  });

  it("clamps imported thresholds and clears incomplete calibration", () => {
    const input = {
      ...calibrated(),
      baseline: null,
      zone: { yawDeg: 500, pitchDeg: -1, rollDeg: 25, gazeX: 0, gazeY: 1 },
      tuning: { ...defaultAttentionProfile("screen").tuning, level1Score: 2.4, level2Score: 0.1 },
    };
    const result = normalizeAttentionProfile(input);
    expect(result?.calibratedAt).toBeNull();
    expect(result?.baseline).toBeNull();
    expect(result?.zone.yawDeg).toBe(60);
    expect(result?.zone.pitchDeg).toBe(5);
    expect(result?.zone.gazeX).toBe(0.15);
    expect(result!.tuning.level2Score).toBeGreaterThan(result!.tuning.level1Score);
  });
});
