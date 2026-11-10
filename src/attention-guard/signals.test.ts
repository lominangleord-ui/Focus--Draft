import { describe, expect, it } from "vitest";
import { matrixToHeadPose } from "./signals";

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

  it("rejects malformed and degenerate transforms", () => {
    expect(matrixToHeadPose([1, 2, 3])).toBeNull();
    expect(matrixToHeadPose(new Array(16).fill(0))).toBeNull();
    expect(matrixToHeadPose([...identity.slice(0, 15), Number.NaN])).toBeNull();
  });
});
