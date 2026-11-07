/* Design orientations ("themes") for the whole interface.
   A theme is deliberately more than a colour: it re-skins typography, surfaces,
   corner language, borders, depth, button shapes and the background treatment —
   the app should feel like a different product, not the same app in a new hue.
   "classic" reproduces the original look exactly and is the default.

   Each theme ships its own accent palette (hue/saturation/lightness) so a theme
   reads correctly out of the box, and every theme can still be re-coloured by
   hand — those overrides are remembered per theme (see AppState.designHues). */

export type DesignId =
  | "classic"
  | "editorial"
  | "brutalist"
  | "swiss"
  | "sketch"
  | "terminal"
  | "retro"
  | "cyber"
  | "deco"
  | "clay"
  | "neu"
  | "ocean"
  | "sunset"
  | "botanical"
  | "kaleido"
  | "manga"
  | "pop"
  | "bubblegum"
  | "vaporwave";

export type DesignGroupId = "paper" | "retro" | "soft" | "palette" | "motion";

/** Illustration/motion layers available to the "Illustrated & motion" group.
    Each one is a variant of the Anime.js layer in src/MotionFx.tsx. */
export type MotionVariant = "kaleido" | "manga" | "pop" | "bubblegum" | "vaporwave";

export type DesignPreset = {
  id: DesignId;
  name: string;
  tagline: string;
  group: DesignGroupId;
  /** Drives text/scrollbar colour handling in CSS. */
  tone: "dark" | "light";
  /** Accent palette the theme is designed around. Null keeps the live scene
      sample, exactly like the original app. */
  accent: { hue: number; sat: number; light: number } | null;
  /** Break-phase hue. Null derives it from the accent (accent + 140°). */
  breakHue: number | null;
  /** Illustration/motion layer this preset mounts (see src/MotionFx.tsx). */
  motion?: MotionVariant;
};

export const DESIGN_GROUPS: { id: DesignGroupId; label: string; note: string }[] = [
  { id: "paper", label: "Paper & print", note: "type-led, flat, no glass" },
  { id: "retro", label: "Retro & neon", note: "screens, bevels, glow" },
  { id: "soft", label: "Soft & sculpted", note: "light, depth, tactility" },
  { id: "palette", label: "Curated palettes", note: "colour + type pairings" },
  { id: "motion", label: "Illustrated & motion", note: "ink, halftone, animated layers" },
];

