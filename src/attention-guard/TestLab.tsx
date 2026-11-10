import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { computeAttentionScore, createClassifierMemory, updateAttentionClassifier, type ClassifierMemory } from "./classifier";
import type { AttentionGuardController } from "./controller";
import { isCalibrationSignalValid } from "./calibration";
import type { AttentionClassifierTuning, AttentionProfile, AttentionZone } from "./profile";
import type { AttentionClassification, GuardRunPurpose, GuardStatus, RawAttentionSignals } from "./types";
import {
  createSimulatedSignals,
  createSimulatorMemory,
  suggestSensitivity,
  summarizeAttentionTest,
  TEST_SCENARIOS,
  type AttentionTestSummary,
  type SensitivitySuggestion,
  type TestScenario,
} from "./testLab";

const LIVE_TEST_DURATION_MS = 30_000;
const SELF_TEST_PHASE_MS = 5_000;
const SELF_TEST_DURATION_MS = SELF_TEST_PHASE_MS * 3;

type TestLabProps = {
  controller: AttentionGuardController;
  profile: AttentionProfile;
  cameraStatus: GuardStatus;
  runPurpose: GuardRunPurpose | null;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onSaveProfile: (profile: AttentionProfile) => void;
};

type LiveTestRun = {
  startedAt: number;
  lastSampledAt: number | null;
  memory: ClassifierMemory;
  observations: AttentionClassification[];
};

type LiveTestState = {
  status: "idle" | "running" | "complete" | "cancelled";
  startedAt: number | null;
  elapsedMs: number;
  sampleCount: number;
  summary: AttentionTestSummary | null;
};

type SelfTestPhase = "center" | "glance" | "recovery";
type SelfTestScores = Record<SelfTestPhase, number[]>;
type SelfTestRun = {
  startedAt: number;
  lastSampledAt: number | null;
  scores: SelfTestScores;
};
type SelfTestState = {
  status: "idle" | "running" | "complete" | "cancelled";
  startedAt: number | null;
  elapsedMs: number;
  phase: SelfTestPhase | null;
  sampleCounts: Record<SelfTestPhase, number>;
  suggestion: SensitivitySuggestion | null;
  message: string;
};
type SimulatorState = {
  active: boolean;
  scenario: TestScenario;
  startedAt: number | null;
  elapsedMs: number;
  classification: AttentionClassification | null;
  history: AttentionClassification[];
};
type SimulatorRun = {
  startedAt: number;
  scenario: TestScenario;
  memory: ClassifierMemory;
};

const EMPTY_COUNTS: Record<SelfTestPhase, number> = { center: 0, glance: 0, recovery: 0 };

function scoreText(score: number | null) {
  return score == null || !Number.isFinite(score) ? "—" : score.toFixed(2);
}

function phaseText(phase: AttentionClassification["phase"] | "preview-attentive" | "preview-level1" | "preview-level2" | "waiting") {
  const labels: Record<typeof phase, string> = {
    waiting: "Waiting for a live signal",
    "needs-calibration": "Calibration needed",
    attentive: "In calibrated zone",
    drifting: "Drifting",
    away: "Outside zone",
    "face-missing": "Face not detected",
    "low-quality": "Low-quality signal",
    "preview-attentive": "No warning predicted",
    "preview-level1": "Level 1 preview",
    "preview-level2": "Level 2 preview",
  };
  return labels[phase];
}

function previewPhase(signals: RawAttentionSignals | null, score: number | null, profile: AttentionProfile) {
  if (profile.calibratedAt == null || !profile.baseline) return "needs-calibration" as const;
  if (!signals) return "waiting" as const;
  if (!signals.facePresent) return "face-missing" as const;
  if (signals.brightness != null && signals.brightness < profile.tuning.lowLightFloor) return "low-quality" as const;
  if (signals.faceWidth != null && signals.faceWidth < profile.tuning.minFaceWidth) return "low-quality" as const;
  if (score == null) return "low-quality" as const;
  if (score >= profile.tuning.level2Score) return "preview-level2" as const;
  if (score >= profile.tuning.level1Score) return "preview-level1" as const;
  return "preview-attentive" as const;
}

function SignalTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="attention-signal"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function TestNumberField({
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
    <label className="field compact attention-number-field attention-lab-number-field">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => {
        const parsed = Number(event.target.value);
        if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
      }} />
    </label>
  );
}

function TestSummary({ summary }: { summary: AttentionTestSummary }) {
  return (
    <div className="attention-test-summary" aria-label="Thirty-second test summary">
      <div><strong>{summary.onTaskPercent}%</strong><span>on-task samples</span></div>
      <div><strong>{summary.driftingSamples + summary.awaySamples}</strong><span>drift samples</span></div>
      <div><strong>{summary.level1Events}</strong><span>level 1 events</span></div>
      <div><strong>{summary.level2Events}</strong><span>level 2 events</span></div>
      <div><strong>{summary.missingFaceSamples}</strong><span>missing face</span></div>
      <div><strong>{summary.lowQualitySamples}</strong><span>low-quality</span></div>
    </div>
  );
}

export default function TestLab({
  controller,
  profile,
  cameraStatus,
  runPurpose,
  onStartCamera,
  onStopCamera,
  onSaveProfile,
}: TestLabProps) {
  const signals = useSyncExternalStore(controller.subscribeSignals, controller.getSignals, controller.getSignals);
  const classification = useSyncExternalStore(controller.subscribeClassification, controller.getClassification, controller.getClassification);
  const [zoneDraft, setZoneDraft] = useState<AttentionZone>(profile.zone);
  const [shapeDraft, setShapeDraft] = useState<AttentionProfile["zoneShape"]>(profile.zoneShape);
  const [tuningDraft, setTuningDraft] = useState<AttentionClassifierTuning>(profile.tuning);
  const [message, setMessage] = useState("");
  const [liveTest, setLiveTest] = useState<LiveTestState>({ status: "idle", startedAt: null, elapsedMs: 0, sampleCount: 0, summary: null });
  const [selfTest, setSelfTest] = useState<SelfTestState>({ status: "idle", startedAt: null, elapsedMs: 0, phase: null, sampleCounts: EMPTY_COUNTS, suggestion: null, message: "" });
  const [simScenario, setSimScenario] = useState<TestScenario>("centered");
  const [simulator, setSimulator] = useState<SimulatorState>({ active: false, scenario: "centered", startedAt: null, elapsedMs: 0, classification: null, history: [] });
  const liveTestRef = useRef<LiveTestRun | null>(null);
  const selfTestRef = useRef<SelfTestRun | null>(null);
  const simulatorRef = useRef<SimulatorRun | null>(null);

  const labProfile = useMemo<AttentionProfile>(() => ({
    ...profile,
    zone: zoneDraft,
    zoneShape: shapeDraft,
    tuning: tuningDraft,
  }), [profile, shapeDraft, tuningDraft, zoneDraft]);
  const liveScore = signals ? computeAttentionScore(signals, labProfile) : null;
  const livePreview = previewPhase(signals, liveScore, labProfile);
  const zoneChanged = (Object.keys(zoneDraft) as Array<keyof AttentionZone>).some((key) => zoneDraft[key] !== profile.zone[key]);
  const tuningChanged = (Object.keys(tuningDraft) as Array<keyof AttentionClassifierTuning>).some((key) => tuningDraft[key] !== profile.tuning[key]);
  const overlapChanged = zoneChanged
    || shapeDraft !== profile.zoneShape
    || tuningDraft.poseWeight !== profile.tuning.poseWeight
    || tuningDraft.gazeWeight !== profile.tuning.gazeWeight;
  const labProfileChanged = zoneChanged || shapeDraft !== profile.zoneShape || tuningChanged;
  const testCameraActive = cameraStatus === "on" && runPurpose === "diagnostic";
  const focusCameraActive = cameraStatus === "on" && runPurpose === "focus";

  const finishLiveTest = useCallback(() => {
    const run = liveTestRef.current;
    if (!run) return;
    liveTestRef.current = null;
    setLiveTest({
      status: "complete",
      startedAt: run.startedAt,
      elapsedMs: LIVE_TEST_DURATION_MS,
      sampleCount: run.observations.length,
      summary: summarizeAttentionTest(run.observations),
    });
  }, []);

  const finishSelfTest = useCallback(() => {
    const run = selfTestRef.current;
    if (!run) return;
    selfTestRef.current = null;
    const suggestion = suggestSensitivity(run.scores.center, run.scores.glance, run.scores.recovery);
    const sampleCounts = {
      center: run.scores.center.length,
      glance: run.scores.glance.length,
      recovery: run.scores.recovery.length,
    };
    setSelfTest({
      status: "complete",
      startedAt: run.startedAt,
      elapsedMs: SELF_TEST_DURATION_MS,
      phase: null,
      sampleCounts,
      suggestion,
      message: suggestion ? suggestion.reason : "Not enough good frames were collected in each step. Improve lighting or camera position and try again.",
    });
  }, []);

  function startLiveTest() {
    if (cameraStatus !== "on") {
      setMessage("Start the temporary camera test first. No camera starts automatically from the Test Lab.");
      return;
    }
    const startedAt = performance.now();
    liveTestRef.current = { startedAt, lastSampledAt: null, memory: createClassifierMemory(), observations: [] };
    setLiveTest({ status: "running", startedAt, elapsedMs: 0, sampleCount: 0, summary: null });
    setMessage("Thirty-second test started. Only aggregate results will be shown; nothing is saved.");
  }

  function cancelLiveTest() {
    liveTestRef.current = null;
    setLiveTest((previous) => ({ ...previous, status: "cancelled", summary: null }));
    setMessage("Thirty-second test cancelled; no results were saved.");
  }

  function startGuidedSelfTest() {
    if (cameraStatus !== "on") {
      setMessage("Start the temporary camera test before the guided self-test.");
      return;
    }
    if (profile.calibratedAt == null || !profile.baseline) {
      setMessage("Complete a calibration before measuring center-versus-glance separation.");
      return;
    }
    const startedAt = performance.now();
    selfTestRef.current = {
      startedAt,
      lastSampledAt: null,
      scores: { center: [], glance: [], recovery: [] },
    };
    setSelfTest({ status: "running", startedAt, elapsedMs: 0, phase: "center", sampleCounts: { ...EMPTY_COUNTS }, suggestion: null, message: "Look at your normal work target for five seconds, then follow the prompts." });
    setMessage("Guided self-test started. It records only temporary numeric scores in this page.");
  }

  function cancelSelfTest() {
    selfTestRef.current = null;
    setSelfTest((previous) => ({ ...previous, status: "cancelled", phase: null, message: "Guided self-test cancelled; nothing was saved." }));
  }

  function applySelfTestSuggestion() {
    const suggestion = selfTest.suggestion;
    if (!suggestion?.separable || suggestion.level1Score == null || suggestion.level2Score == null) return;
    const nextTuning = { ...tuningDraft, level1Score: suggestion.level1Score, level2Score: suggestion.level2Score };
    const now = Date.now();
    setTuningDraft(nextTuning);
    onSaveProfile({
      ...profile,
      zone: zoneDraft,
      zoneShape: shapeDraft,
      tuning: nextTuning,
      negativeOverlap: overlapChanged ? null : profile.negativeOverlap,
      updatedAt: now,
    });
    setMessage("Suggested thresholds applied and saved locally. Review the live preview; the webcam estimate is approximate.");
  }

  function saveLabSettings() {
    if (!labProfileChanged) return;
    onSaveProfile({
      ...profile,
      zone: zoneDraft,
      zoneShape: shapeDraft,
      tuning: tuningDraft,
      negativeOverlap: overlapChanged ? null : profile.negativeOverlap,
      updatedAt: Date.now(),
    });
    setMessage("Test Lab zone and classifier settings saved to this local profile.");
  }

  function resetLabSettings() {
    setZoneDraft(profile.zone);
    setShapeDraft(profile.zoneShape);
    setTuningDraft(profile.tuning);
    setMessage("Test Lab edits reset to the saved profile.");
  }

  function updateTuning<K extends keyof AttentionClassifierTuning>(key: K, value: number) {
    setTuningDraft((previous) => {
      const next = { ...previous, [key]: value };
      if (key === "level1Score") next.level2Score = Math.max(next.level2Score, value + 0.15);
      if (key === "level2Score") next.level2Score = Math.max(value, next.level1Score + 0.15);
      return next;
    });
  }

  function startSimulator() {
    const startedAt = performance.now();
    const scenario = simScenario;
    simulatorRef.current = { startedAt, scenario, memory: createSimulatorMemory() };
    setSimulator({ active: true, scenario, startedAt, elapsedMs: 0, classification: null, history: [] });
  }

  function stopSimulator() {
    simulatorRef.current = null;
    setSimulator((previous) => ({ ...previous, active: false }));
  }

  useEffect(() => {
    setZoneDraft(profile.zone);
    setShapeDraft(profile.zoneShape);
    setTuningDraft(profile.tuning);
  }, [profile.id, profile.updatedAt, profile.zone, profile.zoneShape, profile.tuning]);

  useEffect(() => {
    if (cameraStatus === "on") return;
    if (liveTestRef.current) {
      const run = liveTestRef.current;
      liveTestRef.current = null;
      setLiveTest({
        status: "cancelled",
        startedAt: run.startedAt,
        elapsedMs: Math.min(LIVE_TEST_DURATION_MS, performance.now() - run.startedAt),
        sampleCount: run.observations.length,
        summary: null,
      });
    }
    if (selfTestRef.current) {
      const run = selfTestRef.current;
      selfTestRef.current = null;
      setSelfTest((previous) => ({
        ...previous,
        status: "cancelled",
        phase: null,
        elapsedMs: Math.min(SELF_TEST_DURATION_MS, performance.now() - run.startedAt),
        message: "Camera stopped; the guided self-test was cancelled and no results were saved.",
      }));
    }
  }, [cameraStatus]);

  useEffect(() => {
    if (!signals || signals.sampledAt === liveTestRef.current?.lastSampledAt) return;
    const run = liveTestRef.current;
    if (!run) return;
    run.lastSampledAt = signals.sampledAt;
    const update = updateAttentionClassifier(run.memory, signals, labProfile, signals.sampledAt);
    run.memory = update.memory;
    run.observations.push(update.classification);
    const elapsedMs = Math.min(LIVE_TEST_DURATION_MS, Math.max(0, signals.sampledAt - run.startedAt));
    setLiveTest((previous) => previous.status === "running"
      ? { ...previous, elapsedMs, sampleCount: run.observations.length }
      : previous);
    if (elapsedMs >= LIVE_TEST_DURATION_MS) finishLiveTest();
  }, [finishLiveTest, labProfile, signals]);

  useEffect(() => {
    if (!signals || signals.sampledAt === selfTestRef.current?.lastSampledAt) return;
    const run = selfTestRef.current;
    if (!run) return;
    run.lastSampledAt = signals.sampledAt;
    const elapsedMs = signals.sampledAt - run.startedAt;
    if (elapsedMs >= SELF_TEST_DURATION_MS) {
      finishSelfTest();
      return;
    }
    const phase: SelfTestPhase = elapsedMs < SELF_TEST_PHASE_MS ? "center" : elapsedMs < SELF_TEST_PHASE_MS * 2 ? "glance" : "recovery";
    const score = computeAttentionScore(signals, labProfile);
    if (score != null && isCalibrationSignalValid(signals, labProfile)) run.scores[phase].push(score);
    const sampleCounts = {
      center: run.scores.center.length,
      glance: run.scores.glance.length,
      recovery: run.scores.recovery.length,
    };
    setSelfTest((previous) => previous.status === "running" ? { ...previous, elapsedMs, phase, sampleCounts } : previous);
  }, [finishSelfTest, labProfile, signals]);

  useEffect(() => {
    if (liveTest.status !== "running" || liveTest.startedAt == null) return;
    const startedAt = liveTest.startedAt;
    const timer = window.setInterval(() => {
      if (!liveTestRef.current) return;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= LIVE_TEST_DURATION_MS) {
        finishLiveTest();
      } else {
        setLiveTest((previous) => previous.status === "running" ? { ...previous, elapsedMs } : previous);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [finishLiveTest, liveTest.startedAt, liveTest.status]);

  useEffect(() => {
    if (selfTest.status !== "running" || selfTest.startedAt == null) return;
    const startedAt = selfTest.startedAt;
    const timer = window.setInterval(() => {
      if (!selfTestRef.current) return;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= SELF_TEST_DURATION_MS) {
        finishSelfTest();
      } else {
        const phase: SelfTestPhase = elapsedMs < SELF_TEST_PHASE_MS ? "center" : elapsedMs < SELF_TEST_PHASE_MS * 2 ? "glance" : "recovery";
        setSelfTest((previous) => previous.status === "running" ? { ...previous, elapsedMs, phase } : previous);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [finishSelfTest, selfTest.startedAt, selfTest.status]);

  useEffect(() => {
    if (!simulator.active || simulator.startedAt == null) return;
    const run = simulatorRef.current;
    if (!run) return;
    const timer = window.setInterval(() => {
      const active = simulatorRef.current;
      if (!active) return;
      const sampledAt = performance.now();
      const elapsedMs = sampledAt - active.startedAt;
      const simulatedSignals = createSimulatedSignals(labProfile, active.scenario, elapsedMs, sampledAt);
      const update = updateAttentionClassifier(active.memory, simulatedSignals, labProfile, sampledAt);
      active.memory = update.memory;
      setSimulator((previous) => previous.active ? {
        ...previous,
        elapsedMs,
        classification: update.classification,
        history: [...previous.history, update.classification].slice(-60),
      } : previous);
    }, 500);
    return () => window.clearInterval(timer);
  }, [labProfile, simulator.active, simulator.startedAt]);

  useEffect(() => () => {
    liveTestRef.current = null;
    selfTestRef.current = null;
    simulatorRef.current = null;
  }, []);

  const previewClass = livePreview === "preview-level2" || livePreview === "face-missing"
    ? "is-warning"
    : livePreview === "preview-level1" ? "is-caution" : "is-clear";
  const liveProgress = Math.round(liveTest.elapsedMs / LIVE_TEST_DURATION_MS * 100);
  const selfTestProgress = Math.round(selfTest.elapsedMs / SELF_TEST_DURATION_MS * 100);
  const selfTestStepLabel = selfTest.phase === "center" ? "1 · normal center" : selfTest.phase === "glance" ? "2 · glance outside" : selfTest.phase === "recovery" ? "3 · return to center" : "Complete";
  const selfTestPrompt = selfTest.phase === "center"
    ? "Look normally at your calibrated work target."
    : selfTest.phase === "glance"
      ? "Look just beyond the edge of your normal work area."
      : selfTest.phase === "recovery"
        ? "Return to your normal target and posture."
        : "";
  const previewLabel = phaseText(livePreview);

  return (
    <section className="attention-test-lab" role="tabpanel" id="attention-test-lab-panel" aria-labelledby="attention-test-lab-tab">
      <div className="attention-section-heading">
        <div><h3>Attention Guard Test Lab</h3><p>Tune and test locally before enabling focus-session interventions. Nothing in this lab is included in your saved stats.</p></div>
        <span className="attention-profile-state">{profile.mode.toUpperCase()} · {profile.calibratedAt ? "CALIBRATED" : "NEEDS CALIBRATION"}</span>
      </div>

      <section className="attention-lab-card attention-lab-camera-card" aria-labelledby="attention-lab-camera-title">
        <div>
          <h4 id="attention-lab-camera-title">Temporary live camera test</h4>
          <p>The camera runs only after an explicit start here. It is separate from normal focus-session tracking and stops on tab hide or when you stop it.</p>
        </div>
        {testCameraActive ? (
          <button type="button" className="attention-secondary-button" onClick={onStopCamera}>Stop test camera</button>
        ) : focusCameraActive ? (
          <span className="attention-lab-live-badge">Focus-session camera is already on</span>
        ) : (
          <button type="button" className="panel-primary" onClick={onStartCamera} disabled={cameraStatus === "starting"}>
            {cameraStatus === "starting" ? "Starting…" : "Start temporary camera"}
          </button>
        )}
      </section>
      {cameraStatus === "error" && <p className="attention-error" role="alert">{controller.getState().error}</p>}

      <section className="attention-lab-card" aria-labelledby="attention-lab-live-title">
        <div className="attention-calibration-subheading">
          <div><h4 id="attention-lab-live-title">Live diagnostics and preview</h4><p>Preview is instantaneous. Real warnings use smoothing, dwell, and recovery delays.</p></div>
          <span className={`attention-sample-state ${signals?.facePresent ? "has-face" : ""}`}>{cameraStatus === "on" ? signals?.facePresent ? "FACE FOUND" : "SEARCHING" : "CAMERA OFF"}</span>
        </div>
        <div className={`attention-lab-preview ${previewClass}`} role="status">
          <span className="attention-classification-dot" aria-hidden="true" />
          <div><strong>{previewLabel}</strong><small>{liveScore == null ? "No calibrated score yet" : `Instantaneous zone score ${liveScore.toFixed(2)} · L1 ${tuningDraft.level1Score.toFixed(2)} · L2 ${tuningDraft.level2Score.toFixed(2)}`}</small></div>
          <div className="attention-lab-controller-phase"><b>{phaseText(classification.phase)}</b><small>live controller</small></div>
        </div>
        <div className="attention-signal-grid attention-lab-signal-grid">
          <SignalTile label="Head yaw" value={signals?.yawDeg == null ? "—" : `${signals.yawDeg.toFixed(1)}°`} />
          <SignalTile label="Head pitch" value={signals?.pitchDeg == null ? "—" : `${signals.pitchDeg.toFixed(1)}°`} />
          <SignalTile label="Head roll" value={signals?.rollDeg == null ? "—" : `${signals.rollDeg.toFixed(1)}°`} />
          <SignalTile label="Gaze X / Y" value={signals?.gazeX == null || signals.gazeY == null ? "—" : `${signals.gazeX.toFixed(2)} / ${signals.gazeY.toFixed(2)}`} detail="coarse eye-box estimate" />
          <SignalTile label="Face size" value={signals?.faceWidth == null ? "—" : `${Math.round(signals.faceWidth * 100)}%`} />
          <SignalTile label="Brightness" value={signals?.brightness == null ? "—" : `${Math.round(signals.brightness * 100)}%`} />
        </div>
      </section>

      <div className="attention-lab-grid">
        <details className="attention-lab-card attention-lab-tuning" open>
          <summary>Zone and classifier tuning</summary>
          <p>Changes are preview-only until saved. Weights are normalized automatically; zero-weight groups are ignored. Keep at least one weight above zero.</p>
          <h5>Attention zone</h5>
          <div className="attention-number-grid">
            <TestNumberField label="Head yaw (°)" value={zoneDraft.yawDeg} min={5} max={60} onChange={(value) => setZoneDraft((previous) => ({ ...previous, yawDeg: value }))} />
            <TestNumberField label="Head pitch (°)" value={zoneDraft.pitchDeg} min={5} max={60} onChange={(value) => setZoneDraft((previous) => ({ ...previous, pitchDeg: value }))} />
            <TestNumberField label="Head roll (°)" value={zoneDraft.rollDeg} min={5} max={60} onChange={(value) => setZoneDraft((previous) => ({ ...previous, rollDeg: value }))} />
            <TestNumberField label="Gaze X" value={zoneDraft.gazeX} min={0.15} max={1.5} step={0.05} onChange={(value) => setZoneDraft((previous) => ({ ...previous, gazeX: value }))} />
            <TestNumberField label="Gaze Y" value={zoneDraft.gazeY} min={0.15} max={1.5} step={0.05} onChange={(value) => setZoneDraft((previous) => ({ ...previous, gazeY: value }))} />
          </div>
          <div className="attention-zone-shape" role="group" aria-label="Test Lab zone shape">
            <button type="button" aria-pressed={shapeDraft === "rectangle"} className={shapeDraft === "rectangle" ? "active" : ""} onClick={() => setShapeDraft("rectangle")}>Rectangle</button>
            <button type="button" aria-pressed={shapeDraft === "ellipse"} className={shapeDraft === "ellipse" ? "active" : ""} onClick={() => setShapeDraft("ellipse")}>Ellipse</button>
          </div>
          <h5>Classifier timing and weights</h5>
          <div className="attention-number-grid">
            <TestNumberField label="Level 1 score" value={tuningDraft.level1Score} min={0.2} max={2.5} step={0.05} onChange={(value) => updateTuning("level1Score", value)} />
            <TestNumberField label="Level 2 score" value={tuningDraft.level2Score} min={0.4} max={4} step={0.05} onChange={(value) => updateTuning("level2Score", value)} />
            <TestNumberField label="Level 1 hold (ms)" value={tuningDraft.level1DwellMs} min={500} max={30_000} step={500} onChange={(value) => updateTuning("level1DwellMs", value)} />
            <TestNumberField label="Level 2 hold (ms)" value={tuningDraft.level2DwellMs} min={1_000} max={60_000} step={1_000} onChange={(value) => updateTuning("level2DwellMs", value)} />
            <TestNumberField label="Glance allowance (ms)" value={tuningDraft.glanceAllowanceMs} min={0} max={10_000} step={250} onChange={(value) => updateTuning("glanceAllowanceMs", value)} />
            <TestNumberField label="No-face delay (ms)" value={tuningDraft.faceMissingMs} min={1_000} max={30_000} step={500} onChange={(value) => updateTuning("faceMissingMs", value)} />
            <TestNumberField label="Recovery hold (ms)" value={tuningDraft.recoveryMs} min={300} max={15_000} step={250} onChange={(value) => updateTuning("recoveryMs", value)} />
            <TestNumberField label="Smoothing alpha" value={tuningDraft.smoothingAlpha} min={0.05} max={0.9} step={0.05} onChange={(value) => updateTuning("smoothingAlpha", value)} />
            <TestNumberField label="Hysteresis" value={tuningDraft.hysteresis} min={0.05} max={0.8} step={0.05} onChange={(value) => updateTuning("hysteresis", value)} />
            <TestNumberField label="Pose weight" value={tuningDraft.poseWeight} min={0} max={1} step={0.05} onChange={(value) => updateTuning("poseWeight", value)} />
            <TestNumberField label="Gaze weight" value={tuningDraft.gazeWeight} min={0} max={1} step={0.05} onChange={(value) => updateTuning("gazeWeight", value)} />
            <TestNumberField label="Low-light floor" value={tuningDraft.lowLightFloor} min={0} max={0.5} step={0.01} onChange={(value) => updateTuning("lowLightFloor", value)} />
            <TestNumberField label="Minimum face width" value={tuningDraft.minFaceWidth} min={0.02} max={0.5} step={0.01} onChange={(value) => updateTuning("minFaceWidth", value)} />
          </div>
          <div className="attention-calibration-actions">
            <button type="button" className="panel-primary" onClick={saveLabSettings} disabled={!labProfileChanged}>Save Lab settings</button>
            <button type="button" className="attention-secondary-button" onClick={resetLabSettings} disabled={!labProfileChanged}>Reset draft</button>
          </div>
        </details>

        <div className="attention-lab-stack">
          <section className="attention-lab-card attention-lab-test-card" aria-labelledby="attention-30s-title">
            <div><h4 id="attention-30s-title">30-second live test</h4><p>Aggregates local classifier results. No frames, raw signals, or test results are saved.</p></div>
            {liveTest.status === "running" ? (
              <>
                <div className="attention-lab-test-progress"><span>{Math.ceil((LIVE_TEST_DURATION_MS - liveTest.elapsedMs) / 1000)}s left · {liveTest.sampleCount} samples</span><div className="attention-progress-track" role="progressbar" aria-label="Thirty-second test progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={liveProgress}><i style={{ width: `${liveProgress}%` }} /></div></div>
                <button type="button" className="attention-secondary-button" onClick={cancelLiveTest}>Cancel test</button>
              </>
            ) : (
              <button type="button" className="attention-secondary-button" onClick={startLiveTest} disabled={cameraStatus !== "on"}>{liveTest.status === "complete" ? "Run again" : "Start 30-second test"}</button>
            )}
            {liveTest.status === "cancelled" && <p className="attention-inline-message">Test cancelled; partial data was discarded.</p>}
            {liveTest.summary && <TestSummary summary={liveTest.summary} />}
          </section>

          <section className="attention-lab-card attention-lab-self-test" aria-labelledby="attention-guided-test-title">
            <div><h4 id="attention-guided-test-title">Guided sensitivity self-test</h4><p>Five seconds center, five seconds looking just outside your work area, then five seconds back at center.</p></div>
            {selfTest.status === "running" ? (
              <>
                <div className="attention-self-test-step"><strong>{selfTestStepLabel}</strong><p>{selfTestPrompt}</p><span>{Math.ceil((SELF_TEST_PHASE_MS - selfTest.elapsedMs % SELF_TEST_PHASE_MS) / 1000)}s · {selfTest.sampleCounts[selfTest.phase ?? "center"]} valid samples</span><div className="attention-progress-track" role="progressbar" aria-label="Guided self-test progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={selfTestProgress}><i style={{ width: `${selfTestProgress}%` }} /></div></div>
                <button type="button" className="attention-secondary-button" onClick={cancelSelfTest}>Cancel self-test</button>
              </>
            ) : (
              <button type="button" className="attention-secondary-button" onClick={startGuidedSelfTest} disabled={cameraStatus !== "on" || !profile.calibratedAt}>{selfTest.status === "complete" ? "Run self-test again" : "Start guided self-test"}</button>
            )}
            {selfTest.status === "complete" && selfTest.message && (
              <div className={`attention-self-test-result ${selfTest.suggestion?.separable ? "is-usable" : "is-caution"}`}>
                <p>{selfTest.message}</p>
                {selfTest.suggestion && (
                  <>
                    <div className="attention-suggestion-metrics"><span>Center p90 <b>{selfTest.suggestion.centerP90.toFixed(2)}</b></span><span>Glance p25 <b>{selfTest.suggestion.glanceP25.toFixed(2)}</b></span><span>Recovery p90 <b>{selfTest.suggestion.recoveryP90.toFixed(2)}</b></span></div>
                    {selfTest.suggestion.separable && <button type="button" className="panel-primary" onClick={applySelfTestSuggestion}>Apply suggested thresholds</button>}
                  </>
                )}
              </div>
            )}
            {selfTest.status === "cancelled" && <p className="attention-inline-message">{selfTest.message}</p>}
          </section>
        </div>
      </div>

      <section className="attention-lab-card attention-lab-simulator" aria-labelledby="attention-simulator-title">
        <div className="attention-calibration-subheading">
          <div><h4 id="attention-simulator-title">Camera-free simulator</h4><p>Deterministic scenarios use synthetic numeric values and never read the camera or affect your real session.</p></div>
          <label className="field attention-scenario-field"><span>Scenario</span><select value={simScenario} disabled={simulator.active} onChange={(event) => {
            const value = event.target.value;
            if (TEST_SCENARIOS.some((scenario) => scenario.id === value)) setSimScenario(value as TestScenario);
          }}>{TEST_SCENARIOS.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}</select></label>
        </div>
        <p className="attention-scenario-description">{TEST_SCENARIOS.find((scenario) => scenario.id === simScenario)?.description}</p>
        <div className="attention-simulator-controls">
          {simulator.active ? <button type="button" className="attention-secondary-button" onClick={stopSimulator}>Stop simulation</button> : <button type="button" className="attention-secondary-button" onClick={startSimulator}>Run simulation</button>}
          {simulator.classification && <span>{Math.floor(simulator.elapsedMs / 1000)}s · {phaseText(simulator.classification.phase)} · score {scoreText(simulator.classification.score)} · warning {simulator.classification.warningLevel}</span>}
        </div>
        <div className="attention-simulator-timeline" aria-hidden="true">
          {simulator.history.map((item, index) => <i key={`${item.updatedAt}-${index}`} className={`phase-${item.phase}`} style={{ height: `${Math.max(10, Math.min(100, (item.score ?? 0.15) * 35))}%` }} />)}
        </div>
        {simulator.classification && <p className="attention-simulator-current" role="status"><strong>{phaseText(simulator.classification.phase)}</strong><span>{simulator.classification.reason.split("-").join(" ")} · warning level {simulator.classification.warningLevel}</span></p>}
      </section>

      {message && <p className="attention-inline-message" role="status">{message}</p>}
      <p className="attention-lab-limitations">The simulator checks deterministic state transitions, not camera accuracy. Auto-tune is a suggestion from one short sample; do not rely on it until you have checked your real directional diagnostics and preview.</p>
    </section>
  );
}
