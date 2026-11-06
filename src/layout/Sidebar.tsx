import { LayoutDashboard, Box, ClipboardList, Eraser, HardDrive, FlaskConical, Package, Plug, Lock, Settings, Keyboard, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type DockerTab, type View, type WslView } from '../store/appStore'
import { DOCKER_TABS } from '../features/docker/tabs'
import { composeStatusLabel } from '../utils/format'

function RailItem({ view, icon: Icon, label, count }: { view: View; icon: LucideIcon; label: string; count?: string | false | null }) {
  const active = useAppStore(s => s.activeView === view)
  const setActiveView = useAppStore(s => s.setActiveView)
  return (
    <button
      className={clsx('rail-item', active && 'active')}
      onClick={() => setActiveView(view)}
      aria-current={active ? 'page' : undefined}
    >
      <span className="rail-icon"><Icon size={15} /></span>
      <span className="rail-label">{label}</span>
      {count && <span className="rail-count">{count}</span>}
    </button>
  )
}

function RailKid({ active, onClick, ariaLabel, dot, label, note }: {
  active: boolean
  onClick: () => void
  ariaLabel?: string
  dot?: string
  label: string
  note?: string | false
}) {
  return (
    <button
      className={clsx('rail-kid', active && 'active')}
      onClick={onClick}
      style={{ width: '100%' }}
      aria-current={active ? 'page' : undefined}
      aria-label={ariaLabel}
    >
      {dot && <span className={clsx('rail-dot', dot)} />}
      <span className="rail-kid-label">{label}</span>
      {note && <span className="rail-frac">{note}</span>}
    </button>
  )
}

export default function Sidebar() {
  const activeView    = useAppStore(s => s.activeView)
  const setActiveView = useAppStore(s => s.setActiveView)
  const dockerTab     = useAppStore(s => s.dockerTab)
  const setDockerTab  = useAppStore(s => s.setDockerTab)
  const dockerBadges  = useAppStore(s => s.dockerBadges)
  const composeProjectsNav   = useAppStore(s => s.composeProjectsNav)
  const composeActiveProject = useAppStore(s => s.composeActiveProject)
  const wslView       = useAppStore(s => s.wslView)
  const setWslView    = useAppStore(s => s.setWslView)
  const wslSelectedDistro = useAppStore(s => s.wslSelectedDistro)
  const wslDistrosNav = useAppStore(s => s.wslDistrosNav)
  const setShortcutsOpen = useAppStore(s => s.setShortcutsOpen)

  const wslRunning = wslDistrosNav.filter(d => d.running).length
  const wslCount = wslRunning > 0 ? `${wslRunning}/${wslDistrosNav.length}` : String(wslDistrosNav.length)

  const goDockerTab = (id: DockerTab) => { setActiveView('docker'); setDockerTab(id) }
  const goWslView   = (v: WslView)    => { setActiveView('wsl'); setWslView(v) }
  const goWslDistro = (name: string) => {
    setActiveView('wsl')
    useAppStore.getState().setWslSelectedDistro(name)
    setWslView('distro')
  }
  const goComposeProject = (name: string) => {
    setActiveView('docker')
    setDockerTab('compose')
    useAppStore.getState().setComposePreselect(name)
  }

  const tabCount = (id: DockerTab): string | undefined => {
    if (!dockerBadges) return undefined
    if (id === 'images'     && dockerBadges.images > 0) return String(dockerBadges.images)
    if (id === 'containers' && dockerBadges.containers) return dockerBadges.containers
    if (id === 'volumes'    && dockerBadges.volumes)    return dockerBadges.volumes
    return undefined
  }

  return (
    <nav className="sidebar" aria-label="Modules">
      <div className="rail-group">
        <RailItem view="dashboard" icon={LayoutDashboard} label="Overview" />
      </div>

      <span className="rail-section">Environments</span>
      <div className="rail-group">
        <RailItem view="docker" icon={Box} label="Docker" count={dockerBadges?.containers} />

        {activeView === 'docker' && (
          <div className="rail-kids">
            {DOCKER_TABS.map(({ id, label }) => (
              <div key={id}>
                <RailKid active={dockerTab === id} onClick={() => goDockerTab(id)} label={label} note={tabCount(id)} />

                {id === 'compose' && dockerTab === 'compose' && composeProjectsNav.length > 0 && (
                  <div className="rail-kids">
                    {composeProjectsNav.map(p => {
                      const { dot, running, total } = composeStatusLabel(p.status)
                      return (
                        <RailKid
                          key={p.name}
                          active={composeActiveProject === p.name}
                          onClick={() => goComposeProject(p.name)}
                          ariaLabel={total > 0 ? `${p.name}, ${running} of ${total} services running` : p.name}
                          dot={dot}
                          label={p.name}
                          note={total > 0 && `${running}/${total}`}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <RailItem view="wsl" icon={HardDrive} label="WSL" count={wslDistrosNav.length > 0 && wslCount} />

        {activeView === 'wsl' && (
          <div className="rail-kids">
            {wslDistrosNav.map(d => (
              <RailKid
                key={d.name}
                active={wslView === 'distro' && wslSelectedDistro === d.name}
                onClick={() => goWslDistro(d.name)}
                // The dot is the only visual sign of running state, so the label must say it too.
                ariaLabel={`${d.name}, ${d.running ? 'running' : 'stopped'}${d.is_default ? ', default' : ''}`}
                dot={d.running ? 'running' : 'stopped'}
                label={d.name}
                note={d.is_default && 'default'}
              />
            ))}
            <RailKid active={wslView === 'install'} onClick={() => goWslView('install')} label="Install distro" />
            <RailKid active={wslView === 'wslconfig'} onClick={() => goWslView('wslconfig')} label=".wslconfig" />
          </div>
        )}

        <RailItem view="sandbox" icon={FlaskConical} label="Sandbox" />
      </div>

      <span className="rail-section">Tools</span>
      <div className="rail-group">
        <RailItem view="ports" icon={Plug} label="Ports" />
        <RailItem view="locks" icon={Lock} label="File locks" />
        <RailItem view="clipboard" icon={ClipboardList} label="Clipboard" />
        <RailItem view="caches" icon={Eraser} label="Dev caches" />
      </div>

      <span className="rail-section">System</span>
      <div className="rail-group">
        <RailItem view="packages" icon={Package} label="Packages" />
        <RailItem view="settings" icon={Settings} label="Settings" />
      </div>

      <div className="rail-foot rail-group">
        <button className="rail-item" onClick={() => setShortcutsOpen(true)}>
          <span className="rail-icon"><Keyboard size={15} /></span>
          <span className="rail-label">Shortcuts</span>
        </button>
      </div>
    </nav>
  )
}
