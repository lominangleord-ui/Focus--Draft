import { computeAttentionScore } from "./classifier";
import { defaultAttentionProfile, type AttentionBaseline, type AttentionClassifierTuning, type AttentionProfile, type AttentionZone } from "./profile";
import type { AttentionMode, RawAttentionSignals } from "./types";

export const CALIBRATION_MIN_SAMPLES = 8;

export type CalibrationTarget = {
  id: string;
  label: string;
  kind: "positive" | "negative";
  x: number;
  y: number;
  instruction: string;
};

export type CalibrationSamples = Record<string, RawAttentionSignals[]>;
export type CalibrationSignalKey = keyof AttentionBaseline;

export type CalibrationTargetDiagnostic = {
  id: string;
  label: string;
  kind: CalibrationTarget["kind"];
  yawDelta: number;
  pitchDelta: number;
  gazeXDelta: number;
  gazeYDelta: number;
};

export type CalibrationResult = {
  baseline: AttentionBaseline;
  zone: AttentionZone;
  zoneShape: AttentionProfile["zoneShape"];
  marginPercent: number;
  sampleCount: number;
  negativeOverlap: number | null;
  positiveOutside: number;
  targetDiagnostics: CalibrationTargetDiagnostic[];
  warnings: string[];
};

const SIGNAL_KEYS: CalibrationSignalKey[] = ["yawDeg", "pitchDeg", "rollDeg", "gazeX", "gazeY"];
const MIN_ZONE: Record<CalibrationSignalKey, number> = {
  yawDeg: 6,
  pitchDeg: 6,
  rollDeg: 8,
  gazeX: 0.12,
  gazeY: 0.12,
};
const MAX_ZONE: Record<CalibrationSignalKey, number> = {
  yawDeg: 60,
  pitchDeg: 60,
  rollDeg: 60,
  gazeX: 1.5,
  gazeY: 1.5,
};
const NOISE_FLOOR: Record<CalibrationSignalKey, number> = {
  yawDeg: 1.5,
  pitchDeg: 1.5,
  rollDeg: 2,
  gazeX: 0.04,
  gazeY: 0.04,
};

