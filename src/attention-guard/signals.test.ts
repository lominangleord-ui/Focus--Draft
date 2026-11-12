import { describe, expect, it } from "vitest";
import { extractRawSignals, matrixToHeadPose, normalizedFaceBounds } from "./signals";
import type { FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";

function columnMajorRotation(rows: number[][]) {
  return [
    rows[0][0], rows[1][0], rows[2][0], 0,
    rows[0][1], rows[1][1], rows[2][1], 0,
    rows[0][2], rows[1][2], rows[2][2], 0,
    0, 0, 0, 1,
  ];
}

const identity = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

describe("extractRawSignals", () => {
  it("returns pose, eye-box estimates and a face box without exposing landmark arrays", () => {
    const point = (x: number, y: number): NormalizedLandmark => ({ x, y, z: 0, visibility: 1 });
    const landmarks = Array.from({ length: 478 }, () => point(0.5, 0.5));
    landmarks[0] = point(0.1, 0.1);
    landmarks[1] = point(0.9, 0.9);
    landmarks[234] = point(0.2, 0.5);
    landmarks[454] = point(0.8, 0.5);
    landmarks[33] = point(0.3, 0.4);
    landmarks[133] = point(0.4, 0.4);
    landmarks[159] = point(0.35, 0.48);
    landmarks[145] = point(0.35, 0.52);
    landmarks[468] = point(0.35, 0.5);
    landmarks[362] = point(0.6, 0.4);
    landmarks[263] = point(0.7, 0.4);
    landmarks[386] = point(0.65, 0.48);
    landmarks[374] = point(0.65, 0.52);
    landmarks[473] = point(0.65, 0.5);
    const result: FaceLandmarkerResult = {
      faceLandmarks: [landmarks],
      faceBlendshapes: [],
      facialTransformationMatrixes: [{ rows: 4, columns: 4, data: identity }],
    };

    const signals = extractRawSignals(result, 0.45, 123);
    expect(signals).toMatchObject({
      sampledAt: 123,
      facePresent: true,
      landmarkCount: 478,
      faceBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      brightness: 0.45,
    });
    expect(signals.gazeX).toBeCloseTo(0, 10);
    expect(signals.gazeY).toBeCloseTo(0, 10);
    expect(signals.faceWidth).toBeCloseTo(0.6, 10);
  });
});

describe("normalizedFaceBounds", () => {
  it("returns a frame-clamped rectangle from numeric landmarks", () => {
    expect(normalizedFaceBounds([
      { x: 0.2, y: 0.25 },
      { x: 0.8, y: 0.75 },
      { x: -0.1, y: 0.5 },
      { x: 0.5, y: 0.6 },
      { x: Number.NaN, y: 0.2 },
    ])).toEqual({ x: 0, y: 0.25, width: 0.8, height: 0.5 });
  });

  it("rejects insufficient or degenerate landmark sets", () => {
    expect(normalizedFaceBounds([{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }, { x: 0.5, y: 0.5 }])).toBeNull();
    expect(normalizedFaceBounds(Array.from({ length: 4 }, () => ({ x: 0.5, y: 0.5 })))).toBeNull();
  });
});

describe("matrixToHeadPose", () => {
  it("returns zero pose for an identity transform", () => {
    expect(matrixToHeadPose(identity)).toEqual({ yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
  });

  it("decomposes independently signed yaw, pitch, and roll from column-major data", () => {
    const yaw = 30 * Math.PI / 180;
    const pitch = -18 * Math.PI / 180;
    const roll = 12 * Math.PI / 180;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const rotation = [
      [cy * cr, sp * sy * cr - cp * sr, cp * sy * cr + sp * sr],
      [cy * sr, sp * sy * sr + cp * cr, cp * sy * sr - sp * cr],
      [-sy, sp * cy, cp * cy],
    ];
    const pose = matrixToHeadPose(columnMajorRotation(rotation));
    expect(pose?.yawDeg).toBeCloseTo(30, 5);
    expect(pose?.pitchDeg).toBeCloseTo(-18, 5);
    expect(pose?.rollDeg).toBeCloseTo(12, 5);
  });

  it("ignores translation and independent column scales when decomposing head pose", () => {
    const yaw = 21 * Math.PI / 180;
    const pitch = -9 * Math.PI / 180;
    const roll = 6 * Math.PI / 180;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const data = columnMajorRotation([
      [cy * cr, sp * sy * cr - cp * sr, cp * sy * cr + sp * sr],
      [cy * sr, sp * sy * sr + cp * cr, cp * sy * sr - sp * cr],
      [-sy, sp * cy, cp * cy],
    ]);
    for (let row = 0; row < 4; row += 1) {
      data[row] *= 1.8;
      data[4 + row] *= 0.65;
      data[8 + row] *= 1.25;
    }
    data[12] = 120;
    data[13] = -80;
    data[14] = 45;

    const pose = matrixToHeadPose(data);
    expect(pose?.yawDeg).toBeCloseTo(21, 5);
    expect(pose?.pitchDeg).toBeCloseTo(-9, 5);
    expect(pose?.rollDeg).toBeCloseTo(6, 5);
  });

  it("rejects malformed and degenerate transforms", () => {
    expect(matrixToHeadPose([1, 2, 3])).toBeNull();
    expect(matrixToHeadPose(new Array(16).fill(0))).toBeNull();
    expect(matrixToHeadPose([...identity.slice(0, 15), Number.NaN])).toBeNull();
  });
});
