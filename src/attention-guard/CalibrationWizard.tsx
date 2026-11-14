import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AttentionGuardController } from "./controller";
import {
  calculateSessionCalibration,
  CALIBRATION_SESSION_MIN_SAMPLES,
  isCalibrationSignalValid,
  scaleAttentionZone,
  type CalibrationSessionPhase,
  type CalibrationSessionSamples,
} from "./calibration";
import type { AttentionProfile } from "./profile";
import type { GuardStatus, RawAttentionSignals } from "./types";

const PREPARE_MS = 2_500;
const PHASE_CAPTURE_MS = 60_000;
const TOTAL_PHASE_MS = PREPARE_MS + PHASE_CAPTURE_MS;
const MAX_PHASE_SAMPLES = 3_000;

type CaptureProgress = {
  phase: CalibrationSessionPhase;
  startedAt: number;
  remainingMs: number;
  sampleCount: number;
};

type Precheck = {
  label: string;
  detail: string;
  state: "pass" | "waiting" | "blocked" | "info";
};

const EMPTY_SAMPLES: CalibrationSessionSamples = { focused: [], offTask: [] };

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

function phaseCopy(mode: AttentionProfile["mode"], phase: CalibrationSessionPhase) {
  if (phase === "focused") {
    return mode === "screen"
      ? "Work at your screen as you normally do. Let your eyes and head move naturally across the parts of the screen you use."
      : "Read your book as you normally do. Let your eyes and head move naturally across the page.";
  }
  return mode === "screen"
    ? "Intentionally look away toward ordinary non-work places around you—up, down, left, and right. Vary your direction naturally while keeping your face in frame."
    : "Intentionally look away from the page toward ordinary places around you—up, down, left, and right. Vary your direction naturally while keeping your face in frame.";
}

