export type AttentionMode = "screen" | "book";

/** Numeric-only outputs from the local inference worker. No image or landmark arrays cross this boundary. */
export type RawAttentionSignals = {
  sampledAt: number;
  facePresent: boolean;
  landmarkCount: number;
  yawDeg: number | null;
  pitchDeg: number | null;
  rollDeg: number | null;
  /** Iris position within the eye-box, normalized to -1..1. */
  gazeX: number | null;
  gazeY: number | null;
  faceWidth: number | null;
  brightness: number | null;
  eyeBlinkLeft: number | null;
  eyeBlinkRight: number | null;
};

export type AttentionWarningLevel = 0 | 1 | 2;
export type AttentionPhase = "waiting" | "needs-calibration" | "attentive" | "drifting" | "away" | "face-missing" | "low-quality";
export type AttentionReason = "waiting-for-signals" | "profile-not-calibrated" | "within-zone" | "looking-away" | "face-not-detected" | "lighting-too-low" | "face-too-small" | "insufficient-signals";

export type AttentionClassification = {
  phase: AttentionPhase;
  reason: AttentionReason;
  score: number | null;
  warningLevel: AttentionWarningLevel;
  updatedAt: number;
};

export type AttentionIntervention = {
  level: 1 | 2;
  score: number;
  reason: AttentionReason;
  triggeredAt: number;
};

export type GuardStatus = "off" | "starting" | "on" | "paused" | "error";

export type CameraDevice = {
  deviceId: string;
  label: string;
};

export type GuardRuntimeState = {
  status: GuardStatus;
  error: string;
  devices: CameraDevice[];
  selectedDeviceId: string;
  activeDeviceId: string;
};

export type WorkerInitMessage = {
  type: "init";
  modelUrl: string;
  wasmBaseUrl: string;
};

export type WorkerFrameMessage = {
  type: "frame";
  frameId: number;
  bitmap: ImageBitmap;
  timestamp: number;
};

export type WorkerDisposeMessage = { type: "dispose" };

export type AttentionWorkerRequest = WorkerInitMessage | WorkerFrameMessage | WorkerDisposeMessage;

export type AttentionWorkerResponse =
  | { type: "ready" }
  | { type: "signals"; frameId: number; signals: RawAttentionSignals }
  | { type: "error"; message: string };
