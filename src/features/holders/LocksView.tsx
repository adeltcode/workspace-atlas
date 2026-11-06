import { useEffect, useState } from 'react'
import { File, FolderOpen, Search } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { Button, EmptyState, ErrorBanner, SheetHead, Tag, Toolbar } from '../../components/ui'
import { FileDropPrompt, FileDropZone } from '../../components/FileDropZone'
import { pickDirectory } from '../wsl/api'
import * as api from './api'
import type { LockHolder, LockReport } from './api'
import { checkedSummary, fixDone, HOLD_REASON, itemName } from './rules'
import { CloseProgramDialog, HolderAction, ProgramCell } from './HolderBits'

export default function LocksView() {
  const [path, setPath] = useState('')
  const [reports, setReports] = useState<LockReport[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [closing, setClosing] = useState<{ holder: LockHolder; path: string } | null>(null)
  const [result, setResult] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  const scan = async (targets: string[]) => {
    setScanning(true)
    setError(null)
    try {
      const next = await api.locksFind(targets)
      setReports(next)
      return next
    } catch (e) {
      setReports(null)
      setError(e)
      return null
    } finally {
      setScanning(false)
    }
  }

  const check = (targets: string[]) => {
    // The box holds one path, so several items are named in the results instead.
    setPath(targets.length === 1 ? targets[0] : '')
    setResult(null)
    scan(targets)
  }

  const locksJump = useAppStore(s => s.locksJump)
  useEffect(() => {
    if (locksJump === null) return
    useAppStore.getState().clearLocksJump()
    check([locksJump])
  }, [locksJump]) // eslint-disable-line

  // Locks change while this page is hidden, so coming back checks the same items again.
  useEffect(() => {
    if (reports) scan(reports.map(r => r.path))
  }, []) // eslint-disable-line

  const pick = async (choose: () => Promise<string | null>) => {
    const picked = await choose()
    if (picked) check([picked])
  }

  const afterClose = async (closed: LockHolder) => {
    setClosing(null)
    const next = reports && await scan(reports.map(r => r.path))
    const stillHeld = next?.some(r => r.holders.some(h => h.process.pid === closed.process.pid))
    setResult(stillHeld
      ? { tone: 'warn', text: `${closed.process.name} still holds a lock` }
      : { tone: 'ok', text: fixDone(closed.process) })
  }

  return (
    <div className="view-container">
      <SheetHead
        title="File locks"
        subtitle="Identify processes holding a lock on a file or folder."
      />

      <div className="page-fill">
        <FileDropZone
          className="img-tab"
          label="Drop to check for locks"
          disabled={scanning || closing !== null}
          onDrop={check}
        >
          <form onSubmit={e => { e.preventDefault(); setResult(null); scan([path]) }}>
            <Toolbar>
              <div className="field holder-target">
                <Search size={13} className="field-icon" aria-hidden="true" />
                <input
                  className="field-input"
                  type="text"
                  aria-label="File or folder to check"
                  placeholder="File or folder path"
                  spellCheck={false}
                  value={path}
                  onChange={e => setPath(e.target.value)}
                />
              </div>
              <Button type="submit" variant="primary" disabled={scanning || !path.trim()}>
                {scanning ? 'Checking…' : 'Check'}
              </Button>
              <Button type="button" disabled={scanning} onClick={() => pick(api.pickAnyFile)}><File size={12} /> Choose file…</Button>
              <Button type="button" disabled={scanning} onClick={() => pick(pickDirectory)}><FolderOpen size={12} /> Choose folder…</Button>
              <span role="status">{result && <Tag tone={result.tone}>{result.text}</Tag>}</span>
            </Toolbar>
          </form>

          {error != null && <ErrorBanner className="error-banner--flush" error={error} />}

          {!reports && !error && !scanning && (
            <FileDropPrompt
              title="Drop files or folders here"
              description="Or enter a path. Folders are checked recursively."
            />
          )}

          {reports && (
            <>
              <p className="holder-summary">{checkedSummary(reports)}</p>
              {reports.some(r => !r.complete) && (
                <ErrorBanner className="error-banner--flush" title="Incomplete results">
                  The check timed out, so some processes may be missing.
                </ErrorBanner>
              )}

              {reports.every(r => r.holders.length === 0) ? (
                <EmptyState
                  title="No locks found"
                  description="Windows reported no process holding this item. Some processes may not be reported."
                />
              ) : (
                <div className="img-table-wrap">
                  <table className="img-table">
                    <thead>
                      <tr>
                        {reports.length > 1 && <th className="img-th">Item</th>}
                        <th className="img-th">Program</th>
                        <th className="img-th">PID</th>
                        <th className="img-th">Reason</th>
                        <th className="img-th holder-actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reports.map(report => {
                        const item = reports.length > 1 && (
                          <td className="img-td">
                            <span className="img-repo holder-item" title={report.path}>{itemName(report.path)}</span>
                          </td>
                        )
                        if (report.holders.length === 0) {
                          return (
                            <tr key={report.path} className="img-row">
                              {item}
                              <td className="img-td img-age" colSpan={4}>Windows reports no programs using this</td>
                            </tr>
                          )
                        }
                        return report.holders.map(h => (
                          <tr key={`${report.path}|${h.process.pid}`} className="img-row">
                            {item}
                            <td className="img-td"><ProgramCell process={h.process} /></td>
                            <td className="img-td img-age num">{h.process.pid}</td>
                            <td className="img-td img-age">
                              {HOLD_REASON[h.reason]}
                              {h.example && <span className="holder-path" title={h.example}>{h.example}</span>}
                            </td>
                            <td className="img-td holder-actions">
                              <HolderAction
                                process={h.process}
                                holds={`using ${report.path}`}
                                onClose={() => { setError(null); setResult(null); setClosing({ holder: h, path: report.path }) }}
                              />
                            </td>
                          </tr>
                        ))
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </FileDropZone>
      </div>

      {closing && (
        <CloseProgramDialog
          process={closing.holder.process}
          holds={`Using ${closing.path}`}
          onClosed={() => afterClose(closing.holder)}
          onFailed={e => { setClosing(null); setError(e) }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  )
}
