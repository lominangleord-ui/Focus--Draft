import { defaultAttentionProfile, normalizeAttentionProfile, type AttentionProfile } from "./profile";
import type { AttentionMode } from "./types";

export type AttentionDayStats = {
  guardedSeconds: number;
  onTaskSeconds: number;
  offTaskSeconds: number;
  warningsLevel1: number;
  warningsLevel2: number;
  sessions: number;
};

export type AttentionSessionStats = {
  id: string;
  dayKey: string;
  mode: AttentionMode;
  startedAt: number;
  guardedSeconds: number;
  offTaskSeconds: number;
  warningsLevel1: number;
  warningsLevel2: number;
};

export type AttentionStore = {
  schemaVersion: 1;
  mode: AttentionMode;
  cameraDeviceId: string;
  /** In-app reminders for sustained off-target behavior during Focus. */
  offTargetAlertsEnabled: boolean;
  soundEnabled: boolean;
  strictPause: boolean;
  /** 0 disables the timed Screen-zone break nudge. */
  screenBreakReminderMinutes: number;
  profiles: AttentionProfile[];
  activeProfileIds: Record<AttentionMode, string>;
  statsByDay: Record<string, AttentionDayStats>;
  sessions: AttentionSessionStats[];
};

export const ATTENTION_STORE_KEY = "focusdraft_attention_guard_v1";
const MAX_PROFILES = 24;
const MAX_STATS_DAYS = 180;
const MAX_SESSIONS = 2_000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMode(value: unknown): value is AttentionMode {
  return value === "screen" || value === "book";
}

function emptyDay(): AttentionDayStats {
  return { guardedSeconds: 0, onTaskSeconds: 0, offTaskSeconds: 0, warningsLevel1: 0, warningsLevel2: 0, sessions: 0 };
}

export function defaultAttentionStore(): AttentionStore {
  return {
    schemaVersion: 1,
    mode: "screen",
    cameraDeviceId: "",
    offTargetAlertsEnabled: true,
    soundEnabled: false,
    strictPause: false,
    screenBreakReminderMinutes: 0,
    profiles: [defaultAttentionProfile("screen"), defaultAttentionProfile("book")],
    activeProfileIds: { screen: "default-screen", book: "default-book" },
    statsByDay: {},
    sessions: [],
  };
}

function normalizeDayStats(value: unknown): AttentionDayStats {
  const item = isRecord(value) ? value : {};
  const finiteCount = (key: keyof AttentionDayStats) => {
    const count = item[key];
    return typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.min(1_000_000_000, count)) : 0;
  };
  return {
    guardedSeconds: finiteCount("guardedSeconds"),
    onTaskSeconds: finiteCount("onTaskSeconds"),
    offTaskSeconds: finiteCount("offTaskSeconds"),
    warningsLevel1: Math.round(finiteCount("warningsLevel1")),
    warningsLevel2: Math.round(finiteCount("warningsLevel2")),
    sessions: Math.round(finiteCount("sessions")),
  };
}

