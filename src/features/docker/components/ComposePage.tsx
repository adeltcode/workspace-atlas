import { useMemo } from 'react'
import {
  Star, Tag, Play, Square, RotateCcw, ExternalLink,
  AlertTriangle, Activity, Clock, ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { ComposeProject, DockerContainer, ContainerStats, AppProjectMeta } from '../types'
import { bytesToHuman } from '../../../utils/format'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  projects:       ComposeProject[]
  containers:     DockerContainer[]
  containerStats: ContainerStats[]
  statHistory:    Map<string, { cpu: number[]; mem: number[] }>
  metadata:       Record<string, AppProjectMeta>
  onMetaChange:   (name: string, meta: AppProjectMeta) => void
  onSelectProject:(project: ComposeProject) => void
  onLifecycle:    (project: ComposeProject, action: 'up' | 'down' | 'restart') => Promise<void>
  lifecycleRunning: { project: string; action: string } | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Docker runtime format: "0.0.0.0:3000->3000/tcp, :::3000->3000/tcp"
// Capture the host port (before "->") by matching ":PORT->".
// A new RegExp per call avoids the stateful /g lastIndex issue.
function extractHostPorts(portStr: string): string[] {
  const re = /:(\d+)->/g
  const ports: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(portStr)) !== null) {
    if (m[1] !== '0') ports.push(m[1])
  }
  return [...new Set(ports)]
}

function emptyMeta(): AppProjectMeta {
  return { favorite: false, tags: [], note: '', active_env: null, recent_opened: null, startup_times: [] }
}

// ── Health Score ──────────────────────────────────────────────────────────────

interface HealthResult {
  score:    number
  running:  number
  total:    number
  checks:   { ok: boolean; label: string }[]
}

function calcHealth(projectName: string, containers: DockerContainer[]): HealthResult {
  const projectContainers = containers.filter(c => c.compose_project === projectName)
  const total   = projectContainers.length
  const running = projectContainers.filter(c => c.state === 'running').length
  const restarting = projectContainers.filter(c => c.state === 'restarting').length
  const unhealthy  = projectContainers.filter(c => c.state === 'dead').length

  if (total === 0) return { score: 0, running: 0, total: 0, checks: [{ ok: false, label: 'No containers found' }] }

  let score = 100
  const checks: { ok: boolean; label: string }[] = []

  if (running === total) {
    checks.push({ ok: true, label: 'All services running' })
  } else {
    const deduction = Math.round(((total - running) / total) * 60)
    score -= deduction
    checks.push({ ok: false, label: `${total - running} service${total - running !== 1 ? 's' : ''} stopped` })
  }

  if (restarting > 0) {
    score -= 20
    checks.push({ ok: false, label: `${restarting} container${restarting !== 1 ? 's' : ''} restarting` })
  }

  if (unhealthy > 0) {
    score -= 15
    checks.push({ ok: false, label: `${unhealthy} container${unhealthy !== 1 ? 's' : ''} unhealthy` })
  }

  if (restarting === 0 && unhealthy === 0 && running === total) {
    checks.push({ ok: true, label: 'No warnings' })
  }

  return { score: Math.max(0, score), running, total, checks }
}

function healthColor(score: number) {
  if (score >= 90) return 'health--great'
  if (score >= 60) return 'health--warn'
  return 'health--bad'
}

// ── Port conflict detection ───────────────────────────────────────────────────

function findPortConflicts(containers: DockerContainer[]): Set<string> {
  const portToProjects = new Map<string, string[]>()
  for (const c of containers) {
    if (!c.compose_project || !c.ports) continue
    for (const port of extractHostPorts(c.ports)) {
      const list = portToProjects.get(port) ?? []
      if (!list.includes(c.compose_project)) list.push(c.compose_project)
      portToProjects.set(port, list)
    }
  }
  const conflicts = new Set<string>()
  for (const [port, projects] of portToProjects) {
    if (projects.length > 1) conflicts.add(port)
  }
  return conflicts
}

// ── Stats strip ───────────────────────────────────────────────────────────────

