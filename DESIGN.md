---
name: Workspace Atlas
description: A quiet developer console where the machine's state is the only thing wearing colour.
colors:
  bg-base: "#0b0c0e"
  bg-primary: "#111214"
  bg-secondary: "#17181b"
  bg-tertiary: "#1e2024"
  bg-hover: "#24262b"
  border: "rgba(255,255,255,0.075)"
  border-light: "rgba(255,255,255,0.045)"
  border-strong: "rgba(255,255,255,0.15)"
  text-primary: "#f2f3f5"
  text-secondary: "#a2a9b2"
  text-tertiary: "#8d949e"
  accent: "#7c84e8"
  accent-fill: "#4c53c4"
  accent-hover: "#959ced"
  accent-subtle: "rgba(124,132,232,0.14)"
  success: "#4ec26a"
  success-subtle: "rgba(78,194,106,0.13)"
  warning: "#e0a63a"
  warning-subtle: "rgba(224,166,58,0.13)"
  danger: "#f2665e"
  danger-fill: "#b8362e"
  danger-subtle: "rgba(242,102,94,0.13)"
  on-brand: "#ffffff"
  on-fill: "#0b0c0e"
  chrome-text: "#f2f3f5"
  chrome-text-muted: "#a2a9b2"
  chrome-text-subtle: "#8d949e"
  chrome-surface: "rgba(255,255,255,0.045)"
  chrome-surface-hover: "rgba(255,255,255,0.075)"
  chrome-divider: "rgba(255,255,255,0.075)"
  titlebar-close: "#c4342b"
  syntax-comment: "#7d858f"
  syntax-key: "#7c84e8"
  syntax-key-nested: "#a2a9b2"
  syntax-string: "#e0a63a"
  syntax-bool: "#b07ce8"
  syntax-number: "#4ec26a"
  syntax-env: "#e08a4a"
  disk-other: "#565d68"
  disk-free: "#1e2024"
  shadow-ink: "#000000"
typography:
  value:
    fontFamily: "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
    fontFeature: "tabular-nums"
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  control:
    fontFamily: "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "normal"
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.06em"
  mono:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
components:
  button:
    backgroundColor: "{colors.bg-secondary}"
    textColor: "{colors.text-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "28px"
  button-hover:
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.text-primary}"
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.on-brand}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-brand}"
  button-danger:
    backgroundColor: "{colors.danger-fill}"
    textColor: "{colors.on-brand}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "28px"
  button-danger-outline:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "28px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  button-ghost-hover:
    backgroundColor: "{colors.chrome-surface}"
    textColor: "{colors.text-primary}"
  button-sm:
    height: "24px"
    padding: "0 8px"
  button-lg:
    height: "32px"
    padding: "0 16px"
    typography: "{typography.body}"
  button-icon:
    width: "28px"
    height: "28px"
    padding: "0"
  field:
    backgroundColor: "{colors.bg-tertiary}"
    textColor: "{colors.text-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  tag:
    backgroundColor: "{colors.chrome-surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  tag-ok:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
  tag-warn:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.warning}"
  tag-danger:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.danger}"
  tag-accent:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.accent}"
  pill:
    backgroundColor: "{colors.bg-secondary}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  panel:
    backgroundColor: "{colors.bg-secondary}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  stat:
    backgroundColor: "{colors.bg-secondary}"
    textColor: "{colors.text-primary}"
    typography: "{typography.value}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  rail-item:
    backgroundColor: "transparent"
    textColor: "{colors.chrome-text-muted}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 10px"
  rail-item-active:
    backgroundColor: "{colors.chrome-surface}"
    textColor: "{colors.chrome-text}"
  segmented-item:
    backgroundColor: "{colors.bg-secondary}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.control}"
    rounded: "0"
    padding: "0 10px"
    height: "28px"
  segmented-item-active:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.accent}"
  command:
    backgroundColor: "{colors.bg-primary}"
    textColor: "{colors.accent}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