export function getCalibrationTargets(mode: AttentionMode): CalibrationTarget[] {
  if (mode === "screen") {
    return [
      { id: "center", label: "Screen center", kind: "positive", x: 50, y: 50, instruction: "Look at the center of your screen and sit in your usual working posture." },
      { id: "top-left", label: "Top left", kind: "positive", x: 20, y: 20, instruction: "Look at the top-left corner of the area where you normally work." },
      { id: "top-right", label: "Top right", kind: "positive", x: 80, y: 20, instruction: "Look at the top-right corner of the area where you normally work." },
      { id: "bottom-left", label: "Bottom left", kind: "positive", x: 20, y: 80, instruction: "Look at the bottom-left corner of the area where you normally work." },
      { id: "bottom-right", label: "Bottom right", kind: "positive", x: 80, y: 80, instruction: "Look at the bottom-right corner of the area where you normally work." },
      { id: "negative-top", label: "Above screen", kind: "negative", x: 50, y: 4, instruction: "Look just beyond the top edge of your normal screen work area, toward a neutral point." },
      { id: "negative-bottom", label: "Below screen", kind: "negative", x: 50, y: 96, instruction: "Look just beyond the bottom edge of your normal screen work area, toward a neutral point." },
      { id: "negative-left", label: "Left of screen", kind: "negative", x: 4, y: 50, instruction: "Look just beyond the left edge of your normal screen work area, toward a neutral point." },
      { id: "negative-right", label: "Right of screen", kind: "negative", x: 96, y: 50, instruction: "Look just beyond the right edge of your normal screen work area, toward a neutral point." },
    ];
  }

  return [
    { id: "center", label: "Page center", kind: "positive", x: 50, y: 50, instruction: "Place your book as usual and look at a comfortable point near the center of the page." },
    { id: "top", label: "Page top", kind: "positive", x: 50, y: 28, instruction: "Look at a comfortable point near the top of the page." },
    { id: "bottom", label: "Page bottom", kind: "positive", x: 50, y: 72, instruction: "Look at a comfortable point near the bottom of the page." },
    { id: "left", label: "Page left", kind: "positive", x: 35, y: 50, instruction: "Look at a comfortable point near the left side of the page." },
    { id: "right", label: "Page right", kind: "positive", x: 65, y: 50, instruction: "Look at a comfortable point near the right side of the page." },
    { id: "negative-top", label: "Above the page", kind: "negative", x: 50, y: 6, instruction: "Look just above the book, beyond the page edge. This is a negative, off-page sample." },
    { id: "negative-bottom", label: "Below the page", kind: "negative", x: 50, y: 94, instruction: "Look just below the book, beyond the page edge. This is a negative, off-page sample." },
    { id: "negative-left", label: "Left of the page", kind: "negative", x: 18, y: 50, instruction: "Look just to the left of the book, beyond the page edge. This is a negative, off-page sample." },
    { id: "negative-right", label: "Right of the page", kind: "negative", x: 82, y: 50, instruction: "Look just to the right of the book, beyond the page edge. This is a negative, off-page sample." },
  ];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function medianAbsoluteDeviation(values: number[], center = median(values)) {
  return median(values.map((value) => Math.abs(value - center)));
}

function finiteSignalValues(samples: RawAttentionSignals[], key: CalibrationSignalKey) {
  return samples.map((sample) => sample[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function medianCalibrationBaseline(samples: RawAttentionSignals[]): AttentionBaseline | null {
  if (samples.length < CALIBRATION_MIN_SAMPLES) return null;
  const values = Object.fromEntries(SIGNAL_KEYS.map((key) => [key, finiteSignalValues(samples, key)])) as Record<CalibrationSignalKey, number[]>;
  if (SIGNAL_KEYS.some((key) => values[key].length < CALIBRATION_MIN_SAMPLES)) return null;
  return Object.fromEntries(SIGNAL_KEYS.map((key) => [key, median(values[key])])) as AttentionBaseline;
}

export function isCalibrationSignalValid(signals: RawAttentionSignals, profile: AttentionProfile): boolean {
  return signals.facePresent
    && SIGNAL_KEYS.every((key) => typeof signals[key] === "number" && Number.isFinite(signals[key]))
    && (signals.brightness == null || signals.brightness >= profile.tuning.lowLightFloor)
    && (signals.faceWidth == null || signals.faceWidth >= profile.tuning.minFaceWidth);
}

function targetSummary(samples: RawAttentionSignals[], key: CalibrationSignalKey) {
  const values = finiteSignalValues(samples, key);
  const center = median(values);
  return { center, spread: medianAbsoluteDeviation(values, center) * 1.4826 };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function createScoringProfile(
  mode: AttentionMode,
  baseline: AttentionBaseline,
  zone: AttentionZone,
  zoneShape: AttentionProfile["zoneShape"],
  tuning: AttentionClassifierTuning,
): AttentionProfile {
  return {
    ...defaultAttentionProfile(mode),
    baseline,
    calibratedAt: 1,
    zone,
    zoneShape,
    tuning,
  };
}

function makeDiagnostic(target: CalibrationTarget, samples: RawAttentionSignals[], baseline: AttentionBaseline): CalibrationTargetDiagnostic {
  const summary = Object.fromEntries(SIGNAL_KEYS.map((key) => [key, targetSummary(samples, key).center])) as AttentionBaseline;
  return {
    id: target.id,
    label: target.label,
    kind: target.kind,
    yawDelta: summary.yawDeg - baseline.yawDeg,
    pitchDelta: summary.pitchDeg - baseline.pitchDeg,
    gazeXDelta: summary.gazeX - baseline.gazeX,
    gazeYDelta: summary.gazeY - baseline.gazeY,
  };
}

/**
 * Computes a robust profile from the user's target captures. Only medians,
 * robust ranges, and aggregate overlap are returned; raw samples stay in the
 * wizard's transient component state and are never persisted.
 */
export function calculateCalibration(
  mode: AttentionMode,
  samplesByTarget: CalibrationSamples,
  marginPercent: number,
  zoneShape: AttentionProfile["zoneShape"],
  tuning: AttentionClassifierTuning = defaultAttentionProfile(mode).tuning,
): CalibrationResult | null {
  const targets = getCalibrationTargets(mode);
  if (targets.some((target) => (samplesByTarget[target.id]?.length ?? 0) < CALIBRATION_MIN_SAMPLES)) return null;

  const centerSamples = samplesByTarget.center;
  const baseline = medianCalibrationBaseline(centerSamples);
  if (!baseline) return null;

  const positiveTargets = targets.filter((target) => target.kind === "positive");
  const negativeTargets = targets.filter((target) => target.kind === "negative");
  const positiveSamples = positiveTargets.flatMap((target) => samplesByTarget[target.id] ?? []);
  const negativeSamples = negativeTargets.flatMap((target) => samplesByTarget[target.id] ?? []);
  const safeMargin = clamp(Number.isFinite(marginPercent) ? marginPercent : 20, 0, 80);

  const zone = {} as AttentionZone;
  for (const key of SIGNAL_KEYS) {
    const centerSpread = targetSummary(centerSamples, key).spread * 2.5;
    const targetRadii = positiveTargets.map((target) => {
      const summary = targetSummary(samplesByTarget[target.id], key);
      return Math.abs(summary.center - baseline[key]) + Math.max(summary.spread * 2.5, NOISE_FLOOR[key]);
    });
    const robustRadius = Math.max(MIN_ZONE[key], centerSpread, ...targetRadii);
    zone[key] = clamp(robustRadius * (1 + safeMargin / 100), MIN_ZONE[key], MAX_ZONE[key]);
  }

  // Elliptical scoring combines multiple simultaneous deviations more strictly
  // than rectangular scoring. Expand only as much as needed to keep the robust
  // medians of the intentionally on-task targets inside the fitted zone.
  let scoreProfile = createScoringProfile(mode, baseline, zone, zoneShape, tuning);
  const positiveTargetMedians = positiveTargets.map((target) => {
    const sample = samplesByTarget[target.id][0];
    const summary = Object.fromEntries(SIGNAL_KEYS.map((key) => [key, targetSummary(samplesByTarget[target.id], key).center])) as AttentionBaseline;
    return { ...sample, ...summary };
  });
  const maxPositiveScore = Math.max(0, ...positiveTargetMedians.map((sample) => computeAttentionScore(sample, scoreProfile) ?? 0));
  if (maxPositiveScore > 0.96) {
    const expansion = maxPositiveScore / 0.96;
    for (const key of SIGNAL_KEYS) zone[key] = clamp(zone[key] * expansion, MIN_ZONE[key], MAX_ZONE[key]);
    scoreProfile = createScoringProfile(mode, baseline, zone, zoneShape, tuning);
  }

  const negativeOverlap = negativeSamples.length
    ? negativeSamples.filter((sample) => (computeAttentionScore(sample, scoreProfile) ?? Number.POSITIVE_INFINITY) <= 1).length / negativeSamples.length
    : null;
  const positiveOutside = positiveSamples.length
    ? positiveSamples.filter((sample) => (computeAttentionScore(sample, scoreProfile) ?? Number.POSITIVE_INFINITY) > 1).length / positiveSamples.length
    : 0;
  const diagnostics = targets.map((target) => makeDiagnostic(target, samplesByTarget[target.id], baseline));
  const warnings: string[] = [];

  if (negativeOverlap != null && negativeOverlap >= 0.15) {
    warnings.push(`${Math.round(negativeOverlap * 100)}% of the off-target samples overlap the proposed work zone. Try a smaller margin or repeat the negative samples while looking farther beyond the work area.`);
  } else if (negativeOverlap != null && negativeOverlap > 0.03) {
    warnings.push(`${Math.round(negativeOverlap * 100)}% of the off-target samples overlap the proposed zone. Check the result in the Test Lab before using reminders.`);
  }
  if (positiveOutside >= 0.2) {
    warnings.push(`${Math.round(positiveOutside * 100)}% of the on-task samples fall outside the fitted zone. Recheck the target captures or choose a more generous margin.`);
  }
  if (SIGNAL_KEYS.some((key) => zone[key] >= MAX_ZONE[key] - 1e-9)) {
    warnings.push("At least one calibrated range reached its safety limit. The camera signal may not distinguish this work area reliably; verify it in the Test Lab.");
  }
  if (positiveTargets.some((target) => {
    if (target.id === "center") return false;
    const item = diagnostics.find((entry) => entry.id === target.id)!;
    return Math.hypot(item.yawDelta / 6, item.pitchDelta / 6, item.gazeXDelta / 0.18, item.gazeYDelta / 0.18) < 0.18;
  })) {
    warnings.push("One or more target captures looked very similar to center in the available signals. Keep the defaults conservative and verify directional response in the Live Test Lab.");
  }

  return {
    baseline,
    zone,
    zoneShape,
    marginPercent: safeMargin,
    sampleCount: targets.reduce((sum, target) => sum + samplesByTarget[target.id].length, 0),
    negativeOverlap,
    positiveOutside,
    targetDiagnostics: diagnostics,
    warnings,
  };
}

export function scaleAttentionZone(zone: AttentionZone, scale: number): AttentionZone {
  return {
    yawDeg: clamp(zone.yawDeg * scale, MIN_ZONE.yawDeg, MAX_ZONE.yawDeg),
    pitchDeg: clamp(zone.pitchDeg * scale, MIN_ZONE.pitchDeg, MAX_ZONE.pitchDeg),
    rollDeg: clamp(zone.rollDeg * scale, MIN_ZONE.rollDeg, MAX_ZONE.rollDeg),
    gazeX: clamp(zone.gazeX * scale, MIN_ZONE.gazeX, MAX_ZONE.gazeX),
    gazeY: clamp(zone.gazeY * scale, MIN_ZONE.gazeY, MAX_ZONE.gazeY),
  };
}