function phaseLabel(phase: CalibrationSessionPhase) {
  return phase === "focused" ? "Normal work or reading" : "Intentional off-task looks";
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
  onSave: (profile: AttentionProfile) => boolean | void;
}) {
  const signals = useSyncExternalStore(controller.subscribeSignals, controller.getSignals, controller.getSignals);
  const [samples, setSamples] = useState<CalibrationSessionSamples>(EMPTY_SAMPLES);
  const samplesRef = useRef<CalibrationSessionSamples>(EMPTY_SAMPLES);
  const [capture, setCapture] = useState<CaptureProgress | null>(null);
  const [marginPercent, setMarginPercent] = useState(profile.marginPercent);
  const [zoneShape, setZoneShape] = useState<AttentionProfile["zoneShape"]>(profile.zoneShape);
  const [message, setMessage] = useState("");
  const captureBuffer = useRef<RawAttentionSignals[]>([]);
  const captureRef = useRef<CaptureProgress | null>(null);
  const lastSampledAt = useRef<number | null>(null);
  const profileIdentity = useRef(`${profile.mode}:${profile.id}`);
  const tracking = cameraStatus === "on";
  const prechecks = calibrationPrechecks(signals, cameraStatus, profile);
  const canCapture = tracking && prechecks.every((check) => check.state === "pass" || check.state === "info");
  const captureBlocker = prechecks.find((check) => check.state === "blocked" || check.state === "waiting");
  const captureDisabledHint = capture
    ? "Finish this 60-second capture or cancel it before starting another."
    : captureBlocker ? `${captureBlocker.label}: ${captureBlocker.detail}` : "Start the temporary camera and complete the live checks first.";
  const result = useMemo(
    () => calculateSessionCalibration(profile.mode, samples, marginPercent, zoneShape, profile.tuning),
    [marginPercent, profile.mode, profile.tuning, samples, zoneShape],
  );
  const storedZoneScale = (100 + marginPercent) / (100 + profile.marginPercent);
  const previewZone = result?.zone ?? (profile.calibratedAt != null ? scaleAttentionZone(profile.zone, storedZoneScale) : profile.zone);
  const hasToleranceEdits = marginPercent !== profile.marginPercent || zoneShape !== profile.zoneShape;
  const focusedCount = samples.focused.length;
  const offTaskCount = samples.offTask.length;
  const canSave = result != null || (profile.calibratedAt != null && hasToleranceEdits);
  const saveDisabledHint = result == null
    ? `Capture at least ${CALIBRATION_SESSION_MIN_SAMPLES} valid samples in both 60-second phases before saving a new calibration.`
    : "";

  function startCapture(phase: CalibrationSessionPhase) {
    if (!canCapture) {
      setMessage("Start the temporary camera and complete the live checks before capturing.");
      return;
    }
    if (samplesRef.current[phase].length >= MAX_PHASE_SAMPLES) {
      setMessage("This phase already has plenty of samples. Clear the draft before replacing them.");
      return;
    }
    captureBuffer.current = [];
    lastSampledAt.current = signals?.sampledAt ?? null;
    const progress = {
      phase,
      startedAt: performance.now(),
      remainingMs: TOTAL_PHASE_MS,
      sampleCount: 0,
    };
    captureRef.current = progress;
    setCapture(progress);
    setMessage(`${phaseLabel(phase)} capture started. Follow the prompt for one minute; valid local signal samples are collected automatically.`);
  }

  function finishCapture(phase: CalibrationSessionPhase, startedAt: number) {
    const active = captureRef.current;
    if (!active || active.phase !== phase || active.startedAt !== startedAt) return;

    const collected = captureBuffer.current;
    captureBuffer.current = [];
    captureRef.current = null;
    setCapture(null);

    if (collected.length < CALIBRATION_SESSION_MIN_SAMPLES) {
      setMessage(`Only ${collected.length} valid samples were collected in this minute; ${CALIBRATION_SESSION_MIN_SAMPLES} are needed. Improve lighting or camera position and add another capture. Earlier captures are kept.`);
      return;
    }

    const current = samplesRef.current;
    const combined = [...current[phase], ...collected].slice(-MAX_PHASE_SAMPLES);
    const next = { ...current, [phase]: combined };
    samplesRef.current = next;
    setSamples(next);
    setMessage(`${phaseLabel(phase)}: added ${collected.length} valid samples (${combined.length} total). You can add another one-minute capture or continue to the other phase.`);
  }

  function cancelCapture() {
    captureBuffer.current = [];
    captureRef.current = null;
    setCapture(null);
    setMessage("This one-minute capture was discarded; previous phase samples are unchanged.");
  }

  function clearDraft() {
    captureBuffer.current = [];
    captureRef.current = null;
    samplesRef.current = EMPTY_SAMPLES;
    setCapture(null);
    setSamples(EMPTY_SAMPLES);
    setMessage("Unsaved calibration samples cleared from this window.");
  }

  function saveCalibration() {
    if (!result) {
      setMessage("Complete both focused and off-task captures before saving a new calibration.");
      return;
    }
    const now = Date.now();
    const saved = onSave({
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
    setMessage(saved === false
      ? "Calibration was calculated, but this browser could not save it locally. Check this site's storage permissions and try again."
      : `Calibration saved on this device from ${result.sampleCount} numeric samples. Raw camera frames and signal samples were not saved.`);
  }

  function saveZoneSettings() {
    if (profile.calibratedAt == null || !hasToleranceEdits) return;
    const now = Date.now();
    const saved = onSave({
      ...profile,
      zone: scaleAttentionZone(profile.zone, storedZoneScale),
      zoneShape,
      marginPercent,
      negativeOverlap: null,
      updatedAt: now,
    });
    setMessage(saved === false
      ? "Zone settings changed, but this browser could not save them locally. Check this site's storage permissions and try again."
      : "Zone settings saved on this device. The overlap estimate was cleared because raw calibration samples are not retained.");
  }

  useEffect(() => {
    const active = captureRef.current;
    if (!active || !signals || signals.sampledAt === lastSampledAt.current) return;
    lastSampledAt.current = signals.sampledAt;
    if (signals.sampledAt - active.startedAt < PREPARE_MS || !isCalibrationSignalValid(signals, profile)) return;
    if (captureBuffer.current.length >= MAX_PHASE_SAMPLES) return;

    captureBuffer.current.push(signals);
    const updated = { ...active, sampleCount: captureBuffer.current.length };
    captureRef.current = updated;
    setCapture(updated);
  }, [capture?.phase, capture?.startedAt, profile, signals]);

  useEffect(() => {
    if (!capture) return;
    const phase = capture.phase;
    const startedAt = capture.startedAt;
    const timer = window.setInterval(() => {
      const active = captureRef.current;
      if (!active || active.phase !== phase || active.startedAt !== startedAt) return;
      const elapsed = performance.now() - startedAt;
      const updated = {
        ...active,
        remainingMs: Math.max(0, TOTAL_PHASE_MS - elapsed),
        sampleCount: captureBuffer.current.length,
      };
      captureRef.current = updated;
      setCapture(updated);
      if (updated.remainingMs === 0) finishCapture(phase, startedAt);
    }, 100);
    return () => window.clearInterval(timer);
  }, [capture?.phase, capture?.startedAt]);

  useEffect(() => {
    if (cameraStatus === "on" || !captureRef.current) return;
    captureBuffer.current = [];
    captureRef.current = null;
    setCapture(null);
    setMessage("The camera stopped, so the active minute was cancelled. Samples from earlier completed captures are kept.");
  }, [cameraStatus]);

  useEffect(() => {
    const identity = `${profile.mode}:${profile.id}`;
    if (profileIdentity.current === identity) return;
    profileIdentity.current = identity;
    captureBuffer.current = [];
    captureRef.current = null;
    samplesRef.current = EMPTY_SAMPLES;
    setCapture(null);
    setSamples(EMPTY_SAMPLES);
    setMarginPercent(profile.marginPercent);
    setZoneShape(profile.zoneShape);
    setMessage("The active profile changed; the previous unsaved draft was cleared.");
  }, [profile.id, profile.mode, profile.marginPercent, profile.zoneShape]);

  useEffect(() => () => {
    captureBuffer.current = [];
    captureRef.current = null;
  }, []);

  const elapsed = capture ? TOTAL_PHASE_MS - capture.remainingMs : 0;
  const isCountdown = capture != null && elapsed < PREPARE_MS;
  const countdown = isCountdown ? Math.max(1, Math.ceil((PREPARE_MS - elapsed) / 1000)) : 0;
  const progressPercent = capture ? Math.round((Math.min(PHASE_CAPTURE_MS, Math.max(0, elapsed - PREPARE_MS)) / PHASE_CAPTURE_MS) * 100) : 0;
  const phaseProgress = result?.targetDiagnostics ?? [];
  const saveAction = result ? saveCalibration : saveZoneSettings;

  return (
    <section className="attention-calibration" aria-labelledby="attention-calibration-title">
      <div className="attention-section-heading">
        <div>
          <div className="attention-kicker">Private · local camera signals only</div>
          <h2 id="attention-calibration-title">Calibrate {profile.mode === "screen" ? "screen" : "book"} work area</h2>
          <p>Two one-minute phases learn your normal work or reading range and compare it with intentional off-task looks.</p>
        </div>
        <span className={`attention-profile-state ${profile.calibratedAt ? "is-calibrated" : ""}`}>{profile.calibratedAt ? "RECALIBRATE" : "SET UP"}</span>
      </div>

      <div className="attention-calibration-layout">
        <div className="attention-calibration-main">
          <section className="attention-calibration-prechecks" aria-labelledby="attention-precheck-title">
            <div className="attention-calibration-subheading">
              <div><h3 id="attention-precheck-title">Camera and signal checks</h3><p>Start the temporary camera once. It is not a Focus tracking run.</p></div>
              {cameraStatus === "on" ? (
                <button type="button" className="attention-secondary-button" onClick={onStopCalibrationCamera}>Stop temporary camera</button>
              ) : (
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
          </section>

          <section className="attention-session-card" aria-labelledby="attention-session-title">
            <div className="attention-calibration-subheading">
              <div><h3 id="attention-session-title">Two natural-viewing captures</h3><p>No fixed target clicking: keep working or reading naturally for one minute per phase.</p></div>
              <span className="attention-session-minimum">{CALIBRATION_SESSION_MIN_SAMPLES} valid samples / phase</span>
            </div>

            {(["focused", "offTask"] as const).map((phase, index) => {
              const count = samples[phase].length;
              const active = capture?.phase === phase;
              const complete = count >= CALIBRATION_SESSION_MIN_SAMPLES;
              const canAdd = count < MAX_PHASE_SAMPLES;
              return (
                <div key={phase} className={`attention-session-phase ${active ? "is-capturing" : complete ? "is-complete" : ""}`}>
                  <div className="attention-session-phase-copy">
                    <span className="attention-step-number">{index + 1}</span>
                    <div>
                      <strong>{phaseLabel(phase)}</strong>
                      <p>{phaseCopy(profile.mode, phase)}</p>
                      <small>{count ? `${count} valid local samples collected` : "No samples yet"}</small>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="attention-secondary-button"
                    onClick={() => startCapture(phase)}
                    disabled={!canCapture || Boolean(capture) || !canAdd}
                    title={!canCapture || capture || !canAdd ? captureDisabledHint : undefined}
                  >
                    {active ? "Capturing…" : count ? "Add another 60-second capture" : "Capture for 60 seconds"}
                  </button>
                </div>
              );
            })}

            {capture && (
              <div className="attention-capture-banner" role="status" aria-live="polite">
                <div className="attention-capture-countdown" aria-hidden="true">{isCountdown ? countdown : "●"}</div>
                <div className="attention-capture-copy">
                  <strong>{isCountdown ? `Get ready · ${countdown}` : `Capturing ${phaseLabel(capture.phase).toLowerCase()}`}</strong>
                  <span>{capture.sampleCount} valid frames · {Math.ceil(capture.remainingMs / 1000)} seconds remaining</span>
                  <div className="attention-progress-track" role="progressbar" aria-label="One-minute calibration capture progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
                    <i style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
                <button type="button" className="attention-cancel-capture" onClick={cancelCapture}>Cancel</button>
              </div>
            )}

            <p className="attention-session-privacy">The camera model collects only temporary numeric head-pose and coarse eye-box estimates during these explicit captures. Images, video, and raw samples are not saved.</p>
          </section>

          {result && (
            <section className="attention-calibration-result" aria-labelledby="attention-calibration-result-title">
              <div className="attention-calibration-subheading">
                <div><h3 id="attention-calibration-result-title">Calibration preview</h3><p>Robust ranges from normal work or reading, checked against the separate off-task capture.</p></div>
              </div>
              <div className="attention-direction-table-wrap">
                <table className="attention-direction-table">
                  <thead><tr><th>Capture</th><th>Δ yaw</th><th>Δ pitch</th><th>Δ gaze X</th><th>Δ gaze Y</th></tr></thead>
                  <tbody>
                    {phaseProgress.map((diagnostic) => (
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
                  <strong>{Math.round(result.negativeOverlap * 100)}% off-task overlap</strong>
                  <span>{result.negativeOverlap >= 0.15 ? "Some intentional off-task samples fall inside the work zone." : result.negativeOverlap > 0.03 ? "A few off-task samples overlap; verify the boundary in Test Area." : "The collected off-task samples stayed outside the proposed zone."}</span>
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
              <div><h3 id="attention-zone-editor-title">Zone shape and margin</h3><p>The margin makes the saved work zone more or less tolerant of natural variation.</p></div>
              <span className="attention-zone-margin-value">{marginPercent}%</span>
            </div>
            <div className="attention-zone-shape" role="group" aria-label="Attention zone shape">
              <button type="button" aria-pressed={zoneShape === "rectangle"} className={zoneShape === "rectangle" ? "active" : ""} onClick={() => setZoneShape("rectangle")}>Rectangle</button>
              <button type="button" aria-pressed={zoneShape === "ellipse"} className={zoneShape === "ellipse" ? "active" : ""} onClick={() => setZoneShape("ellipse")}>Ellipse</button>
            </div>
            <label className="attention-margin-control">
              <span><b>Margin</b><small>Applied to the focused-sample spread</small></span>
              <input type="range" min="0" max="80" step="5" value={marginPercent} onChange={(event) => setMarginPercent(Number(event.target.value))} aria-label="Calibration margin percent" />
              <output>{marginPercent}%</output>
            </label>
            <div className="attention-zone-numbers" aria-label="Preview zone ranges">
              <span>Yaw ±{previewZone.yawDeg.toFixed(1)}°</span>
              <span>Pitch ±{previewZone.pitchDeg.toFixed(1)}°</span>
              <span>Gaze X ±{previewZone.gazeX.toFixed(2)}</span>
              <span>Gaze Y ±{previewZone.gazeY.toFixed(2)}</span>
            </div>
            {profile.calibratedAt != null && !result && hasToleranceEdits && (
              <p className="attention-inline-message">This changes only the saved zone tolerance; off-task overlap cannot be recalculated without a new two-phase capture.</p>
            )}
            <div className="attention-calibration-actions">
              <button type="button" className="panel-primary" onClick={saveAction} disabled={!canSave} title={!canSave ? saveDisabledHint : undefined}>
                {result ? profile.calibratedAt ? "Save updated calibration" : "Save calibration" : "Save zone settings"}
              </button>
              <button type="button" className="attention-secondary-button" onClick={clearDraft} disabled={!focusedCount && !offTaskCount && !capture}>Clear draft</button>
            </div>
          </section>
        </div>

        <aside className="attention-calibration-sidebar">
          <div className="attention-calibration-summary-card">
            <h3>Calibration progress</h3>
            <div className="attention-current-target-label">{result ? "Both phases ready" : focusedCount < CALIBRATION_SESSION_MIN_SAMPLES ? "Normal work or reading next" : "Intentional off-task looks next"}</div>
            <p>{result ? `${result.sampleCount} valid numeric samples are ready to save.` : `Focused: ${focusedCount} samples · Off-task: ${offTaskCount} samples. Capture at least ${CALIBRATION_SESSION_MIN_SAMPLES} in each phase.`}</p>
            <span className={`attention-calibration-state ${result ? "is-ready" : capture ? "is-capturing" : ""}`}>
              {capture ? `${capture.sampleCount} frames this minute` : result ? "READY TO SAVE" : "IN PROGRESS"}
            </span>
          </div>
          <div className="attention-calibration-signal-card">
            <h3>Latest local signals</h3>
            <dl>
              <div><dt>Face</dt><dd>{signals?.facePresent ? "Found" : tracking ? "Not found" : "Camera off"}</dd></div>
              <div><dt>Yaw</dt><dd>{signals?.yawDeg == null ? "—" : `${signals.yawDeg.toFixed(1)}°`}</dd></div>
              <div><dt>Pitch</dt><dd>{signals?.pitchDeg == null ? "—" : `${signals.pitchDeg.toFixed(1)}°`}</dd></div>
              <div><dt>Gaze X / Y</dt><dd>{signals?.gazeX == null || signals.gazeY == null ? "—" : `${signals.gazeX.toFixed(2)} / ${signals.gazeY.toFixed(2)}`}</dd></div>
              <div><dt>Light</dt><dd>{signals?.brightness == null ? "—" : `${Math.round(signals.brightness * 100)}%`}</dd></div>
            </dl>
            <p>These are approximate head-pose and eye-box estimates, not pixel-accurate gaze tracking.</p>
          </div>
          {message && <p className="attention-inline-message" role="status">{message}</p>}
        </aside>
      </div>
      <p className="attention-calibration-caveat">Use your usual camera, chair, lighting, screen or book position. Focus and off-task captures estimate webcam direction only; they do not detect phones or identify what you are looking at.</p>
    </section>
  );
}
