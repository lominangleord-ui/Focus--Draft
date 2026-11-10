import type { AttentionProfile } from "./profile";
import type {
  AttentionClassification,
  AttentionIntervention,
  AttentionReason,
  AttentionWarningLevel,
  RawAttentionSignals,
} from "./types";

export type ClassifierMemory = {
  smoothedScore: number | null;
  warningLevel: AttentionWarningLevel;
  candidateLevel: AttentionWarningLevel;
  candidateSince: number | null;
  recoverySince: number | null;
  missingSince: number | null;
  lastUpdatedAt: number;
};

export type ClassifierUpdate = {
  memory: ClassifierMemory;
  classification: AttentionClassification;
  intervention: AttentionIntervention | null;
};

export function createClassifierMemory(): ClassifierMemory {
  return {
    smoothedScore: null,
    warningLevel: 0,
    candidateLevel: 0,
    candidateSince: null,
    recoverySince: null,
    missingSince: null,
    lastUpdatedAt: 0,
  };
}

export function computeAttentionScore(signals: RawAttentionSignals, profile: AttentionProfile) {
  if (!profile.baseline) return null;
  const baseline = profile.baseline;
  const zone = profile.zone;
  const poseDeviations = [
    signals.yawDeg == null ? null : Math.abs(signals.yawDeg - baseline.yawDeg) / zone.yawDeg,
    signals.pitchDeg == null ? null : Math.abs(signals.pitchDeg - baseline.pitchDeg) / zone.pitchDeg,
    signals.rollDeg == null ? null : Math.abs(signals.rollDeg - baseline.rollDeg) / zone.rollDeg,
  ].filter((value): value is number => value != null && Number.isFinite(value));
  const gazeDeviations = [
    signals.gazeX == null ? null : Math.abs(signals.gazeX - baseline.gazeX) / zone.gazeX,
    signals.gazeY == null ? null : Math.abs(signals.gazeY - baseline.gazeY) / zone.gazeY,
  ].filter((value): value is number => value != null && Number.isFinite(value));

  const groupScore = (values: number[]) => profile.zoneShape === "ellipse"
    ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
    : Math.max(...values);
  const poseScore = poseDeviations.length ? groupScore(poseDeviations) : null;
  const gazeScore = gazeDeviations.length ? groupScore(gazeDeviations) : null;
  if (poseScore == null && gazeScore == null) return null;

  // Missing feature groups are omitted and the configured weights are
  // renormalized; the default remains pose-heavy because webcam gaze is coarse.
  const poseWeight = poseScore == null ? 0 : profile.tuning.poseWeight;
  const gazeWeight = gazeScore == null ? 0 : profile.tuning.gazeWeight;
  const totalWeight = poseWeight + gazeWeight;
  if (totalWeight <= 0) return null;
  return ((poseScore ?? 0) * poseWeight + (gazeScore ?? 0) * gazeWeight) / totalWeight;
}

function phaseFromScore(score: number, profile: AttentionProfile, warningLevel: AttentionWarningLevel) {
  if (warningLevel === 2 || score >= profile.tuning.level2Score) return "away" as const;
  if (warningLevel === 1 || score >= profile.tuning.level1Score) return "drifting" as const;
  return "attentive" as const;
}

function createOutput(
  phase: AttentionClassification["phase"],
  reason: AttentionReason,
  score: number | null,
  warningLevel: AttentionWarningLevel,
  updatedAt: number,
): AttentionClassification {
  return { phase, reason, score, warningLevel, updatedAt };
}

function resetUncalibrated(_memory: ClassifierMemory, now: number): ClassifierMemory {
  return { ...createClassifierMemory(), lastUpdatedAt: now };
}

function candidateForScore(score: number, memory: ClassifierMemory, profile: AttentionProfile): AttentionWarningLevel {
  const { level1Score, level2Score, hysteresis } = profile.tuning;
  if (memory.warningLevel === 0) {
    if (score >= level2Score) return 2;
    return score >= level1Score ? 1 : 0;
  }
  if (memory.warningLevel === 1) {
    if (score >= level2Score) return 2;
    return score < level1Score - hysteresis ? 0 : 1;
  }
  if (score < level1Score - hysteresis) return 0;
  return score < level2Score - hysteresis ? 1 : 2;
}

