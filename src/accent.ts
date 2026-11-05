/* Accent maths.

   A preset is designed around one accent colour, and its text, chips and glows
   are tuned against that colour's *brightness*. Letting someone pick any hue is
   only safe if the new colour keeps roughly the same brightness — otherwise a
   pale yellow accent turns white button text invisible while a deep blue one
   swallows dark text.

   So a hand-picked hue keeps the theme's saturation and is re-lit to the same
   relative luminance the theme was designed around. Same contrast, new hue. */

export type Hsl = { h: number; s: number; l: number };

/** HSL -> sRGB triplet, all 0-255. */
export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + m) * 255)) as [number, number, number];
}

/** WCAG relative luminance of a colour. */
export function luminance({ h, s, l }: Hsl): number {
  const [r, g, b] = hslToRgb({ h, s, l }).map((v) => {
    const channel = v / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: Hsl, b: Hsl): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The lightness that gives `hue`/`sat` the requested relative luminance.
 * Luminance rises monotonically with lightness, so a bisection is exact enough
 * (and cheaper than any analytic approximation worth reading).
 */
export function lightnessFor(target: number, hue: number, sat: number, fallback: number): number {
  const goal = Math.max(0, Math.min(1, target));
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (luminance({ h: hue, s: sat, l: mid }) < goal) lo = mid;
    else hi = mid;
  }
  const found = (lo + hi) / 2;
  if (!Number.isFinite(found)) return fallback;
  // Stay inside a usable range: a colour that is technically correct but almost
  // pure black or pure white is not a usable accent.
  return Math.max(12, Math.min(88, found));
}

/** Readable text colour on top of an accent fill. */
export function inkOn(accent: Hsl): string {
  const white = { h: 0, s: 0, l: 100 };
  const ink = { h: 0, s: 0, l: 8 };
  return contrast(accent, white) >= contrast(accent, ink) ? "#ffffff" : "#0b0b10";
}
