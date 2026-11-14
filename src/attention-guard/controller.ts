import { createClassifierMemory, updateAttentionClassifier, type ClassifierMemory } from "./classifier";
import { createScreenBreakMemory, updateScreenBreakReminder, type ScreenBreakMemory } from "./breakReminder";
import { isCameraSelectionConfirmedMissing } from "./deviceSelection";
import { ATTENTION_SAMPLE_STALE_MS, isAttentionSampleStale } from "./freshness";
import { canEmitFocusIntervention } from "./lifecycle";
import type { AttentionProfile } from "./profile";
import type { AttentionClassification, AttentionIntervention, AttentionWorkerResponse, CameraDevice, GuardRunPurpose, GuardRuntimeState, RawAttentionSignals } from "./types";

const FIRST_SAMPLE_TIMEOUT_MS = 20_000;
const CAMERA_PERMISSION_TIMEOUT_MS = 30_000;
const FRAME_RESPONSE_TIMEOUT_MS = 8_000;
const SAMPLE_STALL_TIMEOUT_MS = 8_000;
const MAX_CAPTURE_FAILURES = 4;

const OFF_STATE: GuardRuntimeState = {
  status: "off",
  error: "",
  devices: [],
  devicesReady: false,
  selectedDeviceId: "",
  activeDeviceId: "",
  runPurpose: null,
  startupStage: null,
};

function isEmbeddedDocument() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function isCameraConstraintError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  return name === "OverconstrainedError" || name === "NotFoundError" || name === "DevicesNotFoundError";
}

function cameraErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) return error instanceof Error ? error.message : "Camera could not be started.";
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    const embeddedHint = isEmbeddedDocument() ? " This app is embedded; open its Vercel URL directly or allow camera access in the parent page too." : "";
    return `Camera permission was denied or blocked by browser/site settings. Allow camera for this site using the address-bar permission icon, then retry.${embeddedHint}`;
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "No camera was found. Connect a camera and try again.";
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return "The camera is busy in another app or could not be read. Close other camera apps and try again.";
  }
  if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") {
    return "That camera does not support the requested video size. Choose another camera.";
  }
  if (error.name === "SecurityError") {
    return "Camera access requires a secure page (HTTPS or localhost).";
  }
  return error.message || "Camera could not be started.";
}

function createWorker() {
  const workerUrl = import.meta.env.DEV
    ? new URL("/src/attention-guard/worker.ts", window.location.href)
    : new URL("attention-guard/worker.js", new URL(import.meta.env.BASE_URL, document.baseURI));
  return new Worker(workerUrl, {
    type: "module",
    name: "Attention Guard local inference",
  });
}

function assetUrl(path: string) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, document.baseURI).href;
}

const CAMERA_DEPLOYMENT_FILES = [
  "attention-guard/worker.js",
  "attention-guard/face_landmarker.task",
  "attention-guard/wasm/vision_wasm_module_internal.js",
  "attention-guard/wasm/vision_wasm_module_internal.wasm",
] as const;

