import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ClipboardList, Copy, Eye, EyeOff, Info, KeyRound, Maximize2, Power, RefreshCw, Settings, Trash2 } from 'lucide-react'
import { toggled } from '../../utils/toggled'
import { useAppStore } from '../../store/appStore'
import { useVisiblePoll } from '../../hooks/useVisiblePoll'
import { timeAgo } from '../../utils/format'
import { Button, ConfirmDestructive, EmptyState, ErrorBanner, SearchField, SheetHead, Switch, Toast, Toolbar, FilterSegments } from '../../components/ui'
import { ColumnsMenu, TableHead, useTableColumns, type TableColumn, useTableSort } from '../../components/TableColumns'
import { CloseProgramDialog, HolderAction } from '../holders/HolderBits'
import type { ProcessInfo } from '../holders/api'
import * as api from './api'
import type { ClipboardItem, ClipboardStatus, CurrentClipboard } from './api'
import { ClipboardItemDialog } from './ClipboardItemDialog'
import {
  CLEAR_HISTORY_COMMAND, countLabel, ENABLE_SERVICE_COMMAND, filterItems, historyCommand, historyState, KIND_LABEL, kindOf, looksSecret, mergeEntries, noticesFor,
  previewLine, problemFor, REMOVE_BLOCK_COMMAND, RESTART_SERVICE_COMMAND, sizeLabel, sortItems,
  type ClipboardAction, type ClipboardFilter, type ClipboardNotice, type ClipboardSortKey,
} from './rules'

const READ_MS = 2_000
const STATUS_MS = 10_000
const HIDDEN_TEXT = '••••••••••••'
const FILTERS: { key: ClipboardFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'text', label: 'Text' },
  { key: 'image', label: 'Images' },
  { key: 'link', label: 'Links' },
  { key: 'secret', label: 'Possible secrets' },
]

/** The defaults that start visible add up to about 760, which fits the table at a 1280px window. */
const COLUMNS: TableColumn<ClipboardSortKey>[] = [
  { key: 'copied',  label: 'Copied',  width: 100, sort: 'copied' },
  { key: 'type',    label: 'Type',    width: 120, sort: 'type', hideable: true },
  { key: 'content', label: 'Content', width: 300, sort: 'content' },
  { key: 'size',    label: 'Size',    width: 130, sort: 'size', hideable: true },
  { key: 'formats', label: 'Formats', width: 240, hideable: true },
  { key: 'actions', label: 'Actions', width: 150 },
]

const ACTIONS: Record<ClipboardAction, { label: string; icon: React.ElementType }> = {
  'turn-on': { label: 'Enable history', icon: Power },
  'try-again': { label: 'Retry', icon: Power },
  'remove-block': { label: 'Remove policy and enable…', icon: Power },
  'restart-service': { label: 'Restart service…', icon: RefreshCw },
  'enable-service': { label: 'Enable service…', icon: Power },
  'open-settings': { label: 'Open Windows Settings', icon: Settings },
}

type DialogName = 'turn-off' | 'clear' | 'remove-block' | 'restart-service' | 'enable-service'

function ContentPreview({ text, kind, visible, secret }: { text: string; kind: string; visible: boolean; secret: boolean }) {
  return (
    <span className="clipboard-preview">
      {visible
        ? (
          <>
            {kind === 'color' && <span className="clipboard-swatch" style={{ background: text.trim() }} aria-hidden="true" />}
            <span className="clipboard-preview-text" title={previewLine(text)}>{previewLine(text)}</span>
          </>
        )
        : <span className="clipboard-hidden" role="img" aria-label="Hidden">{HIDDEN_TEXT}</span>}
      {secret && <span className="clipboard-secret" title="Possible secret"><KeyRound size={13} role="img" aria-label="Possible secret" /></span>}
    </span>
  )
}

function ActionButton({ action, size, variant, disabled, onRun }: {
  action: ClipboardAction
  size?: 'sm'
  variant?: 'primary'
  disabled: boolean
  onRun: (action: ClipboardAction) => void
}) {
  const { label, icon: Icon } = ACTIONS[action]
  return <Button size={size} variant={variant} disabled={disabled} onClick={() => onRun(action)}><Icon size={12} /> {label}</Button>
}

