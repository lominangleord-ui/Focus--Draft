import { describe, expect, it } from "vitest";
import { ATTENTION_SAMPLE_STALE_MS, isAttentionSampleStale } from "./freshness";

describe("camera sample freshness", () => {
  it("keeps recent samples fresh and expires stalled samples", () => {
    expect(isAttentionSampleStale(1_000, 1_000 + ATTENTION_SAMPLE_STALE_MS)).toBe(false);
    expect(isAttentionSampleStale(1_000, 1_001 + ATTENTION_SAMPLE_STALE_MS)).toBe(true);
  });

  it("ignores invalid clocks rather than falsely marking a sample stale", () => {
    expect(isAttentionSampleStale(Number.NaN, 5_000)).toBe(false);
    expect(isAttentionSampleStale(1_000, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