export function normalizeAttentionStore(value: unknown): AttentionStore {
  const base = defaultAttentionStore();
  if (!isRecord(value) || value.schemaVersion !== 1) return base;

  const profiles: AttentionProfile[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.profiles)) {
    for (const entry of value.profiles.slice(0, MAX_PROFILES)) {
      const profile = normalizeAttentionProfile(entry);
      if (!profile || seen.has(profile.id)) continue;
      profiles.push(profile);
      seen.add(profile.id);
    }
  }
  for (const mode of ["screen", "book"] as const) {
    if (!profiles.some((profile) => profile.mode === mode)) {
      if (profiles.length >= MAX_PROFILES) profiles.pop();
      profiles.push(defaultAttentionProfile(mode));
    }
  }

  const activeIds = isRecord(value.activeProfileIds) ? value.activeProfileIds : {};
  const activeProfileIds: Record<AttentionMode, string> = {
    screen: profiles.some((profile) => profile.mode === "screen" && profile.id === activeIds.screen)
      ? String(activeIds.screen)
      : profiles.find((profile) => profile.mode === "screen")!.id,
    book: profiles.some((profile) => profile.mode === "book" && profile.id === activeIds.book)
      ? String(activeIds.book)
      : profiles.find((profile) => profile.mode === "book")!.id,
  };

  const statsByDay: Record<string, AttentionDayStats> = {};
  if (isRecord(value.statsByDay)) {
    const records = Object.entries(value.statsByDay).slice(-MAX_STATS_DAYS);
    for (const [dayKey, stats] of records) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) statsByDay[dayKey] = normalizeDayStats(stats);
    }
  }

  const sessions: AttentionSessionStats[] = [];
  if (Array.isArray(value.sessions)) {
    for (const entry of value.sessions.slice(-MAX_SESSIONS)) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.dayKey)) || !isMode(entry.mode)) continue;
      const validNumber = (key: string) => typeof entry[key] === "number" && Number.isFinite(entry[key]) ? Math.max(0, entry[key]) : 0;
      sessions.push({
        id: entry.id.slice(0, 100),
        dayKey: String(entry.dayKey),
        mode: entry.mode,
        startedAt: validNumber("startedAt"),
        guardedSeconds: validNumber("guardedSeconds"),
        offTaskSeconds: validNumber("offTaskSeconds"),
        warningsLevel1: Math.round(validNumber("warningsLevel1")),
        warningsLevel2: Math.round(validNumber("warningsLevel2")),
      });
    }
  }

  // Legacy v1 stores without this preference retain the prior on-by-default
  // in-app nudge behavior; an explicit false remains respected.
  const offTargetAlertsEnabled = typeof value.offTargetAlertsEnabled === "boolean" ? value.offTargetAlertsEnabled : true;

  return {
    schemaVersion: 1,
    mode: isMode(value.mode) ? value.mode : base.mode,
    cameraDeviceId: typeof value.cameraDeviceId === "string" ? value.cameraDeviceId.slice(0, 512) : "",
    offTargetAlertsEnabled,
    soundEnabled: value.soundEnabled === true,
    strictPause: value.strictPause === true && offTargetAlertsEnabled,
    screenBreakReminderMinutes: [0, 25, 45, 60].includes(value.screenBreakReminderMinutes as number)
      ? value.screenBreakReminderMinutes as number
      : 0,
    profiles: profiles.slice(0, MAX_PROFILES),
    activeProfileIds,
    statsByDay,
    sessions,
  };
}

export function loadAttentionStore(storage: StorageLike | undefined = browserStorage()): AttentionStore {
  if (!storage) return defaultAttentionStore();
  try {
    const raw = storage.getItem(ATTENTION_STORE_KEY);
    return raw ? normalizeAttentionStore(JSON.parse(raw) as unknown) : defaultAttentionStore();
  } catch {
    return defaultAttentionStore();
  }
}

export function saveAttentionStore(store: AttentionStore, storage: StorageLike | undefined = browserStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(ATTENTION_STORE_KEY, JSON.stringify(normalizeAttentionStore(store)));
    return true;
  } catch {
    return false;
  }
}

export function clearAttentionStore(storage: StorageLike | undefined = browserStorage()) {
  try {
    storage?.removeItem(ATTENTION_STORE_KEY);
  } catch {
    // Storage may be unavailable or read-only.
  }
}

export function activeAttentionProfile(store: AttentionStore) {
  const id = store.activeProfileIds[store.mode];
  return store.profiles.find((profile) => profile.id === id && profile.mode === store.mode)
    ?? store.profiles.find((profile) => profile.mode === store.mode)
    ?? defaultAttentionProfile(store.mode);
}

export function upsertAttentionProfile(store: AttentionStore, profile: AttentionProfile): AttentionStore {
  const normalized = normalizeAttentionProfile(profile);
  if (!normalized) return store;
  const existing = store.profiles.some((item) => item.id === normalized.id);
  if (!existing && store.profiles.length >= MAX_PROFILES) return store;
  const profiles = existing
    ? store.profiles.map((item) => item.id === normalized.id ? normalized : item)
    : [...store.profiles, normalized];
  return {
    ...store,
    profiles,
    activeProfileIds: { ...store.activeProfileIds, [normalized.mode]: normalized.id },
  };
}

export function addImportedProfile(store: AttentionStore, imported: AttentionProfile, now = Date.now()): AttentionStore {
  const id = `profile-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const profile = { ...imported, id, name: `${imported.name.slice(0, 23)} · imported`, createdAt: now, updatedAt: now };
  return upsertAttentionProfile({ ...store, mode: profile.mode }, profile);
}

export function makeSessionId(now = Date.now()) {
  return `guard-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyAttentionDay() {
  return emptyDay();
}
