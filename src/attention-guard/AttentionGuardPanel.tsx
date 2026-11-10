import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";
import type { RawAttentionSignals } from "./types";

function number(value: number | null, digits = 2) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function degrees(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}°`;
}

function SignalValue({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="attention-signal">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function SignalReadout({ signals }: { signals: RawAttentionSignals | null }) {
  const faceLabel = signals?.facePresent ? "Face found" : signals ? "No face" : "Waiting";
  return (
    <div className="attention-signal-grid">
      <SignalValue label="Face" value={faceLabel} detail={signals ? `${signals.landmarkCount} points` : "Start tracking to sample"} />
      <SignalValue label="Head yaw" value={degrees(signals?.yawDeg ?? null)} />
      <SignalValue label="Head pitch" value={degrees(signals?.pitchDeg ?? null)} />
      <SignalValue label="Head roll" value={degrees(signals?.rollDeg ?? null)} />
      <SignalValue label="Gaze X" value={number(signals?.gazeX ?? null)} detail="coarse eye-box estimate" />
      <SignalValue label="Gaze Y" value={number(signals?.gazeY ?? null)} detail="coarse eye-box estimate" />
      <SignalValue label="Face width" value={number(signals?.faceWidth ?? null)} detail="fraction of frame" />
      <SignalValue label="Brightness" value={signals?.brightness == null ? "—" : `${Math.round(signals.brightness * 100)}%`} detail="frame luminance" />
      <SignalValue label="Blink L / R" value={`${number(signals?.eyeBlinkLeft ?? null)} / ${number(signals?.eyeBlinkRight ?? null)}`} />
    </div>
  );
}

export function AttentionCameraIndicator({
  controller,
  onOpen,
}: {
  controller: AttentionGuardController;
  onOpen: () => void;
}) {
  const state = useSyncExternalStore(controller.subscribeState, controller.getState, controller.getState);
  if (state.status === "off") return null;
  const active = state.status === "on" || state.status === "starting";
  return (
    <div className={`attention-live-indicator ${active ? "is-active" : "is-paused"}`} role="status">
      <span className="attention-live-dot" aria-hidden="true" />
      <span>{state.status === "on" ? "Camera on" : state.status === "starting" ? "Starting camera" : "Camera paused"}</span>
      <button type="button" onClick={onOpen} aria-label="Open Attention Guard panel">Details</button>
      {active && <button type="button" onClick={() => controller.stop()} aria-label="Turn off Attention Guard">Stop</button>}
    </div>
  );
}

export default function AttentionGuardPanel({ controller }: { controller: AttentionGuardController }) {
  const state = useSyncExternalStore(controller.subscribeState, controller.getState, controller.getState);
  const signals = useSyncExternalStore(controller.subscribeSignals, controller.getSignals, controller.getSignals);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const isActive = state.status === "on" || state.status === "starting";
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

  const bindPreview = useCallback((node: HTMLVideoElement | null) => {
    previewRef.current = node;
  }, []);

  useEffect(() => {
    void controller.refreshDevices();
  }, [controller, state.status]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    return controller.attachPreview(preview);
  }, [controller, state.status]);

  return (
    <div className="attention-panel">
      <section className="attention-intro">
        <div className="attention-kicker">Optional · local processing</div>
        <h2>Attention Guard</h2>
        <p>Use a webcam to notice when your face and gaze drift away from your calibrated work area. It is off until you turn tracking on.</p>
      </section>

      <section className={`attention-control-card ${isActive ? "is-active" : ""}`} aria-label="Camera tracking controls">
        <div className="attention-control-copy">
          <strong>{state.status === "on" ? "Tracking is on" : state.status === "starting" ? "Starting local tracking…" : state.status === "paused" ? "Tracking paused" : state.status === "error" ? "Tracking stopped" : "Tracking is off"}</strong>
          <span>{state.status === "on" ? "Camera frames are being analyzed on this device." : state.status === "paused" ? "The camera and inference worker were stopped when the tab went into the background." : state.status === "error" ? state.error : "No camera is active. Your timer works normally while this is off."}</span>
        </div>
        <button
          type="button"
          className={`attention-toggle ${isActive ? "is-on" : ""}`}
          role="switch"
          aria-checked={isActive}
          onClick={() => isActive ? controller.stop() : void controller.start()}
        >
          <span className="attention-toggle-track" aria-hidden="true"><i /></span>
          <span>{isActive ? "Turn off tracking" : state.status === "paused" ? "Turn tracking back on" : "Turn on tracking"}</span>
        </button>
      </section>

      <div className="attention-camera-row">
        <label className="field attention-device-field">
          <span>Camera device</span>
          <select
            value={state.selectedDeviceId}
            onChange={(event) => controller.selectDevice(event.target.value)}
            disabled={isActive || state.devices.length === 0}
          >
            <option value="">Default camera</option>
            {state.devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>{device.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="attention-secondary-button" onClick={() => void controller.refreshDevices()}>
          Refresh cameras
        </button>
      </div>
      {!supported && <p className="attention-error" role="alert">Camera access is not available in this browser. Try a current browser on HTTPS or localhost.</p>}
      {state.status === "error" && <p className="attention-error" role="alert">{state.error}</p>}

      <div className="attention-preview-wrap">
        {isActive ? (
          <video ref={bindPreview} className="attention-preview" autoPlay muted playsInline aria-label="Local mirrored camera preview" />
        ) : (
          <div className="attention-preview-placeholder">
            <span aria-hidden="true">◉</span>
            <p>Camera preview appears here while tracking is on.</p>
          </div>
        )}
      </div>

      <section className="attention-debug" aria-labelledby="attention-debug-title">
        <div className="attention-section-heading">
          <div>
            <h3 id="attention-debug-title">Live signal diagnostics</h3>
            <p>Only numeric estimates are shown here; the model does not provide a calibrated gaze-confidence score.</p>
          </div>
          <span className={`attention-sample-state ${signals?.facePresent ? "has-face" : ""}`}>{signals?.facePresent ? "FACE FOUND" : isActive ? "SEARCHING" : "OFF"}</span>
        </div>
        <SignalReadout signals={signals} />
      </section>

      <details className="attention-privacy">
        <summary>Camera and privacy details</summary>
        <ul>
          <li>Nothing starts until you select <strong>Turn on tracking</strong> and grant camera permission.</li>
          <li>Video frames and landmarks are processed in a local worker. They are not uploaded or saved.</li>
          <li>Tracking uses the camera only (no microphone). Turning it off stops every camera track and terminates the worker.</li>
          <li>The face model and WebAssembly files are served from this app. External worker requests, including SDK performance telemetry, are blocked.</li>
          <li>When this tab goes into the background, tracking is stopped; turn it back on when you return.</li>
        </ul>
      </details>
    </div>
  );
}
