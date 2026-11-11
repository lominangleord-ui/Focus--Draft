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

  it("scores an elliptical zone more strictly when several feature axes drift together", () => {
    const profile = calibratedProfile();
    const combined = sample({
      yawDeg: profile.zone.yawDeg,
      pitchDeg: profile.zone.pitchDeg,
      gazeX: profile.zone.gazeX,
      gazeY: profile.zone.gazeY,
    });
    const rectangularScore = computeAttentionScore(combined, profile);
    profile.zoneShape = "ellipse";
    const ellipticalScore = computeAttentionScore(combined, profile);
    expect(ellipticalScore).toBeGreaterThan(rectangularScore!);
  });

  it("applies the configured pose/gaze weights and glance allowance", () => {
    const profile = calibratedProfile();
    profile.tuning.level1DwellMs = 1_000;
    profile.tuning.glanceAllowanceMs = 2_000;
    const gazeOnly = sample({ gazeX: profile.baseline!.gazeX + profile.zone.gazeX * 1.3 });
    const defaultWeightScore = computeAttentionScore(gazeOnly, profile);
    profile.tuning.poseWeight = 0;
    profile.tuning.gazeWeight = 1;
    expect(computeAttentionScore(gazeOnly, profile)).toBeGreaterThan(defaultWeightScore!);

    profile.tuning.smoothingAlpha = 1;
    let update = updateAttentionClassifier(createClassifierMemory(), gazeOnly, profile, 1_000);
    update = updateAttentionClassifier(update.memory, gazeOnly, profile, 3_999);
    expect(update.classification.warningLevel).toBe(0);
    update = updateAttentionClassifier(update.memory, gazeOnly, profile, 4_000);
    expect(update.classification.warningLevel).toBe(1);
    profile.tuning.poseWeight = 0;
    profile.tuning.gazeWeight = 0;
    expect(computeAttentionScore(gazeOnly, profile)).toBeNull();
  });

  it("uses a deterministic hold before emitting level 1", () => {
    const profile = calibratedProfile();
    const drift = sample({ yawDeg: 40 });
    const first = updateAttentionClassifier(createClassifierMemory(), drift, profile, 1_000);
    expect(first.classification.phase).toBe("drifting");
    expect(first.classification.warningLevel).toBe(0);
    expect(first.intervention).toBeNull();

    const held = updateAttentionClassifier(first.memory, drift, profile, 5_399);
    expect(held.classification.warningLevel).toBe(0);
    const triggered = updateAttentionClassifier(held.memory, drift, profile, 5_400);
    expect(triggered.classification.warningLevel).toBe(1);
    expect(triggered.intervention).toMatchObject({ level: 1, triggeredAt: 5_400, reason: "looking-away" });
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
    const warned = updateAttentionClassifier(first.memory, drift, profile, 5_400);
    expect(warned.classification.warningLevel).toBe(1);

    const returned = updateAttentionClassifier(warned.memory, sample(), profile, 5_500);
    expect(returned.classification.warningLevel).toBe(1);
    const cleared = updateAttentionClassifier(returned.memory, sample(), profile, 7_100);
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

  it("treats a dim missing face as low-quality instead of a level 2 warning", () => {
    const profile = calibratedProfile();
    const dimMissing = sample({
      facePresent: false,
      landmarkCount: 0,
      yawDeg: null,
      pitchDeg: null,
      rollDeg: null,
      gazeX: null,
      gazeY: null,
      faceWidth: null,
      brightness: 0.01,
    });
    const update = updateAttentionClassifier(createClassifierMemory(), dimMissing, profile, 1_000);
    expect(update.classification).toMatchObject({ phase: "low-quality", reason: "lighting-too-low", warningLevel: 0 });
    expect(update.intervention).toBeNull();
  });

  it("clears a stale warning when signal quality becomes too low", () => {
    const profile = calibratedProfile();
    const drift = sample({ yawDeg: 40 });
    const first = updateAttentionClassifier(createClassifierMemory(), drift, profile, 1_000);
    const warned = updateAttentionClassifier(first.memory, drift, profile, 5_400);
    expect(warned.memory.warningLevel).toBe(1);

    const lowQuality = updateAttentionClassifier(warned.memory, sample({ brightness: 0.01 }), profile, 5_500);
    expect(lowQuality.classification.warningLevel).toBe(0);
    expect(lowQuality.memory).toMatchObject({ warningLevel: 0, smoothedScore: null, candidateLevel: 0 });
    expect(lowQuality.intervention).toBeNull();
  });

  it("clears transient warning state when the camera stops producing samples", () => {
    const profile = calibratedProfile();
    const drift = sample({ yawDeg: 40 });
    const first = updateAttentionClassifier(createClassifierMemory(), drift, profile, 1_000);
    const warned = updateAttentionClassifier(first.memory, drift, profile, 5_400);
    expect(warned.memory.warningLevel).toBe(1);

    const waiting = updateAttentionClassifier(warned.memory, null, profile, 5_500);
    expect(waiting.classification).toMatchObject({ phase: "waiting", warningLevel: 0 });
    expect(waiting.memory).toMatchObject({ warningLevel: 0, smoothedScore: null, candidateLevel: 0 });
  });

  it("does not move its clock backward when timestamps arrive out of order", () => {
    const profile = calibratedProfile();
    const first = updateAttentionClassifier(createClassifierMemory(), sample(), profile, 1_000);
    const second = updateAttentionClassifier(first.memory, sample(), profile, 500);
    expect(second.memory.lastUpdatedAt).toBe(1_000);
  });
});
