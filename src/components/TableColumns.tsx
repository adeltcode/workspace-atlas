import { useEffect, useRef, useState } from 'react'
import { Columns3, Check, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react'
import clsx from 'clsx'
import { Button } from './ui'
import { useAppStore, type AppState } from '../store/appStore'
import type { SortDir } from '../utils/sortRows'

function SortHeader<K extends string>({ label, col, sortKey, sortDir, onSort, children }: {
  label: string; col: K; sortKey: K; sortDir: 'asc' | 'desc'
  onSort: (k: K) => void
  /** Extra header content, such as a column resize handle. */
  children?: React.ReactNode
}) {
  const active = col === sortKey
  return (
    <th
      className={clsx('img-th img-th-sort sortable', active && 'active')}
      onClick={() => onSort(col)}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {/* The header cell cannot take focus, so the control inside it does. */}
      <div
        className="th-sort-inner"
        role="button"
        tabIndex={0}
        aria-label={`Sort by ${label}`}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(col) } }}
      >
        {label}
        {active
          ? sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
          : <ChevronDown size={12} className="sort-idle" />}
      </div>
      {children}
    </th>
  )
}

const MIN_WIDTH = 60
const MAX_WIDTH = 900

export interface TableColumn<K extends string = string> {
  key: string
  label: string
  /** Default width in px. */
  width: number
  sort?: K
  hideable?: boolean
}

export interface ColumnPrefs {
  widths: Record<string, number>
  hidden: string[]
}

/** Clicking the sorted column flips it, and a new column starts ascending unless it is in `descFirst`. */
export function useTableSort<K extends string>(initialKey: K, initialDir: SortDir, descFirst: readonly K[] = []) {
  const [sortKey, setSortKey] = useState<K>(initialKey)
  const [sortDir, setSortDir] = useState<SortDir>(initialDir)
  const handleSort = (key: K) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(descFirst.includes(key) ? 'desc' : 'asc') }
  }
  return { sortKey, sortDir, handleSort }
}

/** Saved widths and hidden columns for a table. `fill` is the column that takes the spare width until
 *  it is resized, after which a filler column does. */
export function useTableColumns<K extends string>({ columns, fill, select, save }: {
  columns: TableColumn<K>[]
  fill: string
  /** Where this table's choices live in the store. */
  select: (state: AppState) => ColumnPrefs
  save: (prefs: ColumnPrefs) => void
}) {
  const prefs = useAppStore(select)
  // Read at call time: two clicks can land before a re-render.
  const read = () => select(useAppStore.getState())
  // Widths while a drag is in progress, so the saved settings are written once when it ends.
  const [dragWidths, setDragWidths] = useState<Record<string, number> | null>(null)
  const widths = dragWidths ?? prefs.widths
  const visible = columns.filter(c => !prefs.hidden.includes(c.key))
  const widthOf = (c: TableColumn<K>) => widths[c.key] ?? c.width

  return {
    columns,
    fill,
    hidden: prefs.hidden,
    visible,
    widthOf,
    shows: (key: string) => visible.some(c => c.key === key),
    fillFixed: widths[fill] !== undefined,
    tableWidth: visible.reduce((sum, c) => sum + widthOf(c), 0),
    resize: (key: string, width: number | null, done: boolean) => {
      const saved = read()
      const next = { ...saved.widths }
      if (width === null) delete next[key]
      else next[key] = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
      if (done) {
        save({ ...saved, widths: next })
        setDragWidths(null)
      } else {
        setDragWidths(next)
      }
    },
    toggle: (key: string) => {
      const saved = read()
      save({
        ...saved,
        hidden: saved.hidden.includes(key) ? saved.hidden.filter(k => k !== key) : [...saved.hidden, key],
      })
    },
    reset: () => save(select(useAppStore.getInitialState())),
  }
}

/** The `<colgroup>` and `<thead>` of a table with resizable, sortable columns. Put it inside
 *  `<table className="img-table pkg-table" style={{ width: table.tableWidth }}>`. */
