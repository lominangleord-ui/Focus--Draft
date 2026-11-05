# Focus

A single-screen focus timer: pomodoro session, task list, stats, notes, ambience
(scenes, music, YouTube background) and a side panel for reading documents — all
stored locally in the browser. Built with React 19, Vite 7 and Tailwind 4.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # single-file bundle in dist/
```

## Themes

`Personalization` in the dock holds 24 presets. A preset is not a colour scheme:
it re-skins typography, button shape and press states, surfaces, corner language,
border weight, depth model and the background treatment, so the app reads as a
different product. The original look (`classic`) is the default and untouched.

| Group | Presets |
| --- | --- |
| Paper & print | Original, Editorial, Brutalist, Swiss, Sketchbook |
| Retro & neon | Terminal, Retro 95, Cyber, Art Deco |
| Soft & sculpted | Aurora, Clay, Neumorph, Nordic |
| Curated palettes | Ocean Depths, Sunset Boulevard, Forest Canopy, Minimalist, Golden Hour, Arctic Frost, Desert Rose, Tech Innovation, Botanical Garden, Midnight Galaxy |
| Illustrated & motion | Anime |

Every theme exposes the accent-hue slider (12 swatches + a full hue ramp), and
each theme remembers its own override (`designHues` in app state). Accent defaults
come from the theme's own palette when it has one, otherwise from the sampled
scene.

A hue pick only replaces the **hue** — the preset keeps its own saturation and
lightness (`accent.sat` / `accent.light`), so a picker change stays on-palette
while still being unmistakable. Themes that used to paint fixed colours now
derive them: `--d-btn-grad`, `--d-btn-shadow`, active tabs, dock chips, session
dots, progress fills, card rings, glows and borders are all `color-mix(...)` over
`var(--accent)`. Nothing in a preset is hard-coded to a hex any more, so the
colour control changes the start button, the active mode, the dock and the
borders in all 24 presets, including `classic` (`Original`).

### Adding a preset

1. Add an id and an entry to `DESIGNS` in `src/designs.ts` (`accent`, `breakHue`,
   `backdrop` decide the default colour; `tone` drives text/scrollbar handling).
2. In `src/index.css` add a `.focus-app .design-card[data-preview="<id>"]` block
   so the picker card previews it, then a `.focus-app[data-design="<id>"]` block
   with the token set (`--ink`, `--d-panel-*`, `--d-btn-*`, …) plus any structural
   overrides, and a `body:has(.focus-app[data-design="<id>"])` background.
3. Paint `.visual-plane` with the theme's own backdrop if it has one. Themes may
   hide `.video-plane`/`.snow-layer`/`.rain-layer` for their idle look — a
   wallpaper the user picks still overrides all of that (see below).

Motion should stay opt-in per theme and respect `prefers-reduced-motion`.

## Wallpapers

`Scenes` in the dock sets the wallpaper: one of six scenes, any image URL, or a
YouTube link that loops muted behind the app. **A wallpaper you pick shows behind
every preset** — it is not a per-theme option any more.

How it works, so a new preset cannot break it:

- `<main>` carries `data-wallpaper="image" | "video" | "scene"` (absent when
  there is none). The default (`cabin`) and `Pure Black` count as "none", so the
  theme's own background is shown untouched.
- `.wallpaper-plane` is a fixed layer at `z-index: -5` carrying the picture;
  `.wallpaper-veil` sits above it and reads `--wall-veil`, which is dark for
  `data-tone="dark"` presets and light for `data-tone="light"` ones (Anime warms
  its own). The veil keeps type legible without flattening the photo.
- `[data-wallpaper]` switches the theme's `.visual-plane` off, clears an opaque
  shell colour off the root, and eases `.scrim` down to `--wall-scrim`, so the
  picture reads through instead of being buried under a texture.
- `prefers-reduced-motion` drops the fade-in.

Only `Pure Black` opts out — it is the "no wallpaper" choice.

## Anime theme

`Anime` is cel-shaded: ink outlines, hard offset shadows, a dusk sky and a
halftone screen. Its speed-line fan, drifting petals and start-of-session impact
ring are driven by **Anime.js v4** in `src/AnimeFx.tsx`; the layer only mounts for
that theme, is `aria-hidden`, and stays still when reduced motion is requested.

## Credits

- Palette and type pairings for the Curated palettes come from
  [anthropics/skills — theme-factory](https://github.com/anthropics/skills/tree/main/skills/theme-factory)
  (Apache-2.0); the font intent is mapped onto the fonts this app loads.
- Animation guidance from
  [BowTiedSwan/animejs-skills](https://github.com/BowTiedSwan/animejs-skills),
  installed as a Claude skill at `~/.claude/skills/animejs`.
- Background photography from Pexels; icons drawn in `src/App.tsx`.
