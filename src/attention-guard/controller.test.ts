import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionGuardController } from "./controller";
import { createAttentionProfile } from "./profile";
import type { AttentionWorkerRequest, AttentionWorkerResponse, RawAttentionSignals } from "./types";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<AttentionWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: AttentionWorkerRequest[] = [];
  terminated = false;

  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: AttentionWorkerRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

function installCameraMocks(videoReadyState: number) {
  const track = {
    onended: null as (() => void) | null,
    getSettings: () => ({ deviceId: "mock-camera" }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const video = {
    muted: true,
    playsInline: true,
    autoplay: true,
    srcObject: null,
    readyState: videoReadyState,
    videoWidth: 640,
    videoHeight: 480,
    currentTime: 0,
    paused: false,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;

  vi.stubGlobal("window", {
    isSecureContext: true,
    location: { href: "https://focus.example.test/" },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  vi.stubGlobal("document", {
    baseURI: "https://focus.example.test/",
    createElement: () => video,
  });
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(null, {
    status: 200,
    headers: { "content-type": String(input).endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream" },
  })));
  vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
  return { track, stream, video, getUserMedia, worker: () => FakeWorker.instances[0] };
}

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

  it("requires a calibrated profile before starting Focus tracking", async () => {
    const controller = new AttentionGuardController();
    controller.setFocusTimerActive(true);

    await controller.start();

    expect(controller.getState()).toMatchObject({ status: "error", runPurpose: null });
    expect(controller.getState().error).toContain("Calibrate the active Attention Guard profile");
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("allows Focus tracking with a calibrated profile during an active Focus timer", async () => {
    installCameraMocks(2);
    const controller = new AttentionGuardController();
    const profile = createAttentionProfile("screen", "Desk", "desk", 1);
    profile.calibratedAt = 2;
    profile.baseline = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, gazeX: 0, gazeY: 0 };
    controller.setProfile(profile);
    controller.setFocusTimerActive(true);

    await controller.start();

    expect(controller.getState()).toMatchObject({ status: "starting", runPurpose: "focus" });
    expect(FakeWorker.instances).toHaveLength(1);
    controller.stop();
  });

  it("keeps facing mode and video size as preferences so ordinary webcams still prompt", async () => {
    const mocks = installCameraMocks(2);
    const controller = new AttentionGuardController();

    await controller.startDiagnostic();

    const constraints = mocks.getUserMedia.mock.calls[0]?.[0];
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
    expect(constraints?.video).toMatchObject({
      facingMode: { ideal: "user" },
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 12 },
    });
    controller.stop();
  });

  it("shows real camera startup stages and waits for the published worker and model assets", async () => {
    installCameraMocks(2);
    const controller = new AttentionGuardController();

    const startup = controller.startDiagnostic();
    expect(controller.getState()).toMatchObject({ status: "starting", startupStage: "requesting-permission" });
    await startup;
    expect(controller.getState()).toMatchObject({ status: "starting", startupStage: "loading-model" });
    expect(fetch).toHaveBeenCalledTimes(4);

    const worker = FakeWorker.instances[0];
    worker.onmessage?.({ data: { type: "ready" } } as MessageEvent<AttentionWorkerResponse>);
    expect(controller.getState()).toMatchObject({ status: "on", startupStage: null });
    controller.stop();
  });

  it("retries the browser default camera when a saved device ID cannot be opened", async () => {
    const mocks = installCameraMocks(2);
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new DOMException("Saved camera is unavailable", "OverconstrainedError"))
      .mockResolvedValueOnce(mocks.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = new AttentionGuardController();

    await controller.startDiagnostic("stale-camera-id");

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ video: { deviceId: { exact: "stale-camera-id" } } });
    expect(getUserMedia.mock.calls[1]?.[0]).toMatchObject({ video: { facingMode: { ideal: "user" } } });
    expect(controller.getState()).toMatchObject({ status: "starting", startupStage: "loading-model", selectedDeviceId: "mock-camera" });
    expect(FakeWorker.instances).toHaveLength(1);
    controller.stop();
  });

  it("times out a camera permission request that never receives a browser response", async () => {
    vi.useFakeTimers();
    const mocks = installCameraMocks(2);
    const pendingPermission = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => pendingPermission.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = new AttentionGuardController();

    const startup = controller.startDiagnostic();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ status: "starting", startupStage: "requesting-permission" });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.getState()).toMatchObject({ status: "error", startupStage: null });
    expect(controller.getState().error).toContain("Camera permission is still pending");

    pendingPermission.resolve(mocks.stream);
    await startup;
    expect(mocks.track.stop).toHaveBeenCalled();
  });

  it("explains when Vercel is missing the deployed camera worker or model assets", async () => {
    const mocks = installCameraMocks(2);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const controller = new AttentionGuardController();

    await controller.startDiagnostic();

    expect(controller.getState()).toMatchObject({ status: "error", startupStage: null });
    expect(controller.getState().error).toContain('Vercel must run "npm run build" and publish "dist"');
    expect(FakeWorker.instances).toHaveLength(0);
    expect(mocks.track.stop).toHaveBeenCalled();
  });

  it("stops instead of showing a live camera when no video samples ever arrive", async () => {
    vi.useFakeTimers();
    const mocks = installCameraMocks(0);
    const controller = new AttentionGuardController();

    await controller.startDiagnostic();
    const worker = mocks.worker();
    worker.onmessage?.({ data: { type: "ready" } } as MessageEvent<AttentionWorkerResponse>);
    expect(controller.getState().status).toBe("on");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.getState()).toMatchObject({ status: "error" });
    expect(controller.getState().error).toContain("no video samples arrived");
    expect(worker.terminated).toBe(true);
  });

  it("times out an inference worker that accepts a frame but never responds", async () => {
    vi.useFakeTimers();
    const mocks = installCameraMocks(2);
    const controller = new AttentionGuardController();

    await controller.startDiagnostic();
    const worker = mocks.worker();
    worker.onmessage?.({ data: { type: "ready" } } as MessageEvent<AttentionWorkerResponse>);
    await vi.advanceTimersByTimeAsync(220);
    expect(worker.messages.some((message) => message.type === "frame")).toBe(true);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(controller.getState()).toMatchObject({ status: "error" });
    expect(controller.getState().error).toContain("stopped responding to camera frames");
    expect(worker.terminated).toBe(true);
    expect(mocks.track.stop).toHaveBeenCalled();
  });

  it("stops tracking when the camera feed freezes after an initial sample", async () => {
    vi.useFakeTimers();
    const mocks = installCameraMocks(2);
    const controller = new AttentionGuardController();

    await controller.startDiagnostic();
    const worker = mocks.worker();
    worker.onmessage?.({ data: { type: "ready" } } as MessageEvent<AttentionWorkerResponse>);
    await vi.advanceTimersByTimeAsync(220);
    const frame = worker.messages.find((message) => message.type === "frame");
    expect(frame?.type).toBe("frame");
    if (frame?.type !== "frame") throw new Error("Expected a camera frame message.");

    const signals: RawAttentionSignals = {
      sampledAt: performance.now(), facePresent: true, landmarkCount: 478,
      faceBounds: { x: 0.3, y: 0.15, width: 0.4, height: 0.7 },
      yawDeg: 0, pitchDeg: 0, rollDeg: 0, gazeX: 0, gazeY: 0,
      faceWidth: 0.4, brightness: 0.6, eyeBlinkLeft: 0, eyeBlinkRight: 0,
    };
    worker.onmessage?.({ data: { type: "signals", frameId: frame.frameId, signals } } as MessageEvent<AttentionWorkerResponse>);

    await vi.advanceTimersByTimeAsync(8_500);
    expect(controller.getState()).toMatchObject({ status: "error" });
    expect(controller.getState().error).toContain("Camera samples stopped updating");
    expect(worker.terminated).toBe(true);
    expect(mocks.track.stop).toHaveBeenCalled();
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