async function verifyCameraDeploymentFiles() {
  const deploymentHint = 'Vercel must run "npm run build" and publish "dist".';
  await Promise.all(CAMERA_DEPLOYMENT_FILES.map(async (path) => {
    let response: Response;
    try {
      response = await fetch(assetUrl(path), { method: "HEAD", cache: "no-store" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Network request failed.";
      throw new Error(`Could not verify camera file "${path}". Check network access and deployment settings. ${deploymentHint} (${detail})`);
    }
    if (!response.ok) {
      throw new Error(`Camera file "${path}" returned HTTP ${response.status}. ${deploymentHint}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || (path.endsWith(".js") && !/javascript|ecmascript/.test(contentType))) {
      throw new Error(`Camera file "${path}" is being served with an invalid content type (${contentType || "missing"}). ${deploymentHint}`);
    }
  }));
}

export class AttentionGuardController {
  private runtime: GuardRuntimeState = OFF_STATE;
  private signals: RawAttentionSignals | null = null;
  private profile: AttentionProfile | null = null;
  private profileKey = "";
  private classifierMemory: ClassifierMemory = createClassifierMemory();
  private classification: AttentionClassification = { phase: "waiting", reason: "waiting-for-signals", score: null, warningLevel: 0, updatedAt: 0 };
  private stateListeners = new Set<() => void>();
  private signalListeners = new Set<() => void>();
  private classificationListeners = new Set<() => void>();
  private interventionListeners = new Set<(intervention: AttentionIntervention) => void>();
  private previewElements = new Set<HTMLVideoElement>();
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private worker: Worker | null = null;
  private captureTimer: number | null = null;
  private initTimer: number | null = null;
  private firstSampleTimer: number | null = null;
  private frameResponseTimer: number | null = null;
  private permissionTimer: number | null = null;
  private consecutiveCaptureFailures = 0;
  private lastSampleReceivedAt: number | null = null;
  private screenBreakReminderMinutes = 0;
  private screenBreakMemory: ScreenBreakMemory = createScreenBreakMemory();
  private generation = 0;
  private deviceRefreshGeneration = 0;
  private nextFrameId = 1;
  private pendingFrameId: number | null = null;
  private lastVideoTime = -1;
  private mounted = false;
  private focusTimerActive = false;

  readonly getState = () => this.runtime;
  readonly getSignals = () => this.signals;
  readonly getClassification = () => this.classification;

  readonly subscribeClassification = (listener: () => void) => {
    this.classificationListeners.add(listener);
    return () => { this.classificationListeners.delete(listener); };
  };

  readonly subscribeInterventions = (listener: (intervention: AttentionIntervention) => void) => {
    this.interventionListeners.add(listener);
    return () => { this.interventionListeners.delete(listener); };
  };

  readonly subscribeState = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  };

  readonly subscribeSignals = (listener: () => void) => {
    this.signalListeners.add(listener);
    return () => { this.signalListeners.delete(listener); };
  };

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
  }

  dispose() {
    this.mounted = false;
    this.focusTimerActive = false;
    this.deviceRefreshGeneration += 1;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.stop();
    this.previewElements.clear();
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const request = ++this.deviceRefreshGeneration;
    try {
      const inputs = await navigator.mediaDevices.enumerateDevices();
      if (request !== this.deviceRefreshGeneration) return;
      const cameras: CameraDevice[] = inputs
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      const selectedDeviceMissing = isCameraSelectionConfirmedMissing(this.runtime.selectedDeviceId, cameras, true);
      this.updateState({
        devices: cameras,
        devicesReady: true,
        selectedDeviceId: selectedDeviceMissing ? "" : this.runtime.selectedDeviceId,
      });
    } catch {
      // Device enumeration is best-effort; the browser may hide devices until permission is granted.
    }
  }

  selectDevice(deviceId: string) {
    this.updateState({ selectedDeviceId: deviceId });
  }

  setFocusTimerActive(active: boolean) {
    this.focusTimerActive = active;
    if (!active && this.runtime.runPurpose === "focus") this.stop();
  }

  setScreenBreakReminderMinutes(minutes: number) {
    const next = [0, 25, 45, 60].includes(minutes) ? minutes : 0;
    if (next === this.screenBreakReminderMinutes) return;
    this.screenBreakReminderMinutes = next;
    this.screenBreakMemory = createScreenBreakMemory();
    this.updateClassification(this.signals);
  }

  setProfile(profile: AttentionProfile) {
    const key = JSON.stringify(profile);
    if (this.profileKey === key) return;
    this.profileKey = key;
    this.profile = profile;
    this.classifierMemory = createClassifierMemory();
    this.screenBreakMemory = createScreenBreakMemory();
    this.updateClassification(this.signals);
  }

  attachPreview(element: HTMLVideoElement | null) {
    if (!element) return () => undefined;
    this.previewElements.add(element);
    element.muted = true;
    element.playsInline = true;
    if (this.stream) {
      element.srcObject = this.stream;
      void element.play().catch(() => undefined);
    }
    return () => {
      this.previewElements.delete(element);
      if (element.srcObject === this.stream) element.srcObject = null;
    };
  }

  async start(deviceId = this.runtime.selectedDeviceId) {
    if (!this.focusTimerActive) return;
    if (!this.profile?.baseline || this.profile.calibratedAt == null) {
      this.generation += 1;
      this.stopResources();
      this.setSignals(null);
      this.updateState({
        status: "error",
        error: "Calibrate the active Attention Guard profile before starting Focus tracking.",
        activeDeviceId: "",
        runPurpose: null,
        startupStage: null,
      });
      return;
    }
    await this.startWithPurpose(deviceId, "focus");
  }

  async startCalibration(deviceId = this.runtime.selectedDeviceId) {
    await this.startWithPurpose(deviceId, "calibration");
  }

  async startDiagnostic(deviceId = this.runtime.selectedDeviceId) {
    await this.startWithPurpose(deviceId, "diagnostic");
  }

  private async startWithPurpose(deviceId: string, runPurpose: GuardRunPurpose) {
    if (runPurpose === "focus" && !this.focusTimerActive) return;
    const run = ++this.generation;
    this.stopResources();
    this.classifierMemory = createClassifierMemory();
    this.setSignals(null);
    this.updateState({
      status: "starting",
      error: "",
      selectedDeviceId: deviceId,
      activeDeviceId: "",
      runPurpose,
      startupStage: "requesting-permission",
    });

    if (!window.isSecureContext) {
      this.fail(run, new Error("Camera access requires a secure page (HTTPS or localhost)."));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = isEmbeddedDocument()
        ? "Camera access is unavailable in this embedded page. Open the Vercel URL directly, or allow camera access for the iframe in its parent page."
        : "This browser does not expose camera access. Open the HTTPS Vercel URL in a current browser and check its site permissions.";
      this.fail(run, new Error(message));
      return;
    }

    try {
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 640, max: 1280 },
        height: { ideal: 480, max: 720 },
        frameRate: { ideal: 12, max: 20 },
      };
      if (deviceId) videoConstraints.deviceId = { exact: deviceId };
      else videoConstraints.facingMode = "user";
      // Invoke getUserMedia immediately in the click stack so browsers can show
      // their permission UI before any deployment or model checks run.
      const permissionRequest = navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      this.permissionTimer = window.setTimeout(() => {
        this.fail(run, new Error("Camera permission is still pending. If no browser prompt appeared, allow camera for this site in the address-bar permission settings, then retry. Embedded pages also need the parent page to allow camera access."));
      }, CAMERA_PERMISSION_TIMEOUT_MS);
      let stream: MediaStream;
      try {
        stream = await permissionRequest;
      } catch (error) {
        // Device IDs are origin-specific and can go stale when moving between
        // Vercel preview/production URLs. Retry the user's default camera when
        // an exact ID or strict constraint prevents the browser from prompting.
        const canRetryDefault = isCameraConstraintError(error) && (Boolean(deviceId) || (error instanceof Error && error.name === "OverconstrainedError"));
        if (!canRetryDefault || run !== this.generation) throw error;
        this.updateState({ startupStage: "retrying-default-camera" });
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
      }
      if (this.permissionTimer != null) window.clearTimeout(this.permissionTimer);
      this.permissionTimer = null;
      if (run !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => this.fail(run, new Error("The camera stopped. Check the connection or choose another camera."));
      this.video = document.createElement("video");
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;
      this.video.srcObject = stream;
      const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId;
      this.updateState({
        activeDeviceId,
        selectedDeviceId: activeDeviceId || deviceId,
        startupStage: "starting-camera",
      });
      this.syncPreviewElements();
      await this.video.play();
      if (run !== this.generation) return;

      this.updateState({ startupStage: "checking-deployment" });
      await verifyCameraDeploymentFiles();
      if (run !== this.generation) return;
      this.updateState({ startupStage: "loading-model" });

      const worker = createWorker();
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<AttentionWorkerResponse>) => this.onWorkerMessage(run, event.data);
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        this.fail(run, new Error(event.message || "The local inference worker stopped unexpectedly."));
      };
      worker.postMessage({
        type: "init",
        modelUrl: assetUrl("attention-guard/face_landmarker.task"),
        wasmBaseUrl: assetUrl("attention-guard/wasm").replace(/\/$/, ""),
      });
      this.initTimer = window.setTimeout(() => {
        this.fail(run, new Error("The local face model took too long to load. Check that the app is fully downloaded and refresh."));
      }, 45_000);
    } catch (error) {
      this.fail(run, new Error(cameraErrorMessage(error)));
    }
  }

  stop() {
    this.generation += 1;
    this.stopResources();
    this.setSignals(null);
    this.updateState({ status: "off", error: "", activeDeviceId: "", runPurpose: null, startupStage: null });
  }

  private readonly onVisibilityChange = () => {
    if (document.hidden && (this.runtime.status === "on" || this.runtime.status === "starting")) {
      this.generation += 1;
      this.stopResources();
      this.setSignals(null);
      this.updateState({ status: "paused", error: "Tracking paused because this tab went into the background. Turn it on again when you return.", activeDeviceId: "", startupStage: null });
    }
  };

  private readonly onDeviceChange = () => {
    void this.refreshDevices();
    const active = this.runtime.activeDeviceId;
    if (!active || !this.stream) return;
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (this.stream && !devices.some((device) => device.kind === "videoinput" && device.deviceId === active)) {
        this.fail(this.generation, new Error("The active camera was disconnected. Choose another camera and turn tracking on again."));
      }
    }).catch(() => undefined);
  };

  private onWorkerMessage(run: number, message: AttentionWorkerResponse) {
    if (run !== this.generation) return;
    if (message.type === "ready") {
      if (this.initTimer != null) window.clearTimeout(this.initTimer);
      this.initTimer = null;
      this.firstSampleTimer = window.setTimeout(() => {
        if (run === this.generation && this.signals == null) {
          this.fail(run, new Error("The camera and local model started, but no video samples arrived. Check that the selected camera is producing a live picture, then retry."));
        }
      }, FIRST_SAMPLE_TIMEOUT_MS);
      this.updateState({ status: "on", error: "", startupStage: null });
      this.scheduleCapture(run);
      return;
    }
    if (message.type === "signals") {
      if (this.pendingFrameId !== message.frameId) return;
      if (this.frameResponseTimer != null) window.clearTimeout(this.frameResponseTimer);
      if (this.firstSampleTimer != null) window.clearTimeout(this.firstSampleTimer);
      this.frameResponseTimer = null;
      this.firstSampleTimer = null;
      this.pendingFrameId = null;
      this.consecutiveCaptureFailures = 0;
      this.lastSampleReceivedAt = performance.now();
      this.setSignals(message.signals);
      return;
    }
    this.fail(run, new Error(message.message));
  }

  private scheduleCapture(run: number) {
    if (run !== this.generation || this.runtime.status !== "on") return;
    this.captureTimer = window.setTimeout(() => void this.captureFrame(run), 220);
  }

  private async captureFrame(run: number) {
    const video = this.video;
    const worker = this.worker;
    if (run !== this.generation || !video || !worker || this.runtime.status !== "on") return;
    const now = performance.now();
    if (this.lastSampleReceivedAt != null && now - this.lastSampleReceivedAt > SAMPLE_STALL_TIMEOUT_MS) {
      this.fail(run, new Error("Camera samples stopped updating. Check the camera feed and turn tracking on again when it is live."));
      return;
    }
    if (this.signals && isAttentionSampleStale(this.signals.sampledAt, now, ATTENTION_SAMPLE_STALE_MS)) {
      this.setSignals(null);
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && !video.paused && this.pendingFrameId == null && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(video);
      } catch {
        this.registerCaptureFailure(run, "The browser could not read a fresh camera frame for local tracking. Check camera access and retry.");
        this.scheduleCapture(run);
        return;
      }
      if (run !== this.generation || !this.worker) {
        bitmap.close();
        return;
      }
      const frameId = this.nextFrameId++;
      this.pendingFrameId = frameId;
      try {
        worker.postMessage({ type: "frame", frameId, bitmap, timestamp: performance.now() }, [bitmap]);
        this.frameResponseTimer = window.setTimeout(() => {
          if (run === this.generation && this.pendingFrameId === frameId) {
            this.fail(run, new Error("The local face model stopped responding to camera frames. Turn tracking off, check the browser and camera, then retry."));
          }
        }, FRAME_RESPONSE_TIMEOUT_MS);
      } catch {
        bitmap.close();
        this.pendingFrameId = null;
        this.registerCaptureFailure(run, "The browser could not transfer a camera frame to the local model. This browser may not support the required camera-worker features.");
      }
    }
    this.scheduleCapture(run);
  }

  private registerCaptureFailure(run: number, message: string) {
    this.consecutiveCaptureFailures += 1;
    if (this.consecutiveCaptureFailures >= MAX_CAPTURE_FAILURES) this.fail(run, new Error(message));
  }

  private fail(run: number, error: unknown) {
    if (run !== this.generation) return;
    const message = cameraErrorMessage(error);
    this.generation += 1;
    this.stopResources();
    this.setSignals(null);
    this.updateState({ status: "error", error: message, activeDeviceId: "", runPurpose: null, startupStage: null });
  }

  private stopResources() {
    if (this.captureTimer != null) window.clearTimeout(this.captureTimer);
    if (this.permissionTimer != null) window.clearTimeout(this.permissionTimer);
    if (this.initTimer != null) window.clearTimeout(this.initTimer);
    if (this.firstSampleTimer != null) window.clearTimeout(this.firstSampleTimer);
    if (this.frameResponseTimer != null) window.clearTimeout(this.frameResponseTimer);
    this.captureTimer = null;
    this.permissionTimer = null;
    this.initTimer = null;
    this.firstSampleTimer = null;
    this.frameResponseTimer = null;
    this.consecutiveCaptureFailures = 0;
    this.lastSampleReceivedAt = null;
    this.screenBreakMemory = createScreenBreakMemory();
    this.pendingFrameId = null;
    this.lastVideoTime = -1;

    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.postMessage({ type: "dispose" });
      } catch {
        // The worker may already be shutting down.
      }
      worker.terminate();
    }

    const stream = this.stream;
    this.stream = null;
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    for (const preview of this.previewElements) preview.srcObject = null;
  }

  private syncPreviewElements() {
    if (!this.stream) return;
    for (const preview of this.previewElements) {
      preview.srcObject = this.stream;
      void preview.play().catch(() => undefined);
    }
  }

  private setSignals(signals: RawAttentionSignals | null) {
    this.signals = signals;
    this.signalListeners.forEach((listener) => listener());
    this.updateClassification(signals);
  }

  private updateClassification(signals: RawAttentionSignals | null) {
    if (!this.profile) return;
    const now = signals?.sampledAt ?? performance.now();
    const update = updateAttentionClassifier(this.classifierMemory, signals, this.profile, now);
    this.classifierMemory = update.memory;
    this.classification = update.classification;
    this.classificationListeners.forEach((listener) => listener());

    const eligible = canEmitFocusIntervention(this.focusTimerActive, this.runtime.status, this.runtime.runPurpose);
    if (update.intervention && eligible) this.interventionListeners.forEach((listener) => listener(update.intervention!));

    const breakReminder = updateScreenBreakReminder(this.screenBreakMemory, {
      mode: this.profile.mode,
      reminderMinutes: this.screenBreakReminderMinutes,
      phase: update.classification.phase,
      eligible,
      fresh: signals != null && !isAttentionSampleStale(signals.sampledAt, performance.now(), ATTENTION_SAMPLE_STALE_MS),
      sampledAt: now,
    });
    this.screenBreakMemory = breakReminder.memory;
    if (breakReminder.shouldRemind) {
      const intervention: AttentionIntervention = {
        level: 1,
        score: update.classification.score ?? 0,
        reason: "screen-break",
        triggeredAt: now,
      };
      this.interventionListeners.forEach((listener) => listener(intervention));
    }
  }

  private updateState(patch: Partial<GuardRuntimeState>) {
    this.runtime = { ...this.runtime, ...patch };
    this.stateListeners.forEach((listener) => listener());
  }
}