---

# Design System: Workspace Atlas

## Overview

**Creative North Star: "The Quiet Console"**

This is a developer console held to the craft level of Linear, Vercel and Raycast, and that is a deliberate choice over an authored visual metaphor. The product's name is cartographic and its language is cartographic, but the interface carries no map, no notebook, no ornament. Familiarity is the feature: a developer arrives mid-incident with a full disk or a container that will not start, and they should trust the interface on sight rather than decode it. The tool disappears into the task.

The consequence is that the interface is almost entirely greyscale. Five near-neutral grounds with the barest cool cast, three weights of text, hairline borders, and exactly one accent that carries the primary action, the current selection and the focus ring. Everything else that has colour has it because the machine is in a state: green succeeded, amber is caution, red failed or will destroy. If a colour is not saying one of those things, it does not belong on the screen. Dark is the default because the scene is a developer at their desk beside a dark terminal, often at night; light is a true neutral, never a warm paper.

Density is a design position, not an accident. The whole app runs at 11 to 13px with a 28px control height and 34px table rows, because the user is comparing forty images or six distros and wants them on one screen. That density is what makes contrast and focus visibility structural rather than cosmetic: every colour token in the stylesheet carries its measured contrast ratio in a comment beside it, checked against the lightest ground it can land on rather than the average case, and the focus ring is enforced globally with `!important` because at 11px there is nothing else to see it by.

**Key Characteristics:**
- Near-neutral greys, one indigo accent, and colour otherwise reserved for state.
- Separation is a 1px hairline and a small tone shift. Cards do not float.
- Four radii, none of them large; the biggest is 10px and belongs to overlays.
- Seven space steps on a 4px scale, and seven type steps, six of which render.
- Every number that sits in a column is tabular.
- Contrast is measured and recorded in the token comment, not estimated.

### Scope of this record

The canonical system is the token layer at the top of `src/index.css`, the shared component CSS under the `THE BUTTON`, `THE ERROR BANNER` and `PRIMITIVES` banners, the component vocabulary in `src/components/ui.tsx`, the rail (`src/layout/Sidebar.tsx`), the index (`src/components/CommandIndex.tsx`), and the page shape every view shares. **Build new surfaces from `ui.tsx`.**

The interiors of the Docker tabs, the WSL components and the Packages table still carry per-module class families (`img-*`, `ctr-*`, `wsl-*`, `pkg-*`, `compose-*`). They inherit the tokens and the shared button base but predate the component vocabulary, and they are being migrated onto it. They are not a reference for new work.

## Colors

Two renditions of one near-neutral palette, with a single accent and three state colours. Frontmatter values are the dark rendition, which is the default; the light rendition is carried in `.impeccable/design.json` under `colorMeta`.

### Primary
- **Console Indigo** (`accent`): The app's only accent. It appears as the primary action, the current selection, the active tab underline, the focus ring, and the command text in the terminal. Never as decoration.
- **Indigo Fill** (`accent-fill`): The same hue dark enough that white sits on it at 6.3:1. Fills only, never small text. Two tokens exist because one colour cannot be both a legible fill and legible small text.

### Secondary
- **Selection Wash** (`accent-subtle`): A 14% indigo ground. It marks a selected row, the active segment of a segmented control, and the highlighted row of the index. It is the accent acting as furniture, which is the one job the bright accent may not do alone.

### Tertiary
- **Signal Green** (`success`), **Signal Amber** (`warning`), **Signal Red** (`danger`): The three state colours. Green is an operation that succeeded, amber is caution, red is failure or destruction. Each carries a 13% companion for use as a ground behind its own text, and red carries a darker fill for solid destructive buttons.

