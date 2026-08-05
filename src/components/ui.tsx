/* The component vocabulary.
 *
 * Before this file existed the app had 38 `*-btn` class families, 12 empty-state
 * families, 8 search inputs using 4 different verbs, and two entirely different
 * renderings of "this module's prerequisite is missing". Every module now draws
 * from here. If a module needs something this file does not have, it belongs
 * here, not in that module. */
import { Search, X, ChevronRight, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { toAppError } from '../utils/errors'
import ModalShell from './ModalShell'

// ── Button ───────────────────────────────────────────────────────────────────

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `danger` is the solid confirm inside a dialog; `danger-outline` is the
   *  destructive action that opens one, so the two never read alike. */
  variant?: 'default' | 'primary' | 'danger' | 'danger-outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  /** Renders as a square icon-only button. Requires `aria-label`. */
  icon?: boolean
}

export function Button({ variant = 'default', size = 'md', icon, className, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={clsx(
        'btn',
        variant !== 'default' && `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        icon && 'btn--icon',
        className,
      )}
    />
  )
}

// ── Search field ─────────────────────────────────────────────────────────────
// One verb. The app used to say "Filter by...", "Search by...", "Find a..." and
// "Search..." in different modules for the identical control.

export function SearchField({ value, onChange, placeholder, label, className }: {
  value: string
  onChange: (v: string) => void
  /** What is being searched, e.g. "images". Becomes "Search images". */
  placeholder: string
  /** Accessible name. Defaults to the placeholder. */
  label?: string
  className?: string
}) {
  return (
    <div className={clsx('field', className)}>
      <Search size={13} className="field-icon" aria-hidden="true" />
      <input
        className="field-input"
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        spellCheck={false}
      />
      {value && (
        <button className="field-clear" onClick={() => onChange('')} aria-label="Clear search" type="button">
          <X size={12} />
        </button>
      )}
    </div>
  )
}

// ── Tag ──────────────────────────────────────────────────────────────────────

export function Tag({ tone = 'neutral', children, className }: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={clsx('tag', tone !== 'neutral' && `tag--${tone}`, className)}>{children}</span>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────
// Teaches the surface. "Nothing here" is not an acceptable empty state.

export function EmptyState({ icon: Icon, title, description, actions }: {
  icon?: React.ElementType
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="empty">
      {Icon && <Icon size={22} className="empty-icon" aria-hidden="true" />}
      <p className="empty-title">{title}</p>
      {description && <p className="empty-desc">{description}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  )
}

// ── Prerequisite notice ──────────────────────────────────────────────────────
// Docker missing and WSL missing are the same state and now read the same way.

export function Prerequisite({ title, description, steps, command, actions }: {
  title: string
  description: string
  steps?: string[]
  /** The command that installs it, shown because the user could have typed it. */
  command?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="prereq">
      <h2 className="prereq-title">{title}</h2>
      <p className="prereq-desc">{description}</p>
      {steps && steps.length > 0 && (
        <ol className="prereq-steps">
          {steps.map(s => <li key={s} className="prereq-step">{s}</li>)}
        </ol>
      )}
      {command && <code className="cmd">{command}</code>}
      {actions && <div className="prereq-actions" style={{ marginTop: 'var(--space-4)' }}>{actions}</div>}
    </div>
  )
}

// ── Sheet header ─────────────────────────────────────────────────────────────
// Replaces four different view-header treatments, and adds the breadcrumb the
// app never had.

export interface Crumb { label: string; onClick?: () => void }

export function SheetHead({ crumbs, title, subtitle, status, actions }: {
  crumbs?: Crumb[]
  title: string
  subtitle?: React.ReactNode
  status?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="sheet-head">
      <div className="sheet-head-main">
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} style={{ display: 'contents' }}>
                {i > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}
                {c.onClick
                  ? <button className="crumb" onClick={c.onClick}>{c.label}</button>
                  : <span className="crumb crumb--here" aria-current="page">{c.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <h1 className="sheet-title">{title}</h1>
          {status}
        </div>
        {subtitle && <p className="sheet-sub">{subtitle}</p>}
      </div>
      {actions && <div className="sheet-actions">{actions}</div>}
    </header>
  )
}

// ── Keycap ───────────────────────────────────────────────────────────────────

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

// ── Section heading ──────────────────────────────────────────────────────────

export function SectionHead({ title, meta, actions }: {
  title: string
  /** A fact about the section, right of the title. Not a control. */
  meta?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="section-head">
      <h2 className="section-title">{title}</h2>
      {meta && <span className="section-meta">{meta}</span>}
      <span className="section-rule" aria-hidden="true" />
      {actions}
    </div>
  )
}

// ── Stat card ────────────────────────────────────────────────────────────────
// One number, stated. The Overview and the Docker summary used to draw the same
// thing two ways - `metric-card` with a meter and `hero-tile` without - so a
// count of containers looked like a different kind of fact from a percentage of
// memory. It is the same kind of fact.

export function StatCard({ label, value, unit, sub, pct, tone, onClick, ariaLabel }: {
  label: string
  value: string
  /** Rendered small and dim after the value: "%", "free". */
  unit?: string
  sub?: React.ReactNode
  /** 0-100 draws a meter under the value; null draws an empty track; undefined
   *  draws no track at all, for facts that have no ceiling. */
  pct?: number | null
  /** Overrides the automatic 75/90 banding. */
  tone?: 'ok' | 'warn' | 'danger'
  onClick?: () => void
  ariaLabel?: string
}) {
  const auto = pct == null ? undefined : pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : undefined
  const t = tone ?? auto
  const width = pct == null ? 0 : Math.min(100, Math.max(0, pct))

  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value num">
        {value}{unit && <span className="stat-unit">{unit}</span>}
      </span>
      {pct !== undefined && (
        <span
          className="stat-track"
          role="meter"
          aria-label={label}
          aria-valuenow={pct == null ? undefined : Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className={clsx('stat-fill', t && `stat-fill--${t}`)}
            style={{ transform: `scaleX(${width / 100})` }}
          />
        </span>
      )}
      {sub && <span className="stat-sub">{sub}</span>}
    </>
  )

  return onClick
    ? <button className="stat stat--clickable" onClick={onClick} aria-label={ariaLabel}>{body}</button>
    : <div className="stat">{body}</div>
}

/** The row stat cards sit in. Fills the column at any width, which the old
 *  fixed six-column grid did not once the tile count dropped to three. */
export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="stat-row">{children}</div>
}

// ── Panel ────────────────────────────────────────────────────────────────────
// A bordered group with an optional head. Replaces `overview-section`,
// `rowlist` and four hand-rolled card treatments.

export function Panel({ title, meta, actions, onOpen, children, className }: {
  /** Omit for a plain bordered group with no head. */
  title?: string
  meta?: React.ReactNode
  actions?: React.ReactNode
  /** Makes the whole head a link into the section it summarises. */
  onOpen?: () => void
  children: React.ReactNode
  className?: string
}) {
  const head = title && (
    <>
      <span className="panel-title">{title}</span>
      {meta && <span className="panel-meta">{meta}</span>}
    </>
  )
  return (
    <section className={clsx('panel', className)}>
      {title && (onOpen
        ? (
          <button className="panel-head panel-head--link" onClick={onOpen}>
            {head}
            <ChevronRight size={13} className="panel-head-arrow" aria-hidden="true" />
          </button>
        )
        : (
          <div className="panel-head">
            {head}
            {actions && <div className="panel-actions">{actions}</div>}
          </div>
        )
      )}
      {children}
    </section>
  )
}

// ── Error banner ─────────────────────────────────────────────────────────────
// Thirteen copies of this markup existed, three of them with different padding.
//
// An error that names the problem and stops is half an error. Pass `error` (the
// caught value) instead of a string and the banner draws what the backend
// classified: the sentence, the recovery hint, and the raw Windows or Docker
// text behind a disclosure - hidden by default because it is evidence, not the
// message, but present because this app does not hide what actually happened.

export function ErrorBanner({ title, error, action, className, children }: {
  /** Names the operation that failed: "Could not remove the volume". */
  title?: string
  /** The caught value. Supplies the sentence, the hint and the raw detail. */
  error?: unknown
  /** Recovery control. A button that retries or opens where the fix lives. */
  action?: React.ReactNode
  /** `error-banner--flush` where the surrounding layout owns the spacing. */
  className?: string
  /** Legacy plain-text body, used when there is no `error` to unpack. */
  children?: React.ReactNode
}) {
  const e = error === undefined ? null : toAppError(error)
  const body = e ? e.message : children

  return (
    <div className={clsx('error-banner', className)} role="alert">
      <AlertTriangle size={14} className="error-icon" aria-hidden="true" />
      <div className="error-body">
        {title ? (
          <>
            <p className="error-headline">{title}</p>
            <p className="error-msg">{body}</p>
          </>
        ) : (
          <p className="error-headline">{body}</p>
        )}
        {e?.hint && <p className="error-hint">{e.hint}</p>}
        {e?.detail && (
          <details className="error-detail">
            <summary className="error-detail-summary">What Windows reported</summary>
            <pre className="error-detail-text">{e.detail}</pre>
          </details>
        )}
        {action && <div className="error-actions">{action}</div>}
      </div>
    </div>
  )
}

// ── Destructive confirmation ─────────────────────────────────────────────────
/**
 * The dialog a bulk destructive action opens.
 *
 * `docker volume prune -f` and `docker rm` across a selection used to run
 * straight off a toolbar click. The per-row remove had a two-click arm, so the
 * action that destroyed one volume was harder to trigger than the action that
 * destroyed seven - the exact inversion PRODUCT.md's second principle forbids.
 *
 * Four things, in the order the user needs them: what is about to happen, what
 * it costs, the command that will run, and the list of objects by name. The
 * escape hatch sits on the left, away from the confirm, because it is a
 * different decision rather than a softer version of the same one.
 */
export function ConfirmDestructive({
  title, consequence, command, items, summary, confirmLabel, onConfirm, onCancel, busy, escape,
}: {
  title: string
  /** What is lost. Concrete, not "this cannot be undone" alone. */
  consequence: React.ReactNode
  /** The exact shell line, shown because the user could have typed it. */
  command: string
  items: { name: string; meta?: string }[]
  /** Counts and totals: "7 volumes · 2.4 GB". */
  summary: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
  /** The safer path, when one exists: back up first, export first. */
  escape?: React.ReactNode
}) {
  return (
    <ModalShell className="modal-overlay" onClose={busy ? undefined : onCancel} closeOnBackdrop={!busy}>
      <div className="modal modal--wide">
        <div className="modal-header">
          <div className="modal-icon-wrap danger"><AlertTriangle size={16} /></div>
          <h2 className="modal-title">{title}</h2>
        </div>

        <p className="modal-body">{consequence}</p>

        <div className="cmd-block">
          <span className="cmd-block-label">Exact command</span>
          <code className="cmd-block-code">{command}</code>
        </div>

        <div className="confirm-list-head">
          <span className="confirm-list-summary num">{summary}</span>
        </div>
        <ul className="confirm-list">
          {items.map(i => (
            <li key={i.name} className="confirm-list-item">
              <span className="confirm-list-name">{i.name}</span>
              {i.meta && <span className="confirm-list-meta num">{i.meta}</span>}
            </li>
          ))}
        </ul>

        <div className="modal-actions">
          {escape && <div className="modal-actions-escape">{escape}</div>}
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Removing…' : confirmLabel}
          </Button>
        </div>
      </div>
    </ModalShell>
  )
}

// ── Toolbar ──────────────────────────────────────────────────────────────────
// The row above a table: search, filters, count. One height, one gap.

export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx('toolbar', className)}>{children}</div>
}

/** Segmented filter group. Was `ctr-state-filter` in three modules and a loose
 *  row of pill buttons in two others. */
export function Segmented({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="segmented" role="group" aria-label={label}>{children}</div>
}

export function SegmentedItem({ active, count, onClick, title, children }: {
  active: boolean
  count?: number | string
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      className={clsx('segmented-item', active && 'segmented-item--active')}
      onClick={onClick}
      aria-pressed={active}
      title={title}
    >
      {children}
      {count !== undefined && count !== '' && <span className="segmented-count num">{count}</span>}
    </button>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
// The app had four tab strips built from plain buttons and a CSS `.active`
// class, so a screen reader announced them as an unlabelled row of buttons with
// no selected state and no way to arrow between them. These two carry the
// semantics; each strip keeps its own class, so this changes what the strip
// says, not how it looks.

/** `role="tablist"` with arrow-key traversal. Selection follows focus, which is
 *  the WAI-ARIA automatic-activation pattern and is correct here because every
 *  panel in this app is cheap to switch to. */
export function TabList({ label, className, onClick, children }: {
  label: string
  className?: string
  /** Escape hatch for a strip that sits inside another click surface. */
  onClick?: React.MouseEventHandler<HTMLDivElement>
  children: React.ReactNode
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    // Reading the tabs out of the DOM beats threading a ref array through every
    // call site, and no strip in this app is more than four tabs long.
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'))
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (i === -1) return
    e.preventDefault()
    const next =
      e.key === 'Home'  ? tabs[0] :
      e.key === 'End'   ? tabs[tabs.length - 1] :
      tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    next.focus()
    next.click()
  }
  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown} onClick={onClick}>
      {children}
    </div>
  )
}

/** One tab. `tabIndex` is roving: only the selected tab is in the Tab order, so
 *  Tab moves past the whole strip and the arrows move within it. */
export function Tab({ active, panelId, className, onClick, onKeyDown, title, children }: {
  active: boolean
  /** `id` of the element carrying `role="tabpanel"`, when there is one. */
  panelId?: string
  className?: string
  onClick: () => void
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      aria-controls={panelId}
      className={className}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={title}
    >
      {children}
    </button>
  )
}
