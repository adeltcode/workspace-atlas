import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Timer, Gauge, Play, ShieldAlert, Lightbulb } from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import type { WslDistro, ShellProfile } from '../types'

/** Format a duration given in seconds as ms or s. */
function fmtSecs(s: number): string {
  const ms = s * 1000
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

export default function WslPerformanceTab({ distros }: { distros: WslDistro[] }) {
  const selected = useAppStore(s => s.wslSelectedDistro) ?? ''
  const addActivity      = useAppStore(s => s.addActivity)
  const benchmarks       = useAppStore(s => s.wslBenchmarks)
  const addWslBenchmark  = useAppStore(s => s.addWslBenchmark)

  const [confirmBench, setConfirmBench] = useState(false)
  const [benching, setBenching] = useState(false)
  const [benchErr, setBenchErr] = useState<string | null>(null)

  const [profiling, setProfiling] = useState(false)
  const [profile, setProfile]     = useState<ShellProfile | null>(null)
  const [profileErr, setProfileErr] = useState<string | null>(null)

  // Reset transient results when the distro changes (history is persisted, so it
  // is read fresh from the store).
  useEffect(() => { setProfile(null); setProfileErr(null); setBenchErr(null) }, [selected])

  const history = benchmarks[selected] ?? []

  const runBenchmark = async () => {
    setConfirmBench(false)
    setBenching(true)
    setBenchErr(null)
    try {
      const r = await api.wslBenchmarkBoot(selected)
      addWslBenchmark(selected, r.boot_ms)
      addActivity({ module: 'wsl', action: `Boot benchmark ${selected}`, outcome: 'success', detail: fmtMs(r.boot_ms) })
    } catch (e) {
      setBenchErr(String(e))
      addActivity({ module: 'wsl', action: `Boot benchmark ${selected}`, outcome: 'failure', detail: String(e) })
    } finally {
      setBenching(false)
    }
  }

  const runProfile = async () => {
    setProfiling(true)
    setProfileErr(null)
    try {
      setProfile(await api.wslProfileShell(selected))
    } catch (e) {
      setProfileErr(String(e))
    } finally {
      setProfiling(false)
    }
  }

  if (distros.length === 0) {
    return <p className="empty-state" style={{ marginTop: 24 }}>No distributions found.</p>
  }

  const maxBoot = Math.max(1, ...history.map(h => h.boot_ms))
  const maxFile = profile ? Math.max(0.001, ...profile.files.map(f => f.seconds)) : 0
  const isBash  = !profile || profile.shell.endsWith('bash')

  return (
    <div className="wsl-perf">
      <div className="wsl-perf-cols">
        {/* ── Cold-boot benchmark ──────────────────────────────────────── */}
        <div className="overview-section" style={{ margin: 0 }}>
          <div className="overview-section-head overview-section-head--static">
            <Timer size={14} className="wsl-perf-head-icon" />
            <span className="section-label" style={{ margin: 0 }}>Cold-boot benchmark</span>
            <button
              className="btn-secondary"
              style={{ marginLeft: 'auto' }}
              onClick={() => setConfirmBench(true)}
              disabled={benching}
            >
              <Play size={12} /> {benching ? 'Booting…' : 'Run'}
            </button>
          </div>

          {benchErr && <p className="wsl-opt-error">{benchErr}</p>}

          {history.length === 0 ? (
            <p className="overview-empty-row">
              No runs yet. A benchmark terminates the distro and times its next cold start.
            </p>
          ) : (
            <>
              <div className="wsl-perf-latest">
                <span className="wsl-perf-latest-val">{fmtMs(history[0].boot_ms)}</span>
                <span className="wsl-perf-latest-label">last cold boot</span>
              </div>
              <div className="wsl-perf-history">
                {[...history].reverse().map((h, i) => (
                  <div key={h.ts} className="wsl-perf-bar-wrap" title={`${fmtMs(h.boot_ms)} · ${new Date(h.ts).toLocaleString()}`}>
                    <div
                      className={clsx('wsl-perf-bar', i === history.length - 1 && 'wsl-perf-bar--latest')}
                      style={{ height: `${(h.boot_ms / maxBoot) * 100}%` }}
                    />
                  </div>
                ))}
              </div>
              <p className="wsl-perf-history-note">{history.length} run{history.length !== 1 ? 's' : ''} tracked · oldest → newest</p>
            </>
          )}
        </div>

        {/* ── Shell startup profiler ───────────────────────────────────── */}
        <div className="overview-section" style={{ margin: 0 }}>
          <div className="overview-section-head overview-section-head--static">
            <Gauge size={14} className="wsl-perf-head-icon" />
            <span className="section-label" style={{ margin: 0 }}>Shell startup profiler</span>
            <button
              className="btn-secondary"
              style={{ marginLeft: 'auto' }}
              onClick={runProfile}
              disabled={profiling}
            >
              <Play size={12} /> {profiling ? 'Profiling…' : 'Profile'}
            </button>
          </div>

          {profileErr && <p className="wsl-opt-error">{profileErr}</p>}

          {!profile && !profileErr && (
            <p className="overview-empty-row">
              Measures interactive shell startup and isolates rc-file overhead. Reads inside the distro
              (starts it if stopped).
            </p>
          )}

          {profile && (
            <>
              <div className="wsl-perf-metrics">
                <div className="wsl-perf-metric">
                  <span className="wsl-perf-metric-val">{fmtSecs(profile.interactive_secs)}</span>
                  <span className="wsl-perf-metric-label">interactive startup</span>
                </div>
                <div className="wsl-perf-metric">
                  <span className="wsl-perf-metric-val">{fmtSecs(profile.baseline_secs)}</span>
                  <span className="wsl-perf-metric-label">baseline (no rc)</span>
                </div>
                <div className="wsl-perf-metric wsl-perf-metric--accent">
                  <span className="wsl-perf-metric-val">{fmtSecs(profile.rc_overhead_secs)}</span>
                  <span className="wsl-perf-metric-label">rc overhead</span>
                </div>
                <div className="wsl-perf-metric">
                  <span className="wsl-perf-metric-val">{fmtSecs(profile.login_secs)}</span>
                  <span className="wsl-perf-metric-label">login shell</span>
                </div>
              </div>

              {!isBash && (
                <p className="wsl-perf-shellnote">
                  Profiling assumes <code>bash</code>; this distro's login shell is <code>{profile.shell}</code>,
                  so figures cover bash startup, not your actual shell.
                </p>
              )}

              {profile.files.length > 0 && (
                <div className="wsl-perf-files">
                  <div className="stats-col-label">Per-file source time (isolated)</div>
                  {profile.files.map(f => (
                    <div key={f.path} className="stats-row">
                      <span className="stats-name" title={f.path}>{f.path}</span>
                      <div className="stats-bar-wrap">
                        <div className="stats-bar stats-bar--cpu" style={{ width: `${(f.seconds / maxFile) * 100}%` }} />
                      </div>
                      <span className="stats-value">{fmtSecs(f.seconds)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="wsl-perf-suggestions">
                {profile.detected.length === 0 ? (
                  <p className="overview-empty-row">No known slow startup items detected.</p>
                ) : profile.detected.map(d => (
                  <div key={d.tool} className="wsl-perf-suggestion">
                    <Lightbulb size={13} className="wsl-perf-suggestion-icon" />
                    <div>
                      <span className="wsl-perf-suggestion-tool">{d.tool}</span>
                      <p className="wsl-perf-suggestion-text">{d.suggestion}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {confirmBench && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap warning"><ShieldAlert size={16} /></div>
              <h2 className="modal-title">Benchmark {selected}?</h2>
            </div>
            <p className="modal-body">
              This terminates <strong>{selected}</strong> (<code>wsl --terminate</code>) and times its next
              cold start. Any running processes inside it stop immediately.
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmBench(false)}>Cancel</button>
              <button className="btn-filled btn-filled--accent" onClick={runBenchmark}>
                <Timer size={13} /> Run benchmark
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
