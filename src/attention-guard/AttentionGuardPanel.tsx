import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";
import CalibrationWizard from "./CalibrationWizard";
import { isCameraSelectionConfirmedMissing } from "./deviceSelection";
import { mapFaceBoundsToPreview } from "./previewGeometry";
import { canStartFocusTrackingFromView } from "./lifecycle";
import { prepareAttentionWarningAudio, soundSupported } from "../sound";
import TestLab from "./TestLab";
import { createAttentionProfile, parseAttentionProfileFile, serializeAttentionProfile, type AttentionProfile } from "./profile";
import { activeAttentionProfile, addImportedProfile, upsertAttentionProfile, type AttentionStore } from "./storage";
import type { AttentionClassification, RawAttentionSignals } from "./types";

type StoreUpdate = (update: Partial<AttentionStore> | ((previous: AttentionStore) => AttentionStore)) => void;

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
  const [view, setView] = useState<"monitor" | "calibrate" | "lab">("monitor");
  const profile = useMemo(() => activeAttentionProfile(store), [store]);
  const isActive = state.status === "on" || state.status === "starting";
  const isTemporaryRun = state.runPurpose === "calibration" || state.runPurpose === "diagnostic";
  const pausedTemporaryRun = state.status === "paused" && isTemporaryRun;
  const pausedFocusRun = state.status === "paused" && state.runPurpose === "focus";
  const showFocusTimerAction = view === "monitor" && profile.calibratedAt != null && !focusTimerActive && !isActive && !pausedTemporaryRun;
  const canStartFocusTracking = canStartFocusTrackingFromView(view, focusTimerActive);
  const canStartFocusCamera = canStartFocusTracking && profile.calibratedAt != null;
  const controlChecked = isActive;
  const controlDisabled = !canStartFocusCamera && !isActive;
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const warningSoundSupported = soundSupported();
  const profilesForMode = store.profiles.filter((item) => item.mode === store.mode);
  const previewVideo = previewRef.current;
  const previewViewport = previewVideo?.parentElement;
  const facePreviewBox = signals?.faceBounds && previewVideo && previewViewport
    ? mapFaceBoundsToPreview(signals.faceBounds, previewVideo.videoWidth, previewVideo.videoHeight, previewViewport.clientWidth, previewViewport.clientHeight)
    : null;
  const selectedDeviceId = store.cameraDeviceId;
  const cameraHeading = state.status === "on"
    ? state.runPurpose === "diagnostic" ? "Temporary Test Lab camera is on" : state.runPurpose === "calibration" ? "Temporary calibration camera is on" : "Focus tracking is on"
    : state.status === "starting"
      ? state.runPurpose === "diagnostic" ? "Starting temporary camera test…" : state.runPurpose === "calibration" ? "Starting temporary calibration camera…" : "Starting focus tracking…"
      : state.status === "paused" ? "Camera paused" : state.status === "error" ? "Tracking stopped" : "Tracking is off";
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
    if (view !== "monitor") return "Use the temporary camera action in this view; it does not require a running Focus timer.";
    if (profile.calibratedAt == null) return "Calibrate and test this profile first. Focus tracking stays unavailable until its work area is calibrated.";
    if (!focusTimerActive) {
      return timerMode === "focus"
        ? "Start or resume Focus to enable tracking. The camera stays off until you turn it on."
        : "You are on a break. Switch to Focus to enable tracking; the camera stays off until you turn it on.";
    }
    return "No camera is active. Turn on focus tracking when you want to use it.";
  })();
  const toggleLabel = isActive
    ? isTemporaryRun ? "Stop temporary camera" : "Turn off tracking"
    : view !== "monitor"
      ? "Use temporary camera below"
      : profile.calibratedAt == null
        ? "Calibrate profile to enable tracking"
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
    if (view !== "monitor" && controller.getState().runPurpose === "focus") controller.stop();
    return () => {
      const purpose = controller.getState().runPurpose;
      if ((view !== "monitor" && purpose === "focus") || (view === "calibrate" && purpose === "calibration") || (view === "lab" && purpose === "diagnostic")) {
        controller.stop();
      }
    };
  }, [controller, view]);

  useEffect(() => {
    if (isCameraSelectionConfirmedMissing(selectedDeviceId, state.devices, state.devicesReady)) {
      if (state.selectedDeviceId) controller.selectDevice("");
      updateStore({ cameraDeviceId: "" });
      return;
    }
    if (state.selectedDeviceId !== selectedDeviceId) controller.selectDevice(selectedDeviceId);
  }, [controller, selectedDeviceId, state.devices, state.devicesReady, state.selectedDeviceId, updateStore]);

  function changeView(nextView: typeof view) {
    if (nextView === view) return;
    const purpose = controller.getState().runPurpose;
    const leavingTemporaryRun = (view === "calibrate" && purpose === "calibration") || (view === "lab" && purpose === "diagnostic");
    const leavingFocusTracking = nextView !== "monitor" && purpose === "focus";
    if (leavingTemporaryRun || leavingFocusTracking) controller.stop();
    setView(nextView);
  }

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
      ? "Camera stopped. The new profile is active; calibrate it before using warnings."
      : "Profile added. Calibrate it before using warnings.");
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

  return (
    <div className="attention-panel">
      <section className="attention-intro">
        <div className="attention-kicker">Optional · local processing</div>
        <h2>Attention Guard</h2>
        <p>Calibrate a work area and test the webcam estimates before starting Focus tracking. Gentle in-app off-target reminders are on by default and can be changed below; the camera stays off until you explicitly start it.</p>
      </section>

      <div className="attention-mode-switch" role="group" aria-label="Attention mode">
        {(["screen", "book"] as const).map((mode) => (
          <button key={mode} type="button" className={store.mode === mode ? "active" : ""} aria-pressed={store.mode === mode} onClick={() => changeMode(mode)}>
            {mode === "screen" ? "SCREEN" : "BOOK"}
          </button>
        ))}
      </div>

      <details className="attention-guide" open={profile.calibratedAt == null}>
        <summary><span>First-use guide</span><small>Four steps · 2–3 minutes to set up</small></summary>
        <ol>
          <li><b>1</b><div><strong>Choose your work area</strong><small>{store.mode === "screen" ? "Screen mode uses your calibrated screen zone; sustained looks outside it can trigger an off-target nudge. It cannot identify a phone or other object." : "Book mode learns the page area and samples just beyond it to estimate off-page overlap."}</small></div></li>
          <li><b>2</b><div><strong>Set camera angle and distance</strong><small>Place the camera near eye level, face it with your full face in frame, and keep the same chair, lighting and camera position for calibration and use.</small></div></li>
          <li><b>3</b><div><strong>Calibrate, then test</strong><small>Follow each on-area and off-area target. Use Test Lab to verify that center, boundary and away movements produce sensible results before relying on reminders.</small></div></li>
          <li><b>4</b><div><strong>Start Focus and tracking</strong><small>Turning on the camera during a running Focus timer enables gentle in-app off-target reminders by default. You can turn them off below; sound and strict pause are separate optional settings.</small></div></li>
        </ol>
        <div className="attention-guide-actions">
          <button type="button" className="attention-secondary-button" onClick={() => changeView("calibrate")}>Open calibration</button>
          <button type="button" className="attention-secondary-button" onClick={() => changeView("lab")}>Open Test Lab</button>
          {!store.offTargetAlertsEnabled && <button type="button" className="attention-secondary-button" onClick={() => updateStore({ offTargetAlertsEnabled: true })}>Re-enable in-app off-target reminders</button>}
        </div>
        <p>Webcam direction and iris signals are estimates, not pixel-accurate gaze tracking. The preview outline only shows face position; it does not label pupils or detect phones.</p>
      </details>

      <section className={`attention-control-card ${isActive ? "is-active" : ""}`} aria-label="Camera tracking controls">
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
              else if (canStartFocusCamera) {
                controller.selectDevice(selectedDeviceId);
                void controller.start(selectedDeviceId);
              }
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
        <button type="button" className="attention-secondary-button" onClick={() => void controller.refreshDevices()}>
          Refresh cameras
        </button>
      </div>
      {isActive && <p className="attention-inline-message">Stop the current camera run before choosing a different device.</p>}
      {state.devicesReady && state.devices.length === 0 && <p className="attention-inline-message">No cameras are listed. Choose Default camera to try browser selection, or connect a camera and refresh.</p>}
      {!supported && state.status !== "error" && <p className="attention-error" role="alert">Camera access is not available in this browser. Try a current browser on HTTPS or localhost.</p>}
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
        {isActive && facePreviewBox && (
          <svg className="attention-face-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <rect className="attention-face-outline" x={facePreviewBox.x * 100} y={facePreviewBox.y * 100} width={facePreviewBox.width * 100} height={facePreviewBox.height * 100} rx="3" />
          </svg>
        )}
        {isActive && <span className={`attention-preview-status ${signals?.facePresent ? "has-face" : ""}`} role="status">
          {state.status === "starting" ? "Starting local model" : signals?.facePresent ? "Face found" : signals ? "Searching for face" : "Waiting for camera samples"}
        </span>}
      </div>
      <p className="attention-preview-caption">The outline shows face position, not eye landmarks. Head pose is calibrated to your usual camera angle; iris direction is a coarse eye-box estimate and is not measured in screen pixels.</p>

      <div className="attention-tabs" role="tablist" aria-label="Attention Guard views">
        <button id="attention-monitor-tab" type="button" role="tab" aria-selected={view === "monitor"} className={view === "monitor" ? "active" : ""} onClick={() => changeView("monitor")}>Monitor</button>
        <button id="attention-calibrate-tab" type="button" role="tab" aria-selected={view === "calibrate"} className={view === "calibrate" ? "active" : ""} onClick={() => changeView("calibrate")}>Calibrate</button>
        <button id="attention-test-lab-tab" type="button" role="tab" aria-selected={view === "lab"} className={view === "lab" ? "active" : ""} onClick={() => changeView("lab")}>Test Lab</button>
      </div>

      <section className="attention-settings" aria-labelledby="attention-profile-title">
        <div className="attention-section-heading">
          <div><h3 id="attention-profile-title">Active profile</h3><p>Choose a saved calibration for this work area, or create a separate desk/reading setup.</p></div>
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

      {view === "calibrate" ? (
        <CalibrationWizard
          controller={controller}
          profile={profile}
          cameraStatus={state.status}
          onStartCalibrationCamera={() => { controller.selectDevice(selectedDeviceId); void controller.startCalibration(selectedDeviceId); }}
          onSave={(next) => updateStore((previous) => upsertAttentionProfile(previous, next))}
        />
      ) : view === "lab" ? (
        <TestLab
          controller={controller}
          profile={profile}
          cameraStatus={state.status}
          runPurpose={state.runPurpose}
          onStartCamera={() => { controller.selectDevice(selectedDeviceId); void controller.startDiagnostic(selectedDeviceId); }}
          onStopCamera={() => controller.stop()}
          onSaveProfile={(next) => updateStore((previous) => upsertAttentionProfile(previous, next))}
        />
      ) : (
        <div className="attention-monitor-view" role="tabpanel" id="attention-monitor-panel" aria-labelledby="attention-monitor-tab">
      <details className="attention-tuning">
        <summary>Classifier zone and sensitivity</summary>
        <p>Adjust how far pose/gaze may drift from calibration before it counts as outside the zone. Values are normalized per profile.</p>
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

      <section className="attention-debug" aria-labelledby="attention-debug-title">
        <div className="attention-section-heading">
          <div>
            <h3 id="attention-debug-title">Live signal diagnostics</h3>
            <p>Only numeric estimates are shown here; the model does not provide a calibrated gaze-confidence score.</p>
          </div>
          <span className={`attention-sample-state ${signals?.facePresent ? "has-face" : ""}`}>{signals?.facePresent ? "FACE FOUND" : isActive ? "SEARCHING" : "OFF"}</span>
        </div>
        <ClassificationCard classification={classification} />
        <SignalReadout signals={signals} cameraActive={isActive} />
      </section>

      <details className="attention-settings-extra" open={!store.offTargetAlertsEnabled}>
        <summary>Alerts and break reminders</summary>
        <p className="attention-preference-intro">Alerts only run during an explicitly started Focus camera session. Calibration and Test Lab never notify or pause the timer.</p>
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
            ? "A gentle nudge after continuous time inside your Screen zone. This is a timer—not eye-strain or exact gaze-duration detection."
            : "Available in Screen mode only; this setting does not apply to reading."}</small>
        </label>
      </details>
        </div>
      )}

      <details className="attention-privacy">
        <summary>Camera and privacy details</summary>
        <ul>
          <li>Focus tracking can be started only while the Focus timer is running. Pausing, resetting, finishing, skipping, or switching to a break stops its camera and worker; after resuming, start tracking again if desired.</li>
          <li>Opening Calibrate or Test Lab stops Focus tracking. Their separate temporary camera runs require an explicit start and never trigger focus-session interventions.</li>
          <li>Video frames and landmarks are processed in a local worker. They are not uploaded or saved.</li>
          <li>Tracking uses the camera only (no microphone). Stopping a run ends every camera track and terminates the worker.</li>
          <li>The face model and WebAssembly files are served from this app. External worker requests, including SDK performance telemetry, are blocked.</li>
          <li>When this tab goes into the background, the current camera run is stopped; start it again explicitly when you return.</li>
        </ul>
      </details>
    </div>
  );
}
