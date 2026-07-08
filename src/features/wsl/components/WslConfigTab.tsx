import { useEffect, useMemo } from 'react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import { getDefaultBackupDir } from '../../docker/api'
import { WSLCONFIG_SECTIONS } from '../ini'
import IniConfigEditor, { type IniBackend } from './IniConfigEditor'

const TEMPLATE = `# Global WSL2 configuration. Applies to all WSL2 distributions.
# Changes take effect after a WSL restart (wsl --shutdown).

[wsl2]
memory=8GB
processors=4
swap=2GB
localhostForwarding=true
`

export default function WslConfigTab({ runningNames, onAfterShutdown }: {
  runningNames: string[]
  onAfterShutdown: () => void
}) {
  const backupDir    = useAppStore(s => s.backupDir)
  const setBackupDir = useAppStore(s => s.setBackupDir)

  // Ensure a backup directory exists (mirrors the Docker backup default).
  useEffect(() => {
    if (!backupDir) getDefaultBackupDir().then(setBackupDir).catch(() => {})
  }, [backupDir, setBackupDir])

  const backend = useMemo<IniBackend>(() => ({
    load:          () => api.readWslConfig(),
    save:          (content) => api.writeWslConfig(content),
    listBackups:   () => api.wslconfigListBackups(backupDir),
    createBackup:  () => api.wslconfigBackup(backupDir),
    restoreBackup: (path) => api.wslconfigRestore(path),
    deleteBackup:  (path) => api.wslConfDeleteBackup(path),
  }), [backupDir])

  return (
    <IniConfigEditor
      label=".wslconfig"
      sections={WSLCONFIG_SECTIONS}
      commonSplit
      template={TEMPLATE}
      backend={backend}
      runningNames={runningNames}
      onAfterShutdown={onAfterShutdown}
    />
  )
}