function StatsStrip({ projects, containers }: { projects: ComposeProject[]; containers: DockerContainer[] }) {
  const running  = projects.filter(p => p.status.toLowerCase().includes('running')).length
  const stopped  = projects.filter(p => p.status.toLowerCase() === 'exited' || p.status.toLowerCase() === 'stopped').length
  const partial  = projects.length - running - stopped
  const services = containers.filter(c => c.compose_project !== null).length
  const conflicts = findPortConflicts(containers).size

  return (
    <div className="compose-stats-strip">
      <div className="compose-stat">
        <span className="compose-stat-value">{projects.length}</span>
        <span className="compose-stat-label">projects</span>
      </div>
      <div className="compose-stat-sep" />
      <div className="compose-stat">
        <span className="compose-stat-value compose-stat--running">{running}</span>
        <span className="compose-stat-label">running</span>
      </div>
      {partial > 0 && (
        <>
          <div className="compose-stat-sep" />
          <div className="compose-stat">
            <span className="compose-stat-value compose-stat--partial">{partial}</span>
            <span className="compose-stat-label">partial</span>
          </div>
        </>
      )}
      {stopped > 0 && (
        <>
          <div className="compose-stat-sep" />
          <div className="compose-stat">
            <span className="compose-stat-value compose-stat--stopped">{stopped}</span>
            <span className="compose-stat-label">stopped</span>
          </div>
        </>
      )}
      <div className="compose-stat-sep" />
      <div className="compose-stat">
        <span className="compose-stat-value">{services}</span>
        <span className="compose-stat-label">services</span>
      </div>
      {conflicts > 0 && (
        <>
          <div className="compose-stat-sep" />
          <div className="compose-stat compose-stat--conflict">
            <AlertTriangle size={12} />
            <span className="compose-stat-value">{conflicts}</span>
            <span className="compose-stat-label">port conflict{conflicts !== 1 ? 's' : ''}</span>
          </div>
        </>
      )}
    </div>
  )
}

// ── Project card ──────────────────────────────────────────────────────────────

interface CardProps {
  project:          ComposeProject
  containers:       DockerContainer[]
  containerStats:   ContainerStats[]
  statHistory:      Map<string, { cpu: number[]; mem: number[] }>
  meta:             AppProjectMeta
  conflictPorts:    Set<string>
  onToggleFavorite: () => void
  onSelect:         () => void
  onLifecycle:      (action: 'up' | 'down' | 'restart') => void
  lifecycleRunning: string | null
}

