import { describe, expect, it } from "vitest";
import { mapFaceBoundsToPreview } from "./previewGeometry";

describe("camera preview face-box geometry", () => {
  it("mirrors a face box in an uncropped 4:3 preview", () => {
    const box = mapFaceBoundsToPreview(
      { x: 0.2, y: 0.25, width: 0.4, height: 0.5 },
      640,
      480,
      640,
      480,
    );
    expect(box).not.toBeNull();
    expect(box?.x).toBeCloseTo(0.4, 10);
    expect(box?.y).toBeCloseTo(0.25, 10);
    expect(box?.width).toBeCloseTo(0.4, 10);
    expect(box?.height).toBeCloseTo(0.5, 10);
  });

  it("accounts for the vertical crop when a 4:3 camera fills a 16:9 preview", () => {
    const box = mapFaceBoundsToPreview(
      { x: 0.2, y: 0.25, width: 0.4, height: 0.5 },
      640,
      480,
      640,
      360,
    );
    expect(box).not.toBeNull();
    expect(box?.x).toBeCloseTo(0.4, 10);
    expect(box?.y).toBeCloseTo(1 / 6, 10);
    expect(box?.width).toBeCloseTo(0.4, 10);
    expect(box?.height).toBeCloseTo(2 / 3, 10);
  });

  it("clips and mirrors bounds when a wide camera is cropped horizontally", () => {
    const box = mapFaceBoundsToPreview(
      { x: 0.1, y: 0.2, width: 0.3, height: 0.5 },
      1920,
      1080,
      800,
      600,
    );
    expect(box).not.toBeNull();
    expect(box?.x).toBeCloseTo(1 - (0.4 - 0.125) / 0.75, 10);
    expect(box?.width).toBeCloseTo(0.275 / 0.75, 10);
    expect(box?.y).toBeCloseTo(0.2, 10);
    expect(box?.height).toBeCloseTo(0.5, 10);
  });

  it("returns null for invalid inputs and a face wholly outside the cover crop", () => {
    expect(mapFaceBoundsToPreview(null, 640, 480, 640, 360)).toBeNull();
    expect(mapFaceBoundsToPreview({ x: 0, y: 0, width: 1, height: 1 }, 0, 480, 640, 360)).toBeNull();
    expect(mapFaceBoundsToPreview({ x: 0.1, y: 0, width: 0.2, height: 0.1 }, 640, 480, 640, 360)).toBeNull();
  });
});