export function TableHead<K extends string>({ table, sortKey, sortDir, onSort, actionsClass, select }: {
  table: ReturnType<typeof useTableColumns<K>>
  sortKey: K
  sortDir: 'asc' | 'desc'
  onSort: (key: K) => void
  /** Header class for the `actions` column. */
  actionsClass: string
  /** The header checkbox of a column keyed `select`, which cannot be resized. */
  select?: React.ReactNode
}) {
  return (
    <>
      <colgroup>
        {table.visible.map(c => (
          <col key={c.key} style={c.key === table.fill && !table.fillFixed ? undefined : { width: table.widthOf(c) }} />
        ))}
        {table.fillFixed && <col />}
      </colgroup>
      <thead>
        <tr>
          {table.visible.map(c => {
            if (c.key === 'select') return <th key={c.key} className="img-th img-th-check">{select}</th>
            const handle = (
              <ResizeHandle
                label={c.label}
                width={table.widthOf(c)}
                onResize={(width, done) => table.resize(c.key, width, done)}
              />
            )
            return c.sort ? (
              <SortHeader key={c.key} label={c.label} col={c.sort} sortKey={sortKey} sortDir={sortDir} onSort={onSort}>
                {handle}
              </SortHeader>
            ) : (
              <th key={c.key} className={clsx('img-th', c.key === 'actions' && actionsClass)}>
                {c.label}{handle}
              </th>
            )
          })}
          {table.fillFixed && <th className="img-th" aria-hidden="true" />}
        </tr>
      </thead>
    </>
  )
}

/** The right edge of a header cell. Drag it, or focus it and press the arrow keys, to resize the
 *  column. Double-click restores the default width. */
function ResizeHandle({ label, width, onResize }: {
  label: string
  width: number
  /** `null` resets to the default. `done` is false while a drag is moving. */
  onResize: (width: number | null, done: boolean) => void
}) {
  const cellWidth = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? width

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const x0 = e.clientX
    const w0 = cellWidth(el)
    let last = w0
    const move = (ev: PointerEvent) => { last = w0 + ev.clientX - x0; onResize(last, false) }
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('lostpointercapture', end)
      onResize(last, true)
    }
    el.setPointerCapture(e.pointerId)
    el.addEventListener('pointermove', move)
    el.addEventListener('lostpointercapture', end)
  }

  return (
    <div
      className="col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      // The header cell sorts on click, and a resize is not a sort.
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => { e.stopPropagation(); onResize(null, true) }}
      onKeyDown={e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        onResize(cellWidth(e.currentTarget) + (e.key === 'ArrowRight' ? 16 : -16), true)
      }}
    />
  )
}

export function ColumnsMenu({ table }: {
  table: { columns: TableColumn<string>[]; hidden: string[]; toggle: (key: string) => void; reset: () => void }
}) {
  return (
    <CheckMenu
      label={<><Columns3 size={13} /> Columns</>}
      menuLabel="Columns"
      items={table.columns.filter(c => c.hideable).map(c => ({ key: c.key, label: c.label, checked: !table.hidden.includes(c.key) }))}
      onToggle={table.toggle}
      resetLabel="Reset columns"
      onReset={table.reset}
    />
  )
}

/** A button that opens a list of checkboxes, so a long list takes one row of the page. */
export function CheckMenu({ label, active, menuLabel, items, onToggle, resetLabel, onReset, alignLeft }: {
  label: React.ReactNode
  /** Marks the button while the choices are narrowing what the page shows. */
  active?: boolean
  menuLabel: string
  items: { key: string; label: string; checked: boolean; count?: number; title?: string }[]
  onToggle: (key: string) => void
  resetLabel: string
  onReset: () => void
  /** For a button near the left of the page, where a panel opening leftward would be cut off. */
  alignLeft?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <Button className={clsx(active && 'btn--on')} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        {label}
      </Button>
      {open && (
        <div className={clsx('menu-panel', alignLeft && 'menu-panel--left')} role="menu" aria-label={menuLabel}>
          {items.map(item => (
            <button key={item.key} className="menu-item" role="menuitemcheckbox" aria-checked={item.checked} title={item.title} onClick={() => onToggle(item.key)}>
              {item.checked ? <Check size={14} /> : <span className="menu-check" />}
              {item.label}
              {item.count !== undefined && <span className="menu-count num">{item.count}</span>}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button className="menu-item" role="menuitem" onClick={() => { onReset(); setOpen(false) }}>
            <RotateCcw size={14} /> {resetLabel}
          </button>
        </div>
      )}
    </div>
  )
}
