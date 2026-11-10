import type { AttentionMode } from "./types";

export type AttentionBaseline = {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  gazeX: number;
  gazeY: number;
};

export type AttentionZone = {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  gazeX: number;
  gazeY: number;
};

export type AttentionClassifierTuning = {
  smoothingAlpha: number;
  level1Score: number;
  level2Score: number;
  level1DwellMs: number;
  level2DwellMs: number;
  recoveryMs: number;
  faceMissingMs: number;
  glanceAllowanceMs: number;
  hysteresis: number;
  poseWeight: number;
  gazeWeight: number;
  lowLightFloor: number;
  minFaceWidth: number;
};

export type AttentionProfile = {
  id: string;
  name: string;
  mode: AttentionMode;
  createdAt: number;
  updatedAt: number;
  calibratedAt: number | null;
  calibrationSamples: number;
  baseline: AttentionBaseline | null;
  zone: AttentionZone;
  zoneShape: "ellipse" | "rectangle";
  marginPercent: number;
  negativeOverlap: number | null;
  tuning: AttentionClassifierTuning;
};

export type AttentionProfileFile = {
  format: "focus-draft-attention-profile";
  schemaVersion: 1;
  exportedAt: string;
  profile: AttentionProfile;
};

const DEFAULT_TUNING: AttentionClassifierTuning = {
  smoothingAlpha: 0.32,
  level1Score: 1,
  level2Score: 1.75,
  level1DwellMs: 3_500,
  level2DwellMs: 6_000,
  recoveryMs: 1_600,
  faceMissingMs: 4_500,
  glanceAllowanceMs: 900,
  hysteresis: 0.2,
  poseWeight: 0.65,
  gazeWeight: 0.35,
  lowLightFloor: 0.11,
  minFaceWidth: 0.075,
};

const DEFAULT_ZONE: AttentionZone = {
  yawDeg: 22,
  pitchDeg: 18,
  rollDeg: 25,
  gazeX: 0.82,
  gazeY: 0.9,
};

export function defaultAttentionProfile(mode: AttentionMode, id = `default-${mode}`, now = 0): AttentionProfile {
  return {
    id,
    name: mode === "screen" ? "Screen · calibrate me" : "Book · calibrate me",
    mode,
    createdAt: now,
    updatedAt: now,
    calibratedAt: null,
    calibrationSamples: 0,
    baseline: null,
    zone: { ...DEFAULT_ZONE, pitchDeg: mode === "book" ? 22 : DEFAULT_ZONE.pitchDeg, gazeY: mode === "book" ? 1.05 : DEFAULT_ZONE.gazeY },
    zoneShape: "rectangle",
    marginPercent: 20,
    negativeOverlap: null,
    tuning: { ...DEFAULT_TUNING },
  };
}