### Neutral
- **The Grounds** (`bg-base` through `bg-hover`): Five steps, deepest outward. `bg-base` is the app ground and the chrome, `bg-primary` the main panel, `bg-secondary` cards and raised rows, `bg-tertiary` inputs and wells, `bg-hover` a control under the pointer and the lightest surface any text lands on.
- **The Text** (`text-primary`, `text-secondary`, `text-tertiary`): Three weights. Primary carries the fact, secondary the supporting detail, tertiary the labels, counts and units.
- **The Hairlines** (`border-light`, `border`, `border-strong`): Three weights of 1px line doing the work a shadow would do elsewhere.
- **The Chrome** (`chrome-*`, `sidebar-bg`, `titlebar-bg`, `terminal-bg`): The rail, titlebar and terminal are the app's frame and stay at `bg-base` in both themes. They carry their own solid text tokens because those surfaces are darker than any page.

### Named Rules

**The Two Accents Rule.** `accent` is the text and border value; `accent-fill` is the background value. Never use the bright accent as a fill under white, and never use the fill accent as small text.

**The State-Only Rule.** Green, amber and red encode state and nothing else. They are never chrome, never a section accent, never a brand colour. If a colour is not saying "this succeeded / take care / this failed", it is not one of these three.

**The Fill Names Its Foreground Rule.** Every filled surface names its own text colour. A single on-brand white fails badly on the bright state colours (white on dark-theme amber measures 2.1:1), so green and amber fills take `on-fill` and only the accent and danger fills take white.

**The Solid Chrome Rule.** Chrome text tokens are solid hex, never alpha. A translucent chrome value composites down against whatever is behind it and fails at 11px.

**The Doubled Tint Rule.** A state colour has to survive its own tint applied twice: a selected card takes the subtle ground and the badge inside it takes the same ground again. That doubled ground is the darkest surface either can land on, and it is where the light-theme green and red were re-measured to 4.67:1 and 4.56:1.

**The One Black Rule.** `shadow-ink` is the only black, and it exists for cast shadow and the scrim behind an overlay. It is unthemed, because a shadow is an absence of light in both renditions. The single exception is `titlebar-close`, the Windows system close-button red, which is the one place the app speaks the host platform's language instead of its own.

**The Annotation Palette Rule.** Compose files, Dockerfiles and `.env` are marked up in the app's own `syntax-*` tokens rather than an imported editor theme, and both themes read the same token names so there is no per-theme override to drift.

## Typography

**Interface Font:** Segoe UI Variable Text (with Segoe UI Variable, Segoe UI, system-ui, sans-serif)
**Machine Font:** Cascadia Mono (with Cascadia Code, Consolas, ui-monospace, monospace)

**Character:** Both faces ship with Windows, so the app loads no webfont and touches no network, which is a product commitment rather than a performance one. Segoe UI Variable *Text* is the optical size cut for 12-28px, which is where all of this app lives. Cascadia Mono is Windows Terminal's own face, so machine output looks like machine output rather than a styled quotation of it.

### Hierarchy

Seven steps are defined and six render; 13px is deliberately both the body step and the table step, because a row of facts and a paragraph about them are the same size of thing.

- **Value** (600, 22px, 1.1, -0.02em, tabular): The one big number on a stat card. One per card, never for prose.
- **Title** (600, 19px, 1.2, -0.02em): The page title in the pinned head. One per view.
- **Heading** (600, 14px): Prerequisite notices, the index's search line, and dialog titles.
- **Body** (400, 13px, 1.5): Descriptions, empty-state copy, table cells.
- **Control** (500, 12px, 1): The working size. Buttons, fields, tabs, rail items, segment labels.
- **Label** (600, 11px, 0.06em, uppercase): Panel titles, table headers, section and stat labels. Everything that names a group of facts takes exactly this treatment, which is why they all look like the same kind of thing.
- **Machine** (Cascadia Mono, 13px, 1.7, tabular): Commands, identifiers, image and container IDs, paths, terminal output.

### Named Rules

