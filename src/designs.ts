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
  | "aurora"
  | "clay"
  | "neu"
  | "nordic"
  | "ocean"
  | "sunset"
  | "forest"
  | "minimal"
  | "golden"
  | "arctic"
  | "desert"
  | "tech"
  | "botanical"
  | "galaxy"
  | "anime";

export type DesignGroupId = "paper" | "retro" | "soft" | "palette" | "motion";

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
  /** Whether scene photography / custom backgrounds still show through. */
  backdrop: boolean;
};

export const DESIGN_GROUPS: { id: DesignGroupId; label: string; note: string }[] = [
  { id: "paper", label: "Paper & print", note: "type-led, flat, no glass" },
  { id: "retro", label: "Retro & neon", note: "screens, bevels, glow" },
  { id: "soft", label: "Soft & sculpted", note: "light, depth, tactility" },
  { id: "palette", label: "Curated palettes", note: "colour + type pairings" },
  { id: "motion", label: "Illustrated & motion", note: "ink, cel shading, animation" },
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
    backdrop: true,
  },
  {
    id: "editorial",
    name: "Editorial",
    tagline: "Warm paper, serif numerals, hairline rules, no glass.",
    group: "paper",
    tone: "light",
    accent: null,
    breakHue: null,
    backdrop: true,
  },
  {
    id: "brutalist",
    name: "Brutalist",
    tagline: "Concrete blocks, thick rules, hard offset shadows.",
    group: "paper",
    tone: "light",
    accent: { hue: 16, sat: 84, light: 54 },
    breakHue: 199,
    backdrop: false,
  },
  {
    id: "swiss",
    name: "Swiss",
    tagline: "White grid, grotesk caps, one red rule. Nothing else.",
    group: "paper",
    tone: "light",
    accent: { hue: 4, sat: 74, light: 50 },
    breakHue: 214,
    backdrop: false,
  },
  {
    id: "sketch",
    name: "Sketchbook",
    tagline: "Ruled paper, wobble borders, handwriting everything.",
    group: "paper",
    tone: "light",
    accent: { hue: 14, sat: 52, light: 50 },
    breakHue: 196,
    backdrop: false,
  },
  {
    id: "terminal",
    name: "Terminal",
    tagline: "Phosphor monospace on black, hard edges, scanlines.",
    group: "retro",
    tone: "dark",
    accent: { hue: 134, sat: 68, light: 58 },
    breakHue: 44,
    backdrop: false,
  },
  {
    id: "retro",
    name: "Retro 95",
    tagline: "Teal desktop, bevelled windows, pressed-in buttons.",
    group: "retro",
    tone: "light",
    accent: { hue: 221, sat: 72, light: 46 },
    breakHue: 168,
    backdrop: false,
  },
  {
    id: "cyber",
    name: "Cyber",
    tagline: "Neon magenta rails, cut corners, chromatic glow.",
    group: "retro",
    tone: "dark",
    accent: { hue: 317, sat: 92, light: 62 },
    breakHue: 187,
    backdrop: false,
  },
  {
    id: "deco",
    name: "Art Deco",
    tagline: "Deep emerald, gold double rules, wide engraved caps.",
    group: "retro",
    tone: "dark",
    accent: { hue: 42, sat: 58, light: 58 },
    breakHue: 152,
    backdrop: false,
  },
  {
    id: "aurora",
    name: "Aurora",
    tagline: "Soft glow, pill shapes, weightless type over drifted light.",
    group: "soft",
    tone: "dark",
    accent: { hue: 268, sat: 78, light: 66 },
    breakHue: 172,
    backdrop: false,
  },
  {
    id: "clay",
    name: "Clay",
    tagline: "Puffy pastel shapes with pressed-clay shadows.",
    group: "soft",
    tone: "light",
    accent: { hue: 276, sat: 62, light: 66 },
    breakHue: 168,
    backdrop: false,
  },
  {
    id: "neu",
    name: "Neumorph",
    tagline: "One surface colour, embossed and inset, no outlines.",
    group: "soft",
    tone: "light",
    accent: { hue: 224, sat: 34, light: 60 },
    breakHue: 172,
    backdrop: false,
  },
  {
    id: "nordic",
    name: "Nordic",
    tagline: "Quiet sage and stone, thin rules, barely-there depth.",
    group: "soft",
    tone: "dark",
    accent: { hue: 104, sat: 30, light: 52 },
    breakHue: 36,
    backdrop: false,
  },
  {
    id: "ocean",
    name: "Ocean Depths",
    tagline: "Deep navy water, teal light, seafoam hairlines.",
    group: "palette",
    tone: "dark",
    accent: { hue: 180, sat: 51, light: 36 },
    breakHue: 12,
    backdrop: false,
  },
  {
    id: "sunset",
    name: "Sunset Boulevard",
    tagline: "Burnt orange and warm sand over deep teal, set in serif.",
    group: "palette",
    tone: "dark",
    accent: { hue: 12, sat: 76, light: 61 },
    breakHue: 188,
    backdrop: false,
  },
  {
    id: "forest",
    name: "Forest Canopy",
    tagline: "Ivory paper, forest-green ink, olive rules, serif caps.",
    group: "palette",
    tone: "light",
    accent: { hue: 137, sat: 25, light: 39 },
    breakHue: 32,
    backdrop: false,
  },
  {
    id: "minimal",
    name: "Minimalist",
    tagline: "Charcoal and slate on white. Hairlines, no shadows.",
    group: "palette",
    tone: "light",
    accent: { hue: 203, sat: 19, light: 26 },
    breakHue: 208,
    backdrop: false,
  },
  {
    id: "golden",
    name: "Golden Hour",
    tagline: "Mustard and terracotta on warm beige, soft and round.",
    group: "palette",
    tone: "light",
    accent: { hue: 41, sat: 100, light: 48 },
    breakHue: 356,
    backdrop: false,
  },
  {
    id: "arctic",
    name: "Arctic Frost",
    tagline: "Frosted glass, steel blue, silver hairlines.",
    group: "palette",
    tone: "light",
    accent: { hue: 216, sat: 38, light: 47 },
    breakHue: 190,
    backdrop: false,
  },
  {
    id: "desert",
    name: "Desert Rose",
    tagline: "Dusty rose and clay on sand, burgundy ink.",
    group: "palette",
    tone: "light",
    accent: { hue: 13, sat: 35, light: 57 },
    breakHue: 322,
    backdrop: false,
  },
  {
    id: "tech",
    name: "Tech Innovation",
    tagline: "Electric blue edges on graphite, cyan highlights.",
    group: "palette",
    tone: "dark",
    accent: { hue: 216, sat: 100, light: 50 },
    breakHue: 180,
    backdrop: false,
  },
  {
    id: "botanical",
    name: "Botanical Garden",
    tagline: "Cream, fern green and marigold; leafy serif headings.",
    group: "palette",
    tone: "light",
    accent: { hue: 35, sat: 95, light: 52 },
    breakHue: 140,
    backdrop: false,
  },
  {
    id: "galaxy",
    name: "Midnight Galaxy",
    tagline: "Deep purple night, lavender stars, cosmic glow.",
    group: "palette",
    tone: "dark",
    accent: { hue: 266, sat: 27, light: 66 },
    breakHue: 190,
    backdrop: false,
  },
  {
    id: "anime",
    name: "Anime",
    tagline: "Cel-shaded panels, ink outlines, anime.js speed lines.",
    group: "motion",
    tone: "light",
    accent: { hue: 350, sat: 100, light: 62 },
    breakHue: 190,
    backdrop: false,
  },
];

export const DEFAULT_DESIGN: DesignId = "classic";

export function designById(id: DesignId): DesignPreset {
  return DESIGNS.find((preset) => preset.id === id) ?? DESIGNS[0];
}

export function isDesignId(value: unknown): value is DesignId {
  return DESIGNS.some((preset) => preset.id === value);
}
