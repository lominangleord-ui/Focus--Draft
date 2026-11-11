import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";
import CalibrationWizard from "./CalibrationWizard";
import { isCameraSelectionConfirmedMissing } from "./deviceSelection";
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

function AttentionSwitch({ label, checked, help, onChange }: { label: string; checked: boolean; help?: string; onChange: (checked: boolean) => void }) {
  return (
    <div className="attention-setting-row">
      <div><strong>{label}</strong>{help && <small>{help}</small>}</div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`attention-small-switch ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
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
  const isActive = state.status === "on" || state.status === "starting";
  const isTemporaryRun = state.runPurpose === "calibration" || state.runPurpose === "diagnostic";
  const pausedTemporaryRun = state.status === "paused" && isTemporaryRun;
  const pausedFocusRun = state.status === "paused" && state.runPurpose === "focus";
  const showFocusTimerAction = view === "monitor" && !focusTimerActive && !isActive && !pausedTemporaryRun;
  const canStartFocusTracking = canStartFocusTrackingFromView(view, focusTimerActive);
  const controlChecked = isActive;
  const controlDisabled = !canStartFocusTracking && !isActive;
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const warningSoundSupported = soundSupported();
  const profile = useMemo(() => activeAttentionProfile(store), [store]);
  const profilesForMode = store.profiles.filter((item) => item.mode === store.mode);
  const selectedDeviceId = store.cameraDeviceId;
  const cameraHeading = state.status === "on"
    ? state.runPurpose === "diagnostic" ? "Temporary Test Lab camera is on" : state.runPurpose === "calibration" ? "Temporary calibration camera is on" : "Focus tracking is on"
    : state.status === "starting"
      ? state.runPurpose === "diagnostic" ? "Starting temporary camera test…" : state.runPurpose === "calibration" ? "Starting temporary calibration camera…" : "Starting focus tracking…"
      : state.status === "paused" ? "Camera paused" : state.status === "error" ? "Tracking stopped" : "Tracking is off";
  const cameraDescription = state.status === "on"
    ? state.runPurpose === "diagnostic"
      ? "This explicit Test Lab run is temporary and does not trigger focus-session interventions."
      : state.runPurpose === "calibration"
        ? "This explicit calibration run is temporary and does not trigger focus-session interventions."
        : "Camera frames are being analyzed locally during the active Focus timer."
    : state.status === "starting"
      ? state.runPurpose === "diagnostic"
        ? "Starting the explicit Test Lab camera run; it will not trigger focus-session interventions."
        : state.runPurpose === "calibration"
          ? "Starting the explicit calibration camera run; it will not trigger focus-session interventions."
          : "Starting local camera analysis for this Focus timer."
      : state.status === "paused"
        ? "The camera and inference worker were stopped when the tab went into the background."
      : state.status === "error"
        ? "The camera or local analysis stopped. See the message below, then retry when ready."
        : view !== "monitor"
          ? "Use the temporary camera action in this view; it does not require a running Focus timer."
          : !focusTimerActive
            ? timerMode === "focus"
              ? "Start or resume Focus to enable tracking. The camera stays off until you turn it on."
              : "You are on a break. Switch to Focus to enable tracking; the camera stays off until you turn it on."
            : "No camera is active. Turn on focus tracking when you want to use it.";
  const toggleLabel = isActive
    ? isTemporaryRun ? "Stop temporary camera" : "Turn off tracking"
    : state.status === "error" && canStartFocusTracking
      ? "Retry camera"
      : state.status === "paused" && state.runPurpose === "focus" && canStartFocusTracking
        ? "Turn tracking back on"
        : canStartFocusTracking
          ? "Turn on tracking"
          : view !== "monitor"
            ? "Use temporary camera below"
            : focusTimerActive ? "Use Monitor for tracking" : "Focus timer required";
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

  function changeMode(mode: AttentionStore["mode"]) {
    updateStore({ mode });
    setProfileMessage("");
  }

  function selectProfile(id: string) {
    updateStore({ activeProfileIds: { ...store.activeProfileIds, [store.mode]: id } });
    setProfileMessage("");
  }

  function addProfile() {
    if (store.profiles.length >= 24) {
      setProfileMessage("Profile limit reached. Delete an old profile before adding another.");
      return;
    }
    const now = Date.now();
    const id = `profile-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const created = createAttentionProfile(store.mode, newProfileName, id, now);
    updateStore((previous) => upsertAttentionProfile(previous, created));
    setNewProfileName("");
    setProfileMessage("Profile added. Calibrate it before using warnings.");
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
      updateStore((previous) => addImportedProfile(previous, imported));
      setProfileMessage(`Imported ${imported.mode.toUpperCase()} profile. It is stored only on this device.`);
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
        <p>Optional on-device camera checks help you stay within your calibrated work area. Regular tracking runs only during an active Focus timer; calibration and Test Lab use separate temporary camera runs.</p>
      </section>

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
              else if (canStartFocusTracking) {
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
      </div>

      <div className="attention-tabs" role="tablist" aria-label="Attention Guard views">
        <button id="attention-monitor-tab" type="button" role="tab" aria-selected={view === "monitor"} className={view === "monitor" ? "active" : ""} onClick={() => changeView("monitor")}>Monitor</button>
        <button id="attention-calibrate-tab" type="button" role="tab" aria-selected={view === "calibrate"} className={view === "calibrate" ? "active" : ""} onClick={() => changeView("calibrate")}>Calibrate</button>
        <button id="attention-test-lab-tab" type="button" role="tab" aria-selected={view === "lab"} className={view === "lab" ? "active" : ""} onClick={() => changeView("lab")}>Test Lab</button>
      </div>

      <section className="attention-settings" aria-labelledby="attention-profile-title">
        <div className="attention-section-heading">
          <div><h3 id="attention-profile-title">Mode and profile</h3><p>Each mode has its own calibration and attention zone.</p></div>
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

      <details className="attention-settings-extra">
        <summary>Intervention preferences</summary>
        {warningSoundSupported ? <AttentionSwitch label="Warning sound" help="Soft in-app chime; off by default." checked={store.soundEnabled} onChange={(value) => {
          if (value) prepareAttentionWarningAudio();
          updateStore({ soundEnabled: value });
        }} /> : <p className="attention-inline-message">Warning sounds are not supported in this browser.</p>}
        <AttentionSwitch label="Strict pause" help="Pause the focus timer after a sustained level 2 warning." checked={store.strictPause} onChange={(value) => updateStore({ strictPause: value })} />
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