**The Machine Voice Rule.** Monospace means the string came from the machine or can be pasted back into it. Nothing is monospace for flavour.

**The Aligned Numbers Rule.** Every number that sits in a column takes `font-variant-numeric: tabular-nums`, via the `num` class or a token that carries it. Sizes, counts, versions, percentages and durations all line up.

**The Group Label Rule.** A panel title, a table header and a section label are all 11px, 600, uppercase, 0.06em, tertiary. They are the same thing wearing the same clothes. Do not introduce a fourth treatment for naming a group.

**The One Exception.** The 20px titlebar mark is the single place in the app off both scales: a 10px literal on the stylesheet's only gradient. It is a logotype rather than type, exempt under WCAG 1.4.3, and it is the exception that should stay one. Nothing else may borrow either liberty.

## Layout

The shell is four regions: a 44px titlebar, a 212px rail on the left (user-resizable), a main panel, and a 240px terminal panel that floats over the bottom of the content column rather than entering its height calculation. A 300px context panel is defined for selection detail.

Every view is the same three parts, and this is the single most load-bearing layout decision in the app: a pinned head carrying breadcrumb, title, status and primary actions; an optional tab strip in the same fixed block; and one scrolling body beneath. The view owns its scroll, not the main panel, which is what keeps Refresh reachable from the bottom of a 400-row table. The head sits on a hairline so the body scrolling under it reads as a separate plane. Page padding is 24px top and 32px sides on the head, and 24/32/48 on the body, which scrolls with `scrollbar-gutter: stable` so the column never shifts sideways when a short page becomes a long one.

Spacing is one 4px scale of seven steps (4, 8, 12, 16, 24, 32, 48) and nothing outside it. Vertical rhythm inside a scrolling body is a single rule: consecutive panels, stat rows and error banners are separated by 16px.

The window floor is 900x600 and there is no mobile context, so the only responsive behaviour is intrinsic: the stat row is `repeat(auto-fit, minmax(168px, 1fr))`, the toolbar search is `flex: 1 1 220px` capped at 360px, the index panel is `min(620px, 100vw - 32px)`, and long identifiers ellipsize rather than wrap.

**The Flat Rail Rule.** The module list is flat and always will be. Sections within a module live in the in-view tab strip; individual objects live in the index (Ctrl+K). The rail has to take twelve modules as easily as it takes three, which a nested tree cannot.

## Elevation & Depth

Surfaces do not float. `--shadow-card` is literally `none`, and depth comes from five background layers plus three weights of hairline. The only things that lift are things genuinely overlaid on the page, and they lift with intent.

### Shadow Vocabulary
- **`--shadow-sm`** (`0 1px 2px` at 30% ink): A barely-there seat for small floating chrome.
- **`--shadow-md`** (`0 8px 24px -6px` at 50% ink): Popovers, dropdown menus.
- **`--shadow-lg`** (`0 20px 56px -16px` at 65% ink): Modal-scale overlays and the index panel.

Stacking is tokenised rather than ad hoc: sticky 10, dropdown 100, terminal 200, modal 500, index 600.

### Named Rules

**The Flat Surface Rule.** A card, panel, table or section gets no shadow. If a thing needs a shadow it is not on the page, it is over the page, and it should be a real overlay with a scrim.

## Shapes

Four radii and none of them large: `sm` (4px) for tags, checkboxes, command blocks and small inset code; `md` (6px) for every control, which is buttons, fields, segmented groups and rail items; `lg` (8px) for containers, which is panels, stat cards and row lists; `xl` (10px) for true overlays, which is the index panel and modals. `full` exists for two jobs only, the status pill and small round dots and pips.

Borders carry the structure the corners do not. Every container is a 1px drawn line weighted by the three border tokens, and a control at rest is a 1px line plus a one-step ground shift. Tabs and rail items underline or take a wash rather than filling. The meter under a stat value is a 3px track, effectively a rule rather than a bar, because it annotates a number that is already stated.

