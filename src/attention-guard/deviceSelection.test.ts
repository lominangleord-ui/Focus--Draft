import { describe, expect, it } from "vitest";
import { isCameraSelectionConfirmedMissing } from "./deviceSelection";
import type { CameraDevice } from "./types";

const knownCamera: CameraDevice = { deviceId: "camera-1", label: "Desk camera" };

describe("camera selection reconciliation", () => {
  it("keeps an available saved camera", () => {
    expect(isCameraSelectionConfirmedMissing("camera-1", [knownCamera], true)).toBe(false);
  });

  it("clears a missing selection only when enumeration exposes identifiable devices", () => {
    expect(isCameraSelectionConfirmedMissing("camera-old", [knownCamera], true)).toBe(true);
    expect(isCameraSelectionConfirmedMissing("camera-old", [knownCamera], false)).toBe(false);
  });

  it("preserves a saved camera while browser permission hides device IDs", () => {
    const hiddenIdCamera: CameraDevice = { deviceId: "", label: "Camera 1" };
    expect(isCameraSelectionConfirmedMissing("camera-old", [hiddenIdCamera], true)).toBe(false);
  });

  it("does not treat an empty or partially identifiable list as proof that a camera was removed", () => {
    expect(isCameraSelectionConfirmedMissing("camera-old", [], true)).toBe(false);
    expect(isCameraSelectionConfirmedMissing("camera-old", [knownCamera, { deviceId: "", label: "Camera 2" }], true)).toBe(false);
  });
});
