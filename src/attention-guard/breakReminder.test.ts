import { describe, expect, it } from "vitest";
import { createScreenBreakMemory, updateScreenBreakReminder } from "./breakReminder";

describe("screen break reminder timing", () => {
  it("fires only after continuous, eligible in-zone time and then starts a new interval", () => {
    const initial = createScreenBreakMemory();
    const start = updateScreenBreakReminder(initial, {
      mode: "screen", reminderMinutes: 25, phase: "attentive", eligible: true, fresh: true, sampledAt: 1_000,
    });
    expect(start).toEqual({ memory: { inZoneSince: 1_000 }, shouldRemind: false });

    const before = updateScreenBreakReminder(start.memory, {
      mode: "screen", reminderMinutes: 25, phase: "attentive", eligible: true, fresh: true, sampledAt: 1_500_999,
    });
    expect(before.shouldRemind).toBe(false);

    const due = updateScreenBreakReminder(before.memory, {
      mode: "screen", reminderMinutes: 25, phase: "attentive", eligible: true, fresh: true, sampledAt: 1_501_000,
    });
    expect(due).toEqual({ memory: { inZoneSince: 1_501_000 }, shouldRemind: true });
  });

  it.each([
    { mode: "book" as const, phase: "attentive" as const, eligible: true, fresh: true },
    { mode: "screen" as const, phase: "drifting" as const, eligible: true, fresh: true },
    { mode: "screen" as const, phase: "attentive" as const, eligible: false, fresh: true },
    { mode: "screen" as const, phase: "attentive" as const, eligible: true, fresh: false },
  ])("resets rather than reminding for an ineligible interval ($mode, $phase)", (input) => {
    const update = updateScreenBreakReminder({ inZoneSince: 1_000 }, {
      ...input,
      reminderMinutes: 1,
      sampledAt: 100_000,
    });
    expect(update).toEqual({ memory: { inZoneSince: null }, shouldRemind: false });
  });

  it("does not count when the setting is off or the clock moves backward", () => {
    const off = updateScreenBreakReminder({ inZoneSince: 1_000 }, {
      mode: "screen", reminderMinutes: 0, phase: "attentive", eligible: true, fresh: true, sampledAt: 100_000,
    });
    expect(off.shouldRemind).toBe(false);
    expect(off.memory.inZoneSince).toBeNull();

    const reversed = updateScreenBreakReminder({ inZoneSince: 90_000 }, {
      mode: "screen", reminderMinutes: 1, phase: "attentive", eligible: true, fresh: true, sampledAt: 1_000,
    });
    expect(reversed.shouldRemind).toBe(false);
    expect(reversed.memory.inZoneSince).toBe(90_000);
  });
});
