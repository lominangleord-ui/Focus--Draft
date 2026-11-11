import type { GuardRunPurpose, GuardStatus } from "./types";

export type AttentionGuardView = "monitor" | "calibrate" | "lab";

export function canStartFocusTrackingFromView(view: AttentionGuardView, focusTimerActive: boolean): boolean {
  return focusTimerActive && view === "monitor";
}

export function isActiveFocusTimer(running: boolean, mode: "focus" | "short" | "long"): boolean {
  return running && mode === "focus";
}

export function canEmitFocusIntervention(
  focusTimerActive: boolean,
  status: GuardStatus,
  runPurpose: GuardRunPurpose | null,
): boolean {
  return focusTimerActive && status === "on" && runPurpose === "focus";
}

export function shouldPauseFocusTimer(level: 1 | 2, strictPause: boolean, focusTimerActive: boolean): boolean {
  return level === 2 && strictPause && focusTimerActive;
}
