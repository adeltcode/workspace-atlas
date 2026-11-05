# Design system

This document describes the visual design of Workspace Atlas: its design tokens, components, and accessibility rules.

If this document and the code disagree, the code is correct and this document needs updating.

| Source | Location |
|---|---|
| Design tokens | Top of `src/index.css` |
| Shared component styles | `src/index.css`, in the `THE BUTTON`, `THE ERROR BANNER`, `PRIMITIVES`, `THE STAT CARD`, and `THE PANEL` sections |
| Shared React components | `src/components/ui.tsx` |
| Dialogs | `src/components/ModalShell.tsx` |
| Command index | `src/components/CommandIndex.tsx` |
| Sidebar | `src/layout/Sidebar.tsx` |

**Contents:** [Principles](#principles) · [Color](#color) · [Typography](#typography) · [Spacing](#spacing) · [Shape](#shape) · [Elevation](#elevation) · [Layout](#layout) · [Motion](#motion) · [Components](#components) · [Accessibility](#accessibility) · [Rules for new UI](#rules-for-new-ui) · [Known issues](#known-issues)

## Principles

1. **Color has meaning.** Surfaces and text are neutral. One accent marks the primary action, the current selection, and keyboard focus. Green, amber, and red show state only.
2. **Density comes first.** Most text is 11 to 14px, controls are 28px tall, and table rows are 34px, so many objects fit on one screen.
3. **Surfaces are flat.** Borders and small background changes separate content. Only overlays get a shadow.
4. **Commands are visible.** When the app is about to change the machine, it shows the exact command.
5. **Risk sets the effort.** The more damage an action can do, the harder it is to trigger.

## Color

Dark values are set on `:root`. Light values are set on `[data-theme="light"]` and override them. On first launch the app follows the Windows theme, and it then saves the user's choice.

In the tables below, "Same" means the light theme does not override the token.

### Surfaces

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-bg-base` | `#0b0c0e` | `#f6f7f8` | App background |
| `--color-bg-primary` | `#111214` | `#ffffff` | Main panel, inset code |
| `--color-bg-secondary` | `#17181b` | `#fbfbfc` | Panels, cards, tables, dialogs |
| `--color-bg-tertiary` | `#1e2024` | `#f1f2f4` | Inputs, active sidebar item |
| `--color-bg-hover` | `#24262b` | `#e9ebee` | Hover state |

### Borders

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-border-light` | `rgba(255,255,255,0.045)` | `rgba(16,20,26,0.06)` | Lines between rows |
| `--color-border` | `rgba(255,255,255,0.075)` | `rgba(16,20,26,0.10)` | Default border |
| `--color-border-strong` | `rgba(255,255,255,0.15)` | `rgba(16,20,26,0.20)` | Hover state, overlays |

### Text

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-text-primary` | `#f2f3f5` | `#16181c` | Main content |
| `--color-text-secondary` | `#a2a9b2` | `#5a626c` | Supporting content |
| `--color-text-tertiary` | `#8d949e` | `#616872` | Labels, counts, units |

### Accent

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-accent` | `#8c94ee` | `#4a51c0` | Accent text and borders, focus ring |
| `--color-accent-fill` | `#4c53c4` | `#4c53c4` | Primary button background |
| `--color-accent-hover` | `#959ced` | `#3a40a8` | Stronger accent text, such as terminal commands |
| `--color-accent-subtle` | `rgba(140,148,238,0.12)` | `rgba(76,83,196,0.10)` | Selected row or item background |
| `--color-accent-border` | `color-mix(in srgb, var(--color-accent) 32%, transparent)` | Same | Border of accent tags and pressed toggles |

### State

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--color-success` | `#4ec26a` | `#1a6d36` | The operation succeeded |
| `--color-success-subtle` | `rgba(78,194,106,0.13)` | `rgba(26,109,54,0.10)` | Background for success text |
| `--color-warning` | `#e0a63a` | `#7d5307` | Take care |
| `--color-warning-subtle` | `rgba(224,166,58,0.13)` | `rgba(125,83,7,0.10)` | Background for warning text |
| `--color-danger` | `#f77f78` | `#b02f28` | Failure or destructive action |
| `--color-danger-fill` | `#b8362e` | `#b8362e` | Solid destructive button |
| `--color-danger-subtle` | `rgba(247,127,120,0.13)` | `rgba(176,47,40,0.10)` | Background for danger text |
| `--color-danger-border` | `color-mix(in srgb, var(--color-danger) 26%, transparent)` | Same | Border of danger tags and outline buttons |

### Text on fills

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-on-brand` | `#fff` | Same | Text on accent and danger fills |
| `--color-on-fill` | `#0b0c0e` | `#ffffff` | Text on success and warning fills |

### Window frame

The titlebar, sidebar, and terminal match `--color-bg-base` in both themes.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-sidebar-bg` | `#0b0c0e` | `#f6f7f8` | Sidebar background |
| `--color-titlebar-bg` | `#0b0c0e` | `#f6f7f8` | Titlebar background |
| `--color-terminal-bg` | `#0b0c0e` | `#f6f7f8` | Terminal background |
| `--titlebar-close` | `#c4342b` | Same | Close button on hover, matching Windows |
| `--chrome-text` | `#f2f3f5` | `#16181c` | Main text in the titlebar and terminal |
| `--chrome-text-muted` | `#a2a9b2` | `#5a626c` | Supporting text in the titlebar and terminal |
| `--chrome-text-subtle` | `#8d949e` | `#616872` | Quiet text in the titlebar and terminal |
| `--chrome-surface` | `rgba(255,255,255,0.045)` | `rgba(16,20,26,0.045)` | Subtle hover background, neutral tags |
| `--chrome-surface-hover` | `rgba(255,255,255,0.075)` | `rgba(16,20,26,0.075)` | Stronger hover background |
| `--chrome-divider` | `rgba(255,255,255,0.075)` | `rgba(16,20,26,0.10)` | Lines in the titlebar and terminal |

### Charts and disk usage

| Token | Dark | Light |
|---|---|---|
| `--chart-1` | `#7c84e8` | `#4a51c0` |
| `--chart-2` | `#4ec26a` | `#1f7a3d` |
| `--chart-3` | `#e0a63a` | `#7d5307` |
| `--chart-4` | `#4aa8e0` | `#1d6fa8` |
| `--chart-5` | `#b07ce8` | `#7b3fb5` |
| `--chart-6` | `#f2665e` | `#c0362e` |
| `--chart-7` | `#e08a4a` | `#b0602a` |
| `--chart-8` | `#43c4b0` | `#10756a` |
| `--disk-other` | `#656c77` | `#7f868f` |
| `--disk-free` | `#1e2024` | `#e9ebee` |

### Syntax highlighting

These tokens color Compose files, Dockerfiles, and `.env` files.

| Token | Dark | Light |
|---|---|---|
| `--syntax-comment` | `#7d858f` | `#6b727c` |
| `--syntax-key` | `#7c84e8` | `#4a51c0` |
| `--syntax-key-nested` | `#a2a9b2` | `#5a626c` |
| `--syntax-string` | `#e0a63a` | `#7d5307` |
| `--syntax-bool` | `#b07ce8` | `#7b3fb5` |
| `--syntax-number` | `#4ec26a` | `#1f7a3d` |
| `--syntax-env` | `#e08a4a` | `#a5531e` |

### Color rules

- Use `--color-accent` for text and borders, and `--color-accent-fill` for backgrounds. Do not swap them.
- Use the state colors only to show state, not for decoration or branding.
- Set a text color on every filled surface. White fails contrast on the dark theme's success and warning colors, so those fills use `--color-on-fill`.
- Keep `--chrome-text*` tokens as solid colors. A transparent text color changes with whatever is behind it.
- Use `--shadow-ink` only for shadows and overlay backgrounds.

## Typography

| Font | Stack | Use |
|---|---|---|
| Interface | `"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif` | All interface text |
| Monospace (`--font-mono`) | `"Cascadia Mono", "Cascadia Code", "Consolas", ui-monospace, monospace` | Commands, IDs, paths, terminal output |

The app loads no web fonts. It uses fonts already installed on the system.

| Style | Token | Size | Weight | Line height | Letter spacing | Use |
|---|---|---|---|---|---|---|
| Value | `--text-xl` | 22px | 600 | 1.1 | -0.02em | The number on a stat card |
| Title | `--text-lg` | 19px | 600 | 1.2 | -0.02em | Page title |
| Heading | `--text-md` | 14px | 600 | 1.55 | Normal | Prerequisite titles, dialog titles (weight 700) |
| Body | `--text-sm`, `--text-base` | 13px | 400 | 1.55 | Normal | Descriptions, table cells |
| Control | `--text-xs` | 12px | 500 | 1 | Normal | Buttons, fields, segments |
| Label | `--text-2xs` | 11px | 600 | 1.55 | 0.06em, uppercase | Panel titles, section titles, stat labels |
| Code | `--text-sm` | 13px | 400 | 1.7 | Normal | Terminal output, file viewers |

Table headers, sidebar section labels, and command index section labels use the Label style with 0.05em letter spacing.

Helper classes:

| Class | Effect |
|---|---|
| `.num` | Tabular numbers, so digits line up in columns |
| `.mono` | Monospace font |
| `.ident` | 11px monospace in `--color-text-tertiary`, for IDs |

Typography rules:

- Use monospace only for text that came from the machine or can be pasted into it.
- Use tabular numbers for any number in a column.
- Use the Label style for anything that names a group of content.

The titlebar logo (`.titlebar-logo`) is the one exception to the type scale: 10px text on an accent gradient. WCAG 1.4.3 has no contrast requirement for logos.

## Spacing

All spacing uses one scale.

| Token | Value |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 24px |
| `--space-6` | 32px |
| `--space-7` | 48px |

## Shape

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Tags, keycaps, inset code |
| `--radius-md` | 6px | Buttons, fields, segmented groups, sidebar items |
| `--radius-lg` | 8px | Panels, stat cards, tables, dialogs |
| `--radius-xl` | 10px | Command index |
| `--radius-full` | 9999px | Status pill, dots, meters |

Containers use a 1px border. Do not add a radius above 10px, except `--radius-full`.

## Elevation

Panels, cards, and tables have no shadow. Shadows are for content that sits above the page.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--shadow-ink` | `#000` | Same | Shadow and overlay color |
| `--shadow-card` | `none` | Same | Not used |
| `--shadow-sm` | `0 1px 2px color-mix(in srgb, var(--shadow-ink) 30%, transparent)` | `0 1px 2px rgba(16,20,26,0.08)` | Not used |
| `--shadow-md` | `0 8px 24px -6px color-mix(in srgb, var(--shadow-ink) 50%, transparent)` | `0 8px 24px -6px rgba(16,20,26,0.14)` | Chart tooltip |
| `--shadow-lg` | `0 20px 56px -16px color-mix(in srgb, var(--shadow-ink) 65%, transparent)` | `0 20px 56px -16px rgba(16,20,26,0.20)` | Command index |

| Token | Value | Use |
|---|---|---|
| `--z-sticky` | 10 | Sticky table headers |
| `--z-dropdown` | 100 | Not used |
| `--z-terminal` | 200 | Not used |
| `--z-modal` | 500 | Not used |
| `--z-palette` | 600 | Command index |

Dialogs use the native `<dialog>` top layer, so they need no z-index.

## Layout

### Window

| Region | Size | Behavior |
|---|---|---|
| Window | Opens at 1280 by 800px | Minimum 900 by 600px |
| Titlebar | 44px tall (`--titlebar-height`) | Fixed |
| Sidebar | 212px wide (`--sidebar-width`) | Resizes from 160 to 360px |
| Main panel | Fills the remaining space | Minimum 240px tall |
| Terminal | 180px tall when first opened | Resizes from 100 to 600px, and collapses to a 32px header |

The content column adds bottom padding equal to the terminal's height, so the terminal never covers the last row of a page. On `.app-content`, a calculated `--terminal-height` replaces the 240px value set on `:root`.

`--context-width` (300px) and `.context-panel` are defined but not used.

### Page structure

Every view has three parts: a fixed header, an optional tab strip, and one scrolling body. The view scrolls its own body, so the header and its actions stay visible.

| Class | Padding (top, sides, bottom) | Use |
|---|---|---|
| `.page-head` | 24px, 32px, 16px | Fixed header with a bottom border. Holds `SheetHead`. |
| `.page-scroll` | 24px, 32px, 48px | Scrolling body. Uses `scrollbar-gutter: stable` so content does not shift when a scrollbar appears. |
| `.page-fill` | 24px, 32px, 24px | Body that does not scroll, for pages where an inner element scrolls. |
| `.page-fill--bleed` | 0 | A `.page-fill` that manages its own padding. |

Spacing inside a body:

| Element | Space above it |
|---|---|
| `.panel`, `.stat-row`, `.error-banner` | 16px |
| `.section-head` | 32px |

### Resizing

The app has no breakpoints. Content adapts to the window width:

| Element | Rule |
|---|---|
| Stat row | `repeat(auto-fit, minmax(168px, 1fr))` |
| Toolbar search | `flex: 1 1 220px`, from 180 to 360px wide |
| Command index | `min(620px, calc(100vw - var(--space-6)))` |
| Long IDs and names | Cut off with an ellipsis |

## Motion

| Token | Value | Use |
|---|---|---|
| `--transition-fast` | `0.1s ease` | Hover and color changes |
| `--transition-base` | `0.15s ease` | General transitions |
| `--transition-slow` | `0.24s ease` | Terminal panel, meter fill |

Under `prefers-reduced-motion: reduce`, which the Windows "Show animations" setting controls:

| Motion | Behavior |
|---|---|
| Transitions | Finish at once (`transition-duration: 0.01ms`) |
| Entrance animations | Fade without moving |
| Pin animation | Removed |
| Spinners, loading shimmers, and stripes | Pulse in opacity, because they are the only sign that work is running |
| Indeterminate progress bar | Fills its track and pulses |

These overrides redefine each `@keyframes` rule by name. Any new rule that uses one of those names gets the reduced version automatically.

## Components

Build new UI from `src/components/ui.tsx`.

### Button

`Button` takes `variant`, `size`, and `icon` props.

| Variant | Background | Text | Border | On hover | Use |
|---|---|---|---|---|---|
| `default` | `--color-bg-secondary` | `--color-text-primary` | `--color-border` | Background `--color-bg-hover`, border `--color-border-strong` | Most actions |
| `primary` | `--color-accent-fill` | `--color-on-brand` | `--color-accent-fill` | `filter: brightness(1.12)` | The main action in a view or dialog |
| `danger` | `--color-danger-fill` | `--color-on-brand` | `--color-danger-fill` | `filter: brightness(1.12)` | The confirm button in a destructive dialog |
| `danger-outline` | `--color-danger-subtle` | `--color-danger` | `--color-danger-border` | Stronger background and border | A destructive action that opens a dialog |
| `ghost` | Transparent | `--color-text-secondary` | Transparent | Background `--chrome-surface`, text `--color-text-primary` | Low-emphasis actions |

The hover rule of a filled variant must set its background and border again. Otherwise `.btn:hover` replaces the fill.

| Size | Height | Padding | Font size |
|---|---|---|---|
| `sm` | 24px | 0 8px | 12px |
| `md` (default) | 28px | 0 11px | 12px |
| `lg` | 32px | 0 16px | 13px |

| State | Behavior |
|---|---|
| Pressed (`default` variant) | Background `--color-bg-tertiary` |
| Disabled | `opacity: 0.45` and `cursor: not-allowed`. The color stays, so a disabled destructive button still looks destructive. |
| Icon only | The `icon` prop makes a 28px square, or a 24px square with `size="sm"`. Requires `aria-label`. |
| Toggled on | The `btn--on` class sets background `--color-accent-subtle`, border `--color-accent-border`, and text `--color-accent`. |

### SearchField

A search input with a leading icon. A clear button appears when the field has a value.

- **Size:** 28px tall, with a 6px radius, a 1px border, and a `--color-bg-tertiary` background.
- **Placeholder:** Starts with "Search", such as "Search images".
- **Focus:** 2px accent outline inset by 2px, plus an accent border.

### Tag

A small inline label: 20px tall, 8px side padding, 4px radius, 11px text at weight 500.

| `tone` | Background | Text | Border |
|---|---|---|---|
| `neutral` (default) | `--chrome-surface` | `--color-text-secondary` | `--color-border` |
| `ok` | `--color-success-subtle` | `--color-success` | 28% `--color-success` |
| `warn` | `--color-warning-subtle` | `--color-warning` | 28% `--color-warning` |
| `danger` | `--color-danger-subtle` | `--color-danger` | `--color-danger-border` |
| `accent` | `--color-accent-subtle` | `--color-accent` | `--color-accent-border` |

### Status pill

The `.pill` class shows a status dot and a short fact: 20px tall, fully rounded, 11px `--color-text-secondary` text on `--color-bg-secondary`, with a 1px border. It has no React component.

### Panel

A bordered group with an optional header: `--color-bg-secondary` background, 8px radius, 1px border.

| Prop | Effect |
|---|---|
| `title` | Shows a header at least 34px tall with a bottom border. Leave it out for a plain group. |
| `meta` | Shows a short fact next to the title. |
| `actions` | Shows controls at the right of the header. Ignored when `onOpen` is set. |
| `onOpen` | Makes the whole header a button with a chevron, linking to the section it summarizes. |

Use `.panel-body` for 12px by 16px padding inside a panel.

### StatCard and StatRow

`StatCard` shows one number, with an optional unit, meter, and sub-line. Place cards in a `StatRow`, which spaces them 12px apart.

| `pct` value | Result |
|---|---|
| 0 to 100 | Draws a 3px meter |
| `null` | Draws an empty track |
| `undefined` | Draws no track, for values with no upper limit |

The meter uses `--color-accent` below 75, `--color-warning` from 75, and `--color-danger` from 90. The `tone` prop overrides this. The meter has `role="meter"` with min, max, and current values. Add `onClick` to make the whole card a button.

### SheetHead

The page header. It shows a breadcrumb, a title, an optional status, right-aligned actions, and an optional subtitle. Its title row is at least 28px tall, so the height stays the same with or without actions.

Breadcrumbs use 11px `--color-text-tertiary` text, with the current page in `--color-text-secondary`. They sit in a `nav` with `aria-label="Breadcrumb"`, and the current page has `aria-current="page"`.

### SectionHead

A section title with an optional fact, a line that runs to the edge of the column, and optional actions. It is at least 28px tall with 12px of space below it.

### Toolbar

The row above a table, holding search, filters, and counts. It has an 8px gap and 12px of space below it. A `SearchField` inside a toolbar grows to fill the space, up to 360px.

### Segmented and SegmentedItem

A group of filter buttons: 28px tall, 6px radius, with 1px lines between items. The active item uses `--color-accent-subtle` and `--color-accent`, and its count stays dim at 75% opacity. The group has `role="group"`, and each item sets `aria-pressed`.

### TabList and Tab

These two components provide tab behavior only. Each tab strip sets its own appearance through `className`.

- **Roles:** `role="tablist"` and `role="tab"`, with `aria-selected` and `aria-controls`.
- **Keyboard:** Left and Right arrows, Home, and End move between tabs, and selection follows focus. Only the selected tab is in the Tab order.

Use these for anything that switches panels. A row of plain buttons with an `.active` class is not a tab strip.

### Table

There is no shared table component. Tables use the `.img-table` classes inside `.img-table-wrap`. For resizable columns, sorting, and a Columns menu, add `.pkg-table` and use `useTableColumns`, `TableHead`, and `ColumnsMenu` from `src/components/TableColumns.tsx`, with the choices saved in the store.

| Part | Style |
|---|---|
| Wrapper | 1px border, 8px radius, `--color-bg-secondary` background |
| Header | 30px tall and sticky, in the Label style |
| Row | 34px tall, 13px text, with `--color-border-light` between rows |

### Command display

Both styles use monospace text that the user can select.

| Class | Style | Use |
|---|---|---|
| `.cmd-block` | An 11px label above 13px `--color-accent` text on `--color-bg-primary`. Long commands wrap. | Before an action runs, such as in `ConfirmDestructive` |
| `.cmd` | 12px `--color-text-secondary` text on `--color-bg-base`, with a 1px border. Long commands scroll sideways. | Install commands in `Prerequisite` |

The text must be the exact command, and it must work if pasted into PowerShell.

### ErrorBanner

Shows an error with `role="alert"`. A `busy` error also gets a button that opens the File locks page.

| Prop | Effect |
|---|---|
| `title` | Names the operation that failed, such as "Could not remove the volume". |
| `error` | The caught error. Supplies the message, the recovery hint, and the raw error text. |
| `action` | A recovery control, such as a retry button. |
| `detailLabel` | The label for the raw error text, which starts collapsed. Defaults to "Details". |

### EmptyState

Shows an optional icon, a title, a description, and actions, centered. The text should explain what belongs in the view and how to add it, not only say that it is empty.

### FileDropZone

Wraps an area that takes files and folders dragged in from outside the app, from `src/components/FileDropZone.tsx`. While a file is over the area, a dashed cover shows the label. HTML drop events do not work here, because Tauri takes file drags first.

| Prop | Effect |
|---|---|
| `label` | The text on the cover. Say what the drop will do, such as "Drop to check for locks". |
| `disabled` | Ignores drags and shows no cover. Set it while a dialog is open or work is running. |
| `onDrop` | Gets every dropped path, and always at least one. The page decides what to do with more than one. |

Put `FileDropPrompt` inside the zone while the area has nothing else to show. It is an `EmptyState` in a dashed box.

Always offer another way to choose a path, such as a path field or a Browse button. Windows blocks these drags when the app runs as administrator.

### Prerequisite

Shows that a module's tool is missing: a title, a description, optional numbered steps, the install command in `.cmd`, and actions. Use it for every missing tool, so they all look the same.

### ConfirmDestructive

The dialog for bulk destructive actions. It shows, in order:

1. The title.
2. What will be lost.
3. The exact command.
4. A summary of counts and totals.
5. The affected items, by name.
6. Cancel and a solid `danger` confirm button.

The optional `escape` prop adds a safer option at the left of the buttons, such as backing up first. While `busy` is true, both buttons are disabled, and Escape and clicking outside do nothing.

### Dialogs

`ModalShell` wraps the native `<dialog>` element and opens it with `showModal()`. Render it conditionally: it opens when mounted and closes when unmounted.

The `.modal` class sets a `--color-bg-secondary` background, a 1px border, an 8px radius, 28px of padding, and a width of 440px, or 520px with `.modal--wide`.

### Kbd

A keycap: at least 17px wide, 17px tall, 4px radius, 11px text at weight 600 on `--color-bg-tertiary`.

### Sidebar

A vertical list of modules. Items under the active module appear nested below it, with a line down the left side.

| Item | Height | Text | On hover | When active |
|---|---|---|---|---|
| Module (`.rail-item`) | 30px | 13px `--color-text-secondary` | `--chrome-surface` background, `--color-text-primary` text | `--color-bg-tertiary` background, `--color-text-primary` text, weight 550 |
| Child (`.rail-kid`) | 26px | 12px `--color-text-tertiary` | `--chrome-surface` background, `--color-text-secondary` text | `--color-accent-subtle` background, `--color-text-primary` text |

Modules have a 15px icon and an optional count. The current item has `aria-current="page"`.

### Command index

A search dialog opened with Ctrl+K. It lists places, distros, Compose projects, images, containers, and volumes.

- **Panel:** Up to 620px wide and 62vh tall, with a 10px radius, `--color-border-strong`, and `--shadow-lg`, over a 55% `--shadow-ink` background.
- **Rows:** An icon, a label, and the item's location at the right. The active row uses `--color-accent-subtle`, and its icon uses `--color-accent`.

### Legacy classes

The Docker tabs, WSL components, and Packages table still use older classes: `img-*`, `ctr-*`, `wsl-*`, `pkg-*`, and `compose-*`. Older button classes, such as `btn-primary` and `ctr-action-btn`, share the `.btn` base styles.

These classes use the design tokens, but do not copy them for new components. Tables are the exception, as there is no shared component yet.

## Accessibility

The target is [WCAG 2.1](https://www.w3.org/TR/WCAG21/) level AA.

### Contrast

Ratios use the WCAG formula. Text must reach 4.5:1. `--color-bg-hover` gives the lowest ratio for all of these colors, so check new colors against it.

Graphics must reach 3:1 against the colors next to them. `--disk-other` measures 3.08:1 against the disk bar's track in the dark theme, and 3.08:1 against `--disk-free` in the light theme, its lowest ratios.

| Text token | Dark on `--color-bg-primary` | Dark on `--color-bg-hover` | Light on `--color-bg-primary` | Light on `--color-bg-hover` |
|---|---|---|---|---|
| `--color-text-primary` | 16.88 | 13.64 | 17.77 | 14.88 |
| `--color-text-secondary` | 7.90 | 6.38 | 6.18 | 5.17 |
| `--color-text-tertiary` | 6.12 | 4.95 | 5.63 | 4.71 |
| `--color-accent` | 6.77 | 5.47 | 6.50 | 5.44 |
| `--color-success` | 8.25 | 6.67 | 6.39 | 5.35 |
| `--color-warning` | 8.64 | 6.98 | 6.75 | 5.65 |
| `--color-danger` | 7.37 | 5.96 | 6.40 | 5.36 |

| Text on fill | Dark | Light |
|---|---|---|
| `--color-on-brand` on `--color-accent-fill` | 6.28 | 6.28 |
| `--color-on-brand` on `--color-danger-fill` | 5.82 | 5.82 |
| `--color-on-fill` on `--color-success` | 8.62 | 6.39 |
| `--color-on-fill` on `--color-warning` | 9.02 | 6.75 |
| `--color-on-brand` on `--color-accent-fill` at `brightness(1.12)`, on hover | 5.28 | 5.28 |
| `--color-on-brand` on `--color-danger-fill` at `brightness(1.12)`, on hover | 4.85 | 4.85 |

A color can sit on its own subtle background twice, such as a badge inside a selected card, so check that case too. These ratios were measured over `--color-bg-secondary`.

| Text on subtle background | Dark | Light |
|---|---|---|
| `--color-accent` on `--color-accent-subtle` | 5.35 | 5.45 |
| `--color-success` on `--color-success-subtle` | 6.27 | 5.35 |
| `--color-warning` on `--color-warning-subtle` | 6.51 | 5.64 |
| `--color-danger` on `--color-danger-subtle` | 5.72 | 5.29 |
| `--color-success` on `--color-success-subtle`, twice | 4.92 | 4.67 |
| `--color-warning` on `--color-warning-subtle`, twice | 5.06 | 4.91 |
| `--color-danger` on `--color-danger-subtle`, twice | 4.58 | 4.56 |

### Focus

- Buttons, inputs, text areas, selects, and elements with `tabindex` get a 2px `--color-accent` outline with a 2px offset. It uses `!important`, so it overrides any `outline: none`.
- Shared components, such as `.btn`, `.segmented-item`, and `.rail-item`, inset the outline by 2px.
- `.field` shows the outline on the whole field through `:focus-within`, and also turns its border to the accent color.

### Keyboard

| Control | Keys |
|---|---|
| Tabs | Left, Right, Home, End |
| Dialogs | Focus moves in and stays inside. Escape closes the dialog, and focus returns to the control that opened it. |
| Command index | Ctrl+K opens it |

### Names and roles

- Every icon-only control needs an `aria-label` that names its target, such as "Remove volume pgdata" instead of "Remove".
- Current navigation items use `aria-current="page"`.
- Errors use `role="alert"`, and meters use `role="meter"`.
- Hide decorative icons with `aria-hidden="true"`.
- Show every value as text as well. A meter or bar alone is not enough.

## Rules for new UI

**Do:**

- Build from `src/components/ui.tsx`. If something is missing, add it there, not in a module.
- Use tokens for color, size, radius, and spacing.
- Give every view the standard [page structure](#page-structure).
- Show the exact command before the app changes the machine.
- Use `TabList` and `Tab` for anything that switches panels.
- Keep working indicators visible under reduced motion.
- Add new colors to this document, with their contrast ratios.

**Do not:**

- Add a shadow to a panel, card, or table.
- Use green, amber, or red for anything except state.
- Use monospace for emphasis.
- Remove a focus outline.
- Add a second style for search fields, empty states, or missing tools.
- Add decorative graphics.

## Known issues

- `.terminal-panel` uses a literal `z-index: 20` instead of `--z-terminal`.
- Some tokens are defined but not used. They are marked "Not used" in [Elevation](#elevation).
- [Legacy classes](#legacy-classes) remain in the Docker, WSL, and Packages views.