function commitCandidate(
  memory: ClassifierMemory,
  candidateLevel: AttentionWarningLevel,
  now: number,
  profile: AttentionProfile,
  faceMissing = false,
): { memory: ClassifierMemory; intervention: AttentionIntervention | null } {
  if (candidateLevel === memory.warningLevel) {
    return {
      memory: { ...memory, candidateLevel, candidateSince: null, recoverySince: null, lastUpdatedAt: now },
      intervention: null,
    };
  }

  const increasing = candidateLevel > memory.warningLevel;
  const since = increasing
    ? memory.candidateLevel === candidateLevel && memory.candidateSince != null ? memory.candidateSince : now
    : memory.recoverySince ?? now;
  const dwell = increasing
    ? faceMissing
      ? profile.tuning.faceMissingMs
      : candidateLevel === 1
        ? profile.tuning.level1DwellMs + profile.tuning.glanceAllowanceMs
        : profile.tuning.level2DwellMs
    : profile.tuning.recoveryMs;

  if (now - since < dwell) {
    return {
      memory: {
        ...memory,
        candidateLevel,
        candidateSince: increasing ? since : null,
        recoverySince: increasing ? null : since,
        lastUpdatedAt: now,
      },
      intervention: null,
    };
  }

  const nextMemory: ClassifierMemory = {
    ...memory,
    warningLevel: candidateLevel,
    candidateLevel,
    candidateSince: null,
    recoverySince: null,
    missingSince: faceMissing ? memory.missingSince : null,
    lastUpdatedAt: now,
  };
  return {
    memory: nextMemory,
    intervention: increasing
      ? { level: candidateLevel as 1 | 2, score: memory.smoothedScore ?? 0, reason: faceMissing ? "face-not-detected" : "looking-away", triggeredAt: now }
      : null,
  };
}

/** Pure, timestamp-driven classifier. The caller owns memory and can replay samples deterministically. */
export function updateAttentionClassifier(
  previous: ClassifierMemory,
  signals: RawAttentionSignals | null,
  profile: AttentionProfile,
  timestamp: number,
): ClassifierUpdate {
  const now = Math.max(previous.lastUpdatedAt, Number.isFinite(timestamp) ? timestamp : previous.lastUpdatedAt);

  if (!profile.baseline || profile.calibratedAt == null) {
    const memory = resetUncalibrated(previous, now);
    return {
      memory,
      classification: createOutput("needs-calibration", "profile-not-calibrated", null, 0, now),
      intervention: null,
    };
  }

  if (!signals) {
    const memory = { ...previous, candidateLevel: 0 as const, candidateSince: null, recoverySince: null, missingSince: null, lastUpdatedAt: now };
    return { memory, classification: createOutput("waiting", "waiting-for-signals", null, memory.warningLevel, now), intervention: null };
  }

  if (!signals.facePresent) {
    const missingSince = previous.missingSince ?? now;
    const memoryWithMissing = {
      ...previous,
      missingSince,
      candidateLevel: 2 as const,
      candidateSince: previous.candidateLevel === 2 && previous.candidateSince != null ? previous.candidateSince : missingSince,
      recoverySince: null,
      lastUpdatedAt: now,
    };
    const update = commitCandidate(memoryWithMissing, 2, now, profile, true);
    return {
      ...update,
      classification: createOutput("face-missing", "face-not-detected", null, update.memory.warningLevel, now),
    };
  }

  const brightness = signals.brightness;
  if (brightness != null && brightness < profile.tuning.lowLightFloor) {
    const memory = { ...previous, candidateLevel: 0 as const, candidateSince: null, recoverySince: null, missingSince: null, lastUpdatedAt: now };
    return { memory, classification: createOutput("low-quality", "lighting-too-low", null, memory.warningLevel, now), intervention: null };
  }
  if (signals.faceWidth != null && signals.faceWidth < profile.tuning.minFaceWidth) {
    const memory = { ...previous, candidateLevel: 0 as const, candidateSince: null, recoverySince: null, missingSince: null, lastUpdatedAt: now };
    return { memory, classification: createOutput("low-quality", "face-too-small", null, memory.warningLevel, now), intervention: null };
  }

  const rawScore = computeAttentionScore(signals, profile);
  if (rawScore == null || !Number.isFinite(rawScore)) {
    const memory = { ...previous, candidateLevel: 0 as const, candidateSince: null, recoverySince: null, missingSince: null, lastUpdatedAt: now };
    return { memory, classification: createOutput("low-quality", "insufficient-signals", null, memory.warningLevel, now), intervention: null };
  }

  const alpha = profile.tuning.smoothingAlpha;
  const smoothedScore = previous.smoothedScore == null
    ? rawScore
    : previous.smoothedScore + alpha * (rawScore - previous.smoothedScore);
  const memoryWithScore = { ...previous, smoothedScore, missingSince: null, lastUpdatedAt: now };
  const candidate = candidateForScore(smoothedScore, memoryWithScore, profile);
  const update = commitCandidate(memoryWithScore, candidate, now, profile);
  const phase = phaseFromScore(smoothedScore, profile, update.memory.warningLevel);
  const reason = phase === "attentive" ? "within-zone" : "looking-away";
  return {
    ...update,
    classification: createOutput(phase, reason, smoothedScore, update.memory.warningLevel, now),
  };
}
