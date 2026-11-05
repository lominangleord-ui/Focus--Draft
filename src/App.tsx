import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

const PdfViewer = lazy(() => import("./PdfViewer"));
const WebReader = lazy(() => import("./WebReader"));
const YouTubeAudioPlayer = lazy(() => import("./YouTubeAudioPlayer"));

type ModeId = "focus" | "short" | "long";
type PanelId = "tasks" | "music" | "scenes" | "stats" | "notes" | "settings";
type UtilId = "youtube" | "web" | "files";
type FileKind = "text" | "image" | "video" | "audio" | "pdf" | "other";
type LocalFile = { id: string; name: string; type: string; url: string; kind: FileKind; text?: string; data?: ArrayBuffer };
type SceneId = "cabin" | "rain" | "forest" | "ocean" | "dawn" | "pure";

type Task = { id: string; text: string; done: boolean; pomosDone: number; createdAt: number };
/* Time is accrued live, second by second, into three buckets:
     focusSec  — clock running in a focus segment
     breakSec  — clock running in a short/long break (leisure)
     idleSec   — app open but nothing running (Misc / Unproductive)
   Legacy saves stored whole minutes only; they are migrated on load. */
type DayStat = {
  focusSec: number;
  breakSec: number;
  idleSec: number;
  sessions: number;
  skippedFocus: number;
};

const emptyDay = (): DayStat => ({ focusSec: 0, breakSec: 0, idleSec: 0, sessions: 0, skippedFocus: 0 });
type WinFrame = { x: number; y: number; w: number; h: number; full: boolean };

type Settings = {
  name: string;
  focusMinutes: number;
  shortMinutes: number;
  longMinutes: number;
  sessionsBeforeLong: number;
  autoStartBreaks: boolean;
  autoStartFocus: boolean;
  clock24h: boolean;
  checkIns: boolean;
  checkInMinutes: number;
};

type AppState = {
  settings: Settings;
  mode: ModeId;
  remaining: number;
  sessionsDone: number;
  tasks: Task[];
  activeTaskId: string | null;
  notes: string;
  stats: Record<string, DayStat>;
  scene: SceneId;
  sceneAuto: boolean;
  customImage: string;
  customYoutube: string;
  studyVideo: string;
  spotify: { type: string; id: string } | null;
  youtubeMusicUrl: string;
  /** Manual accent override (0-359). Null means "follow the scene / background". */
  customHue: number | null;
  windows: Record<string, WinFrame>;
};

const STORE_KEY = "focusdash_react_v6";
const PREV_STORE_KEY = "focusdash_react_v5";
const MODE_IDS: ModeId[] = ["focus", "short", "long"];
// Currently-active Lofi Girl radio. Users can always paste their own link.
const DEFAULT_STUDY_VIDEO = "https://www.youtube.com/watch?v=X4VbdwhkE10";

/* Curated accent swatches for the custom theme picker — spread evenly around
   the hue wheel at a saturation/lightness that always looks good against the
   dark UI, matching the same formula used for scene-driven accents. */
const THEME_SWATCHES = [
  "#f2545b", "#f5875f", "#f5b74f", "#e3ce55",
  "#a4d65e", "#4fd18b", "#43d0c0", "#4fb8f0",
  "#5c8df6", "#8b6ef2", "#c25ce0", "#f25ca0",
];

const modeLabels: Record<ModeId, string> = {
  focus: "Focus",
  short: "Short Break",
  long: "Long Break",
};

const sceneLabels: Record<SceneId, string> = {
  cabin: "Winter Cabin",
  rain: "Rainlight",
  forest: "Forest Hush",
  ocean: "Ocean Deep",
  dawn: "Dawn Quiet",
  pure: "Pure Black",
};

const SCENE_IMAGES: Record<SceneId, string> = {
  cabin: "https://images.pexels.com/photos/15508361/pexels-photo-15508361.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=900&w=1600",
  rain: "https://images.pexels.com/photos/459451/pexels-photo-459451.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=900&w=1600",
  forest: "https://images.pexels.com/photos/142497/pexels-photo-142497.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=900&w=1600",
  ocean: "https://images.pexels.com/photos/355288/pexels-photo-355288.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=900&w=1600",
  dawn: "https://images.pexels.com/photos/210186/pexels-photo-210186.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=900&w=1600",
  pure: "",
};

/* Fallback accent hue per scene, used until (or if) the image sample succeeds */
const SCENE_HUES: Record<SceneId, number> = {
  cabin: 32,
  rain: 214,
  forest: 142,
  ocean: 192,
  dawn: 338,
  pure: 42,
};

const quotes = [
  "Great results require great ambitions.",
  "The task is smaller than the dread of starting it.",
  "Depth over speed.",
  "Discipline is choosing between what you want now and what you want most.",
  "You don't have to see the whole staircase, just take the first step.",
  "Motivation gets you started. Habit keeps you going.",
  "Small steps every day add up to big results.",
  "The pain of discipline weighs ounces; the pain of regret weighs tons.",
  "Do the hard things while they are still easy.",
  "What you do today can improve all your tomorrows.",
  "Action is the antidote to despair.",
  "The expert in anything was once a beginner.",
  "Hard choices, easy life. Easy choices, hard life.",
  "You are never too tired to at least start.",
  "Focus on being productive instead of busy.",
  "The secret of getting ahead is getting started.",
  "A year from now you will wish you had started today.",
  "Progress, not perfection.",
  "Success is the sum of small efforts repeated daily.",
  "Nothing worth having comes easy.",
  "You don't find willpower, you build it.",
  "Do something today that your future self will thank you for.",
  "The only bad workout is the one that didn't happen.",
  "Slow progress is still progress.",
  "It always seems impossible until it is done.",
  "Well begun is half done.",
  "Energy and persistence conquer all things.",
  "The way to get started is to quit talking and begin doing.",
  "Don't watch the clock; do what it does — keep going.",
  "Believe you can and you're halfway there.",
  "There is no substitute for hard work.",
  "You are capable of more than you know.",
  "Every accomplishment starts with the decision to try.",
  "Push yourself, because no one else is going to do it for you.",
  "Great things never came from comfort zones.",
  "Success doesn't just find you. You have to go out and get it.",
  "The harder you work for something, the greater you'll feel when you achieve it.",
  "Dream bigger. Do bigger.",
  "Don't stop when you're tired. Stop when you're done.",
  "Wake up with determination. Go to bed with satisfaction.",
  "Do something today that your future self will thank you for.",
  "Little things make big days.",
  "It's going to be hard, but hard does not mean impossible.",
  "Don't wait for opportunity. Create it.",
  "Sometimes we're tested not to show our weaknesses, but to discover our strengths.",
  "The key to success is to focus on goals, not obstacles.",
  "Dream it. Wish it. Do it.",
  "Strive for progress, not perfection.",
  "You are your only limit.",
  "Difficult roads often lead to beautiful destinations.",
  "Work hard in silence, let success make the noise.",
  "Your only limit is your mind.",
  "Good things come to those who hustle.",
  "The future depends on what you do today.",
  "Clarity comes from engagement, not thought.",
  "Consistency is what transforms average into excellence.",
  "One day or day one — you decide.",
  "Success is built one focused hour at a time.",
  "You didn't come this far to only come this far.",
  "The comeback is always stronger than the setback.",
  "Doubt kills more dreams than failure ever will.",
  "What seems impossible today will one day become your warm-up.",
  "Champions keep playing until they get it right.",
  "Excellence is not an act but a habit.",
  "The best way out is always through.",
  "Fall seven times, stand up eight.",
  "Effort is never wasted.",
  "Be so good they can't ignore you.",
  "You get in life what you have the courage to ask for.",
  "Don't count the days, make the days count.",
  "Whatever you are, be a good one.",
  "The struggle you're in today is developing the strength you need tomorrow.",
  "Start where you are. Use what you have. Do what you can.",
  "Discomfort today builds strength for tomorrow.",
];

/* Short taglines shown directly under the clock — one per phase, picked at
   random whenever the mode changes so the app never repeats itself. */
const FOCUS_LINES = [
  "Focus. Work hard.",
  "Eyes on the task.",
  "One thing at a time.",
  "Deep work mode.",
  "Quiet mind, sharp focus.",
  "This is your hour.",
  "No distractions. Just work.",
  "Head down. Get it done.",
  "Single task. Full attention.",
  "Make this session count.",
];
const SHORT_BREAK_LINES = [
  "Breathe, reset, return clean.",
  "Stretch. Sip water. Reset.",
  "Small pause, big reset.",
  "Rest the mind, not the momentum.",
  "Step away for a moment.",
  "Shake it out. Come back sharp.",
];
const LONG_BREAK_LINES = [
  "Well earned. Recharge fully.",
  "Cycle complete. Take your time.",
  "Rest deep — you've done the work.",
  "A real break. You've earned it.",
  "Reset completely before the next round.",
];

