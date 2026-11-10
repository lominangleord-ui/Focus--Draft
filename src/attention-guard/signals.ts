import type { FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { RawAttentionSignals } from "./types";

export type HeadPose = { yawDeg: number; pitchDeg: number; rollDeg: number };

type Point = Pick<NormalizedLandmark, "x" | "y">;
const toDeg = (radians: number) => radians * (180 / Math.PI);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Decomposes the 4x4 column-major MediaPipe facial transform into a stable
 * Euler-angle estimate. Calibration uses offsets, so absolute axis conventions
 * do not leak into the classifier.
 */
export function matrixToHeadPose(data: readonly number[], rows = 4, columns = 4): HeadPose | null {
  if (rows !== 4 || columns !== 4 || data.length < 16 || data.slice(0, 16).some((value) => !Number.isFinite(value))) {
    return null;
  }

  // MediaPipe MatrixData defaults to column-major storage.
  const at = (row: number, column: number) => data[column * rows + row];
  const columnLength = (column: number) => Math.hypot(at(0, column), at(1, column), at(2, column));
  const sx = columnLength(0);
  const sy = columnLength(1);
  const sz = columnLength(2);
  if (sx < 1e-6 || sy < 1e-6 || sz < 1e-6) return null;

  const r00 = at(0, 0) / sx;
  const r10 = at(1, 0) / sx;
  const r20 = at(2, 0) / sx;
  const r21 = at(2, 1) / sy;
  const r22 = at(2, 2) / sz;
  const sinYaw = clamp(-r20, -1, 1);
  const yaw = Math.asin(sinYaw);
  const pitch = Math.atan2(r21, r22);
  const roll = Math.atan2(r10, r00);

  return {
    yawDeg: toDeg(yaw),
    pitchDeg: toDeg(pitch),
    rollDeg: toDeg(roll),
  };
}

function eyePosition(
  landmarks: readonly Point[],
  irisIndex: number,
  cornerA: number,
  cornerB: number,
  upperIndex: number,
  lowerIndex: number,
): { x: number; y: number } | null {
  const iris = landmarks[irisIndex];
  const a = landmarks[cornerA];
  const b = landmarks[cornerB];
  const upper = landmarks[upperIndex];
  const lower = landmarks[lowerIndex];
  if (!iris || !a || !b || !upper || !lower) return null;

  const eyeWidth = Math.abs(a.x - b.x);
  const eyeHeight = Math.abs(lower.y - upper.y);
  if (eyeWidth < 0.008 || eyeHeight < 0.003) return null;
  const left = Math.min(a.x, b.x);
  const top = Math.min(upper.y, lower.y);
  return {
    x: clamp(((iris.x - left) / eyeWidth) * 2 - 1, -1.5, 1.5),
    y: clamp(((iris.y - top) / eyeHeight) * 2 - 1, -1.5, 1.5),
  };
}

function average(values: Array<number | null>) {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function faceWidth(landmarks: readonly Point[]) {
  const left = landmarks[234];
  const right = landmarks[454];
  if (!left || !right) return null;
  const width = Math.abs(right.x - left.x);
  return Number.isFinite(width) ? clamp(width, 0, 1) : null;
}

function blendshapeScore(result: FaceLandmarkerResult, name: string) {
  const score = result.faceBlendshapes[0]?.categories.find((entry) => entry.categoryName === name)?.score;
  return typeof score === "number" && Number.isFinite(score) ? clamp(score, 0, 1) : null;
}

/** Extract just the numeric signals needed by the guard/debug UI. */
export function extractRawSignals(
  result: FaceLandmarkerResult,
  brightness: number | null,
  sampledAt: number,
): RawAttentionSignals {
  const landmarks = result.faceLandmarks[0] ?? [];
  if (landmarks.length === 0) {
    return {
      sampledAt,
      facePresent: false,
      landmarkCount: 0,
      yawDeg: null,
      pitchDeg: null,
      rollDeg: null,
      gazeX: null,
      gazeY: null,
      faceWidth: null,
      brightness,
      eyeBlinkLeft: null,
      eyeBlinkRight: null,
    };
  }

  // On an unmirrored frame, 468 is the right iris and 473 is the left iris.
  // Gaze remains an estimate; the mirror is applied only to the UI preview.
  const rightEye = eyePosition(landmarks, 468, 33, 133, 159, 145);
  const leftEye = eyePosition(landmarks, 473, 362, 263, 386, 374);
  const transform = result.facialTransformationMatrixes[0];
  const pose = transform ? matrixToHeadPose(transform.data, transform.rows, transform.columns) : null;

  return {
    sampledAt,
    facePresent: true,
    landmarkCount: landmarks.length,
    yawDeg: pose?.yawDeg ?? null,
    pitchDeg: pose?.pitchDeg ?? null,
    rollDeg: pose?.rollDeg ?? null,
    gazeX: average([rightEye?.x ?? null, leftEye?.x ?? null]),
    gazeY: average([rightEye?.y ?? null, leftEye?.y ?? null]),
    faceWidth: faceWidth(landmarks),
    brightness,
    eyeBlinkLeft: blendshapeScore(result, "eyeBlinkLeft"),
    eyeBlinkRight: blendshapeScore(result, "eyeBlinkRight"),
  };
}
