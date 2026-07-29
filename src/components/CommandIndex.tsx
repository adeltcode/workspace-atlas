/* The index of the bound volume.
 *
 * A user whose disk is full used to have to visit Docker Images, Docker Volumes,
 * the WSL dashboard and every distro page in turn, because the app had eight
 * separate filter boxes and nothing that searched across modules. This searches
 * every module, every section, and every live object on the machine at once. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, HardDrive, Package, LayoutDashboard, Settings, Layers, Database, Network, Trash2, ScrollText, CornerDownLeft } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type View, type DockerTab, type WslView } from '../store/appStore'
import ModalShell from './ModalShell'
import { Kbd } from './ui'

interface Item {
  id: string
  label: string
  /** Where this lives, shown on the right. */
  where: string
  section: string
  icon: React.ElementType
  run: () => void
}

/* Subsequence match, ranked so that a prefix beats a word start, which beats a
 * scattered match. Enough for a few thousand rows and no dependency. */
function score(needle: string, hay: string): number {
  if (!needle) return 1
  const h = hay.toLowerCase()
  const n = needle.toLowerCase()
  const at = h.indexOf(n)
  if (at === 0) return 1000
  if (at > 0) return 800 - at + (/[\s\-_/:.]/.test(h[at - 1]) ? 100 : 0)
  // scattered subsequence
  let i = 0
  for (const ch of h) { if (ch === n[i]) i++; if (i === n.length) break }
  return i === n.length ? 100 : 0
}

const go = (view: View, after?: () => void) => () => {
  useAppStore.getState().setActiveView(view)
  after?.()
}
const goDocker = (tab: DockerTab) => go('docker', () => useAppStore.getState().setDockerTab(tab))
const goWsl    = (v: WslView)    => go('wsl',    () => useAppStore.getState().setWslView(v))

