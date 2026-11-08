# Focus

A single-screen focus timer: pomodoro session, task list, stats, notes, ambience
(scenes, music, YouTube background) and a side panel for reading documents — all
stored locally in the browser. Built with React 19, Vite 7 and Tailwind 4.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # single-file bundle in dist/
```

## Tasks & weekly planner

The Tasks panel has **Tasks** and **Planner** views. Planner is a small Monday–Sunday
week strip with previous/next week navigation and a quick add for the selected day.
Adding there creates a normal task; completion, active-task selection, and deletion
stay in sync in both views. Use the date chip on any task to schedule or move it,
or clear its date to return it to the unscheduled list. Dates are local and stored
with the task in browser storage; the planner uses native date inputs and no extra
calendar package.

## Themes

`Personalization` in the dock holds 19 presets. Its **Themes** and **Scenes** tabs
keep the theme picker, accent controls, palettes and wallpaper settings together
in one place. A preset is not a colour scheme: it re-skins typography, button
shape and press states, surfaces, corner language, border weight, depth model and
the background treatment, so the app reads as a different product. The original
look (`classic`) is the default and untouched.

| Group | Presets | What is different about it |
| --- | --- | --- |
| Paper & print | Original, Editorial, Brutalist, Swiss, Sketchbook | glass over photography · warm serif paper · concrete blocks and hard offset shadows · white grid, one red rule · ruled paper, wobbly ink |
| Retro & neon | Terminal, Retro 95, Cyber, Art Deco | phosphor monospace CRT · a Win95 desktop with bevels · neon grid and glow · gold hairlines on deep green |
| Soft & sculpted | Clay, Neumorph | pressed pastel shapes · one surface colour, embossed |
| Curated palettes | Ocean Depths, Sunset Boulevard, Botanical Garden | deep navy · burnt orange over teal · cream, fern and marigold |
| Illustrated & motion | Kaleido, Manga, Pop Art, Bubblegum, Vaporwave | five animated layers (see below) |

### Palettes

Each preset's default accent is the colour its name promises, so a theme is
recognisable before you touch the slider:

| Preset | Default accent | Preset | Default accent |
| --- | --- | --- | --- |
| Original | sampled from the scene | Clay | pastel lilac 276 |
| Editorial | sampled from the scene | Neumorph | slate blue 224 |
| Brutalist | international orange 16 | Ocean Depths | seafoam teal 180 |
| Swiss | Swiss red 4 | Sunset Boulevard | burnt orange 12 |
| Sketchbook | sepia ink 14 | Botanical Garden | **fern green 133** |
| Terminal | phosphor green 134 | Kaleido | coral 350 |
| Retro 95 | Win95 navy 221 | Manga | ink red 3 |
| Cyber | neon magenta 317 | Pop Art | poster red 354 |
| Art Deco | gold 42 | Bubblegum | bubblegum pink 328 |
| | | Vaporwave | neon magenta 316 |

Botanical Garden used to be marigold — a garden theme whose accent was not
green — and now leads with fern green while marigold moves to the break phase
and the borders, where the tagline always said it was. Its break ink is mixed
dark enough to sit on cream (contrast 4.5 against the panel, up from 2.1).

The set is deliberately curated rather than grown: themes that were only a
recolouring of another one were folded into the strongest of their family
(`aurora`/`galaxy` → Vaporwave, `nordic`/`arctic` → Ocean, `forest` → Botanical,
`golden`/`desert` → Sunset, `minimal` → Swiss, `tech` → Terminal). Saved ids are
mapped through `LEGACY_DESIGN_IDS` in `src/App.tsx`, so nobody's stored choice
breaks.

### The accent control

Every theme exposes the accent-hue slider (12 swatches + a full hue ramp), and
each theme remembers its own override (`designHues` in app state). Accent defaults
come from the theme's own palette when it has one, otherwise from the sampled
scene.

Under the hue ramp sits **Remove tint**. The same switch is also available in
the Scenes tab, right beside the wallpaper controls. It takes the theme's colour
wash off your wallpaper, leaving the picture exactly as it is and letting a
neutral scrim carry legibility instead (see Wallpapers).

A hue pick only replaces the **hue**. The preset keeps its saturation and the
colour is re-lit to the same *perceived brightness* it was designed around
(`src/accent.ts`), so white-on-accent text stays legible whether you land on
yellow or indigo, and no theme has to hardcode a text colour that only works for
one hue. `--accent-ink` (auto white or near-black) backs the primary button.
The break phase is stored as an offset from the accent, so it travels with your
pick instead of staying on the old hue. Themes that used to paint fixed colours
now derive them: `--d-btn-grad`, `--d-btn-shadow`, active tabs, dock chips,
session dots, progress fills, card rings, glows and borders are all
`color-mix(...)` over `var(--accent)`.

This is measured, not assumed: an audit renders all 19 presets at 12 hues and
checks that (a) accent luminance moves by less than 0.005 within a preset, (b)
the break colour changes at every hue, and (c) text/ink contrast against its own
bed is unchanged by the pick.

### Buttons

The silhouette is part of the theme, not a shared rounded rectangle. Three hooks
carry it (`--d-btn-clip`, `--d-mode-clip`, `--d-ctl-clip` for chamfers) on top of
the radius tokens each preset already owns, and one table in `src/index.css`
decides the whole set:

| Preset | Silhouette |
| --- | --- |
| Original | soft rounded rectangle, accent glow |
| Editorial | 3px print edge with a double hairline |
| Brutalist | hard square block, offset shadow |
| Swiss | square, hairline, the one red rule becomes an underline |
| Sketchbook | wobbly hand-drawn corners |
| Terminal | square, bracketed `[ START ]` |
| Retro 95 | bevelled grey key |
| Cyber | corners cut at 45°, glow follows the cut |
| Art Deco | fan — round shoulders, flat foot, double gold rule |
| Clay | pressed pebble, circular controls |
| Neumorph | soft embossed |
| Ocean | capsule |
| Sunset | capsule, sinks on press |
| Botanical | leaf — mirrored asymmetric corners |
| Kaleido | soap bubble with an inked outline and a 5px lift |
| Manga | speech chip — three soft corners, one cut, inked |
| Pop Art | comic bubble, fat ink ring, flat offset shadow |
| Bubblegum | glossy bubble that squishes on press |
| Vaporwave | chrome capsule |

Small chrome (dock chips, round controls) has its own hook because an inked
offset shadow that reads as a comic panel on a big button turns into a crescent
moon at 34px.

### Sound

Every preset has its own synthesised interface voice (`src/sound.ts`) — nothing
is shipped as an asset, each click is an oscillator envelope (plus filtered noise
where a theme needs a texture):

| Voice | Presets |
| --- | --- |
| keycap beep | Terminal |
| bevel click | Retro 95 |
| square blip | Original, Neumorph |
| paper tick / dry click | Editorial, Swiss |
| concrete thunk | Brutalist |
| pencil scratch | Sketchbook |
| sawtooth zap | Cyber |
| small bell | Art Deco |
| muted thock | Clay |
| water drop | Ocean |
| warm dyad | Sunset |
| marimba pluck | Botanical |
| triangle shimmer | Kaleido |
| ink shhk | Manga |
| bright pop | Pop Art |
| bubble pop | Bubblegum |
| chrome swell | Vaporwave |

Sounds are wired through one delegated listener on `document` (pointerdown for
mouse, `detail === 0` click for keyboard and assistive activation), so a new
button needs no wiring and the audio context only starts on the first real
gesture. Clicking a theme card previews that theme's voice. Setting:
`Settings ▸ Interface sounds`, on by default, hidden entirely when the browser
has no Web Audio.

### Adding a preset

1. Add an id and an entry to `DESIGNS` in `src/designs.ts` (`accent`, `breakHue`
   set the default colour; `tone` drives text/scrollbar handling).
2. In `src/index.css` add a `.focus-app .design-card[data-preview="<id>"]` block
   so the picker card previews it, then a `.focus-app[data-design="<id>"]` block
   with the token set (`--ink`, `--d-panel-*`, `--d-btn-*`, …) plus any structural
   overrides, and a `body:has(.focus-app[data-design="<id>"])` background.
3. Paint `.visual-plane` with the theme's own backdrop if it has one, and give it
   a `--wall-tint` / `--wall-wash-*` bed in the wallpaper section (below) so a
   user wallpaper stays legible. Themes may hide
   `.video-plane`/`.snow-layer`/`.rain-layer` for their idle look — a wallpaper
   the user picks still overrides all of that.

Motion should stay opt-in per theme and respect `prefers-reduced-motion`.

## Wallpapers

Open the **Scenes** tab inside `Personalization` to set the wallpaper: choose
one of six scenes, enter an image URL, or use a YouTube link that loops muted
behind the app. **A wallpaper you pick shows behind every preset** — it is not a
per-theme option any more.

How it works, so a new preset cannot break it:

- `<main>` carries `data-wallpaper="image" | "video" | "scene"` (absent when
  there is none). The default (`cabin`) and `Pure Black` count as "none", so the
  theme's own background is shown untouched.
- `.wallpaper-plane` is a fixed layer at `z-index: -5` carrying the picture;
  `.wallpaper-veil` sits above it and paints `--wall-veil`.
- One tint model for every preset: the picture is washed toward `--wall-tint`
  (each preset declares the bed its type needs) with four strengths
  (`--wall-wash-1..4`, top → bottom), plus `--wall-filter` for how the photograph
  itself is treated. Print presets go almost flat-paper, screen presets go nearly
  black, and `classic` stays the one preset that keeps the photograph loud.
- `--wall-texture` draws an optional pattern over the wash — Terminal puts the
  CRT's scanlines back on top of its near-black tint, Manga lays screentone over
  its paper, Vaporwave keeps its scan band.
- `[data-wallpaper]` switches the theme's `.visual-plane` off, sets
  `--d-page-bg: transparent` so no preset's own page colour can hide the picture,
  and eases `.scrim` down to `--wall-scrim`.
- `prefers-reduced-motion` drops the fade-in.

`data-tint="off"` (the **Remove tint** switch in either Personalization tab)
drops the wash entirely: `--wall-veil` becomes a neutral grey/black gradient top
and bottom, a soft neutral vignette is drawn behind the stage, `--wall-filter` and
`--wall-texture` are switched off, and the text halo gets heavier. The photograph
keeps its own colours; nothing is tinted toward the theme.

Legibility is gated by pixels, not by hope: a harness renders every preset over a
deliberately bright, busy photograph at three accents and measures the ink
contrast of the greeting, the quote, the readout, the mode chips and the buttons
straight out of the screenshot. All 19 presets clear 3.0 at every accent.

Only `Pure Black` opts out — it is the "no wallpaper" choice.

## Anime theme

The illustrated group is the animated one. Each preset declares a `motion`
variant in `src/designs.ts` and mounts that layer from `src/MotionFx.tsx`
(**Anime.js v4**):

| Preset | Look | Layer |
| --- | --- | --- |
| Kaleido | cel-shaded panels, ink outlines, dusk sky | speed-line fan, drifting petals, impact ring |
| Manga | screentone paper, ink panel borders, hard offsets | drifting screentone, rake of ink action lines, ink ring |
| Pop Art | Ben-Day dots, canary field, fat outlines | breathing dot field, starburst, confetti on start |
| Bubblegum | glossy pastel pills, lilac and mint | rising bubbles, twinkling sparkles |
| Vaporwave | chrome sunset, neon grid, scanlines | setting sun, scrolling grid, horizon glow, scan band |

Layers are decorative: `aria-hidden`, `pointer-events: none`, mounted only for a
preset with `motion`, and static when `prefers-reduced-motion` is set. Adding a
variant means a new `MotionVariant` member in `src/designs.ts`, a branch in
`MotionFx.tsx` and a `.fx-<variant>` block in `src/index.css`.

## Credits

- Palette and type pairings for the Curated palettes come from
  [anthropics/skills — theme-factory](https://github.com/anthropics/skills/tree/main/skills/theme-factory)
  (Apache-2.0); the font intent is mapped onto the fonts this app loads.
- Animation guidance from
  [BowTiedSwan/animejs-skills](https://github.com/BowTiedSwan/animejs-skills),
  installed as a Claude skill at `~/.claude/skills/animejs`.
- Background photography from Pexels; icons drawn in `src/App.tsx`.
