import { useEffect, useMemo, useState } from 'react'
import { Disc3 } from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import { getDefaultBackupDir } from '../../docker/api'
import { WSLCONF_SECTIONS } from '../ini'
import IniConfigEditor, { type IniBackend } from './IniConfigEditor'
import type { WslDistro } from '../types'

const TEMPLATE = `# Per-distro settings for /etc/wsl.conf.
# Changes take effect after a WSL restart (wsl --shutdown).

[boot]
systemd=true
`

export default function WslConfTab({ distros, runningNames, onAfterShutdown }: {
  distros: WslDistro[]
  runningNames: string[]
  onAfterShutdown: () => void
}) {
  const backupDir    = useAppStore(s => s.backupDir)
  const setBackupDir = useAppStore(s => s.setBackupDir)

  const [distro, setDistro] = useState('')

  useEffect(() => {
    if (!backupDir) getDefaultBackupDir().then(setBackupDir).catch(() => {})
  }, [backupDir, setBackupDir])

  // Default to the default distro (or the first) once the list is available.
  useEffect(() => {
    if (distros.length === 0) return
    if (!distro || !distros.some(d => d.name === distro)) {
      setDistro((distros.find(d => d.is_default) ?? distros[0]).name)
    }
  }, [distros, distro])

  const backend = useMemo<IniBackend>(() => ({
    load:          () => api.readWslConf(distro),
    save:          (content) => api.writeWslConf(distro, content),
    listBackups:   () => api.wslConfListBackups(distro, backupDir),
    createBackup:  () => api.wslConfBackup(distro, backupDir),
    restoreBackup: (path) => api.wslConfRestore(distro, path),
    deleteBackup:  (path) => api.wslConfDeleteBackup(path),
  }), [distro, backupDir])

  if (distros.length === 0) {
    return <p className="empty-state" style={{ marginTop: 24 }}>No distributions found.</p>
  }

  return (
    <div className="wslconf">
      <div className="wslconf-distro-bar">
        <Disc3 size={14} className="wslconf-distro-icon" />
        <label className="wslconf-distro-label">Distribution</label>
        <select className="wslconf-distro-select" value={distro} onChange={e => setDistro(e.target.value)}>
          {distros.map(d => (
            <option key={d.name} value={d.name}>{d.name}{d.is_default ? ' (default)' : ''}</option>
          ))}
        </select>
        <span className="wslconf-distro-note">Editing <code>/etc/wsl.conf</code> inside this distro (writes as root)</span>
      </div>

      {distro && (
        <IniConfigEditor
          label={`wsl.conf · ${distro}`}
          sections={WSLCONF_SECTIONS}
          template={TEMPLATE}
          backend={backend}
          runningNames={runningNames}
          onAfterShutdown={onAfterShutdown}
        />
      )}
    </div>
  )
}
