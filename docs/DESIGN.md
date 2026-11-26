# Visual design

sunvision-ai is a working tool, not a marketing page. The workspace is a canvas with docked panels
around it: neutral grey chrome, one blue for selection and primary actions, hairline dividers instead of cards,
small precise type. Colour is spent on **data**: the sun's amber, the provenance colours, lit and unlit windows.

Tokens live in [`web/src/index.css`](../web/src/index.css) (dark in `@theme`, light under
`:root[data-theme="light"]`). [`themeContrast.test.ts`](../web/src/lib/__tests__/themeContrast.test.ts) checks
their contrast. The shared primitives are in [`ui.tsx`](../web/src/components/ui.tsx) and
[`kit.tsx`](../web/src/components/kit.tsx). Use them before writing a new button.

## Principles

1. **Chrome is grey, data has colour.** Panels, buttons, tabs and inputs are neutral. The amber `sun-*` tokens mark
   sunlight only: hours of direct sun, lit windows, the sun path and the time slider. Selection, focus, links and
   primary buttons are blue (`accent*`).
2. **Hairlines, not boxes.** A panel is a flat `bg-ink-900` surface with a 1 px `border-ink-700` edge. Sections inside
   it are separated by a full-width `border-t border-ink-700`, not by nested rounded cards. Use cards (rounded-lg, a
   hairline ring) only for things that are objects in their own right: example files, a photo thumbnail, a dialog.
3. **Small, even type.** One family (Inter). Hierarchy comes from weight and colour, not size jumps or caps.
4. **Floating means shadow.** Anything over the canvas (toolbars, popovers, menus, dialogs, tooltips) gets
   `shadow-panel` (or `shadow-float` for small chips) and a 12 px radius (`rounded-xl`; menus `rounded-lg`).
   Docked panels have no shadow.
5. **Quiet motion.** 120–160 ms ease-out, no bounces, no glows, no gradients on chrome, no blur.

## Tokens

| Role | Class | Dark | Light |
| --- | --- | --- | --- |
| Canvas / page | `bg-ink-950` | #1e1e1e | #f5f5f5 |
| Panel, card, menu | `bg-ink-900` / `bg-ink-850` / `bg-ink-750` | #2c2c2c | #ffffff |
| Input well, hover | `bg-ink-800` | #383838 | #f0f0f0 |
| Hairline | `border-ink-700`, `ring-ink-700` | #444444 | #e6e6e6 |
| Track, switch off | `bg-ink-600` | #545454 | #d4d4d4 |
| Disabled, strong divider | `ink-500` | #6b6b6b | #b3b3b3 |
| Primary text | `text-paper` | #f5f5f5 | #1e1e1e |
| Secondary text | `text-ink-300` (`ink-200` for emphasis) | #c2c2c2 | #545454 |
| Tertiary text, labels | `text-ink-400` | #a8a8a8 | #6b6b6b |
| Primary button | `bg-accent-500 hover:bg-accent-600 text-on-accent` | #0b6fd4 | #0b6fd4 |
| Focus, selection outline, switch on | `outline-accent`, `ring-accent`, `bg-accent` | #0d99ff | #0b84e5 |
| Selected row / tool / chip | `bg-selected` (accent 22 %) | | |
| Link, accent text | `text-accent-300` | #4db5ff | #0b66c4 |
| Sunlight (data only) | `sun-300…600`, `lit` | amber | burnt amber |

Never use Tailwind palette colours (`text-white`, `bg-blue-500`, …): they ignore the theme and the test rejects
them. `bg-knob` is the white knob of a switch or slider.

## Type

Inter 400/500/600, `font-feature-settings: "cv11"`; Roboto Mono only for code, keys and coordinates (`.mono`).
Numbers use `.num` (tabular figures in Inter, not a monospace face).

| Use | Style |
| --- | --- |
| Body in panels | `text-xs` (12 px) regular, `text-ink-200`/`text-paper` |
| Labels, captions, meta | `text-[11px]`, `text-ink-400` |
| Section title in a panel | `text-[11px] font-semibold text-paper`, sentence case |
| Panel / dialog title | `text-[13px] font-semibold` |
| Buttons, tabs, chips | `text-xs font-medium` |
| Key figure (e.g. "4h 21m") | `.text-answer` (Inter 600, 44 px, −0.035 em) |
| Landing headline | Inter 600, 44–56 px, `tracking-[-0.035em]`, `leading-[1.05]` |