export const DESIGNS: DesignPreset[] = [
  {
    id: "classic",
    name: "Original",
    tagline: "Glass, film photography, accent sampled from the scene.",
    group: "paper",
    tone: "dark",
    accent: null,
    breakHue: null,
  },
  {
    id: "editorial",
    name: "Editorial",
    tagline: "Warm paper, serif numerals, hairline rules, no glass.",
    group: "paper",
    tone: "light",
    accent: null,
    breakHue: null,
  },
  {
    id: "brutalist",
    name: "Brutalist",
    tagline: "Concrete blocks, thick rules, hard offset shadows.",
    group: "paper",
    tone: "light",
    accent: { hue: 16, sat: 84, light: 54 },
    breakHue: 199,
  },
  {
    id: "swiss",
    name: "Swiss",
    tagline: "White grid, grotesk caps, one red rule. Nothing else.",
    group: "paper",
    tone: "light",
    accent: { hue: 4, sat: 74, light: 50 },
    breakHue: 214,
  },
  {
    id: "sketch",
    name: "Sketchbook",
    tagline: "Ruled paper, wobble borders, handwriting everything.",
    group: "paper",
    tone: "light",
    accent: { hue: 14, sat: 52, light: 50 },
    breakHue: 196,
  },
  {
    id: "terminal",
    name: "Terminal",
    tagline: "Phosphor monospace on black, hard edges, scanlines.",
    group: "retro",
    tone: "dark",
    accent: { hue: 134, sat: 68, light: 58 },
    breakHue: 44,
  },
  {
    id: "retro",
    name: "Retro 95",
    tagline: "Teal desktop, bevelled windows, pressed-in buttons.",
    group: "retro",
    tone: "light",
    accent: { hue: 221, sat: 72, light: 46 },
    breakHue: 168,
  },
  {
    id: "cyber",
    name: "Cyber",
    tagline: "Neon magenta rails, cut corners, chromatic glow.",
    group: "retro",
    tone: "dark",
    accent: { hue: 317, sat: 92, light: 62 },
    breakHue: 187,
  },
  {
    id: "deco",
    name: "Art Deco",
    tagline: "Deep emerald, gold double rules, wide engraved caps.",
    group: "retro",
    tone: "dark",
    accent: { hue: 42, sat: 58, light: 58 },
    breakHue: 152,
  },
  {
    id: "clay",
    name: "Clay",
    tagline: "Puffy pastel shapes with pressed-clay shadows.",
    group: "soft",
    tone: "light",
    accent: { hue: 276, sat: 62, light: 66 },
    breakHue: 168,
  },
  {
    id: "neu",
    name: "Neumorph",
    tagline: "One surface colour, embossed and inset, no outlines.",
    group: "soft",
    tone: "light",
    accent: { hue: 224, sat: 34, light: 60 },
    breakHue: 172,
  },
  {
    id: "ocean",
    name: "Ocean Depths",
    tagline: "Deep navy water, teal light, seafoam hairlines.",
    group: "palette",
    tone: "dark",
    accent: { hue: 180, sat: 51, light: 36 },
    breakHue: 12,
  },
  {
    id: "sunset",
    name: "Sunset Boulevard",
    tagline: "Burnt orange and warm sand over deep teal, set in serif.",
    group: "palette",
    tone: "dark",
    accent: { hue: 12, sat: 76, light: 61 },
    breakHue: 188,
  },
  {
    id: "botanical",
    name: "Botanical Garden",
    tagline: "Cream, fern green and marigold; leafy serif headings.",
    group: "palette",
    tone: "light",
    accent: { hue: 35, sat: 95, light: 52 },
    breakHue: 140,
  },
  {
    id: "kaleido",
    name: "Kaleido",
    tagline: "Cel-shaded panels, ink outlines, a colour burst of speed lines.",
    group: "motion",
    tone: "light",
    accent: { hue: 350, sat: 100, light: 62 },
    breakHue: 190,
    motion: "kaleido",
  },
  {
    id: "manga",
    name: "Manga",
    tagline: "Black ink on screentone paper, hard panels, inked pane borders.",
    group: "motion",
    tone: "light",
    accent: { hue: 3, sat: 84, light: 50 },
    breakHue: 205,
    motion: "manga",
  },
  {
    id: "pop",
    name: "Pop Art",
    tagline: "Ben-Day dots, canary yellow, primary blocks and fat outlines.",
    group: "motion",
    tone: "light",
    accent: { hue: 354, sat: 92, light: 54 },
    breakHue: 220,
    motion: "pop",
  },
  {
    id: "bubblegum",
    name: "Bubblegum",
    tagline: "Glossy pastel pills, mint and lilac, bubbles drifting up.",
    group: "motion",
    tone: "light",
    accent: { hue: 328, sat: 92, light: 66 },
    breakHue: 190,
    motion: "bubblegum",
  },
  {
    id: "vaporwave",
    name: "Vaporwave",
    tagline: "Chrome sunset, neon grid, scanlines and a slow breathing horizon.",
    group: "motion",
    tone: "dark",
    accent: { hue: 316, sat: 100, light: 66 },
    breakHue: 185,
    motion: "vaporwave",
  },
];

export const DEFAULT_DESIGN: DesignId = "classic";

export function designById(id: DesignId): DesignPreset {
  return DESIGNS.find((preset) => preset.id === id) ?? DESIGNS[0];
}

export function isDesignId(value: unknown): value is DesignId {
  return DESIGNS.some((preset) => preset.id === value);
}
