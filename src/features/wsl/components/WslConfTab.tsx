import { useEffect, useMemo } from 'react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import { getDefaultBackupDir } from '../../docker/api'
import { WSLCONF_SECTIONS } from '../ini'
import { useDistroSelection } from '../hooks'
import IniConfigEditor, { type IniBackend } from './IniConfigEditor'
import DistroSelect from './DistroSelect'
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

  const [distro, setDistro] = useDistroSelection(distros)

  useEffect(() => {
    if (!backupDir) getDefaultBackupDir().then(setBackupDir).catch(() => {})
  }, [backupDir, setBackupDir])

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
      <DistroSelect
        distros={distros}
        value={distro}
        onChange={setDistro}
        note={<>Editing <code>/etc/wsl.conf</code> inside this distro (writes as root)</>}
      />

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
