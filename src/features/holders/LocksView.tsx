import { useState } from 'react'
import { File, FolderOpen, Search } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { Button, EmptyState, ErrorBanner, SheetHead, Tag, Toolbar } from '../../components/ui'
import { pickDirectory } from '../wsl/api'
import * as api from './api'
import type { LockHolder, LockReport } from './api'
import { HOLD_REASON } from './rules'
import { CloseProgramDialog, HolderAction, ProgramCell } from './HolderBits'

export default function LocksView() {
  const [path, setPath] = useState('')
  const [report, setReport] = useState<LockReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [closing, setClosing] = useState<LockHolder | null>(null)
  const [result, setResult] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  const scan = async (target: string) => {
    setScanning(true)
    setError(null)
    try {
      const next = await api.locksFind(target)
      setReport(next)
      return next
    } catch (e) {
      setReport(null)
      setError(e)
      return null
    } finally {
      setScanning(false)
    }
  }

  const pick = async (choose: () => Promise<string | null>) => {
    const picked = await choose()
    if (picked) {
      setPath(picked)
      setResult(null)
      scan(picked)
    }
  }

  const afterClose = async (closed: LockHolder) => {
    setClosing(null)
    const next = report && await scan(report.path)
    const stillHeld = next?.holders.some(h => h.process.pid === closed.process.pid)
    setResult(stillHeld
      ? { tone: 'warn', text: `${closed.process.name} is still holding this` }
      : { tone: 'ok', text: `Closed ${closed.process.name}` })
  }

  return (
    <div className="view-container">
      <div className="page-head">
        <SheetHead
          crumbs={[
            { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
            { label: 'File locks' },
          ]}
          title="File locks"
          subtitle="See which programs hold a file or folder when Windows will not let you delete or move it."
        />
      </div>

      <div className="page-fill">
        <div className="img-tab">
          <form onSubmit={e => { e.preventDefault(); setResult(null); scan(path) }}>
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
                {scanning ? 'Checking…' : 'Find holders'}
              </Button>
              <Button type="button" disabled={scanning} onClick={() => pick(api.pickAnyFile)}><File size={12} /> File</Button>
              <Button type="button" disabled={scanning} onClick={() => pick(pickDirectory)}><FolderOpen size={12} /> Folder</Button>
              <span role="status">{result && <Tag tone={result.tone}>{result.text}</Tag>}</span>
            </Toolbar>
          </form>

          {error != null && <ErrorBanner className="error-banner--flush" error={error} />}

          {!report && !error && !scanning && (
            <EmptyState
              icon={FolderOpen}
              title="Check a file or folder"
              description="Paste a path or browse to one. A folder includes everything inside it, so you can check a project before deleting it."
            />
          )}

          {report && (
            <>
              <p className="holder-summary">
                Checked {report.path}{report.is_folder && ' and everything inside it'}.
                {report.is_folder && ' A program running as administrator only shows up when you check the exact file it holds.'}
              </p>
              {!report.complete && (
                <ErrorBanner className="error-banner--flush" title="This check is not complete">
                  Windows took too long to answer, so a holder could be missing from this list.
                </ErrorBanner>
              )}

              {report.holders.length === 0 ? (
                <EmptyState
                  title="Windows reports no holders"
                  description="If a delete still fails, the program may have let go already, so try again. Windows may not report every holder."
                />
              ) : (
                <div className="img-table-wrap">
                  <table className="img-table">
                    <thead>
                      <tr>
                        <th className="img-th">Program</th>
                        <th className="img-th">PID</th>
                        <th className="img-th">Why it holds this</th>
                        <th className="img-th holder-actions">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.holders.map(h => (
                        <tr key={h.process.pid} className="img-row">
                          <td className="img-td"><ProgramCell process={h.process} /></td>
                          <td className="img-td img-age num">{h.process.pid}</td>
                          <td className="img-td img-age">
                            {HOLD_REASON[h.reason]}
                            {h.example && <span className="holder-path" title={h.example}>{h.example}</span>}
                          </td>
                          <td className="img-td holder-actions">
                            <HolderAction
                              process={h.process}
                              holds={`holding ${report.path}`}
                              onClose={() => { setError(null); setResult(null); setClosing(h) }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {closing && report && (
        <CloseProgramDialog
          process={closing.process}
          holds={`Holds ${report.path}`}
          onClosed={() => afterClose(closing)}
          onFailed={e => { setClosing(null); setError(e) }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  )
}
