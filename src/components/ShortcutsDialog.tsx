import { useAppStore } from '../store/appStore'
import ModalShell from './ModalShell'
import { Button, Kbd } from './ui'

const SHORTCUTS: Array<{ keys: string[]; desc: string }> = [
  { keys: ['Ctrl', 'K'], desc: 'Search everything: pages, distros, images, containers, volumes' },
  { keys: ['Ctrl', 'R'], desc: 'Refresh the current page (Docker, WSL, Packages)' },
  { keys: ['Ctrl', '`'], desc: 'Show or hide the terminal panel' },
  { keys: ['↑', '↓'],    desc: 'Move through results, or through command history in the terminal' },
  { keys: ['Enter'],     desc: 'Open the highlighted result' },
  { keys: ['Esc'],       desc: 'Close search, a dialog, or a menu' },
]

export default function ShortcutsDialog() {
  const open    = useAppStore(s => s.shortcutsOpen)
  const setOpen = useAppStore(s => s.setShortcutsOpen)
  if (!open) return null

  return (
    <ModalShell className="modal-overlay" label="Keyboard shortcuts" onClose={() => setOpen(false)}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <h2 className="prereq-title">Keyboard shortcuts</h2>
        <div className="shortcut-list">
          {SHORTCUTS.map(s => (
            <div key={s.desc} className="shortcut-row">
              <span className="shortcut-keys">
                {s.keys.map(k => <Kbd key={k}>{k}</Kbd>)}
              </span>
              <span className="shortcut-desc">{s.desc}</span>
            </div>
          ))}
        </div>
        <div className="prereq-actions" style={{ marginTop: 'var(--space-5)', justifyContent: 'flex-end' }}>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </div>
      </div>
    </ModalShell>
  )
}