function ProjectCard({
  project, containers, containerStats, meta, conflictPorts,
  onToggleFavorite, onSelect, onLifecycle, lifecycleRunning,
}: CardProps) {
  const projectContainers = containers.filter(c => c.compose_project === project.name)
  const health = calcHealth(project.name, containers)

  // Aggregate resource usage
  const projectStats = containerStats.filter(s =>
    projectContainers.some(c => c.name === s.name)
  )
  const totalCpu    = projectStats.reduce((a, s) => a + s.cpu_pct, 0)
  const totalMemB   = projectStats.reduce((a, s) => a + s.mem_used_bytes, 0)
  const hasStats    = projectStats.length > 0

  // Exposed ports from running containers
  const hostPorts = [...new Set(
    projectContainers
      .filter(c => c.state === 'running' && c.ports)
      .flatMap(c => extractHostPorts(c.ports))
  )].slice(0, 5)

  const isRunning = lifecycleRunning !== null

  return (
    <div className={clsx('compose-project-card', health.score === 0 && 'compose-project-card--stopped')}>
      {/* ── Card header ── */}
      <div className="compose-card-header">
        <button className="compose-card-title-btn" onClick={onSelect}>
          <span className="compose-card-name">{project.name}</span>
          <ChevronRight size={13} className="compose-card-arrow" />
        </button>
        <button
          className={clsx('compose-card-star', meta.favorite && 'active')}
          onClick={e => { e.stopPropagation(); onToggleFavorite() }}
          title={meta.favorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star size={12} fill={meta.favorite ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* ── Health row ── */}
      <div className="compose-card-health-row">
        <div className={clsx('compose-card-health-score', healthColor(health.score))}>
          {health.score}%
        </div>
        <div className="compose-service-dots">
          {projectContainers.slice(0, 12).map(c => (
            <span
              key={c.id}
              className={clsx('compose-service-dot',
                c.state === 'running'    ? 'dot--running'
                : c.state === 'restarting' ? 'dot--restarting'
                : 'dot--stopped'
              )}
              title={`${c.compose_service ?? c.name}: ${c.state}`}
            />
          ))}
          {projectContainers.length === 0 && (
            <span className="compose-service-dots-empty">{health.total === 0 ? 'no containers' : '—'}</span>
          )}
        </div>
        <span className="compose-card-frac">
          {health.running}/{health.total}
        </span>
      </div>

      {/* ── Resources + tags ── */}
      <div className="compose-card-meta-row">
        {hasStats && (
          <span className="compose-card-resources">
            <Activity size={10} />
            {totalCpu.toFixed(1)}% · {bytesToHuman(totalMemB)}
          </span>
        )}
        {meta.tags.length > 0 && (
          <div className="compose-card-tags">
            {meta.tags.slice(0, 3).map(tag => (
              <span key={tag} className="compose-tag-chip">
                <Tag size={9} />
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Port chips ── */}
      {hostPorts.length > 0 && (
        <div className="compose-card-ports">
          {hostPorts.map(port => (
            <button
              key={port}
              className={clsx('compose-port-chip', conflictPorts.has(port) && 'conflict')}
              onClick={() => openUrl(`http://localhost:${port}`).catch(() => {})}
              title={`Open http://localhost:${port}`}
            >
              :{port}
              <ExternalLink size={8} />
            </button>
          ))}
        </div>
      )}

      {/* ── Lifecycle buttons ── */}
      <div className="compose-card-actions">
        <button
          className="compose-card-btn compose-card-btn--up"
          onClick={() => onLifecycle('up')}
          disabled={isRunning}
          title="docker compose up -d"
        >
          <Play size={10} className={lifecycleRunning === 'up' ? 'spin' : ''} />
          Up
        </button>
        <button
          className="compose-card-btn compose-card-btn--restart"
          onClick={() => onLifecycle('restart')}
          disabled={isRunning || health.running === 0}
          title="docker compose restart"
        >
          <RotateCcw size={10} className={lifecycleRunning === 'restart' ? 'spin' : ''} />
          Restart
        </button>
        <button
          className="compose-card-btn compose-card-btn--down"
          onClick={() => onLifecycle('down')}
          disabled={isRunning || health.running === 0}
          title="docker compose down"
        >
          <Square size={10} className={lifecycleRunning === 'down' ? 'spin' : ''} />
          Down
        </button>
        <button
          className="compose-card-btn compose-card-btn--detail"
          onClick={onSelect}
          title="Open project"
        >
          Open
          <ChevronRight size={10} />
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ComposePage({
  projects, containers, containerStats, statHistory,
  metadata, onMetaChange, onSelectProject, onLifecycle, lifecycleRunning,
}: Props) {
  const conflictPorts = useMemo(() => findPortConflicts(containers), [containers])

  // Sort: favorites first, then by name
  const sorted = useMemo(() => [...projects].sort((a, b) => {
    const af = metadata[a.name]?.favorite ?? false
    const bf = metadata[b.name]?.favorite ?? false
    if (af !== bf) return af ? -1 : 1
    return a.name.localeCompare(b.name)
  }), [projects, metadata])

  const favorites = sorted.filter(p => metadata[p.name]?.favorite)
  const rest      = sorted.filter(p => !metadata[p.name]?.favorite)

  const toggleFavorite = (project: ComposeProject) => {
    const current = metadata[project.name] ?? emptyMeta()
    onMetaChange(project.name, { ...current, favorite: !current.favorite })
  }

  if (projects.length === 0) {
    return (
      <div className="compose-page-empty">
        <Clock size={32} className="compose-page-empty-icon" />
        <p className="compose-page-empty-text">No compose projects found.</p>
        <p className="compose-page-empty-sub">Run <code>docker compose up</code> in a project directory to get started.</p>
      </div>
    )
  }

  return (
    <div className="compose-page">
      <StatsStrip projects={projects} containers={containers} />

      {favorites.length > 0 && (
        <section className="compose-page-section">
          <h3 className="compose-page-section-title">
            <Star size={12} fill="currentColor" /> Favorites
          </h3>
          <div className="compose-card-grid">
            {favorites.map(p => (
              <ProjectCard
                key={p.name}
                project={p}
                containers={containers}
                containerStats={containerStats}
                statHistory={statHistory}
                meta={metadata[p.name] ?? emptyMeta()}
                conflictPorts={conflictPorts}
                onToggleFavorite={() => toggleFavorite(p)}
                onSelect={() => onSelectProject(p)}
                onLifecycle={action => onLifecycle(p, action)}
                lifecycleRunning={
                  lifecycleRunning?.project === p.name ? lifecycleRunning.action : null
                }
              />
            ))}
          </div>
        </section>
      )}

      <section className="compose-page-section">
        {favorites.length > 0 && (
          <h3 className="compose-page-section-title">All Projects</h3>
        )}
        <div className="compose-card-grid">
          {rest.map(p => (
            <ProjectCard
              key={p.name}
              project={p}
              containers={containers}
              containerStats={containerStats}
              statHistory={statHistory}
              meta={metadata[p.name] ?? emptyMeta()}
              conflictPorts={conflictPorts}
              onToggleFavorite={() => toggleFavorite(p)}
              onSelect={() => onSelectProject(p)}
              onLifecycle={action => onLifecycle(p, action)}
              lifecycleRunning={
                lifecycleRunning?.project === p.name ? lifecycleRunning.action : null
              }
            />
          ))}
        </div>
      </section>
    </div>
  )
}
