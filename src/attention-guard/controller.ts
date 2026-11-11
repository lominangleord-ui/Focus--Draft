import { createClassifierMemory, updateAttentionClassifier, type ClassifierMemory } from "./classifier";
import { isCameraSelectionConfirmedMissing } from "./deviceSelection";
import { ATTENTION_SAMPLE_STALE_MS, isAttentionSampleStale } from "./freshness";
import { canEmitFocusIntervention } from "./lifecycle";
import type { AttentionProfile } from "./profile";
import type { AttentionClassification, AttentionIntervention, AttentionWorkerResponse, CameraDevice, GuardRunPurpose, GuardRuntimeState, RawAttentionSignals } from "./types";

const OFF_STATE: GuardRuntimeState = {
  status: "off",
  error: "",
  devices: [],
  devicesReady: false,
  selectedDeviceId: "",
  activeDeviceId: "",
  runPurpose: null,
};

function cameraErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) return error instanceof Error ? error.message : "Camera could not be started.";
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow camera access in your browser, then try again.";
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

  setProfile(profile: AttentionProfile) {
    const key = JSON.stringify(profile);
    if (this.profileKey === key) return;
    this.profileKey = key;
    this.profile = profile;
    this.classifierMemory = createClassifierMemory();
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
    this.updateState({ status: "starting", error: "", selectedDeviceId: deviceId, activeDeviceId: "", runPurpose });

    if (!window.isSecureContext) {
      this.fail(run, new Error("Camera access requires a secure page (HTTPS or localhost)."));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail(run, new Error("This browser does not support camera access."));
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
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
      this.updateState({ activeDeviceId, selectedDeviceId: activeDeviceId || deviceId });
      this.syncPreviewElements();
      await this.video.play();
      if (run !== this.generation) return;

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
    this.updateState({ status: "off", error: "", activeDeviceId: "", runPurpose: null });
  }

  private readonly onVisibilityChange = () => {
    if (document.hidden && (this.runtime.status === "on" || this.runtime.status === "starting")) {
      this.generation += 1;
      this.stopResources();
      this.setSignals(null);
      this.updateState({ status: "paused", error: "Tracking paused because this tab went into the background. Turn it on again when you return.", activeDeviceId: "" });
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
      this.updateState({ status: "on", error: "" });
      this.scheduleCapture(run);
      return;
    }
    if (message.type === "signals") {
      if (this.pendingFrameId === message.frameId) this.pendingFrameId = null;
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
    if (this.signals && isAttentionSampleStale(this.signals.sampledAt, performance.now(), ATTENTION_SAMPLE_STALE_MS)) {
      this.setSignals(null);
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && !video.paused && this.pendingFrameId == null && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(video);
      } catch {
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
      } catch {
        bitmap.close();
        this.pendingFrameId = null;
      }
    }
    this.scheduleCapture(run);
  }

  private fail(run: number, error: unknown) {
    if (run !== this.generation) return;
    const message = cameraErrorMessage(error);
    this.generation += 1;
    this.stopResources();
    this.setSignals(null);
    this.updateState({ status: "error", error: message, activeDeviceId: "", runPurpose: null });
  }

  private stopResources() {
    if (this.captureTimer != null) window.clearTimeout(this.captureTimer);
    if (this.initTimer != null) window.clearTimeout(this.initTimer);
    this.captureTimer = null;
    this.initTimer = null;
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
    const update = updateAttentionClassifier(this.classifierMemory, signals, this.profile, signals?.sampledAt ?? performance.now());
    this.classifierMemory = update.memory;
    this.classification = update.classification;
    this.classificationListeners.forEach((listener) => listener());
    if (update.intervention && canEmitFocusIntervention(this.focusTimerActive, this.runtime.status, this.runtime.runPurpose)) {
      this.interventionListeners.forEach((listener) => listener(update.intervention!));
    }
  }

  private updateState(patch: Partial<GuardRuntimeState>) {
    this.runtime = { ...this.runtime, ...patch };
    this.stateListeners.forEach((listener) => listener());
  }
}