export default function CommandIndex() {
  const open        = useAppStore(s => s.indexOpen)
  const setOpen     = useAppStore(s => s.setIndexOpen)
  const cache       = useAppStore(s => s.dockerCache)
  const distros     = useAppStore(s => s.wslDistrosNav)
  const projects    = useAppStore(s => s.composeProjectsNav)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef  = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []

    // Places
    out.push(
      { id: 'v:dash', label: 'Overview', where: 'Module', section: 'Places', icon: LayoutDashboard, run: go('dashboard') },
      { id: 'v:set',  label: 'Settings',   where: 'Module', section: 'Places', icon: Settings,        run: go('settings') },
      { id: 'v:pkg',  label: 'Packages',   where: 'Module', section: 'Places', icon: Package,         run: go('packages') },
    )
    const dockerTabs: Array<[DockerTab, string, React.ElementType]> = [
      ['overview', 'Overview', Box], ['images', 'Images', Layers],
      ['containers', 'Containers', Box], ['volumes', 'Volumes', Database],
      ['networks', 'Networks', Network], ['compose', 'Compose', Layers],
      ['prune', 'Prune', Trash2], ['log', 'Run log', ScrollText],
    ]
    for (const [id, label, icon] of dockerTabs) {
      out.push({ id: `d:${id}`, label, where: 'Docker', section: 'Places', icon, run: goDocker(id) })
    }
    out.push(
      { id: 'w:dash', label: 'Distros',       where: 'WSL', section: 'Places', icon: HardDrive, run: goWsl('dashboard') },
      { id: 'w:inst', label: 'Install distro', where: 'WSL', section: 'Places', icon: HardDrive, run: goWsl('install') },
      { id: 'w:conf', label: '.wslconfig',     where: 'WSL', section: 'Places', icon: HardDrive, run: goWsl('wslconfig') },
    )

    // Live objects on this machine
    for (const d of distros) {
      out.push({
        id: `distro:${d.name}`, label: d.name,
        where: d.running ? 'WSL · running' : 'WSL · stopped',
        section: 'Distros', icon: HardDrive,
        run: go('wsl', () => {
          useAppStore.getState().setWslSelectedDistro(d.name)
          useAppStore.getState().setWslView('distro')
        }),
      })
    }
    for (const p of projects) {
      out.push({
        id: `compose:${p.name}`, label: p.name, where: 'Compose project',
        section: 'Compose', icon: Layers,
        run: go('docker', () => {
          useAppStore.getState().setDockerTab('compose')
          useAppStore.getState().setComposePreselect(p.name)
        }),
      })
    }
    for (const img of cache?.images ?? []) {
      const name = img.repository === '<none>' ? img.id.slice(0, 12) : `${img.repository}:${img.tag}`
      out.push({ id: `img:${img.id}`, label: name, where: `Image · ${img.size}`, section: 'Images', icon: Layers, run: goDocker('images') })
    }
    for (const c of cache?.containers ?? []) {
      out.push({ id: `ctr:${c.id}`, label: c.name, where: `Container · ${c.state}`, section: 'Containers', icon: Box, run: goDocker('containers') })
    }
    for (const v of cache?.volumes ?? []) {
      out.push({ id: `vol:${v.name}`, label: v.name, where: 'Volume', section: 'Volumes', icon: Database, run: goDocker('volumes') })
    }
    return out
  }, [cache, distros, projects])

  const results = useMemo(() => {
    const scored = items
      .map(it => ({ it, s: Math.max(score(query, it.label), score(query, it.where) * 0.4) }))
      .filter(r => r.s > 0)
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, 60).map(r => r.it)
  }, [items, query])

  useEffect(() => { setCursor(0) }, [query])
  useEffect(() => { if (open) { setQuery(''); setCursor(0); inputRef.current?.focus() } }, [open])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.index-row--active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const choose = (it: Item) => { it.run(); setOpen(false) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape')      { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter')     { e.preventDefault(); if (results[cursor]) choose(results[cursor]) }
  }

  // Group consecutive results by section so headings appear in rank order.
  const rows: Array<{ kind: 'head'; label: string } | { kind: 'item'; item: Item; i: number }> = []
  let lastSection = ''
  results.forEach((item, i) => {
    if (item.section !== lastSection) { rows.push({ kind: 'head', label: item.section }); lastSection = item.section }
    rows.push({ kind: 'item', item, i })
  })

  return (
    // ModalShell is a native <dialog>, so focus moves in, stays trapped, returns
    // to the trigger on close, and Escape works without hand-rolling any of it.
    <ModalShell className="index-scrim" onClose={() => setOpen(false)}>
      <div className="index-panel" onKeyDown={onKeyDown} onClick={e => e.stopPropagation()}>
        <div className="index-search">
          <input
            ref={inputRef}
            className="index-search-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search modules, distros, images, containers, volumes…"
            aria-label="Search everything"
            spellCheck={false}
            autoComplete="off"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div className="index-results" ref={listRef}>
          {results.length === 0 ? (
            <p className="index-section" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Nothing on this machine matches “{query}”.
            </p>
          ) : rows.map((r, k) =>
            r.kind === 'head'
              ? <p key={`h${k}`} className="index-section">{r.label}</p>
              : (
                <button
                  key={r.item.id}
                  className={clsx('index-row', r.i === cursor && 'index-row--active')}
                  onMouseMove={() => setCursor(r.i)}
                  onClick={() => choose(r.item)}
                >
                  <span className="index-row-icon"><r.item.icon size={13} /></span>
                  <span className="index-row-label">{r.item.label}</span>
                  <span className="index-row-where">{r.item.where}</span>
                </button>
              ),
          )}
        </div>

        <div className="index-foot">
          <span className="index-hint"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="index-hint"><CornerDownLeft size={11} /> open</span>
          <span className="index-hint" style={{ marginLeft: 'auto' }}>
            {results.length} of {items.length}
          </span>
        </div>
      </div>
    </ModalShell>
  )
}
