export const ATTENTION_SAMPLE_STALE_MS = 2_500;

/** A stalled camera/worker must not leave an old face or warning on screen. */
export function isAttentionSampleStale(sampledAt: number, now: number, maxAgeMs = ATTENTION_SAMPLE_STALE_MS): boolean {
  if (!Number.isFinite(sampledAt) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  return now - sampledAt > maxAgeMs;
}