function NoticeRow({ notice, canAct, onAction, onCloseProgram }: {
  notice: ClipboardNotice
  canAct: boolean
  onAction: (action: ClipboardAction) => void
  onCloseProgram: (program: ProcessInfo) => void
}) {
  const { action, program } = notice
  return (
    <li className="clipboard-notice">
      {notice.tone === 'warn' && <AlertTriangle size={14} aria-hidden="true" />}
      <p className="clipboard-notice-text"><strong>{notice.title}</strong> {notice.detail}</p>
      {action && <ActionButton action={action} size="sm" disabled={!canAct} onRun={onAction} />}
      {program && <HolderAction process={program} holds="using the clipboard" onClose={() => onCloseProgram(program)} />}
    </li>
  )
}

function CurrentRow({ current, disabled, onClear }: { current: CurrentClipboard; disabled: boolean; onClear: () => void }) {
  const [visible, setVisible] = useState(false)
  const empty = current.formats.length === 0
  const kind = kindOf(current)
  const owner = current.owner && current.owner.owner !== 'windows' ? current.owner.name : null
  const facts = [sizeLabel(current), owner && `from ${owner}`, current.kept_out_of_history && 'Excluded from history'].filter(Boolean).join(' · ')
  return (
    <section className="clipboard-now" aria-label="Current clipboard">
      <span className="clipboard-now-label">Current clipboard</span>
      {empty
        ? <span className="clipboard-muted">Nothing</span>
        : (
          <>
            <span className="clipboard-muted">{KIND_LABEL[kind]}</span>
            {current.text !== null && (
              <ContentPreview text={current.text} kind={kind} visible={visible} secret={looksSecret(current)} />
            )}
            {facts && <span className="clipboard-now-facts" title={[facts, current.owner?.path].filter(Boolean).join('\n')}>{facts}</span>}
            <span className="toolbar-spacer" />
            {current.text !== null && (
              <Button
                size="sm"
                icon
                variant="ghost"
                aria-label={`${visible ? 'Hide' : 'Show'} current clipboard content`}
                title={visible ? 'Hide' : 'Show'}
                onClick={() => setVisible(v => !v)}
              >
                {visible ? <EyeOff size={13} /> : <Eye size={13} />}
              </Button>
            )}
            <Button size="sm" disabled={disabled} onClick={onClear}>Clear clipboard</Button>
          </>
        )}
    </section>
  )
}

