/** Whole seconds remaining for a timestamp-based countdown. */
export function secondsRemaining(endAtMs: number, nowMs: number): number {
  if (!Number.isFinite(endAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((endAtMs - nowMs) / 1000));
}