## Components

The vocabulary lives in `src/components/ui.tsx` and its CSS in the `THE BUTTON`, `THE ERROR BANNER` and `PRIMITIVES` sections of `src/index.css`. If a module needs something the vocabulary does not have, it belongs there, not in that module.

### Buttons
- **Shape:** 6px corner, 1px border, 28px tall at the default size.
- **Default:** Raised ground with a hairline and primary text; hover lifts the ground one step and strengthens the border; active drops it back.
- **Primary:** Solid indigo fill with white text; hover moves to the bright accent, still white.
- **Danger:** Solid dark red with white text; hover brightens 12% rather than changing hue.
- **Danger-outline:** Red text on a 13% red ground with a red hairline. This is the destructive action that *opens* a dialog, and it deliberately weighs less than the solid confirm inside that dialog, because the most dangerous action must be the hardest to trigger.
- **Ghost:** No ground, no border, secondary text; hover picks up the faint chrome surface only.
- **Sizes:** sm 24px, md 28px, lg 32px. Icon-only is a square at the size's own height and requires an `aria-label`.
- **Disabled:** 45% opacity and `not-allowed`. Colour is never removed, only weight: a greyed-out red button still has to read as the destructive one.

### Chips
- **Style:** `Tag` is a 4px-cornered rectangle with a faint chrome ground, a hairline, and 11px label type.
- **State:** Five tones. Neutral, plus ok / warn / danger / accent, each taking its own colour for text, a 28-32% mix of it for the border, and its subtle alpha for the ground.
- **Pill:** A separate, fully-rounded 20px form used for one thing only: a dot and a fact, such as engine status in a page head.

### Cards / Containers
- **Corner Style:** 8px (`lg`).
- **Background:** `bg-secondary` for panels and cards; `bg-primary` for inset code.
- **Shadow Strategy:** None. See Elevation & Depth.
- **Border:** 1px hairline, always.
- **Internal Padding:** 12px vertical, 16px horizontal for a dense panel.
- **Head:** An 11px uppercase title, optional tabular meta, and actions pushed right. A panel that summarises a section can make its whole head a link, in which case it gains a chevron.

### Inputs / Fields
- **Style:** `SearchField` is the only search control in the app and it says one verb, "Search". 28px tall, well-coloured ground, 1px hairline, 6px corner, a leading icon in tertiary text, and a clear button that appears only when there is a value.
- **Focus:** A 2px accent outline inset by 2px, plus an accent border. Every focusable thing in the app gets this ring; it is enforced globally and survives the `outline: none` on inputs.

### Navigation
- **The rail:** A flat vertical list at 12px, 500 weight, in muted chrome text with a 15px icon and an optional right-aligned tabular count. The active item takes the chrome surface and the primary chrome text, and carries `aria-current="page"`. Children (Docker sections, WSL distros) indent one level and mark themselves the same way. A module that cannot run on this machine is dimmed rather than hidden: the user should see the module exists.
- **The tab strip:** Underline tabs in the fixed head block, tertiary at rest, primary with an accent underline when active. Built from `TabList` / `Tab`, which supply `role="tablist"`, `role="tab"`, `aria-selected`, a roving tabindex and arrow-key traversal with selection following focus. A strip of buttons with an `.active` class is not a tab strip.
- **Segmented:** A single 28px bordered group of filters with hairline dividers; the active segment takes the selection wash and accent text, and its count stays dim because a count is a fact about the segment, not part of the selection.
- **Breadcrumbs:** 11px tertiary above the page title, `/` separators at 55% opacity, the current crumb in secondary.

### The Command Block
The product's thesis rendered as a component. A 11px uppercase label, then the exact command in Cascadia Mono, accent-coloured, on the inset ground, selectable, wrapping rather than truncating. It appears wherever the app is about to do something to the machine, and the test is literal: the line shown must run if pasted into PowerShell.

