import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '../../store/appStore'

/**
 * Run a docker action while streaming its `docker-log` events into the bottom
 * terminal. Opens the terminal, prints `header`, classifies and appends every
 * emitted line, then prints a Done/error footer. Returns whether the action
 * succeeded plus the raw lines (for callers that persist a run record).
 *
 * Callers keep their own before/after state (spinners, list reloads) around the
 * call — this only owns the terminal streaming that was copy-pasted at every
 * compose/prune action site.
 */
export async function runWithDockerLog(
  header: string,
  run: () => Promise<void>,
): Promise<{ success: boolean; lines: string[] }> {
  const { addTerminalLine, setTerminalOpen } = useAppStore.getState()
  const lines: string[] = []
  setTerminalOpen(true)
  addTerminalLine(header, 'info')

  const unlisten = await listen<string>('docker-log', e => {
    lines.push(e.payload)
    const type = e.payload.startsWith('$') ? 'cmd'
      : e.payload.startsWith('[err]') ? 'stderr'
      : 'stdout'
    useAppStore.getState().addTerminalLine(e.payload, type)
  })

  let success = false
  try {
    await run()
    success = true
    useAppStore.getState().addTerminalLine('─── Done ───', 'success')
  } catch (e) {
    useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
  } finally {
    unlisten()
  }
  return { success, lines }
}