function pickRandom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function phaseLinesFor(mode: ModeId): string[] {
  if (mode === "short") return SHORT_BREAK_LINES;
  if (mode === "long") return LONG_BREAK_LINES;
  return FOCUS_LINES;
}

const defaultState = (): AppState => ({
  settings: {
    name: "",
    focusMinutes: 25,
    shortMinutes: 5,
    longMinutes: 15,
    // Standard Pomodoro cycle: 4 focus sessions, then a long break.
    sessionsBeforeLong: 4,
    autoStartBreaks: true,
    autoStartFocus: false,
    clock24h: true,
    checkIns: false,
    checkInMinutes: 12,
  },
  mode: "focus",
  remaining: 25 * 60,
  sessionsDone: 0,
  tasks: [],
  activeTaskId: null,
  notes: "",
  stats: {},
  scene: "cabin",
  sceneAuto: false,
  customImage: "",
  customYoutube: "",
  studyVideo: DEFAULT_STUDY_VIDEO,
  spotify: null,
  youtubeMusicUrl: "",
  customHue: null,
  windows: {},
});

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function defaultFrame(): WinFrame {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(390, vw - 20);
  const h = Math.min(500, Math.max(380, vh * 0.66));
  return {
    x: Math.max(10, (vw - w) / 2),
    y: Math.max(12, Math.min(84, (vh - h) / 2 - 48)),
    w,
    h,
    full: false,
  };
}

function secondsFor(mode: ModeId, state: AppState) {
  if (mode === "short") return state.settings.shortMinutes * 60;
  if (mode === "long") return state.settings.longMinutes * 60;
  return state.settings.focusMinutes * 60;
}

function loadState(): AppState {
  try {
    let raw = localStorage.getItem(STORE_KEY);
    let legacy = !raw;
    if (!raw) raw = localStorage.getItem(PREV_STORE_KEY);
    if (!raw) return defaultState();
    const base = defaultState();
    const parsed = JSON.parse(raw) as Partial<AppState> & { mode?: string; remaining?: number };

    const settings = { ...base.settings, ...(parsed.settings ?? {}) };
    if (legacy) {
      // Older saves used a different cycle length — adopt the standard 4-session Pomodoro cycle.
      settings.sessionsBeforeLong = 4;
    }
    const merged: AppState = {
      ...base,
      ...parsed,
      settings,
      windows: { ...(parsed.windows ?? {}) },
      spotify: parsed.spotify ?? null,
      youtubeMusicUrl: parsed.youtubeMusicUrl ?? "",
      mode: (MODE_IDS.includes(parsed.mode as ModeId) ? parsed.mode : "focus") as ModeId,
    };
    if (!Number.isFinite(merged.remaining) || merged.remaining <= 0) {
      merged.remaining = secondsFor(merged.mode, merged);
    }
    // Older saves have no study video — give everyone a working Lofi stream.
    if (!merged.studyVideo) merged.studyVideo = DEFAULT_STUDY_VIDEO;
    // Guard against corrupted/out-of-range custom hue values.
    merged.customHue =
      typeof merged.customHue === "number" && Number.isFinite(merged.customHue) ? ((merged.customHue % 360) + 360) % 360 : null;

    // Migrate minute-based day records to the second-based buckets, and drop
    // anything older than ~6 months so the saved JSON never grows unbounded.
    const stats: Record<string, DayStat> = {};
    const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 180;
    for (const [key, value] of Object.entries(merged.stats ?? {})) {
      const parsedDate = Date.parse(key);
      if (Number.isFinite(parsedDate) && parsedDate < cutoff) continue;
      const legacy = value as Partial<DayStat> & { minutes?: number; breakMinutes?: number };
      stats[key] = {
        focusSec: legacy.focusSec ?? Math.round((legacy.minutes ?? 0) * 60),
        breakSec: legacy.breakSec ?? Math.round((legacy.breakMinutes ?? 0) * 60),
        idleSec: legacy.idleSec ?? 0,
        sessions: legacy.sessions ?? 0,
        skippedFocus: legacy.skippedFocus ?? 0,
      };
    }
    merged.stats = stats;
    return merged;
  } catch {
    return defaultState();
  }
}

