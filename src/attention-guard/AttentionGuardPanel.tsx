import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";
import CalibrationWizard from "./CalibrationWizard";
import AttentionModalCameraPreview from "./AttentionModalCameraPreview";
import AttentionWindow from "./AttentionWindow";
import { isCameraSelectionConfirmedMissing } from "./deviceSelection";
import { mapFaceBoundsToPreview } from "./previewGeometry";
import { canStartFocusTrackingFromView } from "./lifecycle";
import { prepareAttentionWarningAudio, soundSupported } from "../sound";
import TestLab from "./TestLabPanel";
import { createAttentionProfile, parseAttentionProfileFile, serializeAttentionProfile, type AttentionProfile } from "./profile";
import { activeAttentionProfile, addImportedProfile, upsertAttentionProfile, type AttentionStore } from "./storage";
import type { AttentionClassification, RawAttentionSignals } from "./types";

type StoreUpdate = (update: Partial<AttentionStore> | ((previous: AttentionStore) => AttentionStore)) => boolean;
type SettingsPage = "settings" | "calibration" | "test";

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

function SignalReadout({ signals, cameraActive }: { signals: RawAttentionSignals | null; cameraActive: boolean }) {
  const faceLabel = signals?.facePresent ? "Face found" : signals ? "No face" : "Waiting";
  const faceDetail = signals
    ? `${signals.landmarkCount} points`
    : cameraActive ? "Waiting for a fresh local sample" : "Start tracking to sample";
  return (
    <div className="attention-signal-grid">
      <SignalValue label="Face" value={faceLabel} detail={faceDetail} />
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

function AttentionSwitch({ label, checked, help, disabled = false, onChange }: { label: string; checked: boolean; help?: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="attention-setting-row">
      <div><strong>{label}</strong>{help && <small>{help}</small>}</div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`attention-small-switch ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
        <i aria-hidden="true" />
      </button>
    </div>
  );
}

function AttentionNumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field compact attention-number-field">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => {
        const parsed = Number(event.target.value);
        if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
      }} />
    </label>
  );
}

function ClassificationCard({ classification }: { classification: AttentionClassification }) {
  const label: Record<AttentionClassification["phase"], string> = {
    waiting: "Waiting for a sample",
    "needs-calibration": "Calibration needed",
    attentive: "In calibrated zone",
    drifting: "Drifting from zone",
    away: "Outside zone",
    "face-missing": "Face not detected",
    "low-quality": "Signal quality too low",
  };
  const score = classification.score == null ? "—" : classification.score.toFixed(2);
  return (
    <div className={`attention-classification attention-phase-${classification.phase}`}>
      <span className="attention-classification-dot" aria-hidden="true" />
      <div><strong>{label[classification.phase]}</strong><small>{classification.reason.split("-").join(" ")}</small></div>
      <div className="attention-classification-score"><strong>{score}</strong><small>zone score</small></div>
      {classification.warningLevel > 0 && <b className="attention-level-tag">LEVEL {classification.warningLevel}</b>}
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
  const runLabel = state.runPurpose === "diagnostic" ? "Test camera" : state.runPurpose === "calibration" ? "Calibration camera" : "Focus camera";
  const indicatorLabel = state.status === "error"
    ? "Camera error"
    : state.status === "starting"
      ? `Starting ${runLabel.toLowerCase()}`
      : `${runLabel}${state.status === "on" ? " on" : " paused"}`;
  return (
    <div className={`attention-live-indicator ${active ? "is-active" : "is-paused"}`} role="status">
      <span className="attention-live-dot" aria-hidden="true" />
      <span>{indicatorLabel}</span>
      <button type="button" onClick={onOpen} aria-label="Open Attention Guard panel">Details</button>
      {(active || state.status === "paused" || state.status === "error") && <button type="button" onClick={() => controller.stop()} aria-label={active ? "Turn off Attention Guard" : state.status === "paused" ? "Stop paused Attention Guard camera" : "Dismiss Attention Guard error"}>{state.status === "error" ? "Dismiss" : "Stop"}</button>}
    </div>
  );
}

export default function AttentionGuardPanel({
  controller,
  store,
  updateStore,
  focusTimerActive,
  timerMode,
  onStartFocusTimer,
}: {
  controller: AttentionGuardController;
  store: AttentionStore;
  updateStore: StoreUpdate;
  focusTimerActive: boolean;
  timerMode: "focus" | "short" | "long";
  onStartFocusTimer: () => void;
}) {
  const state = useSyncExternalStore(controller.subscribeState, controller.getState, controller.getState);
  const signals = useSyncExternalStore(controller.subscribeSignals, controller.getSignals, controller.getSignals);
  const classification = useSyncExternalStore(controller.subscribeClassification, controller.getClassification, controller.getClassification);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const profileFileRef = useRef<HTMLInputElement | null>(null);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("settings");
  const profile = useMemo(() => activeAttentionProfile(store), [store]);
  const isActive = state.status === "on" || state.status === "starting";
  const isTemporaryRun = state.runPurpose === "calibration" || state.runPurpose === "diagnostic";
  const pausedTemporaryRun = state.status === "paused" && isTemporaryRun;
  const pausedFocusRun = state.status === "paused" && state.runPurpose === "focus";
  const canStartFocusTracking = canStartFocusTrackingFromView("monitor", focusTimerActive);
  const canStartFocusCamera = canStartFocusTracking && profile.calibratedAt != null;
  const controlChecked = isActive;
  const controlDisabled = !isActive && !canStartFocusCamera;
  const showFocusTimerAction = profile.calibratedAt != null && !focusTimerActive && !isActive && !pausedTemporaryRun;
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const warningSoundSupported = soundSupported();
  const profilesForMode = store.profiles.filter((item) => item.mode === store.mode);
  const selectedDeviceId = store.cameraDeviceId;
  const previewVideo = previewRef.current;
  const previewViewport = previewVideo?.parentElement;
  const facePreviewBox = signals?.faceBounds && previewVideo && previewViewport
    ? mapFaceBoundsToPreview(signals.faceBounds, previewVideo.videoWidth, previewVideo.videoHeight, previewViewport.clientWidth, previewViewport.clientHeight)
    : null;
  const cameraHeading = state.status === "on"
    ? state.runPurpose === "diagnostic" ? "Temporary Test Lab camera is on" : state.runPurpose === "calibration" ? "Temporary calibration camera is on" : "Focus tracking is on"
    : state.status === "starting"
      ? state.runPurpose === "diagnostic" ? "Starting temporary Test Lab camera…" : state.runPurpose === "calibration" ? "Starting temporary calibration camera…" : "Starting focus tracking…"
      : state.status === "paused" ? "Camera paused"
        : state.status === "error" ? "Camera setup failed"
          : profile.calibratedAt == null ? "Calibration needed" : "Tracking is off";
  const cameraVisualStatus = state.status === "starting"
    ? state.startupStage === "requesting-permission" ? "Waiting for camera permission"
      : state.startupStage === "retrying-default-camera" ? "Trying the default camera"
        : state.startupStage === "starting-camera" ? "Opening camera stream"
          : state.startupStage === "checking-deployment" ? "Checking camera files"
            : "Loading local face model"
    : state.status === "on"
      ? signals == null ? "Model ready · waiting for first frame" : signals.facePresent ? "Live · face found" : "Live · looking for face"
      : state.status === "paused" ? "Camera paused" : state.status === "error" ? "Camera setup failed" : "Camera off";
  const cameraVisualHint = state.status === "starting"
    ? state.startupStage === "requesting-permission" ? "Approve camera access in your browser if prompted."
      : state.startupStage === "retrying-default-camera" ? "The saved camera setting did not work; asking for the browser's default camera."
        : state.startupStage === "starting-camera" ? "Connecting to the selected camera…"
          : state.startupStage === "checking-deployment" ? "Verifying the worker, model and WebAssembly files on this deployment."
            : "The camera is connected; loading the local face model."
    : state.status === "on"
      ? signals == null ? "The local model is ready and waiting for its first camera frame."
        : signals.facePresent
          ? state.runPurpose === "calibration" ? "Face detected · follow the calibration prompts in its window." : "Face detected · keep your full face inside the guide."
          : "No face detected · move into the dashed guide and improve lighting if needed."
      : state.status === "paused" ? "The camera is off while this tab is in the background. Start it again when you return."
        : state.status === "error" ? state.error
          : profile.calibratedAt == null ? "Open Attention Guard settings with the gear button to calibrate and test this work area."
            : "Start tracking during Focus when you are ready; the camera stays off otherwise.";
  const cameraDescription = (() => {
    if (state.status === "on") {
      if (state.runPurpose === "diagnostic") return "This explicit Test Lab run is temporary and does not trigger focus-session interventions.";
      if (state.runPurpose === "calibration") return "This explicit calibration run is temporary and does not trigger focus-session interventions.";
      if (signals == null) return "Camera and local model are ready; waiting for a fresh sample. Tracking stops automatically if camera samples stall.";
      return `Camera frames are analyzed locally during Focus. In-app off-target reminders are ${store.offTargetAlertsEnabled ? "on" : "off"}.`;
    }
    if (state.status === "starting") {
      if (state.runPurpose === "diagnostic") return "Starting the explicit Test Lab camera run; it will not trigger focus-session interventions.";
      if (state.runPurpose === "calibration") return "Starting the explicit calibration camera run; it will not trigger focus-session interventions.";
      return "Starting local camera analysis for this Focus timer.";
    }
    if (state.status === "paused") return "The camera and inference worker were stopped when the tab went into the background.";
    if (state.status === "error") return "The camera or local analysis stopped. See the message below, then retry when ready.";
    if (profile.calibratedAt == null) return "Open settings to calibrate this work area. Focus tracking remains unavailable until calibration is saved.";
    if (!focusTimerActive) {
      return timerMode === "focus"
        ? "Start or resume Focus to enable tracking. The camera stays off until you turn it on."
        : "You are on a break. Switch to Focus to enable tracking; the camera stays off until you turn it on.";
    }
    return "No camera is active. Turn on Focus tracking when you want to use it.";
  })();
  const toggleLabel = isActive
    ? isTemporaryRun ? "Stop temporary camera" : "Turn off tracking"
    : profile.calibratedAt == null
      ? "Open settings to calibrate"
      : state.status === "error" && canStartFocusTracking
        ? "Retry camera"
        : state.status === "paused" && state.runPurpose === "focus" && canStartFocusTracking
          ? "Turn tracking back on"
          : canStartFocusCamera
            ? "Turn on tracking"
            : "Focus timer required";
  const focusTimerActionLabel = timerMode === "focus" ? "Start or resume Focus timer" : "Switch to Focus and start";

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

  useEffect(() => {
    if (isActive) {
      if (state.activeDeviceId && state.selectedDeviceId !== selectedDeviceId) {
        updateStore({ cameraDeviceId: state.selectedDeviceId });
      }
      return;
    }
    if (isCameraSelectionConfirmedMissing(selectedDeviceId, state.devices, state.devicesReady)) {
      if (state.selectedDeviceId) controller.selectDevice("");
      updateStore({ cameraDeviceId: "" });
      return;
    }
    if (state.selectedDeviceId !== selectedDeviceId) controller.selectDevice(selectedDeviceId);
  }, [controller, isActive, selectedDeviceId, state.activeDeviceId, state.devices, state.devicesReady, state.selectedDeviceId, updateStore]);

  function updateProfile(patch: Partial<AttentionProfile>) {
    updateStore((previous) => upsertAttentionProfile(previous, {
      ...profile,
      ...patch,
      updatedAt: Date.now(),
    }));
  }

  function updateZone(key: keyof AttentionProfile["zone"], value: number) {
    updateProfile({ zone: { ...profile.zone, [key]: value } });
  }

  function updateTuning(key: keyof AttentionProfile["tuning"], value: number) {
    updateProfile({ tuning: { ...profile.tuning, [key]: value } });
  }

  function stopRunBeforeProfileChange() {
    if (!controller.getState().runPurpose) return false;
    controller.stop();
    return true;
  }

  function changeMode(mode: AttentionStore["mode"]) {
    if (mode === store.mode) return;
    const stoppedCamera = stopRunBeforeProfileChange();
    updateStore({ mode });
    setProfileMessage(stoppedCamera ? "Camera stopped because the active work area changed. Review its calibration before restarting." : "");
  }

  function selectProfile(id: string) {
    if (id === profile.id) return;
    const stoppedCamera = stopRunBeforeProfileChange();
    updateStore({ activeProfileIds: { ...store.activeProfileIds, [store.mode]: id } });
    setProfileMessage(stoppedCamera ? "Camera stopped because the active profile changed. Review its calibration before restarting." : "");
  }

  function addProfile() {
    if (store.profiles.length >= 24) {
      setProfileMessage("Profile limit reached. Delete an old profile before adding another.");
      return;
    }
    const stoppedCamera = stopRunBeforeProfileChange();
    const now = Date.now();
    const id = `profile-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const created = createAttentionProfile(store.mode, newProfileName, id, now);
    updateStore((previous) => upsertAttentionProfile(previous, created));
    setNewProfileName("");
    setProfileMessage(stoppedCamera
      ? "Camera stopped. The new profile is active; calibrate it before using Focus tracking."
      : "Profile added. Calibrate it before using Focus tracking.");
  }

  function exportProfile() {
    try {
      const contents = serializeAttentionProfile(profile);
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `focus-draft-${profile.mode}-profile.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setProfileMessage("Profile exported. It contains calibration settings only, not stats or camera data.");
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "Profile could not be exported.");
    }
  }

  async function importProfile(file: File | undefined) {
    if (!file) return;
    if (store.profiles.length >= 24) {
      setProfileMessage("Profile limit reached. Delete an old profile before importing another.");
      return;
    }
    try {
      const imported = parseAttentionProfileFile(await file.text());
      const stoppedCamera = stopRunBeforeProfileChange();
      updateStore((previous) => addImportedProfile(previous, imported));
      setProfileMessage(stoppedCamera
        ? `Imported ${imported.mode.toUpperCase()} profile and stopped the camera. Review its calibration before restarting.`
        : `Imported ${imported.mode.toUpperCase()} profile. It is stored only on this device.`);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "Profile could not be imported.");
    } finally {
      if (profileFileRef.current) profileFileRef.current.value = "";
    }
  }

  function openSettings() {
    setSettingsPage("settings");
    setSettingsOpen(true);
  }

  function openCalibration() {
    if (controller.getState().runPurpose) controller.stop();
    setSettingsPage("calibration");
  }

  function openTestArea() {
    if (controller.getState().runPurpose) controller.stop();
    setSettingsPage("test");
  }

  function backToSettings() {
    const purpose = controller.getState().runPurpose;
    if (purpose === "calibration" || purpose === "diagnostic") controller.stop();
    setSettingsPage("settings");
  }

  function closeSettings() {
    const purpose = controller.getState().runPurpose;
    if (purpose === "calibration" || purpose === "diagnostic") controller.stop();
    setSettingsPage("settings");
    setSettingsOpen(false);
  }

  const settingsTitle = settingsPage === "settings"
    ? "Attention Guard settings"
    : settingsPage === "calibration" ? "Calibrate work area" : "Test Lab";
  const settingsDescription = settingsPage === "settings"
    ? "Choose a work area and profile, then calibrate or test the local webcam estimates."
    : settingsPage === "calibration"
      ? "Capture one minute of normal work or reading, then one minute of intentional off-task looks."
      : "Check how the saved profile responds to live local webcam signals; tests never trigger Focus interventions.";

  return (
    <div className="attention-panel">
      <section className="attention-intro">
        <div className="attention-intro-heading">
          <div>
            <div className="attention-kicker">Optional · local processing</div>
            <h2>Attention Guard</h2>
          </div>
          <button
            type="button"
            className="attention-settings-button"
            onClick={openSettings}
            aria-label="Open Attention Guard settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            title="Attention Guard settings"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z" />
              <path d="m19.4 13.5 1.15.9-1.35 2.34-1.4-.55a7.9 7.9 0 0 1-1.58.92l-.24 1.48h-2.7l-.24-1.48a7.9 7.9 0 0 1-1.58-.92l-1.4.55L6.7 14.4l1.15-.9a7.6 7.6 0 0 1 0-1.8l-1.15-.9 1.35-2.34 1.4.55a7.9 7.9 0 0 1 1.58-.92l.24-1.48h2.7l.24 1.48a7.9 7.9 0 0 1 1.58.92l1.4-.55 1.35 2.34-1.15.9a7.6 7.6 0 0 1 0 1.8Z" />
            </svg>
          </button>
        </div>
        <p>Use a webcam to estimate whether your face and coarse eye-box signals stay near your usual work area. Nothing starts until you explicitly start a camera run.</p>
        <div className="attention-active-profile" role="status">
          <span>{store.mode === "screen" ? "Screen" : "Book"} · {profile.name}</span>
          <strong className={profile.calibratedAt != null ? "is-ready" : "is-needed"}>{profile.calibratedAt != null ? "CALIBRATED" : "NEEDS CALIBRATION"}</strong>
        </div>
      </section>

      <section className={`attention-control-card ${isActive ? "is-active" : ""}`} aria-label="Focus camera tracking controls">
        <div className="attention-control-copy">
          <strong>{cameraHeading}</strong>
          <span>{cameraDescription}</span>
        </div>
        <div className="attention-control-actions">
          <button
            type="button"
            className={`attention-toggle ${isActive ? "is-on" : ""}`}
            role="switch"
            aria-checked={controlChecked}
            disabled={controlDisabled}
            onClick={() => {
              if (isActive) controller.stop();
              else if (canStartFocusCamera) void controller.start(selectedDeviceId);
            }}
          >
            <span className="attention-toggle-track" aria-hidden="true"><i /></span>
            <span>{toggleLabel}</span>
          </button>
          {showFocusTimerAction && <button type="button" className="attention-secondary-button" onClick={onStartFocusTimer}>{focusTimerActionLabel}</button>}
          {pausedFocusRun && <button type="button" className="attention-secondary-button" onClick={() => controller.stop()}>Stop paused camera</button>}
          {pausedTemporaryRun && <button type="button" className="attention-secondary-button" onClick={() => controller.stop()}>Stop paused temporary camera</button>}
        </div>
      </section>

      {isActive && <p className="attention-inline-message">The camera device selector is in Attention Guard settings. Stop this run before changing cameras.</p>}
      {state.status === "error" && <p className="attention-error" role="alert">{state.error}</p>}
      {!supported && state.status !== "error" && <p className="attention-error" role="alert">Camera access is not available in this browser. Try a current browser on HTTPS or localhost.</p>}

      <div className={`attention-preview-wrap is-${state.status}`}>
        {isActive ? (
          <video ref={bindPreview} className="attention-preview" autoPlay muted playsInline aria-label="Local mirrored camera preview" />
        ) : (
          <div className={`attention-preview-placeholder ${state.status === "error" ? "has-error" : ""}`} role={state.status === "error" ? "alert" : undefined}>
            <span aria-hidden="true">{state.status === "error" ? "!" : state.status === "paused" ? "Ⅱ" : "◉"}</span>
            <strong>{cameraVisualStatus}</strong>
            <p>{cameraVisualHint}</p>
          </div>
        )}
        {isActive && (
          <svg className="attention-face-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path className="attention-camera-corner-guides" d="M8 20V8h12 M80 8h12v12 M92 80v12H80 M20 92H8V80" />
            {facePreviewBox ? (
              <rect className="attention-face-outline" x={facePreviewBox.x * 100} y={facePreviewBox.y * 100} width={facePreviewBox.width * 100} height={facePreviewBox.height * 100} rx="3" />
            ) : (
              <g className="attention-face-guide">
                <ellipse cx="50" cy="47" rx="17" ry="27" />
                <path d="M46 45h.1 M54 45h.1 M47 59q3 2 6 0" />
              </g>
            )}
          </svg>
        )}
        {isActive && (
          <>
            <div className={`attention-preview-status ${state.status === "on" && signals?.facePresent ? "has-face" : state.status === "starting" ? "is-pending" : ""}`} role="status">
              <i
                key={signals?.sampledAt ?? `${state.status}:${state.startupStage ?? "ready"}`}
                className={`attention-camera-led ${state.status === "on" && signals ? "is-sampling" : state.status === "starting" ? "is-pending" : ""}`}
                aria-hidden="true"
              />
              <span>{cameraVisualStatus}</span>
            </div>
            <div className="attention-preview-hint" aria-live="polite">{cameraVisualHint}</div>
          </>
        )}
      </div>
      <p className="attention-preview-caption">The outline shows face position, not eye landmarks. Head pose is calibrated to your usual camera angle; iris direction is only a coarse eye-box estimate, not screen-pixel gaze.</p>

      <section className="attention-debug" aria-labelledby="attention-debug-title">
        <div className="attention-section-heading">
          <div>
            <h3 id="attention-debug-title">Live signal diagnostics</h3>
            <p>Numeric estimates only; the model does not provide a calibrated gaze-confidence score.</p>
          </div>
          <span className={`attention-sample-state ${signals?.facePresent ? "has-face" : ""}`}>{signals?.facePresent ? "FACE FOUND" : isActive ? "SEARCHING" : "OFF"}</span>
        </div>
        <ClassificationCard classification={classification} />
        <SignalReadout signals={signals} cameraActive={isActive} />
      </section>

      <details className="attention-privacy">
        <summary>Camera and privacy details</summary>
        <ul>
          <li>Focus monitoring and interventions run only during an active Focus timer. Calibration and Test Lab runs are temporary and never trigger Focus interventions.</li>
          <li>Video frames are analyzed locally. The app does not save or upload camera images, video, or raw calibration samples.</li>
          <li>Tracking uses the camera only, not the microphone. Stopping a run ends every camera track and terminates the worker.</li>
          <li>The webcam estimates direction and face position; it does not identify phones, measure pixel-accurate gaze, or label pupils.</li>
          <li>When this tab goes into the background, the current camera run is stopped; start it again explicitly when you return.</li>
        </ul>
      </details>

      {settingsOpen && (
        <AttentionWindow
          title={settingsTitle}
          description={settingsDescription}
          onClose={closeSettings}
          onBack={settingsPage === "settings" ? undefined : backToSettings}
          wide={settingsPage !== "settings"}
        >
          <div className="attention-dialog-page" hidden={settingsPage !== "settings"}>
            <p className="attention-dialog-intro">Settings apply to this device and the selected work-area profile. Camera data and calibration signals are processed locally.</p>

            {isTemporaryRun && isActive && <p className="attention-inline-message" role="status">A temporary camera run is still active. Reopen its page to stop or continue it, or close this window to stop the camera.</p>}

            <section className="attention-settings" aria-labelledby="attention-mode-title">
              <div className="attention-section-heading">
                <div><h3 id="attention-mode-title">Work area and profile</h3><p>Maintain a separate setup for screen work and book reading.</p></div>
              </div>
              <div className="attention-mode-switch" role="group" aria-label="Attention mode">
                {(["screen", "book"] as const).map((mode) => (
                  <button key={mode} type="button" className={store.mode === mode ? "active" : ""} aria-pressed={store.mode === mode} onClick={() => changeMode(mode)}>
                    {mode === "screen" ? "SCREEN" : "BOOK"}
                  </button>
                ))}
              </div>
              <div className="attention-profile-row">
                <label className="field attention-device-field">
                  <span>Active {store.mode.toUpperCase()} profile</span>
                  <select value={profile.id} onChange={(event) => selectProfile(event.target.value)}>
                    {profilesForMode.map((item) => <option key={item.id} value={item.id}>{item.name}{item.calibratedAt ? " · calibrated" : " · needs calibration"}</option>)}
                  </select>
                </label>
                <div className="attention-profile-state">{profile.calibratedAt ? "CALIBRATED" : "NOT CALIBRATED"}</div>
              </div>
              <div className="attention-profile-create">
                <label className="field"><span>New profile name</span><input value={newProfileName} maxLength={32} onChange={(event) => setNewProfileName(event.target.value.slice(0, 32))} placeholder={store.mode === "screen" ? "Desk monitor" : "Reading chair"} /></label>
                <button type="button" className="attention-secondary-button" onClick={addProfile} disabled={store.profiles.length >= 24}>Add profile</button>
              </div>
              <div className="attention-profile-actions">
                <button type="button" className="attention-secondary-button" onClick={exportProfile}>Export profile JSON</button>
                <label className="attention-file-button">
                  Import profile JSON
                  <input ref={profileFileRef} type="file" accept="application/json,.json" onChange={(event) => void importProfile(event.target.files?.[0])} disabled={store.profiles.length >= 24} />
                </label>
              </div>
              {profileMessage && <p className="attention-inline-message" role="status">{profileMessage}</p>}
            </section>

            <section className="attention-settings" aria-labelledby="attention-camera-settings-title">
              <div className="attention-section-heading">
                <div><h3 id="attention-camera-settings-title">Camera input</h3><p>The selected camera is remembered locally for this site.</p></div>
              </div>
              <div className="attention-camera-row">
                <label className="field attention-device-field">
                  <span>Camera device</span>
                  <select
                    value={selectedDeviceId}
                    onChange={(event) => {
                      controller.selectDevice(event.target.value);
                      updateStore({ cameraDeviceId: event.target.value });
                    }}
                    disabled={isActive}
                  >
                    <option value="">Default camera</option>
                    {selectedDeviceId && !state.devices.some((device) => device.deviceId === selectedDeviceId) && !isCameraSelectionConfirmedMissing(selectedDeviceId, state.devices, state.devicesReady) && (
                      <option value={selectedDeviceId}>Saved camera (not currently listed)</option>
                    )}
                    {state.devices.map((device, index) => (
                      <option key={device.deviceId || index} value={device.deviceId}>{device.label}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="attention-secondary-button" onClick={() => void controller.refreshDevices()}>Refresh cameras</button>
              </div>
              {isActive && <p className="attention-inline-message">Stop the active camera run before changing the selected device.</p>}
              {state.devicesReady && state.devices.length === 0 && <p className="attention-inline-message">No cameras are listed yet. Choose Default camera to request browser selection, or connect a camera and refresh.</p>}
              {!supported && <p className="attention-error" role="alert">Camera access is unavailable in this browser or embedded page. Open the secure site directly and check its camera permission.</p>}
            </section>

            <section className="attention-settings" aria-labelledby="attention-calibration-launch-title">
              <div className="attention-section-heading">
                <div><h3 id="attention-calibration-launch-title">Calibration and Test Lab</h3><p>Open a dedicated window for each temporary camera workflow.</p></div>
              </div>
              <div className="attention-tool-launch-grid">
                <button type="button" className="attention-tool-launch" onClick={openCalibration}>
                  <span className="attention-tool-launch-icon" aria-hidden="true">◎</span>
                  <span><strong>{profile.calibratedAt ? "Recalibrate work area" : "Calibrate work area"}</strong><small>Two natural-viewing phases, one minute each. Samples can be extended.</small></span>
                  <span className="attention-tool-launch-arrow" aria-hidden="true">→</span>
                </button>
                <button type="button" className="attention-tool-launch" onClick={openTestArea}>
                  <span className="attention-tool-launch-icon" aria-hidden="true">◌</span>
                  <span><strong>Test Lab</strong><small>Try live signals, self-test, and simulated scenarios without Focus interventions.</small></span>
                  <span className="attention-tool-launch-arrow" aria-hidden="true">→</span>
                </button>
              </div>
            </section>

            <details className="attention-guide" open={profile.calibratedAt == null}>
              <summary><span>First-use guide</span><small>Set up this work area</small></summary>
              <ol>
                <li><b>1</b><div><strong>Choose Screen or Book</strong><small>Use the active profile for your screen area or reading page; each mode keeps separate settings.</small></div></li>
                <li><b>2</b><div><strong>Calibrate, then test</strong><small>Run both one-minute phases, save the profile, and verify the estimates in Test Lab before relying on reminders.</small></div></li>
                <li><b>3</b><div><strong>Start Focus and tracking</strong><small>Focus monitoring stays off until you explicitly turn it on during an active Focus timer.</small></div></li>
              </ol>
            </details>

            <details className="attention-tuning">
              <summary>Classifier zone and sensitivity</summary>
              <p>Adjust how far pose and coarse eye-box signals may drift from calibration before they count as outside the zone.</p>
              <div className="attention-number-grid">
                <AttentionNumberField label="Head yaw zone (°)" value={profile.zone.yawDeg} min={5} max={60} onChange={(value) => updateZone("yawDeg", value)} />
                <AttentionNumberField label="Head pitch zone (°)" value={profile.zone.pitchDeg} min={5} max={60} onChange={(value) => updateZone("pitchDeg", value)} />
                <AttentionNumberField label="Head roll zone (°)" value={profile.zone.rollDeg} min={5} max={60} onChange={(value) => updateZone("rollDeg", value)} />
                <AttentionNumberField label="Gaze X zone" value={profile.zone.gazeX} min={0.15} max={1.5} step={0.05} onChange={(value) => updateZone("gazeX", value)} />
                <AttentionNumberField label="Gaze Y zone" value={profile.zone.gazeY} min={0.15} max={1.5} step={0.05} onChange={(value) => updateZone("gazeY", value)} />
                <AttentionNumberField label="Level 1 score" value={profile.tuning.level1Score} min={0.2} max={2.5} step={0.1} onChange={(value) => updateTuning("level1Score", value)} />
                <AttentionNumberField label="Level 2 score" value={profile.tuning.level2Score} min={0.4} max={4} step={0.1} onChange={(value) => updateTuning("level2Score", Math.max(value, profile.tuning.level1Score + 0.15))} />
                <AttentionNumberField label="Level 1 hold (ms)" value={profile.tuning.level1DwellMs} min={500} max={30_000} step={500} onChange={(value) => updateTuning("level1DwellMs", value)} />
                <AttentionNumberField label="Level 2 hold (ms)" value={profile.tuning.level2DwellMs} min={1_000} max={60_000} step={1_000} onChange={(value) => updateTuning("level2DwellMs", value)} />
              </div>
            </details>

            <details className="attention-settings-extra" open={!store.offTargetAlertsEnabled}>
              <summary>Alerts and break reminders</summary>
              <p className="attention-preference-intro">These settings apply only to explicitly started Focus camera sessions. Calibration and Test Lab never notify or pause the timer.</p>
              <AttentionSwitch
                label={store.mode === "screen" ? "Off-target reminders" : "Off-page reminders"}
                help={store.mode === "screen"
                  ? "In-app nudges after sustained direction outside your screen zone. A phone is not detected; only webcam direction is estimated."
                  : "In-app nudges after sustained direction outside your calibrated reading area."}
                checked={store.offTargetAlertsEnabled}
                onChange={(value) => updateStore({ offTargetAlertsEnabled: value, ...(value ? {} : { strictPause: false }) })}
              />
              {warningSoundSupported ? <AttentionSwitch label="Warning sound" help="Soft chime for enabled reminders; off by default." checked={store.soundEnabled} onChange={(value) => {
                if (value) prepareAttentionWarningAudio();
                updateStore({ soundEnabled: value });
              }} /> : <p className="attention-inline-message">Warning sounds are not supported in this browser.</p>}
              <AttentionSwitch
                label="Strict pause"
                help="Pause Focus after a sustained level 2 off-target warning. Requires off-target reminders."
                checked={store.strictPause}
                disabled={!store.offTargetAlertsEnabled}
                onChange={(value) => updateStore({ strictPause: value })}
              />
              <label className="field attention-break-field">
                <span>Screen break reminder</span>
                <select className="attention-break-select" value={store.screenBreakReminderMinutes} disabled={store.mode !== "screen"} onChange={(event) => updateStore({ screenBreakReminderMinutes: Number(event.target.value) })}>
                  <option value={0}>Off</option>
                  <option value={25}>Every 25 minutes</option>
                  <option value={45}>Every 45 minutes</option>
                  <option value={60}>Every 60 minutes</option>
                </select>
                <small>{store.mode === "screen"
                  ? "A gentle nudge after continuous time inside your Screen zone. This is a timer—not exact gaze-duration or eye-strain detection."
                  : "Available in Screen mode only; this setting does not apply to reading."}</small>
              </label>
            </details>

            <details className="attention-privacy">
              <summary>Privacy and camera behavior</summary>
              <ul>
                <li>The camera stays off until you explicitly start a Focus, calibration, or Test Lab run.</li>
                <li>Video and raw numeric calibration samples are processed locally and are not saved. Only the profile's aggregate baseline and zone settings are stored on this device.</li>
                <li>Calibration and Test Lab runs do not trigger Focus reminders, sounds, or timer pauses.</li>
                <li>Webcam direction is approximate. The app does not detect phones, pupil landmarks, or pixel-accurate gaze.</li>
              </ul>
            </details>
          </div>

          <div className="attention-dialog-page" hidden={settingsPage !== "calibration"}>
            <AttentionModalCameraPreview controller={controller} />
            <CalibrationWizard
              controller={controller}
              profile={profile}
              cameraStatus={state.status}
              cameraError={state.error}
              onStartCalibrationCamera={() => { void controller.startCalibration(selectedDeviceId); }}
              onStopCalibrationCamera={() => controller.stop()}
              onSave={(next) => updateStore((previous) => upsertAttentionProfile(previous, next))}
            />
          </div>

          <div className="attention-dialog-page" hidden={settingsPage !== "test"}>
            <AttentionModalCameraPreview controller={controller} />
            <TestLab
              controller={controller}
              profile={profile}
              cameraStatus={state.status}
              runPurpose={state.runPurpose}
              onStartCamera={() => { void controller.startDiagnostic(selectedDeviceId); }}
              onStopCamera={() => controller.stop()}
              onSaveProfile={(next) => updateStore((previous) => upsertAttentionProfile(previous, next))}
            />
          </div>
        </AttentionWindow>
      )}
    </div>
  );
}