No uppercase-tracked eyebrows, no serif, no `tracking-wider`. If a line needs to stand out, make it `font-medium`
or `text-paper`, not caps.

## Shape and spacing

* Radii: controls `rounded-md` (5 px), small badges `rounded-sm` (4 px), cards and menus `rounded-lg` (8 px),
  floating panels and dialogs `rounded-xl` (12 px). `rounded-full` only for dots, switches, avatars and the
  sun/time markers. No pills for buttons or tabs.
* Control height 28 px (`h-7`); 24 px (`h-6`) for dense rows and segmented options; icon buttons 28×28 with a
  14–16 px stroke icon (1.5 px stroke). Under a coarse pointer every hit area stays ≥ 44 px
  (`pointer-coarse:min-h-11 pointer-coarse:min-w-11`); keep those classes.
* Panel padding 12–16 px (`px-3`/`px-4`), section rows 32 px (`h-8`), gaps on a 4 px grid.
* Top bar 44 px with a bottom hairline. Panels are docked edge to edge, divided by hairlines, with no gutters
  between them.

## Components

* **Buttons** (`Btn`). `kind="primary"` (alias `"sun"`): blue fill, white text, at most one per view. `solid`:
  secondary, transparent with a hairline ring. `ghost`: text only, grey hover. Toggled tools use `active`
  (`bg-selected`).
* **Segmented control** (`Segmented`): a grey well (`bg-ink-800`, 2 px padding). The selected segment is a raised
  `bg-ink-900` chip with `shadow-float`. Use it for view tabs (Street / Apartment / Inside, Photo / Windows / Floors).
* **Toolbar over a canvas**: a floating `bg-ink-900 rounded-xl shadow-panel p-1` strip of 28 px icon or text
  buttons. The active tool is `bg-accent text-on-accent`, or `bg-selected` when the tool is a mode, not a click
  target.
* **Inputs**: `h-7 rounded-md bg-ink-800 px-2 text-xs`, no border. On focus, `outline-1 outline-accent` (or a
  `ring-1 ring-accent`). Placeholder `text-ink-400`.
* **Chips** (`Chip`): 28 px, `rounded-md`, hairline ring. Selected = `bg-selected` + accent ring.
* **Switch** (`Toggle`, `ModeSwitch`): 24×14, blue when on, white knob.
* **Disclosure** (`FineTune`): a small chevron that rotates, not ▸/▾ glyphs.
* **Provenance** (`Prov`, `Dot`): sentence-case badge (`text-[11px] font-medium`, tinted), never caps.
* **Dialogs** (`Modal`, `Drawer`): `bg-ink-900`, `rounded-xl`, `shadow-panel`, a 44 px header with a 13 px semibold
  title and a hairline under it. The scrim is plain black at 50 % (25 % in light), with no blur.
* **Frame label**: an object shown on the canvas (the landing photo, the 3D view) may carry a frame
  name above its top-left corner: `text-[11px] text-ink-400`, no background.
* **Logo** (`Logo`, `Wordmark`, `public/favicon.svg`): a solid window frame (`currentColor`) with a quarter sun in its
  top-right corner (`--color-lit`). Its edges sit on an 8-unit grid in a 64 box, so the frame is exactly 2 px at 16 px.
  Two colours only; never outline it, add rays, or put it on a tile.
* **Icons**: 1.5 px stroke, round caps, `currentColor`, 14–16 px. No emoji as icons, no arrow glyphs as decoration
  (→ is fine inside a link label).

## What to avoid

Keep these out of the interface: serif display headlines, amber uppercase eyebrows with wide tracking,
big amber step numerals ("1 2 3") in cards with corner icons, everything in rounded cards with gaps, pill buttons,
glows and halos on chrome, gradients, `backdrop-blur`, the accent colour on every interactive thing, and copy
centred in hero blocks. Prefer left alignment, fewer containers, and one strong focal point per view.
