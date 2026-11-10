import type { AttentionWorkerRequest, AttentionWorkerResponse } from "./types";
import { extractRawSignals } from "./signals";

type WorkerScope = {
  onmessage: ((event: MessageEvent<AttentionWorkerRequest>) => void) | null;
  postMessage: (message: AttentionWorkerResponse) => void;
  fetch: typeof fetch;
  location: Location;
  close: () => void;
};

type Landmarker = {
  detectForVideo: (frame: ImageBitmap, timestamp: number) => import("@mediapipe/tasks-vision").FaceLandmarkerResult;
  close: () => void;
};

const scope = globalThis as unknown as WorkerScope;
let landmarker: Landmarker | null = null;
let brightnessCanvas: OffscreenCanvas | null = null;
let lastTimestamp = 0;

/** The SDK queues performance telemetry to Google; keep all worker fetches same-origin. */
function blockExternalWorkerFetches() {
  const nativeFetch = scope.fetch.bind(scope);
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    let requestUrl: URL;
    try {
      requestUrl = new URL(rawUrl, scope.location.href);
    } catch {
      return Promise.reject(new TypeError("Attention Guard blocked an invalid worker request."));
    }
    if (requestUrl.origin !== scope.location.origin) {
      return Promise.reject(new TypeError("Attention Guard blocks external worker requests."));
    }
    return nativeFetch(input, init);
  };
}

function estimateBrightness(bitmap: ImageBitmap): number | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    brightnessCanvas ??= new OffscreenCanvas(48, 27);
    const context = brightnessCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, brightnessCanvas.width, brightnessCanvas.height);
    const { data } = context.getImageData(0, 0, brightnessCanvas.width, brightnessCanvas.height);
    let sum = 0;
    let count = 0;
    // Every fourth pixel is sufficient for a coarse lighting diagnostic.
    for (let i = 0; i < data.length; i += 16) {
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      count += 1;
    }
    return count ? sum / count : null;
  } catch {
    return null;
  }
}

async function initialize(message: Extract<AttentionWorkerRequest, { type: "init" }>) {
  blockExternalWorkerFetches();
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks(message.wasmBaseUrl, true);
  landmarker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: message.modelUrl,
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  scope.postMessage({ type: "ready" });
}

function handleFrame(message: Extract<AttentionWorkerRequest, { type: "frame" }>) {
  try {
    if (!landmarker) throw new Error("The face model is not ready yet.");
    const timestamp = Math.max(Math.round(message.timestamp), lastTimestamp + 1);
    lastTimestamp = timestamp;
    const brightness = estimateBrightness(message.bitmap);
    const result = landmarker.detectForVideo(message.bitmap, timestamp);
    scope.postMessage({
      type: "signals",
      frameId: message.frameId,
      signals: extractRawSignals(result, brightness, timestamp),
    });
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Face inference failed.",
    });
  } finally {
    message.bitmap.close();
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "dispose") {
    landmarker?.close();
    landmarker = null;
    scope.close();
    return;
  }
  if (message.type === "frame") {
    handleFrame(message);
    return;
  }

  void initialize(message).catch((error: unknown) => {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Could not initialize the local face model.",
    });
  });
};
