import { describe, expect, it } from "vitest";
import { createClassifierMemory, type ClassifierMemory } from "./classifier";
import { defaultAttentionProfile } from "./profile";
import { simulateAttentionStep, suggestSensitivity, summarizeAttentionTest, type TestScenario } from "./testLab";
import type { AttentionClassification } from "./types";

function calibratedProfile() {
  const profile = defaultAttentionProfile("screen", "desk", 1);
  return {
    ...profile,
    calibratedAt: 2,
    calibrationSamples: 40,
    baseline: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, gazeX: 0, gazeY: 0 },
    tuning: { ...profile.tuning, level1DwellMs: 3_500, level2DwellMs: 6_000, recoveryMs: 1_000 },
  };
}

function replay(scenario: TestScenario, durationMs: number) {
  const profile = calibratedProfile();
  let memory: ClassifierMemory = createClassifierMemory();
  const levels: number[] = [];
  for (let elapsed = 0; elapsed <= durationMs; elapsed += 500) {
    const update = simulateAttentionStep(memory, profile, scenario, elapsed, elapsed + 1);
    memory = update.memory;
    levels.push(update.classification.warningLevel);
  }
  return levels;
}

const classification = (phase: AttentionClassification["phase"], warningLevel: AttentionClassification["warningLevel"], score: number | null): AttentionClassification => ({
  phase,
  reason: phase === "attentive" ? "within-zone" : phase === "face-missing" ? "face-not-detected" : "looking-away",
  score,
  warningLevel,
  updatedAt: 1,
});

describe("Attention Guard Test Lab tools", () => {
  it("keeps a short glance below the warning dwell and escalates a sustained drift", () => {
    expect(Math.max(...replay("brief-glance", 15_000))).toBe(0);
    expect(Math.max(...replay("sustained-drift", 15_000))).toBe(2);
  });

  it("keeps no-face and low-light scenarios distinct", () => {
    const profile = calibratedProfile();
    const noFace = simulateAttentionStep(createClassifierMemory(), profile, "face-missing", 0, 1);
    const dim = simulateAttentionStep(createClassifierMemory(), profile, "low-light", 0, 1);
    expect(noFace.classification.phase).toBe("face-missing");
    expect(dim.classification.phase).toBe("low-quality");
  });

  it("summarizes warning transitions rather than counting every warned frame as a new event", () => {
    const samples = [
      classification("attentive", 0, 0.1),
      classification("drifting", 1, 1.2),
      classification("drifting", 1, 1.3),
      classification("away", 2, 2),
      classification("away", 2, 2.1),
      classification("attentive", 0, 0.2),
      classification("face-missing", 2, null),
      classification("low-quality", 2, null),
    ];
    expect(summarizeAttentionTest(samples)).toMatchObject({
      totalSamples: 8,
      onTaskPercent: 25,
      level1Events: 2,
      level2Events: 2,
      missingFaceSamples: 1,
      lowQualitySamples: 1,
      meanScore: 1.15,
    });
  });

  it("suggests conservative thresholds only when center, glance, and recovery samples separate", () => {
    const suggestion = suggestSensitivity([0.1, 0.12, 0.11, 0.13, 0.09, 0.1], [1.2, 1.3, 1.35, 1.25, 1.4, 1.3], [0.1, 0.11, 0.12, 0.13, 0.1, 0.09]);
    expect(suggestion?.separable).toBe(true);
    expect(suggestion?.level1Score).toBeGreaterThan(0.1);
    expect(suggestion?.level2Score).toBeGreaterThan(suggestion!.level1Score!);

    const ambiguous = suggestSensitivity([0.2, 0.2, 0.2, 0.2, 0.2, 0.2], [0.21, 0.22, 0.2, 0.22, 0.2, 0.21], [0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(ambiguous?.separable).toBe(false);
    expect(ambiguous?.level1Score).toBeNull();
    expect(suggestSensitivity([0, 0, 0], [1, 1, 1], [0, 0, 0])).toBeNull();
  });
});
