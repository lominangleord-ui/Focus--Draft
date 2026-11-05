/* Design orientations ("presets") for the whole interface.
   A preset is deliberately more than a colour: it re-skins typography,
   surfaces, corner radii, depth, borders and the background treatment — the
   app should feel like a different product, not the same app in a new hue.
   "classic" reproduces the original look exactly and is the default. */

export type DesignId = "classic" | "editorial" | "terminal" | "brutalist" | "aurora";

export type DesignPreset = {
  id: DesignId;
  name: string;
  tagline: string;
  /** Drives text/scrollbar colour handling in CSS. */
  tone: "dark" | "light";
  /** Accent hue the preset is designed around. Null keeps the live scene
      sample, exactly like the original app. */
  accentHue: number | null;
  /** Break-phase hue. Null derives it from the accent (accent + 140°). */
  breakHue: number | null;
  /** Whether scene photography / custom backgrounds still show through. */
  backdrop: boolean;
};

export const DESIGNS: DesignPreset[] = [
  {
    id: "classic",
    name: "Original",
    tagline: "Glass, film photography, accent sampled from the scene.",
    tone: "dark",
    accentHue: null,
    breakHue: null,
    backdrop: true,
  },
  {
    id: "editorial",
    name: "Editorial",
    tagline: "Warm paper, serif numerals, hairline rules and no glass.",
    tone: "light",
    accentHue: null,
    breakHue: null,
    backdrop: true,
  },
  {
    id: "terminal",
    name: "Terminal",
    tagline: "Phosphor monospace on black, hard edges, scanlines.",
    tone: "dark",
    accentHue: 134,
    breakHue: 44,
    backdrop: false,
  },
  {
    id: "brutalist",
    name: "Brutalist",
    tagline: "Concrete blocks, thick rules and hard offset shadows.",
    tone: "light",
    accentHue: 16,
    breakHue: 199,
    backdrop: false,
  },
  {
    id: "aurora",
    name: "Aurora",
    tagline: "Soft glow, pill shapes, weightless type over drifted light.",
    tone: "dark",
    accentHue: 268,
    breakHue: 172,
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