export function createAttentionProfile(mode: AttentionMode, name: string, id: string, now = Date.now()): AttentionProfile {
  const profile = defaultAttentionProfile(mode, id, now);
  return { ...profile, name: name.trim().slice(0, 32) || (mode === "screen" ? "Screen profile" : "Book profile") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeBaseline(value: unknown): AttentionBaseline | null {
  if (!isRecord(value)) return null;
  const fields: (keyof AttentionBaseline)[] = ["yawDeg", "pitchDeg", "rollDeg", "gazeX", "gazeY"];
  if (fields.some((field) => typeof value[field] !== "number" || !Number.isFinite(value[field]))) return null;
  return {
    yawDeg: finite(value.yawDeg, 0, -90, 90),
    pitchDeg: finite(value.pitchDeg, 0, -90, 90),
    rollDeg: finite(value.rollDeg, 0, -90, 90),
    gazeX: finite(value.gazeX, 0, -1.5, 1.5),
    gazeY: finite(value.gazeY, 0, -1.5, 1.5),
  };
}

export function normalizeAttentionProfile(value: unknown): AttentionProfile | null {
  if (!isRecord(value)) return null;
  const mode = value.mode;
  if (mode !== "screen" && mode !== "book") return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  const defaults = defaultAttentionProfile(mode, value.id);
  const zone = isRecord(value.zone) ? value.zone : {};
  const tuning = isRecord(value.tuning) ? value.tuning : {};
  const calibratedAt = typeof value.calibratedAt === "number" && Number.isFinite(value.calibratedAt) ? Math.max(0, value.calibratedAt) : null;
  const baseline = normalizeBaseline(value.baseline);
  const validCalibration = calibratedAt != null && baseline != null;
  const level1Score = finite(tuning.level1Score, defaults.tuning.level1Score, 0.2, 2.5);
  const level2Score = Math.max(level1Score + 0.15, finite(tuning.level2Score, defaults.tuning.level2Score, 0.4, 4));
  const rawPoseWeight = finite(tuning.poseWeight, defaults.tuning.poseWeight, 0, 1);
  const rawGazeWeight = finite(tuning.gazeWeight, defaults.tuning.gazeWeight, 0, 1);
  const rawWeightTotal = rawPoseWeight + rawGazeWeight;
  const poseWeight = rawWeightTotal > 0 ? rawPoseWeight / rawWeightTotal : defaults.tuning.poseWeight;
  const gazeWeight = rawWeightTotal > 0 ? rawGazeWeight / rawWeightTotal : defaults.tuning.gazeWeight;

  return {
    id: value.id.trim().slice(0, 100),
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 32) : defaults.name,
    mode,
    createdAt: finite(value.createdAt, Date.now(), 0, 8.64e15),
    updatedAt: finite(value.updatedAt, Date.now(), 0, 8.64e15),
    calibratedAt: validCalibration ? calibratedAt : null,
    calibrationSamples: validCalibration ? Math.round(finite(value.calibrationSamples, 0, 0, 100_000)) : 0,
    baseline: validCalibration ? baseline : null,
    zone: {
      yawDeg: finite(zone.yawDeg, defaults.zone.yawDeg, 5, 60),
      pitchDeg: finite(zone.pitchDeg, defaults.zone.pitchDeg, 5, 60),
      rollDeg: finite(zone.rollDeg, defaults.zone.rollDeg, 5, 60),
      gazeX: finite(zone.gazeX, defaults.zone.gazeX, 0.15, 1.5),
      gazeY: finite(zone.gazeY, defaults.zone.gazeY, 0.15, 1.5),
    },
    // Missing fields from schema v1 profiles are migrated to the behavior
    // already used by the classifier before calibration shapes were added.
    zoneShape: value.zoneShape === "ellipse" ? "ellipse" : "rectangle",
    marginPercent: finite(value.marginPercent, defaults.marginPercent, 0, 80),
    negativeOverlap: typeof value.negativeOverlap === "number" && Number.isFinite(value.negativeOverlap)
      ? finite(value.negativeOverlap, 0, 0, 1)
      : null,
    tuning: {
      smoothingAlpha: finite(tuning.smoothingAlpha, defaults.tuning.smoothingAlpha, 0.05, 0.9),
      level1Score,
      level2Score,
      level1DwellMs: Math.round(finite(tuning.level1DwellMs, defaults.tuning.level1DwellMs, 500, 30_000)),
      level2DwellMs: Math.round(finite(tuning.level2DwellMs, defaults.tuning.level2DwellMs, 1_000, 60_000)),
      recoveryMs: Math.round(finite(tuning.recoveryMs, defaults.tuning.recoveryMs, 300, 15_000)),
      faceMissingMs: Math.round(finite(tuning.faceMissingMs, defaults.tuning.faceMissingMs, 1_000, 30_000)),
      glanceAllowanceMs: Math.round(finite(tuning.glanceAllowanceMs, defaults.tuning.glanceAllowanceMs, 0, 10_000)),
      hysteresis: finite(tuning.hysteresis, defaults.tuning.hysteresis, 0.05, 0.8),
      poseWeight,
      gazeWeight,
      lowLightFloor: finite(tuning.lowLightFloor, defaults.tuning.lowLightFloor, 0, 0.5),
      minFaceWidth: finite(tuning.minFaceWidth, defaults.tuning.minFaceWidth, 0.02, 0.5),
    },
  };
}

export function serializeAttentionProfile(profile: AttentionProfile, exportedAt = new Date().toISOString()) {
  const normalized = normalizeAttentionProfile(profile);
  if (!normalized) throw new Error("This profile is invalid and cannot be exported.");
  const file: AttentionProfileFile = {
    format: "focus-draft-attention-profile",
    schemaVersion: 1,
    exportedAt,
    profile: normalized,
  };
  return JSON.stringify(file, null, 2);
}

export function parseAttentionProfileFile(json: string): AttentionProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.format !== "focus-draft-attention-profile") {
    throw new Error("This is not a Focus Draft Attention Guard profile file.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported Attention Guard profile version: ${String(parsed.schemaVersion)}.`);
  }
  const profile = normalizeAttentionProfile(parsed.profile);
  if (!profile) throw new Error("The profile data is incomplete or invalid.");
  return profile;
}
