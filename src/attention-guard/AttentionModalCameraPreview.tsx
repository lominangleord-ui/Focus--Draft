import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";

export default function AttentionModalCameraPreview({ controller }: { controller: AttentionGuardController }) {
  const state = useSyncExternalStore(controller.subscribeState, controller.getState, controller.getState);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const active = state.status === "on" || state.status === "starting";

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    return controller.attachPreview(preview);
  }, [controller, state.status]);

  const statusLabel = state.status === "starting"
    ? state.startupStage === "requesting-permission" ? "Waiting for camera permission"
      : state.startupStage === "starting-camera" ? "Opening camera stream"
        : "Starting local camera analysis"
    : state.status === "on" ? "Temporary camera is on"
      : state.status === "error" ? "Camera setup failed" : "Camera is off";

  return (
    <section className="attention-modal-camera" aria-label="Temporary camera preview">
      <div className={`attention-preview-wrap is-${state.status}`}>
        {active ? (
          <video ref={previewRef} className="attention-preview" autoPlay muted playsInline aria-label="Local camera preview" />
        ) : (
          <div className={`attention-preview-placeholder ${state.status === "error" ? "has-error" : ""}`}>
            <span aria-hidden="true">{state.status === "error" ? "!" : "◉"}</span>
            <strong>{statusLabel}</strong>
            <p>{state.status === "error" ? state.error : "Start the temporary camera in this window to see the local preview."}</p>
          </div>
        )}
        {active && (
          <div className={`attention-preview-status ${state.status === "starting" ? "is-pending" : ""}`} role="status">
            <i className={`attention-camera-led ${state.status === "starting" ? "is-pending" : ""}`} aria-hidden="true" />
            <span>{statusLabel}</span>
          </div>
        )}
      </div>
      <p className="attention-preview-caption">The camera preview stays on this device. Frames and raw samples are not saved.</p>
    </section>
  );
}
