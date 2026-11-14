import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";
import {
  calculateCalibration,
  CALIBRATION_MIN_SAMPLES,
  getCalibrationTargets,
  isCalibrationSignalValid,
  medianCalibrationBaseline,
  scaleAttentionZone,
  type CalibrationSamples,
  type CalibrationTarget,
} from "./calibration";
import type { AttentionProfile } from "./profile";
import type { GuardStatus, RawAttentionSignals } from "./types";

const COUNTDOWN_MS = 1_800;
const CAPTURE_MS = 3_000;
const TOTAL_CAPTURE_MS = COUNTDOWN_MS + CAPTURE_MS;

type CaptureProgress = {
  targetId: string;
  startedAt: number;
  remainingMs: number;
  sampleCount: number;
};

type Precheck = {
  label: string;
  detail: string;
  state: "pass" | "waiting" | "blocked" | "info";
};

function formatDelta(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function calibrationPrechecks(signals: RawAttentionSignals | null, cameraStatus: GuardStatus, profile: AttentionProfile): Precheck[] {
  const cameraReady = cameraStatus === "on";
  const isStarting = cameraStatus === "starting";
  const faceReady = signals?.facePresent === true;
  const hasHeadPose = Boolean(signals && [signals.yawDeg, signals.pitchDeg, signals.rollDeg].every((value) => value != null && Number.isFinite(value)));
  const hasEyeEstimate = Boolean(signals && [signals.gazeX, signals.gazeY].every((value) => value != null && Number.isFinite(value)));
  const hasSignals = hasHeadPose && hasEyeEstimate;
  const missingSignals = [!hasHeadPose ? "head-pose angles" : null, !hasEyeEstimate ? "coarse iris/eye-box estimates" : null].filter((value): value is string => value != null);
  const lighting = signals?.brightness;
  const faceWidth = signals?.faceWidth;

  return [
    {
      label: "Camera",
      state: cameraReady ? "pass" : isStarting ? "waiting" : "blocked",
      detail: cameraReady ? "Camera and local model are ready for this calibration." : isStarting ? "Waiting for the local worker to start." : cameraStatus === "error" ? "Camera setup failed; read the error below and retry." : "Start the temporary calibration camera to continue.",
    },
    {
      label: "Face visible",
      state: signals == null ? "waiting" : faceReady ? "pass" : "blocked",
      detail: signals == null ? "Waiting for the first local sample." : faceReady ? "Keep your full face in the frame." : "No face found; adjust the camera or your position.",
    },
    {
      label: "Lighting",
      state: lighting == null ? "info" : lighting >= profile.tuning.lowLightFloor ? "pass" : "blocked",
      detail: lighting == null ? "Brightness estimate unavailable; it will not be used." : lighting >= profile.tuning.lowLightFloor ? `Usable light (${Math.round(lighting * 100)}%).` : "Too dim for a reliable capture; add light facing you.",
    },
    {
      label: "Distance",
      state: faceWidth == null ? "info" : faceWidth >= profile.tuning.minFaceWidth ? "pass" : "blocked",
      detail: faceWidth == null ? "Face-size estimate unavailable; it will not be used." : faceWidth >= profile.tuning.minFaceWidth ? "Face is large enough in frame." : "Move closer until your face is clearly visible.",
    },
    {
      label: "Pose and gaze signals",
      state: hasSignals ? "pass" : cameraReady && faceReady ? "blocked" : "waiting",
      detail: hasSignals
        ? "Head-pose and coarse iris estimates are available."
        : !cameraReady ? "Waiting for the camera and local model."
          : !signals ? "Waiting for the first local sample."
            : !faceReady ? "Waiting for the face to return to frame."
              : `Missing ${missingSignals.join(" and ")}. Center your face, improve light, reduce lens glare, and check camera angle; a blink can pause one sample.`,
    },
  ];
}

function CalibrationMap({
  mode,
  targets,
  samples,
  currentTargetId,
}: {
  mode: AttentionProfile["mode"];
  targets: CalibrationTarget[];
  samples: CalibrationSamples;
  currentTargetId: string | null;
}) {
  const complete = (id: string) => (samples[id]?.length ?? 0) >= CALIBRATION_MIN_SAMPLES;
  const isScreen = mode === "screen";
  return (
    <div className="attention-calibration-map-wrap">
      <svg className={`attention-calibration-map mode-${mode}`} viewBox="0 0 100 100" role="img" aria-label={`${isScreen ? "Screen" : "Book"} calibration target diagram with on-work-area and off-work-area prompts`}>
        <rect className="attention-map-surface" x={isScreen ? "14" : "30"} y={isScreen ? "14" : "14"} width={isScreen ? "72" : "40"} height="72" rx={isScreen ? "4" : "2"} />
        <path className="attention-map-grid" d="M50 15V85 M15 50H85" />
        {targets.map((target) => (
          <g key={target.id} className={`attention-map-target ${target.kind === "negative" ? "is-negative" : "is-positive"} ${complete(target.id) ? "is-complete" : ""} ${target.id === currentTargetId ? "is-current" : ""}`}>
            {target.id === currentTargetId && <circle className="attention-map-target-ring" cx={target.x} cy={target.y} r="6" />}
            <circle cx={target.x} cy={target.y} r={target.id === "center" ? "3.1" : "2.6"} />
          </g>
        ))}
      </svg>
      <p className="attention-map-caption">Green dots are on-work-area samples; red dots are intentionally off-target. This diagram shows prompts only: the fitted zone uses webcam pose and coarse eye-box signals, not screen-pixel coordinates.</p>
    </div>
  );
}

export default function CalibrationWizard({
  controller,
  profile,
  cameraStatus,
  cameraError,
  onStartCalibrationCamera,
  onStopCalibrationCamera,
  onSave,
}: {
  controller: AttentionGuardController;
  profile: AttentionProfile;
  cameraStatus: GuardStatus;
  cameraError: string;
  onStartCalibrationCamera: () => void;
  onStopCalibrationCamera: () => void;
  onSave: (profile: AttentionProfile) => void;
}) {
  const signals = useSyncExternalStore(controller.subscribeSignals, controller.getSignals, controller.getSignals);
  const targets = useMemo(() => getCalibrationTargets(profile.mode), [profile.mode]);
  const [samples, setSamples] = useState<CalibrationSamples>({});
  const [capture, setCapture] = useState<CaptureProgress | null>(null);
  const [marginPercent, setMarginPercent] = useState(profile.marginPercent);
  const [zoneShape, setZoneShape] = useState<AttentionProfile["zoneShape"]>(profile.zoneShape);
  const [quickRecenter, setQuickRecenter] = useState(false);
  const [message, setMessage] = useState("");
  const captured = useRef<RawAttentionSignals[]>([]);
  const captureRef = useRef<CaptureProgress | null>(null);
  const lastSampledAt = useRef<number | null>(null);
  const profileIdentity = useRef(`${profile.mode}:${profile.id}`);
  const tracking = cameraStatus === "on";
  const prechecks = calibrationPrechecks(signals, cameraStatus, profile);
  const canCapture = tracking && prechecks.every((check) => check.state === "pass" || check.state === "info");
  const captureBlocker = prechecks.find((check) => check.state === "blocked" || check.state === "waiting");
  const captureDisabledHint = capture
    ? "Finish this capture or cancel it before starting another."
    : captureBlocker ? `${captureBlocker.label}: ${captureBlocker.detail}` : "Start the camera and complete the live prechecks first.";
  const currentTargetId = capture?.targetId ?? targets.find((target) => (samples[target.id]?.length ?? 0) < CALIBRATION_MIN_SAMPLES)?.id ?? null;
  const currentTarget = targets.find((target) => target.id === currentTargetId) ?? targets[0];
  const result = useMemo(
    () => calculateCalibration(profile.mode, samples, marginPercent, zoneShape, profile.tuning),
    [marginPercent, profile.mode, profile.tuning, samples, zoneShape],
  );
  const storedZoneScale = (100 + marginPercent) / (100 + profile.marginPercent);
  const previewZone = result?.zone ?? (profile.calibratedAt != null ? scaleAttentionZone(profile.zone, storedZoneScale) : profile.zone);
  const hasToleranceEdits = marginPercent !== profile.marginPercent || zoneShape !== profile.zoneShape;
  const hasDraftTargets = Object.keys(samples).some((id) => id !== "center" && (samples[id]?.length ?? 0) > 0);
  const canApplyQuickRecenter = quickRecenter && (samples.center?.length ?? 0) >= CALIBRATION_MIN_SAMPLES;
  const canSave = result != null || (profile.calibratedAt != null && hasToleranceEdits);
  const completedTargetCount = targets.filter((target) => (samples[target.id]?.length ?? 0) >= CALIBRATION_MIN_SAMPLES).length;
  const saveDisabledHint = profile.calibratedAt == null
    ? `Capture all ${targets.length} targets before saving (${completedTargetCount} ready).`
    : "Capture a new calibration or change the zone margin before saving.";

  function startCapture(targetId: string) {
    if (!canCapture) {
      setMessage("Complete the live prechecks before capturing a target.");
      return;
    }
    captured.current = [];
    lastSampledAt.current = null;
    const progress = {
      targetId,
      startedAt: performance.now(),
      remainingMs: TOTAL_CAPTURE_MS,
      sampleCount: 0,
    };
    captureRef.current = progress;
    setCapture(progress);
    setMessage("Follow the visible target. A short countdown runs before numeric samples are collected.");
  }

  function finishCapture(targetId: string) {
    const collectedSamples = captured.current;
    captured.current = [];
    captureRef.current = null;
    setCapture(null);
    if (collectedSamples.length < CALIBRATION_MIN_SAMPLES) {
      setMessage(`Only ${collectedSamples.length} usable frames were collected; ${CALIBRATION_MIN_SAMPLES} are required. Improve the live prechecks and retry this target.`);
      return;
    }
    setSamples((previous) => ({ ...previous, [targetId]: collectedSamples }));
    const target = targets.find((item) => item.id === targetId);
    setMessage(`${target?.label ?? "Target"}: ${collectedSamples.length} temporary numeric samples captured. Frames and landmarks were not saved.`);
  }

  function cancelCapture() {
    captured.current = [];
    captureRef.current = null;
    setCapture(null);
    setMessage("Target capture cancelled; completed targets are unchanged.");
  }

  function clearDraft() {
    captured.current = [];
    captureRef.current = null;
    setCapture(null);
    setSamples({});
    setQuickRecenter(false);
    setMessage("Calibration draft cleared from memory.");
  }

  function saveCalibration() {
    if (!result) {
      setMessage("Capture every on-task target and the negative directions before saving the calibrated zone.");
      return;
    }
    const now = Date.now();
    onSave({
      ...profile,
      baseline: result.baseline,
      zone: result.zone,
      zoneShape: result.zoneShape,
      marginPercent: result.marginPercent,
      negativeOverlap: result.negativeOverlap,
      calibratedAt: now,
      calibrationSamples: result.sampleCount,
      updatedAt: now,
    });
    setMessage("Calibration saved locally. Raw numeric samples remain temporary and are not part of the saved profile.");
  }

  function saveZoneSettings() {
    if (profile.calibratedAt == null || !hasToleranceEdits) return;
    const now = Date.now();
    onSave({
      ...profile,
      zone: scaleAttentionZone(profile.zone, storedZoneScale),
      zoneShape,
      marginPercent,
      negativeOverlap: null,
      updatedAt: now,
    });
    setMessage("Zone settings saved. The old overlap estimate was cleared because raw calibration samples are not retained; repeat calibration to measure overlap again.");
  }

  function startQuickRecenter() {
    if (!canCapture) {
      setMessage("Start tracking and complete the live prechecks before a quick re-center.");
      return;
    }
    captured.current = [];
    captureRef.current = null;
    setCapture(null);
    setSamples({});
    setMarginPercent(profile.marginPercent);
    setZoneShape(profile.zoneShape);
    setQuickRecenter(true);
    startCapture("center");
  }

  function applyQuickRecenter() {
    const baseline = medianCalibrationBaseline(samples.center ?? []);
    if (!baseline || profile.calibratedAt == null) {
      setMessage("Capture a fresh center sample before applying quick re-center.");
      return;
    }
    const now = Date.now();
    onSave({
      ...profile,
      baseline,
      calibratedAt: now,
      calibrationSamples: Math.min(100_000, profile.calibrationSamples + (samples.center?.length ?? 0)),
      negativeOverlap: null,
      updatedAt: now,
    });
    setSamples({});
    setQuickRecenter(false);
    setMessage("Center updated. Existing work-area tolerances were kept unchanged; the overlap estimate was cleared because it cannot be recalculated without a full recapture.");
  }

  useEffect(() => {
    if (!capture || !signals || signals.sampledAt === lastSampledAt.current) return;
    const active = captureRef.current;
    if (!active || active.targetId !== capture.targetId) return;
    lastSampledAt.current = signals.sampledAt;
    if (signals.sampledAt - active.startedAt < COUNTDOWN_MS || !isCalibrationSignalValid(signals, profile)) return;
    captured.current.push(signals);
    const updated = { ...active, sampleCount: captured.current.length };
    captureRef.current = updated;
    setCapture(updated);
  }, [capture, profile, signals]);

  useEffect(() => {
    if (!capture) return;
    const targetId = capture.targetId;
    const startedAt = capture.startedAt;
    const timer = window.setInterval(() => {
      const active = captureRef.current;
      if (!active || active.targetId !== targetId || active.startedAt !== startedAt) return;
      const elapsed = performance.now() - startedAt;
      const updated = {
        ...active,
        remainingMs: Math.max(0, TOTAL_CAPTURE_MS - elapsed),
        sampleCount: captured.current.length,
      };
      captureRef.current = updated;
      setCapture(updated);
      if (updated.remainingMs === 0) finishCapture(targetId);
    }, 100);
    return () => window.clearInterval(timer);
  }, [capture?.startedAt, capture?.targetId]);

  useEffect(() => {
    if (cameraStatus === "on" || !captureRef.current) return;
    captured.current = [];
    captureRef.current = null;
    setCapture(null);
    setMessage("Tracking stopped, so the active target was cancelled. Your camera is off.");
  }, [cameraStatus]);

  useEffect(() => {
    const identity = `${profile.mode}:${profile.id}`;
    if (profileIdentity.current === identity) return;
    profileIdentity.current = identity;
    captured.current = [];
    captureRef.current = null;
    setCapture(null);
    setSamples({});
    setMarginPercent(profile.marginPercent);
    setZoneShape(profile.zoneShape);
    setQuickRecenter(false);
    setMessage("Profile changed; the unsaved calibration draft was cleared.");
  }, [profile.id, profile.mode, profile.marginPercent, profile.zoneShape]);

  useEffect(() => () => {
    captured.current = [];
    captureRef.current = null;
  }, []);

  const elapsed = capture ? TOTAL_CAPTURE_MS - capture.remainingMs : 0;
  const isCountdown = capture != null && elapsed < COUNTDOWN_MS;
  const countdown = isCountdown ? Math.max(1, Math.ceil((COUNTDOWN_MS - elapsed) / 1000)) : 0;
  const progressPercent = capture ? Math.round((Math.min(CAPTURE_MS, Math.max(0, elapsed - COUNTDOWN_MS)) / CAPTURE_MS) * 100) : 0;
  const diagnostics = result?.targetDiagnostics ?? [];
  const saveAction = result ? saveCalibration : saveZoneSettings;

  return (
    <section className="attention-calibration" aria-labelledby="attention-calibration-title" role="tabpanel" id="attention-calibration-panel">
      <div className="attention-section-heading">
        <div>
          <h3 id="attention-calibration-title">Guided {profile.mode.toUpperCase()} calibration</h3>
          <p>{profile.mode === "screen" ? "Sample the center, four screen corners, and four directions just outside your normal work area." : "Sample the reading area plus four intentional off-page directions to estimate overlap."}</p>
        </div>
        <span className={`attention-profile-state ${profile.calibratedAt ? "is-calibrated" : ""}`}>{profile.calibratedAt ? "RECALIBRATE" : "SET UP"}</span>
      </div>

      <div className="attention-calibration-layout">
        <div className="attention-calibration-main">
          <section className="attention-calibration-prechecks" aria-labelledby="attention-precheck-title">
            <div className="attention-calibration-subheading">
              <div><h4 id="attention-precheck-title">Live prechecks</h4><p>Only capture when the checks below are ready.</p></div>
              {cameraStatus !== "on" && (
                <button type="button" className="attention-secondary-button" onClick={cameraStatus === "starting" ? onStopCalibrationCamera : onStartCalibrationCamera}>
                  {cameraStatus === "starting" ? "Cancel camera startup" : cameraStatus === "error" ? "Retry camera setup" : "Start temporary camera"}
                </button>
              )}
            </div>
            {cameraStatus === "error" && <p className="attention-error" role="alert">{cameraError || "Camera setup failed. Retry or choose another camera."}</p>}
            <ul className="attention-precheck-list">
              {prechecks.map((check) => (
                <li key={check.label} className={`is-${check.state}`}>
                  <span aria-hidden="true" />
                  <div><strong>{check.label}</strong><small>{check.detail}</small></div>
                  <b>{check.state === "pass" ? "READY" : check.state === "blocked" ? "CHECK" : check.state === "info" ? "OPTIONAL" : "WAIT"}</b>
                </li>
              ))}
            </ul>
            <p className="attention-calibration-privacy">The camera is on only because you explicitly started it. Temporary numeric signal samples stay in this page's memory and are discarded when you clear or leave calibration.</p>
          </section>

          <div className="attention-calibration-target-card">
            <div className="attention-calibration-subheading">
              <div>
                <h4>{quickRecenter ? "Quick re-center" : "Calibration targets"}</h4>
                <p>{quickRecenter ? "Only the center baseline will change; the existing zone will be preserved." : "Follow each visible target. You can retake a target before saving."}</p>
              </div>
              {profile.calibratedAt != null && !quickRecenter && (
                <button type="button" className="attention-link-button" onClick={startQuickRecenter} disabled={!canCapture || Boolean(capture)} title={hasDraftTargets ? "Temporary target samples will be cleared before recentering." : "Capture a fresh center while keeping the saved tolerance."}>
                  Quick re-center
                </button>
              )}
            </div>

            <CalibrationMap
              mode={profile.mode}
              targets={targets}
              samples={samples}
              currentTargetId={currentTargetId}
            />

            {currentTarget && !quickRecenter && (
              <div className="attention-current-target" aria-live="polite">
                <span>Next target</span>
                <strong>{currentTarget.label}</strong>
                <p>{currentTarget.instruction}</p>
              </div>
            )}

            {capture && (
              <div className="attention-capture-banner" role="status" aria-live="polite">
                <div className="attention-capture-countdown" aria-hidden="true">{isCountdown ? countdown : "●"}</div>
                <div className="attention-capture-copy">
                  <strong>{isCountdown ? `Get ready · ${countdown}` : "Capturing numeric signals"}</strong>
                  <span>{targets.find((target) => target.id === capture.targetId)?.label ?? "Center"} · {capture.sampleCount} valid frames</span>
                  <div className="attention-progress-track" role="progressbar" aria-label="Target capture progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
                    <i style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
                <button type="button" className="attention-cancel-capture" onClick={cancelCapture}>Cancel</button>
              </div>
            )}

            {quickRecenter ? (
              <div className="attention-quick-recenter-actions">
                {canApplyQuickRecenter && <button type="button" className="panel-primary" onClick={applyQuickRecenter}>Save new center</button>}
                <button type="button" className="attention-secondary-button" onClick={() => { clearDraft(); setMessage("Quick re-center cancelled; saved profile is unchanged."); }} disabled={Boolean(capture)}>Cancel quick re-center</button>
              </div>
            ) : (
              <ol className="attention-calibration-target-list">
                {targets.map((target, index) => {
                  const count = samples[target.id]?.length ?? 0;
                  const complete = count >= CALIBRATION_MIN_SAMPLES;
                  return (
                    <li key={target.id} className={`${complete ? "is-complete" : ""} ${capture?.targetId === target.id ? "is-current" : ""} ${target.kind === "negative" ? "is-negative" : ""}`}>
                      <span className="attention-step-number">{index + 1}</span>
                      <div className="attention-step-copy">
                        <strong>{target.label}{target.kind === "negative" ? profile.mode === "screen" ? " · off-screen" : " · off-page" : ""}</strong>
                        <small>{complete ? `${count} usable numeric samples` : target.kind === "negative" ? "Capture an intentional off-task direction." : "Capture this comfortable on-task direction."}</small>
                      </div>
                      <button type="button" className="attention-secondary-button" onClick={() => startCapture(target.id)} disabled={!canCapture || Boolean(capture)} title={!canCapture || capture ? captureDisabledHint : undefined}>
                        {capture?.targetId === target.id ? "Capturing…" : complete ? "Retake" : "Capture"}
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}

            {result && (
              <section className="attention-calibration-result" aria-labelledby="attention-calibration-result-title">
                <div className="attention-calibration-subheading">
                  <div><h4 id="attention-calibration-result-title">Measured signal response</h4><p>Values are each target's robust median minus the center baseline. Signs are measured locally; they are not assumed.</p></div>
                </div>
                <div className="attention-direction-table-wrap">
                  <table className="attention-direction-table">
                    <thead><tr><th>Target</th><th>Δ yaw</th><th>Δ pitch</th><th>Δ gaze X</th><th>Δ gaze Y</th></tr></thead>
                    <tbody>
                      {diagnostics.map((diagnostic) => (
                        <tr key={diagnostic.id} className={diagnostic.kind === "negative" ? "is-negative" : ""}>
                          <th scope="row">{diagnostic.label}</th>
                          <td>{formatDelta(diagnostic.yawDelta)}°</td>
                          <td>{formatDelta(diagnostic.pitchDelta)}°</td>
                          <td>{formatDelta(diagnostic.gazeXDelta)}</td>
                          <td>{formatDelta(diagnostic.gazeYDelta)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.negativeOverlap != null && (
                  <div className={`attention-overlap-status ${result.negativeOverlap >= 0.15 ? "is-warning" : result.negativeOverlap > 0.03 ? "is-caution" : "is-clear"}`} role="status">
                    <strong>{Math.round(result.negativeOverlap * 100)}% off-target overlap</strong>
                    <span>{result.negativeOverlap >= 0.15 ? "The proposed zone includes too many intentionally off-target samples." : result.negativeOverlap > 0.03 ? "Some off-target samples overlap; verify the zone in the Test Lab." : "No captured off-target samples fall inside the proposed zone."}</span>
                  </div>
                )}
                {result.warnings.length > 0 && (
                  <ul className="attention-calibration-warnings">
                    {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                )}
              </section>
            )}

            <section className="attention-calibration-zone-editor" aria-labelledby="attention-zone-editor-title">
              <div className="attention-calibration-subheading">
                <div><h4 id="attention-zone-editor-title">Zone shape and margin</h4><p>Wider margins accept more natural movement, but can include off-task samples.</p></div>
                <span className="attention-zone-margin-value">{marginPercent}%</span>
              </div>
              <div className="attention-zone-shape" role="group" aria-label="Attention zone shape">
                <button type="button" aria-pressed={zoneShape === "rectangle"} className={zoneShape === "rectangle" ? "active" : ""} onClick={() => setZoneShape("rectangle")}>Rectangle</button>
                <button type="button" aria-pressed={zoneShape === "ellipse"} className={zoneShape === "ellipse" ? "active" : ""} onClick={() => setZoneShape("ellipse")}>Ellipse</button>
              </div>
              <label className="attention-margin-control">
                <span><b>Margin</b><small>Applied to robust on-task spread</small></span>
                <input type="range" min="0" max="80" step="5" value={marginPercent} onChange={(event) => setMarginPercent(Number(event.target.value))} aria-label="Calibration margin percent" />
                <output>{marginPercent}%</output>
              </label>
              <div className="attention-zone-numbers" aria-label="Preview zone ranges">
                <span>Yaw ±{previewZone.yawDeg.toFixed(1)}°</span>
                <span>Pitch ±{previewZone.pitchDeg.toFixed(1)}°</span>
                <span>Gaze X ±{previewZone.gazeX.toFixed(2)}</span>
                <span>Gaze Y ±{previewZone.gazeY.toFixed(2)}</span>
              </div>
              {profile.calibratedAt != null && !result && profile.negativeOverlap != null && hasToleranceEdits && (
                <p className="attention-inline-message">The saved {Math.round(profile.negativeOverlap * 100)}% overlap estimate applies to the old zone. Raw samples were not retained, so this preview cannot recalculate overlap until you run a full calibration.</p>
              )}
              <div className="attention-calibration-actions">
                <button type="button" className="panel-primary" onClick={saveAction} disabled={!canSave} title={!canSave ? saveDisabledHint : undefined}>
                  {result ? profile.calibratedAt ? "Save updated calibration" : "Save calibration" : "Save zone settings"}
                </button>
                <button type="button" className="attention-secondary-button" onClick={clearDraft} disabled={!Object.keys(samples).length && !capture && !quickRecenter}>Clear draft</button>
              </div>
            </section>
          </div>
        </div>

        <aside className="attention-calibration-sidebar">
          <div className="attention-calibration-summary-card">
            <h4>Current target</h4>
            <div className="attention-current-target-label">{currentTarget?.label ?? (profile.calibratedAt ? "Saved profile" : "Waiting for capture")}</div>
            <p>{capture ? isCountdown ? `Look at the target in ${countdown}…` : "Hold your gaze naturally while the local samples are collected." : currentTarget?.instruction ?? "Capture a target to continue."}</p>
            <span className={`attention-calibration-state ${capture ? "is-capturing" : currentTarget && (samples[currentTarget.id]?.length ?? 0) >= CALIBRATION_MIN_SAMPLES ? "is-ready" : ""}`}>
              {capture ? `${capture.sampleCount} valid frames` : result ? "ALL TARGETS READY" : currentTarget ? "TARGET REQUIRED" : "SAVED PROFILE"}
            </span>
          </div>
          <div className="attention-calibration-signal-card">
            <h4>Latest local signals</h4>
            <dl>
              <div><dt>Face</dt><dd>{signals?.facePresent ? "Found" : tracking ? "Not found" : "Camera off"}</dd></div>
              <div><dt>Yaw</dt><dd>{signals?.yawDeg == null ? "—" : `${signals.yawDeg.toFixed(1)}°`}</dd></div>
              <div><dt>Pitch</dt><dd>{signals?.pitchDeg == null ? "—" : `${signals.pitchDeg.toFixed(1)}°`}</dd></div>
              <div><dt>Gaze X / Y</dt><dd>{signals?.gazeX == null || signals.gazeY == null ? "—" : `${signals.gazeX.toFixed(2)} / ${signals.gazeY.toFixed(2)}`}</dd></div>
              <div><dt>Light</dt><dd>{signals?.brightness == null ? "—" : `${Math.round(signals.brightness * 100)}%`}</dd></div>
            </dl>
            <p>These are approximate pose and eye-box estimates, not a clinical or screen-calibrated eye tracker.</p>
          </div>
          {message && <p className="attention-inline-message" role="status">{message}</p>}
        </aside>
      </div>
      <p className="attention-calibration-caveat">Use your normal camera, lighting, chair, screen or book position. Retest the boundaries in the Test Lab; webcam gaze estimates vary with device, glasses, occlusion and posture.</p>
    </section>
  );
}