### The Stat Card
A label, one big tabular number with an optional dim unit, an optional 3px meter, and an optional sub-line. The meter bands automatically at 75% (amber) and 90% (red), and it carries `role="meter"` with real min/now/max. `pct` of `null` draws an empty track, `undefined` draws no track at all, for facts that have no ceiling. The number is always stated, because a bar alone is not a reading.

### The Index (Ctrl+K)
A centred 620px panel on a dimmed scrim, capped at 62vh, holding every module, section, distro, image, container, volume, compose project and package on the machine. Rows are icon, label and a right-aligned "where"; the active row takes the selection wash and its icon turns accent. This is the answer to the eight separate filter boxes that used to be the only way to find anything.

### Error Banner, Empty State and Prerequisite
`ErrorBanner` carries `role="alert"` and unpacks a classified error into a sentence, a recovery hint, an optional action, and the raw Windows or Docker text behind a disclosure, hidden by default because it is evidence rather than the message. `EmptyState` teaches the surface rather than announcing a void. `Prerequisite` is the one treatment for "this module's tool is not installed" across every module: title, description, optional numbered steps, and the install command as a real command block, because the user could have typed it.

### Motion
Transitions are 0.1s / 0.15s / 0.24s ease and nothing else. Entrances fade and travel a few pixels. Under `prefers-reduced-motion: reduce` transitions collapse to 0.01ms, slide and scale entrances become pure fades, the pin flourish is neutralised entirely, and spinners, shimmers and stripes become in-place opacity pulses rather than disappearing, because they are the only signal that a distro is booting or a prune is running. The neutralised animations are redefined **by keyframe name**, not by selector, so any future rule reusing the name inherits the reduced variant automatically.

## Do's and Don'ts

### Do:
- **Do** build new surfaces from `src/components/ui.tsx`. If the vocabulary lacks something, add it there.
- **Do** give every view the same three-part shape: pinned head, optional tab strip, one scrolling body.
- **Do** keep spacing on the seven-step 4px scale and pick one of the seven type steps and one of the four radii. All three scales are closed.
- **Do** state a number as well as drawing it. Every meter prints its reading; every reclaim figure prints its size.
- **Do** record the measured contrast ratio in a comment beside any new colour token, against the lightest ground it can land on (`bg-hover`), not the average case.
- **Do** give any filled surface its own explicit foreground token.
- **Do** show the exact command in a command block wherever the app is about to touch the machine.
- **Do** make anything that switches panels a real tab strip via `TabList` / `Tab`, and anything that navigates a rail item with `aria-current`.
- **Do** label every icon-only control with the row it belongs to, not just its verb: "Remove volume pgdata", not "Remove".
- **Do** keep state-carrying pulses alive under reduced motion, and neutralise animations by keyframe name.

### Don't:
- **Don't** reach for the legacy `img-*`, `ctr-*`, `wsl-*`, `pkg-*` or `compose-*` class families in new work. They inherit the tokens but not the vocabulary, and they are being migrated out.
- **Don't** hardcode a colour, size, radius or spacing literal. Every value in this system is a token.
- **Don't** use green, amber or red for anything that is not state.
- **Don't** put a shadow on a card, panel, table or section. Shadows belong to real overlays only.
- **Don't** introduce a radius above 10px, or use `full` on anything but the status pill and small dots.
- **Don't** use monospace for emphasis or flavour. It means the string came from the machine.
- **Don't** define a chrome text colour as an alpha value. It composites down against the frame and fails.
- **Don't** nest the rail. Sections go in the tab strip, objects go in the index.
- **Don't** ship a search control with a verb other than "Search", or a second empty-state or prerequisite treatment.
- **Don't** suppress a focus ring. The global ring is deliberate and load-bearing at these type sizes.
- **Don't** add ornament that illustrates the atlas metaphor. The metaphor governs language and information architecture; the interface stays a console.
