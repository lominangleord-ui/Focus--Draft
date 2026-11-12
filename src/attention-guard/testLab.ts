import { createClassifierMemory, updateAttentionClassifier, type ClassifierMemory } from "./classifier";
import type { AttentionProfile } from "./profile";
import type { AttentionClassification, RawAttentionSignals } from "./types";

export type TestScenario = "centered" | "brief-glance" | "sustained-drift" | "face-missing" | "low-light";

export const TEST_SCENARIOS: Array<{ id: TestScenario; label: string; description: string }> = [
  { id: "centered", label: "Steady on-task", description: "Stable face and gaze at the calibrated center." },
  { id: "brief-glance", label: "Brief glance", description: "Short repeated glances that should stay within the configured dwell allowance." },
  { id: "sustained-drift", label: "Sustained drift", description: "A sustained off-zone sample followed by recovery." },
  { id: "face-missing", label: "Face missing", description: "No face is present; the configured no-face delay should apply." },
  { id: "low-light", label: "Low light", description: "Face remains present but the sample is below the profile's light floor." },
];

const SCENARIO_IDS = new Set<TestScenario>(TEST_SCENARIOS.map((scenario) => scenario.id));

export function isTestScenario(value: string): value is TestScenario {
  return SCENARIO_IDS.has(value as TestScenario);
}

export function createSimulatedSignals(
  profile: AttentionProfile,
  scenario: TestScenario,
  elapsedMs: number,
  sampledAt: number,
): RawAttentionSignals {
  const baseline = profile.baseline ?? { yawDeg: 0, pitchDeg: 0, rollDeg: 0, gazeX: 0, gazeY: 0 };
  const glanceActive = scenario === "brief-glance" && elapsedMs % 10_000 < 1_500;
  const sustainedActive = scenario === "sustained-drift" && elapsedMs % 30_000 < 12_000;
  const offZone = glanceActive || sustainedActive;
  const facePresent = scenario !== "face-missing";
  return {
    sampledAt,
    facePresent,
    landmarkCount: facePresent ? 478 : 0,
    faceBounds: facePresent ? { x: 0.3, y: 0.16, width: 0.4, height: 0.68 } : null,
    yawDeg: facePresent ? baseline.yawDeg + (offZone ? profile.zone.yawDeg * 1.9 : 0) : null,
    pitchDeg: facePresent ? baseline.pitchDeg + (offZone ? profile.zone.pitchDeg * 0.35 : 0) : null,
    rollDeg: facePresent ? baseline.rollDeg : null,
    gazeX: facePresent ? baseline.gazeX + (offZone ? profile.zone.gazeX * 1.8 : 0) : null,
    gazeY: facePresent ? baseline.gazeY : null,
    faceWidth: facePresent ? 0.24 : null,
    brightness: scenario === "low-light" ? Math.max(0, profile.tuning.lowLightFloor * 0.4) : 0.52,
    eyeBlinkLeft: facePresent ? 0.02 : null,
    eyeBlinkRight: facePresent ? 0.02 : null,
  };
}

export function simulateAttentionStep(
  memory: ClassifierMemory,
  profile: AttentionProfile,
  scenario: TestScenario,
  elapsedMs: number,
  timestamp: number,
) {
  const signals = createSimulatedSignals(profile, scenario, elapsedMs, timestamp);
  return updateAttentionClassifier(memory, signals, profile, timestamp);
}

export type AttentionTestSummary = {
  totalSamples: number;
  onTaskPercent: number;
  attentiveSamples: number;
  driftingSamples: number;
  awaySamples: number;
  missingFaceSamples: number;
  lowQualitySamples: number;
  level1Events: number;
  level2Events: number;
  meanScore: number | null;
};

export function summarizeAttentionTest(samples: AttentionClassification[]): AttentionTestSummary {
  const countPhase = (phase: AttentionClassification["phase"]) => samples.filter((sample) => sample.phase === phase).length;
  let level1Events = 0;
  let level2Events = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index].warningLevel;
    const previous = index === 0 ? 0 : samples[index - 1].warningLevel;
    if (current >= 1 && previous === 0) level1Events += 1;
    if (current >= 2 && previous < 2) level2Events += 1;
  }
  const scores = samples.map((sample) => sample.score).filter((score): score is number => score != null && Number.isFinite(score));
  const attentiveSamples = countPhase("attentive");
  return {
    totalSamples: samples.length,
    onTaskPercent: samples.length ? Math.round(attentiveSamples / samples.length * 100) : 0,
    attentiveSamples,
    driftingSamples: countPhase("drifting"),
    awaySamples: countPhase("away"),
    missingFaceSamples: countPhase("face-missing"),
    lowQualitySamples: countPhase("low-quality"),
    level1Events,
    level2Events,
    meanScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
  };
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * fraction)));
  return sorted[index];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export type SensitivitySuggestion = {
  centerP90: number;
  glanceP25: number;
  recoveryP90: number;
  level1Score: number | null;
  level2Score: number | null;
  separable: boolean;
  reason: string;
};

/** Suggest thresholds only when the guided off-zone sample separates from center and recovery. */
export function suggestSensitivity(
  centerScores: number[],
  glanceScores: number[],
  recoveryScores: number[],
): SensitivitySuggestion | null {
  if (centerScores.length < 6 || glanceScores.length < 6 || recoveryScores.length < 6) return null;
  const centerP90 = percentile(centerScores, 0.9)!;
  const glanceP25 = percentile(glanceScores, 0.25)!;
  const recoveryP90 = percentile(recoveryScores, 0.9)!;
  const baselineCeiling = Math.max(centerP90, recoveryP90);
  if (glanceP25 <= baselineCeiling + 0.08) {
    return {
      centerP90,
      glanceP25,
      recoveryP90,
      level1Score: null,
      level2Score: null,
      separable: false,
      reason: "The off-zone sample did not separate cleanly from center or recovery. Recalibrate, improve camera placement, or keep the conservative thresholds.",
    };
  }
  const level1Score = clamp((baselineCeiling + glanceP25) / 2, 0.2, 2.5);
  const glanceMedian = percentile(glanceScores, 0.5)!;
  const level2Score = clamp(Math.max(level1Score + 0.15, glanceMedian * 1.15), level1Score + 0.15, 4);
  return {
    centerP90,
    glanceP25,
    recoveryP90,
    level1Score,
    level2Score,
    separable: true,
    reason: "The guided samples show a separation. Suggested thresholds are estimates; review the live preview and keep warning delays conservative.",
  };
}

export function createSimulatorMemory(): ClassifierMemory {
  return createClassifierMemory();
}
