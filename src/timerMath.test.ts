import { describe, expect, it } from "vitest";
import { secondsRemaining } from "./timerMath";

describe("timestamp-based timer readout", () => {
  it("rounds up to the next displayed second without accumulating pauses", () => {
    expect(secondsRemaining(10_000, 0)).toBe(10);
    expect(secondsRemaining(10_000, 1)).toBe(10);
    expect(secondsRemaining(10_000, 1_001)).toBe(9);
  });

  it("never reports a negative remaining time", () => {
    expect(secondsRemaining(10_000, 10_000)).toBe(0);
    expect(secondsRemaining(10_000, 12_000)).toBe(0);
  });

  it("handles invalid timestamps safely", () => {
    expect(secondsRemaining(Number.NaN, 1_000)).toBe(0);
    expect(secondsRemaining(1_000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