function formatTime(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Seconds → "3h 12m" / "47m" / "38s" for compact stat readouts. */
function formatDuration(totalSeconds: number) {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${safe}s`;
}

function spotifyFromUrl(url: string) {
  const match = url.match(/open\.spotify\.com\/(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]+)/);
  return match ? { type: match[1], id: match[2] } : null;
}

function youtubeId(url: string) {
  const match = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
  return match?.[1] ?? "";
}

/* Sites that send X-Frame-Options / CSP frame-ancestors and therefore cannot be
   embedded by ANY website. Only the site owner can change that, so instead of
   showing a blank frame we surface a proper "open in a tab" interstitial. */
const NO_EMBED_HOSTS = [
  "google.com", "www.google.com", "accounts.google.com", "gemini.google.com",
  "chatgpt.com", "chat.openai.com", "openai.com", "claude.ai",
  "youtube.com", "www.youtube.com", "music.youtube.com",
  "x.com", "twitter.com", "instagram.com", "facebook.com", "reddit.com",
  "www.reddit.com", "linkedin.com", "github.com", "amazon.com", "netflix.com",
  "duckduckgo.com", "bing.com", "www.bing.com", "perplexity.ai", "notion.so",
];

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isBlockedHost(url: string) {
  const host = hostOf(url);
  if (!host) return false;
  return NO_EMBED_HOSTS.some((blocked) => {
    const base = blocked.replace(/^www\./, "");
    return host === base || host.endsWith(`.${base}`);
  });
}

function autoScene() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 8) return "dawn" as SceneId;
  if (hour >= 8 && hour < 13) return "forest" as SceneId;
  if (hour >= 13 && hour < 18) return "ocean" as SceneId;
  if (hour >= 18 && hour < 22) return "cabin" as SceneId;
  return "pure" as SceneId;
}

/* Sample the dominant hue of the active background so the whole UI
   is tinted by whatever is on screen — the theme is never static. */
function sampleImageHue(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timeout = window.setTimeout(() => resolve(null), 6000);
    img.onload = () => {
      window.clearTimeout(timeout);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 48;
        canvas.height = 27;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 48, 27);
        const { data } = ctx.getImageData(0, 0, 48, 27);
        const bins = new Array(36).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255;
          const g = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const l = (max + min) / 2;
          const d = max - min;
          if (d < 0.06 || l < 0.1 || l > 0.9) continue;
          let h = 0;
          if (max === r) h = ((g - b) / d) % 6;
          else if (max === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h = ((h * 60) + 360) % 360;
          const s = d / (1 - Math.abs(2 * l - 1));
          const bin = Math.floor(h / 10) % 36;
          bins[bin] += s * (1 - Math.abs(l - 0.5));
        }
        let best = 0;
        for (let i = 1; i < bins.length; i += 1) if (bins[i] > bins[best]) best = i;
        resolve(bins[best] > 0 ? best * 10 + 5 : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      window.clearTimeout(timeout);
      resolve(null);
    };
    img.src = url;
  });
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    task: <><path d="M4 7l1.5 1.5L9 5" /><path d="M4 13l1.5 1.5L9 11" /><path d="M12 7h8" /><path d="M12 13h8" /><path d="M5 19h15" /></>,
    music: <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
    scene: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 15l3-3 3 3 2-2 3 4" /><circle cx="8" cy="9" r="1.4" /></>,
    stats: <><path d="M5 20V10" /><path d="M12 20V4" /><path d="M19 20v-7" /></>,
    note: <><path d="M4 20h4l11-11-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
    play: <path d="M8 5.5l11 6.5-11 6.5v-13z" />,
    pause: <><rect x="7" y="5" width="4" height="14" rx="1" /><rect x="15" y="5" width="4" height="14" rx="1" /></>,
    reset: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>,
    skip: <><path d="M6 5l9 7-9 7V5z" /><path d="M18 5v14" /></>,
    prev: <><path d="M18 5l-9 7 9 7V5z" /><path d="M6 5v14" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M7 7l1 13h8l1-13" /></>,
    check: <path d="M4 12l5 5L20 6" />,
    close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
    full: <><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>,
    unfull: <><path d="M9 4v5H4" /><path d="M15 4v5h5" /><path d="M9 20v-5H4" /><path d="M15 20v-5h5" /></>,
    youtube: <><path d="M21.5 8.2a3 3 0 0 0-2.1-2.1C17.6 5.6 12 5.6 12 5.6s-5.6 0-7.4.5a3 3 0 0 0-2.1 2.1A31 31 0 0 0 2 12a31 31 0 0 0 .5 3.8 3 3 0 0 0 2.1 2.1c1.8.5 7.4.5 7.4.5s5.6 0 7.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.5-3.8Z" /><path d="m10 9 5 3-5 3V9Z" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" /></>,
    doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    external: <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
    back: <><path d="M15 5l-7 7 7 7" /></>,
    refresh: <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" /></>,
    palette: <><circle cx="12" cy="12" r="9" /><circle cx="9" cy="10" r="1.1" /><circle cx="13" cy="8.5" r="1.1" /><circle cx="16" cy="11.5" r="1.1" /><circle cx="10.5" cy="14.5" r="1.1" /><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.6-.7 1.6-1.5 0-.4-.2-.7-.2-1.1 0-.7.6-1.2 1.3-1.2h1.5A3.8 3.8 0 0 0 20 13.4C20 7.7 16.4 3 12 3Z" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

/** #rrggbb → hue (0-359). Used by the custom accent color picker. */
function hexToHue(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return Math.round(((h * 60 + 360) % 360));
}

/** hue → #rrggbb at the same saturation/lightness used for scene accents,
    so the swatches and the native color input always match what's rendered. */
function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Batches rapid updates (pointer drags) to once per animation frame, so a
    fast mouse move doesn't force a React re-render on every pixel — the
    drag still tracks the cursor exactly, just paced to the display's own
    refresh cadence instead of the input event rate. */
function useRafBatched<T>(callback: (value: T) => void) {
  const box = useRef<{ raf: number | null; value: T | null }>({ raf: null, value: null });
  useEffect(
    () => () => {
      if (box.current.raf != null) cancelAnimationFrame(box.current.raf);
    },
    [],
  );
  return (value: T) => {
    box.current.value = value;
    if (box.current.raf == null) {
      box.current.raf = requestAnimationFrame(() => {
        box.current.raf = null;
        if (box.current.value != null) callback(box.current.value);
      });
    }
  };
}

function FloatingWindow({
  title,
  icon,
  win,
  z = 12,
  onFocus,
  onPatch,
  onClose,
  children,
}: {
  title: string;
  icon: string;
  win: WinFrame;
  z?: number;
  onFocus?: () => void;
  onPatch: (patch: Partial<WinFrame>) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const batchedPatch = useRafBatched<Partial<WinFrame>>(onPatch);

  const begin = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (win.full) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { mode, sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y, ow: win.w, oh: win.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      batchedPatch({
        x: clamp(d.ox + dx, 70 - d.ow, window.innerWidth - 70),
        y: clamp(d.oy + dy, 2, window.innerHeight - 54),
      });
    } else {
      batchedPatch({
        w: clamp(d.ow + dx, 300, window.innerWidth - 8),
        h: clamp(d.oh + dy, 340, window.innerHeight - 8),
      });
    }
  };

  const end = () => {
    drag.current = null;
  };

  const style = win.full
    ? { left: 0, top: 0, width: "100vw", height: "100dvh", zIndex: z }
    : {
        left: Math.min(win.x, window.innerWidth - 40),
        top: Math.min(win.y, window.innerHeight - 60),
        width: Math.min(win.w, window.innerWidth - 12),
        height: Math.min(win.h, window.innerHeight - 12),
        zIndex: z,
      };

  return (
    <div className={`float-win ${win.full ? "is-full" : ""}`} style={style} onPointerDownCapture={onFocus}>
      <div className="fw-head" onPointerDown={begin("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <div className="fw-title"><Icon name={icon} /><span>{title}</span></div>
        <div className="fw-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button className="icon-button" onClick={() => onPatch({ full: !win.full })} aria-label={`Toggle ${title} fullscreen`} title="Fullscreen">
            <Icon name={win.full ? "unfull" : "full"} />
          </button>
          <button className="icon-button" onClick={onClose} aria-label={`Close ${title}`} title="Close">
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className="fw-body">{children}</div>
      {!win.full && (
        <div className="fw-resize" title="Drag to resize" onPointerDown={begin("resize")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
      )}
    </div>
  );
}

/** Renders 25 : 00 with breathing room around the colon. */
function TimeReadout({ seconds }: { seconds: number }) {
  const parts = formatTime(seconds).split(":");
  return (
    <div className="time-readout">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <i className="tr-colon">:</i>}
          <b>{part}</b>
        </span>
      ))}
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="field compact"><span>{label}</span><input type="number" min={min} max={max} value={value} onChange={(event) => onChange(clamp(Number(event.target.value) || min, min, max))} /></label>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="switch-row"><span>{label}</span><button className={value ? "switch on" : "switch"} onClick={() => onChange(!value)} /></div>;
}

function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [running, setRunning] = useState(false);
  const [openPanels, setOpenPanels] = useState<PanelId[]>([]);
  const [clock, setClock] = useState(new Date());
  const [quoteIndex, setQuoteIndex] = useState(() => Math.floor(Math.random() * quotes.length));
  const [taskInput, setTaskInput] = useState("");
  const [spotifyInput, setSpotifyInput] = useState("");
  const [imageInput, setImageInput] = useState("");
  const [youtubeInput, setYoutubeInput] = useState("");
  const [studyInput, setStudyInput] = useState(state.studyVideo);
  const [musicTab, setMusicTab] = useState<"spotify" | "youtube">("spotify");
  const [ytMusicInput, setYtMusicInput] = useState("");
  const [phaseLine, setPhaseLine] = useState(() => pickRandom(FOCUS_LINES));
  const [toast, setToast] = useState("");
  const [sampledHue, setSampledHue] = useState<number | null>(null);
  const [utilTab, setUtilTab] = useState<UtilId | null>(null);
  const [utilMenu, setUtilMenu] = useState(false);
  const [utilWidth, setUtilWidth] = useState(() => Math.min(760, Math.max(380, window.innerWidth * 0.46)));
  const [utilHeight, setUtilHeight] = useState<number | null>(null);
  const [browserUrl, setBrowserUrl] = useState("https://en.wikipedia.org/wiki/Pomodoro_Technique");
  const [browserInput, setBrowserInput] = useState("");
  const [browserNonce, setBrowserNonce] = useState(0);
  const [liveFrame, setLiveFrame] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [fileZoom, setFileZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [confetti, setConfetti] = useState<Array<{ id: string; x: number; dx: number; delay: number; dur: number; size: number; rot: number }>>([]);
  const endAt = useRef(0);
  const segmentStartedAt = useRef<number | null>(null);
  const segmentElapsed = useRef(0);
  const completionLock = useRef(false);
  const pendingAutoStart = useRef(false);
  const lastCheckIn = useRef(Date.now());
  const utilDrag = useRef<{ axis: "x" | "y" | "xy"; sx: number; sy: number; ow: number; oh: number } | null>(null);
  const batchedUtilResize = useRafBatched<{ w?: number; h?: number }>((patch) => {
    if (patch.w !== undefined) setUtilWidth(patch.w);
    if (patch.h !== undefined) setUtilHeight(patch.h);
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const runningRef = useRef(running);
  runningRef.current = running;

  const totalSeconds = secondsFor(state.mode, state);
  const progress = clamp(1 - state.remaining / Math.max(totalSeconds, 1), 0, 1);
  const activeTask = state.tasks.find((task) => task.id === state.activeTaskId) ?? null;
  const isBreak = state.mode === "short" || state.mode === "long";
  const studyId = state.studyVideo ? youtubeId(state.studyVideo) : "";
  const activeFile = files.find((file) => file.id === activeFileId) ?? null;

  /* Pomodoro cycle position: how many focus sessions are done in the current cycle */
  const cycleLength = state.settings.sessionsBeforeLong;
  const inCycle = state.sessionsDone % cycleLength;

  /* ---- dynamic theme: hue is sampled from whatever is on screen ---- */
  const effectiveScene = state.sceneAuto ? autoScene() : state.scene;
  const bgUrl = state.customImage || (effectiveScene !== "pure" ? SCENE_IMAGES[effectiveScene] : "");

  useEffect(() => {
    let alive = true;
    setSampledHue(null);
    // A manual color override always wins, so skip the network fetch and
    // canvas decode entirely while one is active — nothing to gain from it.
    if (!bgUrl || state.customHue != null) return;
    sampleImageHue(bgUrl).then((hue) => {
      if (alive) setSampledHue(hue);
    });
    return () => {
      alive = false;
    };
  }, [bgUrl, state.customHue]);

  // Priority: your manual pick > whatever hue was sampled off the current
  // background > the scene's own default. Never static, always intentional.
  const hue = state.customHue ?? sampledHue ?? SCENE_HUES[effectiveScene];
  const themeVars = useMemo(
    () =>
      ({
        "--accent": `hsl(${hue} 66% 60%)`,
        "--accent-2": `hsl(${hue} 72% 46%)`,
        "--accent-glow": `hsla(${hue}, 75%, 60%, 0.45)`,
        "--accent-soft": `hsla(${hue}, 70%, 60%, 0.15)`,
        "--break": `hsl(${(hue + 140) % 360} 62% 64%)`,
      }) as React.CSSProperties,
    [hue],
  );

  /* ---- persistence ----
     Debounced so a state field that changes every second (the running
     timer, live stat accrual) doesn't serialize and write the whole
     document to localStorage many times a second. A flush on tab-hide /
     unload guarantees the last few hundred milliseconds are never lost. */
  useEffect(() => {
    const id = window.setTimeout(() => localStorage.setItem(STORE_KEY, JSON.stringify(state)), 600);
    return () => window.clearTimeout(id);
  }, [state]);

  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(stateRef.current));
      } catch {
        /* storage full or unavailable — nothing more we can do here */
      }
    };
    const onHide = () => {
      if (document.hidden) flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  /* ---- clock + quote rotation ---- */
  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 15000);
    // Pick a fresh random quote each rotation (never immediately repeating)
    // so a much larger library feels varied instead of walking in order.
    const quoteId = window.setInterval(() => {
      setQuoteIndex((idx) => {
        if (quotes.length <= 1) return idx;
        let next = idx;
        while (next === idx) next = Math.floor(Math.random() * quotes.length);
        return next;
      });
    }, 45000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(quoteId);
    };
  }, []);

  /* ---- timer engine: timestamp-based so it never drifts ----
     Ticks once a second — the readout only ever shows whole seconds anyway,
     so there is nothing to gain from updating four times as often, only a
     4x reduction in re-renders and localStorage churn while running. */
  useEffect(() => {
    if (!running) return;
    completionLock.current = false;
    const interval = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((endAt.current - Date.now()) / 1000));
      setState((prev) => (prev.remaining === next ? prev : { ...prev, remaining: next }));
      // Read live settings from the ref — the effect closure would go stale
      // if the user toggles check-ins mid-session.
      const live = stateRef.current;
      if (live.settings.checkIns && live.mode === "focus" && Date.now() - lastCheckIn.current > live.settings.checkInMinutes * 60000) {
        lastCheckIn.current = Date.now();
        notify("Quick check-in: still on the chosen task?");
      }
      if (next <= 0 && !completionLock.current) {
        completionLock.current = true;
        window.setTimeout(() => completeSegment(), 0);
      }
    }, 1000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, state.mode]);

  useEffect(() => {
    document.title = running ? `${formatTime(state.remaining)} | ${modeLabels[state.mode]}` : "Focus | Quiet work timer";
  }, [running, state.remaining, state.mode]);

  /* Auto-start the next segment when its state is ready */
  useEffect(() => {
    if (!pendingAutoStart.current || running) return;
    pendingAutoStart.current = false;
    startTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode, state.remaining, running]);

  /* Keyboard shortcuts: Space start/pause · R reset · Esc close window.
     The handler is kept in a ref so it always sees the latest state. */
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (running) pauseTimer();
      else startTimer();
    } else if (e.key === "r" || e.key === "R") {
      resetTimer();
    } else if (e.key === "Escape") {
      setUtilMenu(false);
      setOpenPanels((prev) => prev.slice(0, -1));
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    setFileZoom(1);
  }, [activeFileId]);

  // A fresh tagline every time the phase changes — never the task text,
  // never repeating the chip shown below the controls.
  useEffect(() => {
    setPhaseLine(pickRandom(phaseLinesFor(state.mode)));
  }, [state.mode]);

  /* ---- live time accrual ----
     Every second the elapsed wall time is added to whichever bucket is
     currently active, so a focus session that is paused or skipped after
     five minutes still records those five minutes. The delta is capped so
     a sleeping laptop or a backgrounded tab cannot inject phantom hours. */
  const accrualRef = useRef(Date.now());
  useEffect(() => {
    const flush = () => {
      const now = Date.now();
      const delta = Math.min((now - accrualRef.current) / 1000, 90);
      accrualRef.current = now;
      if (delta < 0.5) return;

      const live = stateRef.current;
      const bucket: keyof Pick<DayStat, "focusSec" | "breakSec" | "idleSec"> = !runningRef.current
        ? "idleSec"
        : live.mode === "focus"
          ? "focusSec"
          : "breakSec";

      setState((prev) => {
        const key = todayKey();
        const day = prev.stats[key] ?? emptyDay();
        return { ...prev, stats: { ...prev.stats, [key]: { ...day, [bucket]: day[bucket] + delta } } };
      });
    };

    const id = window.setInterval(flush, 1000);
    // Don't bank time that passed while the tab was hidden or the device slept.
    const onVisible = () => {
      if (document.hidden) flush();
      accrualRef.current = Date.now();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreen);
    syncFullscreen();
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  function resetSegmentClock() {
    segmentStartedAt.current = null;
    segmentElapsed.current = 0;
  }

  function burstConfetti() {
    const pieces = Array.from({ length: 56 }, () => ({
      id: uid(),
      x: 12 + Math.random() * 76,
      dx: -180 + Math.random() * 360,
      delay: Math.random() * 0.18,
      dur: 1.8 + Math.random() * 1.2,
      size: 6 + Math.random() * 8,
      rot: Math.random() * 720,
    }));
    setConfetti(pieces);
    window.setTimeout(() => setConfetti([]), 3400);
  }

  async function toggleAppFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      notify("Fullscreen is blocked by this browser or preview frame.");
    }
  }

  function openPanel(id: PanelId) {
    setOpenPanels((prev) => (prev.includes(id) ? [...prev.filter((p) => p !== id), id] : [...prev, id]));
  }

  function closePanel(id: PanelId) {
    setOpenPanels((prev) => prev.filter((p) => p !== id));
  }

  function togglePanel(id: PanelId) {
    setOpenPanels((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  /** Focus a window by pushing it to the end of the stacking order. */
  function raisePanel(id: PanelId) {
    setOpenPanels((prev) => (prev[prev.length - 1] === id ? prev : [...prev.filter((p) => p !== id), id]));
  }

  function openUtility(id: UtilId) {
    setUtilTab((prev) => (prev === id ? null : id));
    setUtilMenu(false);
  }

  /** Treat input as a URL when it looks like one, otherwise search the web. */
  function goToBrowserTarget(raw: string) {
    const value = raw.trim();
    if (!value) return;
    const looksLikeUrl = /^https?:\/\//i.test(value) || /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(value);
    const target = looksLikeUrl
      ? value.startsWith("http")
        ? value
        : `https://${value}`
      // DuckDuckGo's plain-HTML endpoint extracts cleanly into reader mode.
      : `https://duckduckgo.com/html/?q=${encodeURIComponent(value)}`;
    navigateTo(target);
  }

  function navigateTo(target: string) {
    setHistory((prev) => (browserUrl ? [...prev, browserUrl].slice(-40) : prev));
    setBrowserUrl(target);
    setBrowserNonce((n) => n + 1);
  }

  function goBack() {
    setHistory((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice(0, -1);
      setBrowserUrl(prev[prev.length - 1]);
      setBrowserNonce((n) => n + 1);
      return next;
    });
  }

  /* Decide how to render a file from both its MIME type and its extension —
     many local files arrive with an empty type string. */
  function classifyFile(file: File): FileKind {
    const name = file.name.toLowerCase();
    const type = file.type;
    if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(name)) return "image";
    if (type.startsWith("video/") || /\.(mp4|webm|ogv|mov|mkv)$/.test(name)) return "video";
    if (type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac|aac)$/.test(name)) return "audio";
    if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
    if (
      type.startsWith("text/") ||
      /\.(txt|md|markdown|csv|tsv|json|jsonc|log|xml|yml|yaml|ini|env|js|jsx|ts|tsx|css|scss|html?|py|rb|go|rs|java|c|h|cpp|cs|php|sh|sql)$/.test(name)
    ) {
      return "text";
    }
    return "other";
  }

  async function addLocalFiles(list: FileList | null) {
    if (!list?.length) return;
    const added: LocalFile[] = [];
    for (const file of Array.from(list)) {
      const kind = classifyFile(file);
      const entry: LocalFile = { id: uid(), name: file.name, type: file.type, url: URL.createObjectURL(file), kind };
      if (kind === "text") {
        try {
          entry.text = await file.text();
        } catch {
          entry.kind = "other";
        }
      } else if (kind === "pdf") {
        // Read the bytes up front — PDFs are painted to canvas, never framed.
        try {
          entry.data = await file.arrayBuffer();
        } catch {
          entry.kind = "other";
        }
      }
      added.push(entry);
    }
    setFiles((prev) => [...prev, ...added]);
    setActiveFileId(added[added.length - 1]?.id ?? null);
  }

  function removeLocalFile(id: string) {
    setFiles((prev) => {
      const target = prev.find((file) => file.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((file) => file.id !== id);
    });
    setActiveFileId((current) => (current === id ? null : current));
  }

  function loadStudyVideo() {
    const url = studyInput.trim();
    const id = youtubeId(url);
    if (!id) {
      notify("Couldn't read a video ID from that YouTube link.");
      return;
    }
    setState((prev) => ({ ...prev, studyVideo: url }));
    setStudyInput(url);
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  function startTimer() {
    if (running) return;
    endAt.current = Date.now() + Math.max(1, state.remaining) * 1000;
    segmentStartedAt.current = Date.now();
    lastCheckIn.current = Date.now();
    setRunning(true);
  }

  function pauseTimer() {
    if (segmentStartedAt.current) {
      segmentElapsed.current += Math.floor((Date.now() - segmentStartedAt.current) / 1000);
      segmentStartedAt.current = null;
    }
    setRunning(false);
  }

  function resetTimer() {
    setRunning(false);
    resetSegmentClock();
    setState((prev) => ({ ...prev, remaining: secondsFor(prev.mode, prev) }));
  }

  function switchMode(mode: ModeId) {
    setRunning(false);
    resetSegmentClock();
    setState((prev) => ({ ...prev, mode, remaining: secondsFor(mode, prev) }));
  }

  /* Classic pomodoro cycle: after N focus sessions the long break is next,
     otherwise a short break. Any break is followed by focus. */
  function modeAfterFocus(sessionsDone: number, n: number): ModeId {
    return sessionsDone % n === 0 ? "long" : "short";
  }

  function completeSegment() {
    setRunning(false);
    // Mode / session count are stable across ticks, so deriving the route here
    // is safe; the updater below only touches data that can change
    // while the timer runs (tasks, stats, settings) and stays pure.
    const prev = state;
    const wasFocus = prev.mode === "focus";
    const n = prev.settings.sessionsBeforeLong;
    const sessionsDone = wasFocus ? prev.sessionsDone + 1 : prev.sessionsDone;
    const nextMode: ModeId = wasFocus ? modeAfterFocus(sessionsDone, n) : "focus";
    const shouldAutoStart =
      (nextMode === "focus" && prev.settings.autoStartFocus) ||
      ((nextMode === "short" || nextMode === "long") && prev.settings.autoStartBreaks);
    setState((last) => {
      const nextStats = { ...last.stats };
      const nextTasks = last.tasks.map((task) => ({ ...task }));
      if (wasFocus) {
        // Minutes are already banked by the live accrual ticker; only the
        // completed-session count is recorded here.
        const key = todayKey();
        const day = nextStats[key] ?? emptyDay();
        nextStats[key] = { ...day, sessions: day.sessions + 1 };
        const active = nextTasks.find((task) => task.id === last.activeTaskId);
        if (active) active.pomosDone += 1;
      }
      return { ...last, tasks: nextTasks, stats: nextStats, sessionsDone, mode: nextMode, remaining: secondsFor(nextMode, last) };
    });
    if (wasFocus) burstConfetti();
    resetSegmentClock();
    pendingAutoStart.current = shouldAutoStart;
  }

  function skipSegment() {
    setRunning(false);
    const prev = state;
    const wasFocus = prev.mode === "focus";
    const n = prev.settings.sessionsBeforeLong;
    const sessionsDone = wasFocus ? prev.sessionsDone + 1 : prev.sessionsDone;
    // Skipping advances the cycle. Whatever minutes were actually worked are
    // already banked by the live ticker — only the skip count is added here.
    const nextMode: ModeId = wasFocus ? modeAfterFocus(sessionsDone, n) : "focus";
    setState((last) => {
      const key = todayKey();
      const day = last.stats[key] ?? emptyDay();
      return {
        ...last,
        stats: { ...last.stats, [key]: { ...day, skippedFocus: day.skippedFocus + (wasFocus ? 1 : 0) } },
        sessionsDone,
        mode: nextMode,
        remaining: secondsFor(nextMode, last),
      };
    });
    resetSegmentClock();
  }

  function addTask() {
    const text = taskInput.trim();
    if (!text) return;
    const task: Task = { id: uid(), text, done: false, pomosDone: 0, createdAt: Date.now() };
    setState((prev) => ({ ...prev, tasks: [task, ...prev.tasks], activeTaskId: prev.activeTaskId ?? task.id }));
    setTaskInput("");
  }

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setState((prev) => {
      const next = { ...prev, settings: { ...prev.settings, [key]: value } };
      if (!running && ["focusMinutes", "shortMinutes", "longMinutes"].includes(key)) {
        next.remaining = secondsFor(prev.mode, next);
      }
      return next;
    });
  }

  function patchFrame(id: PanelId, patch: Partial<WinFrame>) {
    setState((prev) => ({
      ...prev,
      windows: { ...prev.windows, [id]: { ...(prev.windows[id] ?? defaultFrame()), ...patch } },
    }));
  }

  const dateText = clock.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const clockText = state.settings.clock24h
    ? clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    : clock.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const greeting =
    clock.getHours() < 5 ? "still up" : clock.getHours() < 12 ? "good morning" : clock.getHours() < 17 ? "good afternoon" : clock.getHours() < 22 ? "good evening" : "still up";

  const sevenDays = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 7 }, (_, index) => {
      const d = new Date(now);
      d.setDate(now.getDate() - (6 - index));
      return { key: todayKey(d), label: d.toLocaleDateString(undefined, { weekday: "narrow" }) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.stats]);
  const maxDay = Math.max(1, ...sevenDays.map((day) => state.stats[day.key]?.focusSec ?? 0));
  const totalSessions = Object.values(state.stats).reduce((sum, day) => sum + (day.sessions ?? 0), 0);
  const streak = useMemo(() => {
    const now = new Date();
    let count = 0;
    for (let i = 0; i < 365; i += 1) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const rec = state.stats[todayKey(d)];
      if (rec?.sessions) count += 1;
      else if (i !== 0) break;
    }
    return count;
  }, [state.stats]);
  const todayStats = state.stats[todayKey()] ?? emptyDay();
  const focusSec = todayStats.focusSec;
  const breakSec = todayStats.breakSec;
  const idleSec = todayStats.idleSec;
  const trackedSec = focusSec + breakSec + idleSec;
  const pct = (value: number) => (trackedSec > 0 ? (value / trackedSec) * 100 : 0);
  const focusBreakRatio =
    breakSec > 0 ? `${(focusSec / breakSec).toFixed(1)} : 1` : focusSec > 0 ? "∞ : 0" : "—";
  const productivity = Math.round(pct(focusSec));

  const ytId = state.customYoutube ? youtubeId(state.customYoutube) || state.customYoutube : "";

  /* Dots represent completed focus sessions only. They stay full through the
     long break, then reset when the next focus cycle begins. */
  const dotClass = (i: number): string => {
    if (state.mode === "long") return "filled";
    if (i < inCycle) return "filled";
    return "";
  };

  const cycleCopy =
    state.mode === "focus"
      ? `Session ${inCycle + 1} of ${cycleLength}`
      : state.mode === "short"
        ? `Short break${inCycle ? ` · after session ${inCycle}` : ""}`
        : "Long break · cycle complete";

  const totalTasks = state.tasks.length;
  const doneTasks = state.tasks.filter((task) => task.done).length;
  const taskPct = totalTasks > 0 ? (doneTasks / totalTasks) * 100 : 0;
  const taskProgressNote =
    totalTasks === 0
      ? ""
      : taskPct === 100
        ? "Everything's done — take the win."
        : doneTasks === 0
          ? "Clear the first one."
          : taskPct >= 75
            ? "Almost there — finish strong."
            : taskPct >= 50
              ? "Past halfway. Keep going."
              : `${totalTasks - doneTasks} left to go.`;

  const panelContent: Record<PanelId, React.ReactNode> = {
    tasks: (
      <>
        {totalTasks > 0 && (
          <div className={`task-progress ${taskPct === 100 ? "complete" : ""}`}>
            <div className="task-progress-head">
              <span>Progress</span>
              <b>{doneTasks}/{totalTasks}</b>
            </div>
            <div
              className="task-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={totalTasks}
              aria-valuenow={doneTasks}
              aria-label={`${doneTasks} of ${totalTasks} tasks complete`}
            >
              <i style={{ width: `${taskPct}%` }} />
            </div>
            <div className="task-progress-foot">
              <small>{Math.round(taskPct)}% complete</small>
              <em>{taskProgressNote}</em>
            </div>
          </div>
        )}
        <div className="add-row">
          <input value={taskInput} onChange={(event) => setTaskInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addTask()} placeholder="Add what you are working on" maxLength={140} />
          <button onClick={addTask} aria-label="Add task"><Icon name="plus" /></button>
        </div>
        <div className="task-list">
          {state.tasks.length === 0 && <p className="empty-copy">No tasks yet. Add one precise target for the next session.</p>}
          {state.tasks.map((task) => (
            <div
              key={task.id}
              className={`task-item ${task.done ? "done" : ""} ${task.id === state.activeTaskId ? "selected" : ""}`}
              onClick={() => setState((prev) => ({ ...prev, activeTaskId: task.id }))}
            >
              <button onClick={(event) => { event.stopPropagation(); setState((prev) => ({ ...prev, tasks: prev.tasks.map((item) => (item.id === task.id ? { ...item, done: !item.done } : item)) })); }} aria-label="Toggle done">
                <Icon name="check" />
              </button>
              <span>{task.text}</span>
              {!!task.pomosDone && <small>{task.pomosDone}x</small>}
              <button
                className="delete"
                onClick={(event) => { event.stopPropagation(); setState((prev) => ({ ...prev, tasks: prev.tasks.filter((item) => item.id !== task.id), activeTaskId: prev.activeTaskId === task.id ? null : prev.activeTaskId })); }}
                aria-label="Delete task"
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      </>
    ),
    music: (
      <>
        <div className="music-tabs">
          <button className={musicTab === "spotify" ? "active" : ""} onClick={() => setMusicTab("spotify")}>Spotify</button>
          <button className={musicTab === "youtube" ? "active" : ""} onClick={() => setMusicTab("youtube")}>YouTube Music</button>
        </div>

        {musicTab === "spotify" && (
          <>
            <label className="field"><span>Spotify link</span><input value={spotifyInput} onChange={(event) => setSpotifyInput(event.target.value)} onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const parsed = spotifyFromUrl(spotifyInput.trim());
              if (!parsed) return notify("Paste a valid Spotify track, album, or playlist link.");
              setState((prev) => ({ ...prev, spotify: parsed }));
            }} placeholder="https://open.spotify.com/playlist/..." /></label>
            <button
              className="panel-primary"
              onClick={() => {
                const parsed = spotifyFromUrl(spotifyInput.trim());
                if (!parsed) return notify("Paste a valid Spotify track, album, or playlist link.");
                setState((prev) => ({ ...prev, spotify: parsed }));
              }}
            >
              Load player
            </button>
            {state.spotify ? (
              <>
                <iframe
                  className="spotify-frame"
                  src={`https://open.spotify.com/embed/${state.spotify.type}/${state.spotify.id}?utm_source=generator&theme=0`}
                  allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                  title="Spotify player"
                />
                <button className="panel-danger" onClick={() => setState((prev) => ({ ...prev, spotify: null }))}>Remove player</button>
              </>
            ) : (
              <p className="empty-copy">Paste a public Spotify playlist, album, or track link. It plays right here — no new tab, no leaving the app.</p>
            )}
          </>
        )}

        {musicTab === "youtube" && (
          <>
            <label className="field">
              <span>YouTube / YouTube Music link</span>
              <input
                value={ytMusicInput}
                onChange={(event) => setYtMusicInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const value = ytMusicInput.trim();
                  if (!value) return;
                  setState((prev) => ({ ...prev, youtubeMusicUrl: value }));
                }}
                placeholder="https://music.youtube.com/playlist?list=..."
              />
            </label>
            <button
              className="panel-primary"
              onClick={() => {
                const value = ytMusicInput.trim();
                if (!value) return notify("Paste a YouTube video or playlist link first.");
                setState((prev) => ({ ...prev, youtubeMusicUrl: value }));
              }}
            >
              Load audio
            </button>
            {state.youtubeMusicUrl ? (
              <>
                <Suspense fallback={<p className="empty-copy">Loading player…</p>}>
                  <YouTubeAudioPlayer url={state.youtubeMusicUrl} />
                </Suspense>
                <button className="panel-danger" onClick={() => setState((prev) => ({ ...prev, youtubeMusicUrl: "" }))}>Remove player</button>
              </>
            ) : (
              <p className="empty-copy">Paste any YouTube or YouTube Music video/playlist link. Only the audio plays — the video is never shown.</p>
            )}
          </>
        )}
      </>
    ),
    scenes: (
      <>
        <div className="switch-row">
          <span>Adapt to time of day</span>
          <button className={state.sceneAuto ? "switch on" : "switch"} onClick={() => setState((prev) => ({ ...prev, sceneAuto: !prev.sceneAuto }))} />
        </div>
        <div className="scene-grid">
          {(Object.keys(sceneLabels) as SceneId[]).map((scene) => (
            <button
              key={scene}
              className={`scene-pick mini-${scene} ${!state.sceneAuto && state.scene === scene ? "active" : ""}`}
              onClick={() => setState((prev) => ({ ...prev, scene, sceneAuto: false, customImage: "", customYoutube: "" }))}
            >
              {sceneLabels[scene]}
            </button>
          ))}
        </div>
        <p className="field-hint">The accent color of the whole UI follows the scene. Switch scenes and watch it shift.</p>

        <div className="theme-block">
          <div className="theme-head">
            <span>Accent color</span>
            <i className="theme-preview" style={{ background: hslToHex(hue, 66, 60) }} aria-hidden="true" />
          </div>

          <div className="swatch-grid">
            {THEME_SWATCHES.map((hexValue) => {
              const swatchHue = hexToHue(hexValue);
              const active = state.customHue !== null && Math.abs(((state.customHue - swatchHue + 540) % 360) - 180) < 6;
              return (
                <button
                  key={hexValue}
                  className={`swatch ${active ? "active" : ""}`}
                  style={{ background: hexValue }}
                  onClick={() => setState((prev) => ({ ...prev, customHue: swatchHue }))}
                  aria-label={`Use ${hexValue} as the accent color`}
                  title={hexValue}
                />
              );
            })}
          </div>

          <input
            className="hue-slider"
            type="range"
            min={0}
            max={359}
            value={Math.round(hue)}
            onChange={(event) => setState((prev) => ({ ...prev, customHue: Number(event.target.value) }))}
            aria-label="Accent hue"
          />

          <button className="theme-reset" onClick={() => setState((prev) => ({ ...prev, customHue: null }))} disabled={state.customHue == null}>
            Reset to scene color
          </button>
        </div>

        <label className="field"><span>Custom image URL</span><input value={imageInput} onChange={(event) => setImageInput(event.target.value)} placeholder="https://..." /></label>
        <button className="panel-primary" onClick={() => setState((prev) => ({ ...prev, customImage: imageInput.trim(), customYoutube: "" }))}>Use image</button>
        <label className="field"><span>YouTube URL</span><input value={youtubeInput} onChange={(event) => setYoutubeInput(event.target.value)} placeholder="https://youtube.com/watch?v=..." /></label>
        <button className="panel-primary subtle" onClick={() => setState((prev) => ({ ...prev, customYoutube: youtubeInput.trim(), customImage: "" }))}>Use video background</button>
        <button className="panel-danger" onClick={() => setState((prev) => ({ ...prev, customImage: "", customYoutube: "" }))}>Clear custom background</button>
      </>
    ),
    stats: (
      <>
        <div className="today-hero">
          <div
            className="focus-dial"
            style={{ "--deg": `${pct(focusSec) * 3.6}deg` } as React.CSSProperties}
            role="img"
            aria-label={`${productivity}% of tracked time was focus`}
          >
            <div className="focus-dial-core">
              <strong>{productivity}%</strong>
              <span>focused</span>
            </div>
          </div>
          <div className="today-figures">
            <div className="figure focus">
              <i /><span>Focus</span><b>{formatDuration(focusSec)}</b>
            </div>
            <div className="figure leisure">
              <i /><span>Leisure</span><b>{formatDuration(breakSec)}</b>
            </div>
            <div className="figure misc">
              <i /><span>Misc / Unproductive</span><b>{formatDuration(idleSec)}</b>
            </div>
          </div>
        </div>

        <div className="split-bar" aria-label="Today time split">
          <div className="split-track">
            <i className="seg-focus" style={{ width: `${pct(focusSec)}%` }} title={`Focus ${formatDuration(focusSec)}`} />
            <i className="seg-leisure" style={{ width: `${pct(breakSec)}%` }} title={`Leisure ${formatDuration(breakSec)}`} />
            <i className="seg-misc" style={{ width: `${pct(idleSec)}%` }} title={`Misc ${formatDuration(idleSec)}`} />
          </div>
          <div className="split-legend">
            <span><i className="seg-focus" />{Math.round(pct(focusSec))}%</span>
            <span><i className="seg-leisure" />{Math.round(pct(breakSec))}%</span>
            <span><i className="seg-misc" />{Math.round(pct(idleSec))}%</span>
          </div>
        </div>

        <div className="stat-row">
          <div><strong>{focusBreakRatio}</strong><span>Focus : leisure</span></div>
          <div><strong>{todayStats.sessions}</strong><span>Done today</span></div>
          <div><strong>{todayStats.skippedFocus}</strong><span>Skipped</span></div>
          <div><strong>{streak}</strong><span>Day streak</span></div>
          <div><strong>{totalSessions}</strong><span>All sessions</span></div>
          <div><strong>{formatDuration(trackedSec)}</strong><span>Tracked</span></div>
        </div>

        <div>
          <div className="chart-head">
            <span>Last 7 days</span>
            <small>focus vs leisure</small>
          </div>
          <div className="chart">
            {sevenDays.map((day) => {
              const record = state.stats[day.key] ?? emptyDay();
              const isToday = day.key === todayKey();
              return (
                <div key={day.key} className={isToday ? "today" : ""}>
                  <div className="bar-stack" title={`Focus ${formatDuration(record.focusSec)} · Leisure ${formatDuration(record.breakSec)}`}>
                    <span className="bar-leisure" style={{ height: `${(record.breakSec / maxDay) * 100}%` }} />
                    <span className="bar-focus" style={{ height: `${Math.max(record.focusSec > 0 ? 4 : 2, (record.focusSec / maxDay) * 100)}%` }} />
                  </div>
                  <small>{day.label}</small>
                </div>
              );
            })}
          </div>
        </div>
      </>
    ),
    notes: <textarea className="notes" value={state.notes} onChange={(event) => setState((prev) => ({ ...prev, notes: event.target.value }))} placeholder="Jot anything down. Saved locally on this device." />,
    settings: (
      <>
        <label className="field"><span>Your name</span><input value={state.settings.name} onChange={(event) => updateSetting("name", event.target.value.slice(0, 24))} placeholder="optional" /></label>
        <div className="settings-grid">
          <NumberField label="Focus (min)" value={state.settings.focusMinutes} min={1} max={180} onChange={(value) => updateSetting("focusMinutes", value)} />
          <NumberField label="Short break (min)" value={state.settings.shortMinutes} min={1} max={60} onChange={(value) => updateSetting("shortMinutes", value)} />
          <NumberField label="Long break (min)" value={state.settings.longMinutes} min={1} max={90} onChange={(value) => updateSetting("longMinutes", value)} />
          <NumberField label="Sessions before long break" value={state.settings.sessionsBeforeLong} min={2} max={12} onChange={(value) => updateSetting("sessionsBeforeLong", value)} />
          <NumberField label="Check-in (min)" value={state.settings.checkInMinutes} min={3} max={60} onChange={(value) => updateSetting("checkInMinutes", value)} />
        </div>
        <ToggleRow label="Auto-start breaks" value={state.settings.autoStartBreaks} onChange={(value) => updateSetting("autoStartBreaks", value)} />
        <ToggleRow label="Auto-start next focus" value={state.settings.autoStartFocus} onChange={(value) => updateSetting("autoStartFocus", value)} />
        <ToggleRow label="24-hour clock" value={state.settings.clock24h} onChange={(value) => updateSetting("clock24h", value)} />
        <ToggleRow label="Focus check-ins" value={state.settings.checkIns} onChange={(value) => updateSetting("checkIns", value)} />
        <button className="panel-danger" onClick={() => { localStorage.removeItem(STORE_KEY); window.location.reload(); }}>Erase local data</button>
      </>
    ),
  };

  const panelMeta: Record<PanelId, { title: string; icon: string }> = {
    tasks: { title: "Tasks", icon: "task" },
    music: { title: "Music", icon: "music" },
    scenes: { title: "Scenes", icon: "scene" },
    stats: { title: "Focus Stats", icon: "stats" },
    notes: { title: "Notes", icon: "note" },
    settings: { title: "Settings", icon: "settings" },
  };

  const dockItems: [PanelId, string][] = [
    ["tasks", "task"],
    ["music", "music"],
    ["scenes", "scene"],
    ["stats", "stats"],
    ["notes", "note"],
    ["settings", "settings"],
  ];

  return (
    <main
      className={`focus-app scene-${effectiveScene} ${running ? "is-running" : ""} ${utilTab ? "util-open" : ""}`}
      style={{ ...themeVars, "--util-w": `${utilWidth}px` } as React.CSSProperties}
    >
      <div className="visual-plane" style={state.customImage ? { backgroundImage: `url(${state.customImage})` } : undefined} />
      {ytId && (
        <iframe
          className="video-plane"
          src={`https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&mute=1&loop=1&playlist=${ytId}&controls=0&modestbranding=1&playsinline=1`}
          allow="autoplay; encrypted-media"
          title="Custom background video"
        />
      )}
      <div className="rain-layer" />
      <div className="snow-layer" />
      <div className="scrim" />

      <header className="topbar">
        <div className="greeting">
          <span className="greet-line">{greeting}{state.settings.name ? `, ${state.settings.name}` : ""}</span>
          <span className="greet-clock">{clockText}</span>
          <span className="greet-date">{dateText}</span>
        </div>
        <div className="top-quote">&ldquo;{quotes[quoteIndex]}&rdquo;</div>
      </header>

      <div className="workspace">
        {utilTab && (
          <section className="util-panel" aria-label="Utilities" style={utilHeight ? { height: utilHeight, flex: "0 0 auto" } : undefined}>
            <div className="util-head">
              <div className="util-tabs">
                {([["youtube", "youtube", "YouTube"], ["web", "globe", "Web"], ["files", "doc", "Files"]] as [UtilId, string, string][]).map(
                  ([id, icon, label]) => (
                    <button key={id} className={utilTab === id ? "active" : ""} onClick={() => setUtilTab(id)}>
                      <Icon name={icon} />
                      <span>{label}</span>
                    </button>
                  ),
                )}
              </div>
              <button className="icon-button" onClick={() => setUtilTab(null)} aria-label="Close utilities"><Icon name="close" /></button>
            </div>

            {utilTab === "youtube" && (
              <div className="util-content">
                <div className="util-bar">
                  <input
                    value={studyInput}
                    onChange={(event) => setStudyInput(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && loadStudyVideo()}
                    placeholder="Paste a YouTube link…"
                    aria-label="YouTube link"
                  />
                  <button className="util-go" onClick={loadStudyVideo}>Load</button>
                </div>
                <div className="util-view">
                  {studyId ? (
                    <iframe
                      key={studyId}
                      src={`https://www.youtube-nocookie.com/embed/${studyId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
                      title="YouTube study stream"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                    />
                  ) : (
                    <div className="util-empty">
                      <Icon name="youtube" />
                      <p>Paste a YouTube link to start your study stream.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {utilTab === "web" && (
              <div className="util-content">
                <div className="util-bar">
                  <button className="icon-button" onClick={goBack} disabled={!history.length} aria-label="Back" title="Back"><Icon name="back" /></button>
                  <button className="icon-button" onClick={() => setBrowserNonce((n) => n + 1)} aria-label="Reload page" title="Reload"><Icon name="refresh" /></button>
                  <input
                    value={browserInput}
                    onChange={(event) => setBrowserInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        goToBrowserTarget(browserInput);
                        setBrowserInput("");
                      }
                    }}
                    placeholder="Search the web or enter a URL…"
                    aria-label="Search or URL"
                  />
                  <button className="util-go" onClick={() => { goToBrowserTarget(browserInput); setBrowserInput(""); }}>Go</button>
                  <a className="icon-button" href={browserUrl} target="_blank" rel="noreferrer" aria-label="Open in new tab" title="Open in a real tab">
                    <Icon name="external" />
                  </a>
                </div>
                <div className="study-apps">
                  <span className="study-apps-label">Open logged-in:</span>
                  {([
                    ["Gemini", "https://gemini.google.com/app"],
                    ["ChatGPT", "https://chatgpt.com/"],
                    ["Claude", "https://claude.ai/new"],
                    ["Google", "https://www.google.com/"],
                    ["Docs", "https://docs.google.com/document/u/0/"],
                  ] as [string, string][]).map(([label, url]) => (
                    <a key={label} href={url} target="_blank" rel="noreferrer" title={`Open ${label} in a real browser tab`}>{label}</a>
                  ))}
                </div>
                <div className="reader-meta">
                  <span title={browserUrl}>{hostOf(browserUrl) || "—"}</span>
                  <div className="reader-modes">
                    <button className={!liveFrame ? "active" : ""} onClick={() => setLiveFrame(false)}>Reader</button>
                    <button className={liveFrame ? "active" : ""} onClick={() => setLiveFrame(true)} disabled={isBlockedHost(browserUrl)}>
                      Live
                    </button>
                  </div>
                </div>
                <div className="util-view">
                  {liveFrame && !isBlockedHost(browserUrl) ? (
                    <iframe
                      key={`${browserUrl}-${browserNonce}`}
                      src={browserUrl}
                      title="In-app browser"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <Suspense fallback={<div className="reader-status">Loading…</div>}>
                      <WebReader url={browserUrl} nonce={browserNonce} onNavigate={(next) => { setBrowserUrl(next); setBrowserNonce((n) => n + 1); }} />
                    </Suspense>
                  )}
                </div>
              </div>
            )}

            {utilTab === "files" && (
              <div className="util-content">
                {!activeFile ? (
                  <>
                    <div className="util-bar">
                      <label className="util-go as-label">
                        Open files…
                        <input type="file" multiple onChange={(event) => { addLocalFiles(event.target.files); event.target.value = ""; }} hidden />
                      </label>
                    </div>
                    {files.length > 0 && (
                      <div className="util-links files">
                        {files.map((file) => (
                          <button key={file.id} onClick={() => setActiveFileId(file.id)} title={file.name}>
                            <span>{file.name}</span>
                            <i onClick={(event) => { event.stopPropagation(); removeLocalFile(file.id); }} aria-hidden="true">×</i>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="util-view">
                      <div className="util-empty">
                        <Icon name="doc" />
                        <p>{files.length ? "Pick a file above to open it." : "Open any local file — PDFs, images, text, audio, or video."}</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="file-header">
                      <button className="icon-button" onClick={() => setActiveFileId(null)} aria-label="Back to files" title="Back to files"><Icon name="back" /></button>
                      <span className="file-title" title={activeFile.name}>{activeFile.name}</span>
                      {(activeFile.kind === "pdf" || activeFile.kind === "image" || activeFile.text !== undefined) && (
                        <div className="pdf-zoom">
                          <button onClick={() => setFileZoom((z) => Math.max(0.4, Math.round((z - 0.2) * 10) / 10))} aria-label="Zoom out">−</button>
                          <span>{Math.round(fileZoom * 100)}%</span>
                          <button onClick={() => setFileZoom((z) => Math.min(4, Math.round((z + 0.2) * 10) / 10))} aria-label="Zoom in">+</button>
                        </div>
                      )}
                      <a className="icon-button" href={activeFile.url} target="_blank" rel="noreferrer" aria-label="Open in new tab" title="Open in a new tab"><Icon name="external" /></a>
                    </div>
                    <div className="util-view">
                      {activeFile.text !== undefined && (
                        <pre className="file-text" style={{ fontSize: `${0.82 * fileZoom}rem` }}>{activeFile.text}</pre>
                      )}
                      {activeFile.text === undefined && activeFile.kind === "image" && (
                        <div className="file-scroll">
                          <img className="file-image" src={activeFile.url} alt={activeFile.name} style={{ width: `${fileZoom * 100}%` }} />
                        </div>
                      )}
                      {activeFile.text === undefined && activeFile.kind === "video" && (
                        <video className="file-media" src={activeFile.url} controls />
                      )}
                      {activeFile.text === undefined && activeFile.kind === "audio" && (
                        <div className="file-audio"><audio src={activeFile.url} controls /></div>
                      )}
                      {activeFile.kind === "pdf" && activeFile.data && (
                        <Suspense fallback={<div className="pdf-status">Loading viewer…</div>}>
                          <PdfViewer key={activeFile.id} data={activeFile.data} scale={fileZoom} name={activeFile.name} downloadUrl={activeFile.url} />
                        </Suspense>
                      )}
                      {activeFile.text === undefined && activeFile.kind === "other" && (
                        <div className="util-empty">
                          <Icon name="doc" />
                          <p><strong>{activeFile.name}</strong></p>
                          <p className="util-empty-sub">{activeFile.type || "Unknown type"} — this format has no in-page preview.</p>
                          <div className="file-actions">
                            <a className="util-go" href={activeFile.url} target="_blank" rel="noreferrer">Open</a>
                            <a className="util-go subtle" href={activeFile.url} download={activeFile.name}>Download</a>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {(["x", "y", "xy"] as const).map((axis) => (
              <div
                key={axis}
                className={`util-resize axis-${axis}`}
                title="Drag to resize"
                onPointerDown={(event) => {
                  utilDrag.current = {
                    axis,
                    sx: event.clientX,
                    sy: event.clientY,
                    ow: utilWidth,
                    oh: utilHeight ?? (event.currentTarget.parentElement as HTMLElement).offsetHeight,
                  };
                  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = utilDrag.current;
                  if (!drag) return;
                  const patch: { w?: number; h?: number } = {};
                  if (drag.axis !== "y") patch.w = clamp(drag.ow + (event.clientX - drag.sx), 320, window.innerWidth - 320);
                  if (drag.axis !== "x") patch.h = clamp(drag.oh + (event.clientY - drag.sy), 240, window.innerHeight - 150);
                  batchedUtilResize(patch);
                }}
                onPointerUp={() => { utilDrag.current = null; }}
                onPointerCancel={() => { utilDrag.current = null; }}
              />
            ))}
          </section>
        )}

        <section className="stage" aria-label="Pomodoro timer">
        <div className="mode-row" role="tablist" aria-label="Timer mode">
          {MODE_IDS.map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={state.mode === mode}
              className={`mode-choice ${state.mode === mode ? "active" : ""}`}
              onClick={() => switchMode(mode)}
            >
              {modeLabels[mode]}
            </button>
          ))}
        </div>

        <div
          className="timer-composition"
          style={{ "--progress": `${progress * 360}deg`, "--aura": isBreak ? "var(--break)" : "var(--accent)" } as React.CSSProperties}
        >
          <div className="timer-aura" aria-hidden="true" />
          <div className="timer-face">
            <div className="micro-dots" aria-hidden="true">
              {Array.from({ length: cycleLength }).map((_, i) => (
                <span key={i} className={dotClass(i)} />
              ))}
            </div>
            <div className="cycle-copy">{cycleCopy}</div>
            <TimeReadout seconds={state.remaining} />
            <div className={`phase-copy ${isBreak ? "break" : ""}`}>{phaseLine}</div>
          </div>
        </div>

        <div className="control-row">
          <button className="round-control" onClick={resetTimer} aria-label="Reset"><Icon name="reset" /></button>
          <button className="start-control" onClick={running ? pauseTimer : startTimer}>
            {running ? (
              <><Icon name="pause" /> Pause</>
            ) : (
              <><Icon name="play" /> Start</>
            )}
          </button>
          <button className="round-control" onClick={skipSegment} aria-label="Skip"><Icon name="skip" /></button>
        </div>

        <button className={`task-chip ${activeTask ? "" : "empty"}`} onClick={() => openPanel("tasks")}>
          <span aria-hidden="true" />
          {activeTask ? activeTask.text : "No task selected. Open tasks to pick one."}
        </button>
        </section>
      </div>

      <nav className="bottom-dock" aria-label="Tools">
        {dockItems.map(([id, icon]) => (
          <button key={id} className={openPanels.includes(id) ? "active" : ""} onClick={() => togglePanel(id)} aria-label={id}>
            <Icon name={icon} />
          </button>
        ))}
        <button onClick={toggleAppFullscreen} aria-label="Toggle fullscreen" title="Fullscreen">
          <Icon name={isFullscreen ? "unfull" : "full"} />
        </button>
      </nav>

      <div className="util-launcher">
        {utilMenu && (
          <div className="util-menu" role="menu">
            {([["youtube", "youtube", "YouTube"], ["web", "globe", "Google / Web"], ["files", "doc", "Documents"]] as [UtilId, string, string][]).map(
              ([id, icon, label]) => (
                <button key={id} role="menuitem" className={utilTab === id ? "active" : ""} onClick={() => openUtility(id)}>
                  <Icon name={icon} />
                  <span>{label}</span>
                </button>
              ),
            )}
          </div>
        )}
        <button
          className={`study-toggle ${utilTab ? "active" : ""}`}
          onClick={() => setUtilMenu((value) => !value)}
          aria-label="Utilities"
          aria-expanded={utilMenu}
          title="Utilities"
        >
          <Icon name="grid" />
        </button>
      </div>

      {openPanels.map((id, index) => (
        <FloatingWindow
          key={id}
          title={panelMeta[id].title}
          icon={panelMeta[id].icon}
          win={state.windows[id] ?? defaultFrame()}
          z={12 + index}
          onFocus={() => raisePanel(id)}
          onPatch={(patch) => patchFrame(id, patch)}
          onClose={() => closePanel(id)}
        >
          {panelContent[id]}
        </FloatingWindow>
      ))}

      {confetti.length > 0 && (
        <div className="confetti" aria-hidden="true">
          {confetti.map((piece) => (
            <i
              key={piece.id}
              style={{
                "--x": `${piece.x}vw`,
                "--dx": `${piece.dx}px`,
                "--delay": `${piece.delay}s`,
                "--dur": `${piece.dur}s`,
                "--size": `${piece.size}px`,
                "--rot": `${piece.rot}deg`,
              } as React.CSSProperties}
            />
          ))}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

export default App;