export default function ClipboardView() {
  const [status, setStatus] = useState<ClipboardStatus | null>(null)
  const [items, setItems] = useState<ClipboardItem[]>([])
  const [current, setCurrent] = useState<CurrentClipboard | null>(null)
  const [statusError, setStatusError] = useState<unknown>(null)
  const [readError, setReadError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [result, setResult] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ClipboardFilter>('all')
  const { sortKey, sortDir, handleSort } = useTableSort<ClipboardSortKey>('copied', 'desc', ['copied', 'size'])
  const [showAll, setShowAll] = useState(false)
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const [openItem, setOpenItem] = useState<ClipboardItem | null>(null)
  const [dialog, setDialog] = useState<DialogName | null>(null)
  const [closing, setClosing] = useState<ProcessInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const itemsRef = useRef<ClipboardItem[]>([])
  const sequence = useRef<number | null>(null)
  const historyOn = useRef<boolean | null>(null)
  const reading = useRef(false)
  const checkingStatus = useRef(false)

  const table = useTableColumns<ClipboardSortKey>({
    columns: COLUMNS,
    fill: 'content',
    select: s => s.clipboardColumns,
    save: prefs => useAppStore.getState().setClipboardColumns(prefs),
  })

  const loadStatus = useCallback(async () => {
    if (checkingStatus.current) return
    checkingStatus.current = true
    try {
      setStatus(await api.clipboardStatus())
      setStatusError(null)
    } catch (e) {
      setStatusError(e)
    } finally {
      checkingStatus.current = false
    }
  }, [])

  const readHistory = useCallback(async () => {
    if (reading.current) return
    reading.current = true
    try {
      const next = await api.clipboardRead(itemsRef.current.map(item => item.id), sequence.current)
      itemsRef.current = mergeEntries(next.entries, itemsRef.current)
      setItems(itemsRef.current)
      if (next.current) setCurrent(next.current)
      sequence.current = next.sequence
      // Someone changed the setting, perhaps in Windows Settings, and the rest of the status goes with it.
      if (historyOn.current !== null && historyOn.current !== next.history_on) loadStatus()
      historyOn.current = next.history_on
      setReadError(null)
    } catch (e) {
      setReadError(e)
    } finally {
      reading.current = false
    }
  }, [loadStatus])

  const refresh = useCallback(async () => {
    await Promise.all([loadStatus(), readHistory()])
  }, [loadStatus, readHistory])

  useEffect(() => { refresh() }, [refresh])
  useVisiblePoll(readHistory, READ_MS, !busy)
  useVisiblePoll(loadStatus, STATUS_MS, !busy)

  /** Clipboard text never goes to the terminal or the activity log, only what was done. */
  const act = async ({ label, command, done, work }: {
    label: string
    command?: string
    done: string
    work: () => Promise<void>
  }) => {
    const { addTerminalLine, addActivity } = useAppStore.getState()
    setBusy(true)
    setActionError(null)
    setResult(null)
    if (command) addTerminalLine(`$ ${command}`, 'cmd')
    try {
      await work()
      if (command) addTerminalLine(`  ✓ ${done}`, 'success')
      addActivity({ module: 'system', action: label, outcome: 'success', detail: done })
      setResult(done)
    } catch (e) {
      if (command) addTerminalLine(`  ✗ ${String(e)}`, 'error')
      addActivity({ module: 'system', action: label, outcome: 'failure', detail: String(e) })
      setActionError(e)
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const turnOn = () => act({
    label: 'Turn on clipboard history',
    command: historyCommand(true),
    done: 'Clipboard history enabled',
    work: () => api.clipboardSetHistory(true),
  })

  const turnOff = async (clearFirst: boolean) => {
    await act({
      label: 'Turn off clipboard history',
      command: historyCommand(false),
      done: clearFirst ? 'History cleared and disabled' : 'Clipboard history disabled',
      work: async () => {
        if (clearFirst) await api.clipboardClearHistory()
        await api.clipboardSetHistory(false)
      },
    })
    setDialog(null)
  }

  const clearHistory = async () => {
    await act({
      label: 'Clear clipboard history',
      command: CLEAR_HISTORY_COMMAND,
      done: 'Clipboard history cleared',
      work: api.clipboardClearHistory,
    })
    setDialog(null)
  }

  const removeBlock = async () => {
    await act({
      label: 'Remove clipboard history block',
      command: REMOVE_BLOCK_COMMAND,
      done: 'Policy removed and history enabled',
      work: api.clipboardRemoveBlock,
    })
    setDialog(null)
  }

  const restartService = async () => {
    await act({
      label: 'Restart clipboard service',
      command: RESTART_SERVICE_COMMAND,
      done: 'Clipboard service restarted',
      work: api.clipboardRestartService,
    })
    setDialog(null)
  }

  const enableService = async () => {
    await act({
      label: 'Turn on clipboard service',
      command: ENABLE_SERVICE_COMMAND,
      done: 'Service enabled. Sign out and back in to start it.',
      work: api.clipboardEnableService,
    })
    setDialog(null)
  }

  const runAction = (action: ClipboardAction) => {
    setActionError(null)
    if (action === 'turn-on' || action === 'try-again') turnOn()
    else if (action === 'open-settings') api.clipboardOpenSettings().catch(setActionError)
    else setDialog(action)
  }

  const copyItem = (item: ClipboardItem) => act({
    label: 'Copy from clipboard history',
    done: 'Copied',
    work: () => api.clipboardCopyItem(item.id),
  })

  const copyText = (text: string, done: string) => act({
    label: 'Copy from clipboard history',
    done,
    work: () => navigator.clipboard.writeText(text),
  })

  const deleteItem = async (item: ClipboardItem) => {
    setOpenItem(null)
    await act({ label: 'Delete from clipboard history', done: 'Item deleted', work: () => api.clipboardDeleteItem(item.id) })
  }

  const toggleShown = (id: string) => setShown(previous => toggled(previous, id))

  // Anything that looks like a secret stays hidden under "Show text", in case the screen is being shared.
  const isVisible = (item: ClipboardItem) => shown.has(item.id) || (showAll && !looksSecret(item))

  const rows = useMemo(() => sortItems(filterItems(items, query, filter), sortKey, sortDir), [items, query, filter, sortKey, sortDir])
  const notices = useMemo(() => (status ? noticesFor(status) : []), [status])
  const warnings = notices.filter(notice => notice.tone === 'warn')
  const notes = notices.filter(notice => notice.tone === 'info')
  const state = status && historyState(status)
  const problem = status && problemFor(status)

  const cell = (column: string, item: ClipboardItem) => {
    const kind = kindOf(item)
    const when = timeAgo(item.copied_at)
    switch (column) {
      case 'copied':
        return <td className="img-td img-age num" title={new Date(item.copied_at).toLocaleString()}>{when}</td>
      case 'type':
        return <td className="img-td img-age">{KIND_LABEL[kind]}</td>
      case 'content':
        return (
          <td className="img-td clipboard-content">
            {item.text === null
              ? <span className="clipboard-muted">{item.has_image ? 'Open to view image' : 'No plain text'}</span>
              : <ContentPreview text={item.text} kind={kind} visible={isVisible(item)} secret={looksSecret(item)} />}
          </td>
        )
      case 'size':
        return <td className="img-td img-age num">{sizeLabel(item) ?? <span className="pkg-dash">-</span>}</td>
      case 'formats':
        return <td className="img-td img-age holder-code" title={item.formats.join(', ')}>{item.formats.join(', ')}</td>
      default:
        return (
          <td className="img-td holder-actions">
            {item.text !== null && (
              <Button
                size="sm"
                icon
                variant="ghost"
                aria-label={`${isVisible(item) ? 'Hide' : 'Show'} the item copied ${when}`}
                title={isVisible(item) ? 'Hide' : 'Show'}
                onClick={() => toggleShown(item.id)}
              >
                {isVisible(item) ? <EyeOff size={13} /> : <Eye size={13} />}
              </Button>
            )}
            <Button size="sm" icon variant="ghost" aria-label={`Open the item copied ${when}`} title="Open" onClick={() => setOpenItem(item)}>
              <Maximize2 size={13} />
            </Button>
            <Button size="sm" icon variant="ghost" disabled={busy} aria-label={`Copy the item copied ${when}`} title="Copy" onClick={() => copyItem(item)}>
              <Copy size={13} />
            </Button>
            <Button size="sm" icon variant="ghost" disabled={busy} aria-label={`Delete the item copied ${when}`} title="Delete" onClick={() => deleteItem(item)}>
              <Trash2 size={13} />
            </Button>
          </td>
        )
    }
  }

  return (
    <div className="view-container">
      <SheetHead
        title="Clipboard"
        status={status && (
          <Switch
            label="History"
            on={state === 'on'}
            disabled={busy || (state !== 'on' && state !== 'off')}
            title={state === 'on' || state === 'off' ? undefined : problem?.title}
            onChange={on => (on ? turnOn() : setDialog('turn-off'))}
          />
        )}
        subtitle="Windows clipboard history retains the 25 most recent items until restart. Files and items marked as excluded, such as passwords, are not stored."
        actions={
          <>
            {notes.length > 0 && (
              <>
                <Button className="clipboard-notes-button" popoverTarget="clipboard-notes">
                  <Info size={13} /> {countLabel(notes.length, 'note')}
                </Button>
                <ul id="clipboard-notes" className="menu-panel clipboard-notes" popover="auto" aria-label="Notes">
                  {notes.map(notice => (
                    <NoticeRow
                      key={notice.key}
                      notice={notice}
                      canAct={!busy}
                      onAction={runAction}
                      onCloseProgram={program => { setActionError(null); setClosing(program) }}
                    />
                  ))}
                </ul>
              </>
            )}
            {state === 'on' && (
              <>
                <ColumnsMenu table={table} />
                <Button variant="danger-outline" disabled={busy || items.length === 0} onClick={() => setDialog('clear')}>
                  <Trash2 size={12} /> Clear history…
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="page-fill">
        <div className="img-tab clipboard-tab">
          {statusError != null && <ErrorBanner className="error-banner--flush" title="Could not check clipboard settings" error={statusError} />}
          {readError != null && <ErrorBanner className="error-banner--flush" title="Could not read clipboard history" error={readError} />}
          {actionError != null && <ErrorBanner className="error-banner--flush" title="That did not work" error={actionError} />}

          {warnings.length > 0 && (
            <ul className="clipboard-notices">
              {warnings.map(notice => (
                <NoticeRow
                  key={notice.key}
                  notice={notice}
                  canAct={!busy}
                  onAction={runAction}
                  onCloseProgram={program => { setActionError(null); setClosing(program) }}
                />
              ))}
            </ul>
          )}

          {state === null && statusError == null && <div className="img-loading">Reading clipboard settings…</div>}

          {problem && (
            <EmptyState
              icon={ClipboardList}
              title={problem.title}
              description={problem.detail}
              actions={problem.actions.length > 0
                ? problem.actions.map((action, i) => (
                  <ActionButton
                    key={action}
                    action={action}
                    variant={i === 0 && action !== 'open-settings' ? 'primary' : undefined}
                    disabled={busy}
                    onRun={runAction}
                  />
                ))
                : undefined}
            />
          )}

          {state === 'on' && (
            <>
              <Toolbar className="clipboard-toolbar">
                <SearchField value={query} onChange={setQuery} placeholder="Search clipboard" label="Search saved text and types" />
                <FilterSegments label="Show items" options={FILTERS} value={filter} onChange={setFilter} count={key => filterItems(items, '', key).length} />
                <span className="toolbar-spacer" />
                <Button
                  title="Possible secrets stay hidden until shown individually."
                  onClick={() => setShowAll(on => !on)}
                >
                  {showAll ? <EyeOff size={12} /> : <Eye size={12} />} {showAll ? 'Hide text' : 'Show text'}
                </Button>
              </Toolbar>

              {rows.length === 0 && (
                <EmptyState
                  title={items.length === 0 ? 'History is empty' : 'No items match'}
                  description={items.length === 0
                    ? 'Copied text and images appear here.'
                    : 'Adjust the search or filters.'}
                  actions={items.length > 0
                    ? <Button onClick={() => { setQuery(''); setFilter('all') }}>Clear filters</Button>
                    : undefined}
                />
              )}

              {rows.length > 0 && (
                <div className="img-table-wrap">
                  <table className="img-table pkg-table" style={{ width: table.tableWidth }}>
                    <TableHead table={table} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} actionsClass="holder-actions" />
                    <tbody>
                      {rows.map(item => (
                        <tr key={item.id} className="img-row">
                          {table.visible.map(c => <Fragment key={c.key}>{cell(c.key, item)}</Fragment>)}
                          {table.fillFixed && <td className="img-td" aria-hidden="true" />}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {current && (
            <CurrentRow
              current={current}
              disabled={busy}
              onClear={() => act({ label: 'Clear clipboard', done: 'Clipboard cleared', work: api.clipboardClearCurrent })}
            />
          )}

          <Toast message={result} onDone={() => setResult(null)} />
        </div>
      </div>

      {openItem && (
        <ClipboardItemDialog
          item={openItem}
          onCopy={() => { setOpenItem(null); copyItem(openItem) }}
          onCopyText={(text, done) => { setOpenItem(null); copyText(text, done) }}
          onDelete={() => deleteItem(openItem)}
          onClose={() => setOpenItem(null)}
        />
      )}

      {dialog === 'turn-off' && (
        <ConfirmDestructive
          title="Disable clipboard history?"
          consequence="Windows stops recording clipboard items and clears the current clipboard. Saved items are retained and return if history is re-enabled before restart. To delete them now, use Clear and disable."
          command={historyCommand(false)}
          confirmLabel="Disable"
          busyLabel="Disabling…"
          busy={busy}
          onConfirm={() => turnOff(false)}
          onCancel={() => setDialog(null)}
          escape={<Button disabled={busy} onClick={() => turnOff(true)}>Clear and disable</Button>}
        />
      )}

      {dialog === 'clear' && (
        <ConfirmDestructive
          title="Clear clipboard history?"
          consequence={`Permanently deletes ${items.length === 1 ? 'the saved item' : `all ${items.length} saved items`} and clears the current clipboard. Other clipboard programs keep their own copies.`}
          command={CLEAR_HISTORY_COMMAND}
          confirmLabel="Clear history"
          busyLabel="Clearing…"
          busy={busy}
          onConfirm={clearHistory}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog === 'remove-block' && (
        <ConfirmDestructive
          title="Remove the clipboard history policy?"
          consequence="AllowClipboardHistory stops Windows from recording clipboard items. It may have been set by a cleanup tool or an administrator. Windows prompts for administrator approval, then history is enabled. On a managed device, check with the administrator first, because the policy may be reapplied."
          command={REMOVE_BLOCK_COMMAND}
          confirmLabel="Remove policy and enable"
          busyLabel="Waiting for approval…"
          busy={busy}
          onConfirm={removeBlock}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog === 'restart-service' && (
        <ConfirmDestructive
          title="Restart the clipboard service?"
          consequence="Windows prompts for administrator approval, then restarts the service. Saved items are lost. The current clipboard is kept."
          command={RESTART_SERVICE_COMMAND}
          confirmLabel="Restart service"
          busyLabel="Waiting for approval…"
          busy={busy}
          onConfirm={restartService}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog === 'enable-service' && (
        <ConfirmDestructive
          title="Enable the clipboard service?"
          consequence="Windows prompts for administrator approval, then sets the service startup type to Automatic. It starts at next sign-in, so sign out and back in afterward."
          command={ENABLE_SERVICE_COMMAND}
          confirmLabel="Enable service"
          busyLabel="Waiting for approval…"
          busy={busy}
          onConfirm={enableService}
          onCancel={() => setDialog(null)}
        />
      )}

      {closing && (
        <CloseProgramDialog
          process={closing}
          holds="Using the clipboard"
          onClosed={() => { setClosing(null); refresh() }}
          onFailed={e => { setClosing(null); setActionError(e) }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  )
}
