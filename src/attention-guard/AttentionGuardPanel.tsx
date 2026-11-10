import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";
import CalibrationWizard from "./CalibrationWizard";
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
  return (
    <div className={`attention-live-indicator ${active ? "is-active" : "is-paused"}`} role="status">
      <span className="attention-live-dot" aria-hidden="true" />
      <span>{state.status === "on" ? "Camera on" : state.status === "starting" ? "Starting camera" : "Camera paused"}</span>
      <button type="button" onClick={onOpen} aria-label="Open Attention Guard panel">Details</button>
      {active && <button type="button" onClick={() => controller.stop()} aria-label="Turn off Attention Guard">Stop</button>}
    </div>
  );
}

export default function AttentionGuardPanel({
  controller,
  store,
  updateStore,
}: {
  controller: AttentionGuardController;
  store: AttentionStore;
  updateStore: StoreUpdate;
}) {
  const state = useSyncExternalStore(controller.subscribeState, controller.getState, controller.getState);
  const signals = useSyncExternalStore(controller.subscribeSignals, controller.getSignals, controller.getSignals);
  const classification = useSyncExternalStore(controller.subscribeClassification, controller.getClassification, controller.getClassification);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const profileFileRef = useRef<HTMLInputElement | null>(null);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [view, setView] = useState<"monitor" | "calibrate">("monitor");
  const isActive = state.status === "on" || state.status === "starting";
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const profile = useMemo(() => activeAttentionProfile(store), [store]);
  const profilesForMode = store.profiles.filter((item) => item.mode === store.mode);
  const selectedDeviceId = store.cameraDeviceId;

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
    if (state.selectedDeviceId !== selectedDeviceId) controller.selectDevice(selectedDeviceId);
  }, [controller, selectedDeviceId, state.selectedDeviceId]);

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
          onClick={() => {
            if (isActive) controller.stop();
            else {
              controller.selectDevice(selectedDeviceId);
              void controller.start(selectedDeviceId);
            }
          }}
        >
          <span className="attention-toggle-track" aria-hidden="true"><i /></span>
          <span>{isActive ? "Turn off tracking" : state.status === "paused" ? "Turn tracking back on" : "Turn on tracking"}</span>
        </button>
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

      <div className="attention-tabs" role="tablist" aria-label="Attention Guard views">
        <button id="attention-monitor-tab" type="button" role="tab" aria-selected={view === "monitor"} className={view === "monitor" ? "active" : ""} onClick={() => setView("monitor")}>Monitor</button>
        <button id="attention-calibrate-tab" type="button" role="tab" aria-selected={view === "calibrate"} className={view === "calibrate" ? "active" : ""} onClick={() => setView("calibrate")}>Calibrate</button>
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
          onStartTracking={() => { controller.selectDevice(selectedDeviceId); void controller.start(selectedDeviceId); }}
          onSave={(next) => updateStore((previous) => upsertAttentionProfile(previous, next))}
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
        <SignalReadout signals={signals} />
      </section>

      <details className="attention-settings-extra">
        <summary>Intervention preferences</summary>
        <AttentionSwitch label="Warning sound" help="Soft in-app chime; off by default." checked={store.soundEnabled} onChange={(value) => updateStore({ soundEnabled: value })} />
        <AttentionSwitch label="Strict pause" help="Pause the focus timer after a sustained level 2 warning." checked={store.strictPause} onChange={(value) => updateStore({ strictPause: value })} />
      </details>
        </div>
      )}

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
