import { describe, expect, it } from "vitest";
import { canEmitFocusIntervention, canStartFocusTrackingFromView, isActiveFocusTimer, shouldPauseFocusTimer } from "./lifecycle";

describe("Attention Guard focus lifecycle", () => {
  it("allows focus tracking only while the Focus timer is running", () => {
    expect(isActiveFocusTimer(true, "focus")).toBe(true);
    expect(isActiveFocusTimer(false, "focus")).toBe(false);
    expect(isActiveFocusTimer(true, "short")).toBe(false);
    expect(isActiveFocusTimer(true, "long")).toBe(false);
  });

  it("keeps ordinary focus tracking in Monitor, separate from temporary calibration and lab cameras", () => {
    expect(canStartFocusTrackingFromView("monitor", true)).toBe(true);
    expect(canStartFocusTrackingFromView("monitor", false)).toBe(false);
    expect(canStartFocusTrackingFromView("calibrate", true)).toBe(false);
    expect(canStartFocusTrackingFromView("lab", true)).toBe(false);
  });

  it("emits interventions only from a live focus-purpose camera run", () => {
    expect(canEmitFocusIntervention(true, "on", "focus")).toBe(true);
    expect(canEmitFocusIntervention(false, "on", "focus")).toBe(false);
    expect(canEmitFocusIntervention(true, "starting", "focus")).toBe(false);
    expect(canEmitFocusIntervention(true, "on", "diagnostic")).toBe(false);
    expect(canEmitFocusIntervention(true, "on", "calibration")).toBe(false);
    expect(canEmitFocusIntervention(true, "off", null)).toBe(false);
  });

  it("honors strict pause only for a level 2 warning during active focus", () => {
    expect(shouldPauseFocusTimer(1, true, true)).toBe(false);
    expect(shouldPauseFocusTimer(2, false, true)).toBe(false);
    expect(shouldPauseFocusTimer(2, true, false)).toBe(false);
    expect(shouldPauseFocusTimer(2, true, true)).toBe(true);
  });
});
