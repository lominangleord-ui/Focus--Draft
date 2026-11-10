import { describe, expect, it } from "vitest";
import { createAttentionProfile } from "./profile";
import { ATTENTION_STORE_KEY, defaultAttentionStore, loadAttentionStore, normalizeAttentionStore, saveAttentionStore } from "./storage";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("Attention Guard local store", () => {
  it("defaults to off-by-default preferences and separate screen/book profiles", () => {
    const store = defaultAttentionStore();
    expect(store.soundEnabled).toBe(false);
    expect(store.strictPause).toBe(false);
    expect(store.profiles.map((profile) => profile.mode).sort()).toEqual(["book", "screen"]);
    expect(store.profiles.every((profile) => profile.calibratedAt == null)).toBe(true);
  });

  it("round-trips valid data and recovers from corrupt storage", () => {
    const storage = new MemoryStorage();
    const store = defaultAttentionStore();
    store.cameraDeviceId = "local-camera-id";
    expect(saveAttentionStore(store, storage)).toBe(true);
    expect(storage.getItem(ATTENTION_STORE_KEY)).toContain("local-camera-id");
    expect(loadAttentionStore(storage).cameraDeviceId).toBe("local-camera-id");
    storage.setItem(ATTENTION_STORE_KEY, "not json");
    expect(loadAttentionStore(storage).cameraDeviceId).toBe("");
  });

  it("keeps a built-in profile for each mode when imported storage is crowded", () => {
    const profiles = Array.from({ length: 24 }, (_, index) => createAttentionProfile("screen", `Screen ${index}`, `screen-${index}`, index));
    const result = normalizeAttentionStore({ schemaVersion: 1, profiles });
    expect(result.profiles.length).toBeLessThanOrEqual(24);
    expect(result.profiles.some((profile) => profile.mode === "screen")).toBe(true);
    expect(result.profiles.some((profile) => profile.mode === "book")).toBe(true);
    expect(result.activeProfileIds.book).toBe(result.profiles.find((profile) => profile.mode === "book")?.id);
  });

  it("ignores storage versions it does not understand", () => {
    const result = normalizeAttentionStore({ schemaVersion: 999, cameraDeviceId: "nope" });
    expect(result.cameraDeviceId).toBe("");
    expect(result.schemaVersion).toBe(1);
  });
});
