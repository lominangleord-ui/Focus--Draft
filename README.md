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

Every theme still exposes the accent-hue slider, and each theme remembers its own
override (`designHues` in app state). Accent defaults come from the theme's own
palette when it has one, otherwise from the sampled scene.

### Adding a preset

1. Add an id and an entry to `DESIGNS` in `src/designs.ts` (`accent`, `breakHue`,
   `backdrop` decide the default colour; `tone` drives text/scrollbar handling).
2. In `src/index.css` add a `.focus-app .design-card[data-preview="<id>"]` block
   so the picker card previews it, then a `.focus-app[data-design="<id>"]` block
   with the token set (`--ink`, `--d-panel-*`, `--d-btn-*`, …) plus any structural
   overrides, and a `body:has(.focus-app[data-design="<id>"])` background.
3. Optional: hide `.video-plane`/`.snow-layer`/`.rain-layer` and paint
   `.visual-plane` when the theme sets `backdrop: false`.

Motion should stay opt-in per theme and respect `prefers-reduced-motion`.

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
