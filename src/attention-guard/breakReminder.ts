import type { AttentionMode, AttentionPhase } from "./types";

export type ScreenBreakMemory = { inZoneSince: number | null };
export type ScreenBreakReminderUpdate = { memory: ScreenBreakMemory; shouldRemind: boolean };

export function createScreenBreakMemory(): ScreenBreakMemory {
  return { inZoneSince: null };
}

/**
 * Counts only fresh, continuous Focus-camera time classified inside a Screen
 * profile's zone. This is a timed break nudge, not eye-strain or gaze-duration
 * detection; Book mode and temporary camera runs never qualify.
 */
export function updateScreenBreakReminder(
  previous: ScreenBreakMemory,
  input: {
    mode: AttentionMode;
    reminderMinutes: number;
    phase: AttentionPhase;
    eligible: boolean;
    fresh: boolean;
    sampledAt: number;
  },
): ScreenBreakReminderUpdate {
  const minutes = Number.isFinite(input.reminderMinutes) ? Math.max(0, input.reminderMinutes) : 0;
  if (!input.eligible || !input.fresh || input.mode !== "screen" || minutes <= 0 || input.phase !== "attentive" || !Number.isFinite(input.sampledAt)) {
    return { memory: createScreenBreakMemory(), shouldRemind: false };
  }

  const inZoneSince = previous.inZoneSince ?? input.sampledAt;
  const now = Math.max(inZoneSince, input.sampledAt);
  const intervalMs = minutes * 60_000;
  if (now - inZoneSince < intervalMs) {
    return { memory: { inZoneSince }, shouldRemind: false };
  }
  // Start the next interval now so a long Focus session receives at most one
  // nudge per configured interval rather than a burst of catch-up events.
  return { memory: { inZoneSince: now }, shouldRemind: true };
}
