import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionGuardController } from "./controller";

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Attention Guard controller lifecycle gate", () => {
  it("does not start a focus-purpose camera outside an active Focus timer", async () => {
    const controller = new AttentionGuardController();

    await controller.start();
    expect(controller.getState()).toMatchObject({ status: "off", runPurpose: null });

    controller.setFocusTimerActive(true);
    controller.setFocusTimerActive(false);
    await controller.start();
    expect(controller.getState()).toMatchObject({ status: "off", runPurpose: null });
  });

  it("keeps the newest camera enumeration when overlapping refreshes finish out of order", async () => {
    const older = deferred<MediaDeviceInfo[]>();
    const newer = deferred<MediaDeviceInfo[]>();
    const enumerateDevices = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });

    const controller = new AttentionGuardController();
    const olderRefresh = controller.refreshDevices();
    const newerRefresh = controller.refreshDevices();
    const camera = (deviceId: string) => ({ kind: "videoinput", deviceId, label: deviceId }) as MediaDeviceInfo;

    newer.resolve([camera("new-camera")]);
    await newerRefresh;
    older.resolve([camera("old-camera")]);
    await olderRefresh;

    expect(controller.getState().devices.map((device) => device.deviceId)).toEqual(["new-camera"]);
  });
});
