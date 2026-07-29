/* The keyboard reference.
 *
 * The shortcuts already existed. They were documented only inside `title`
 * attributes, which are neither keyboard reachable nor reliably announced, so
 * in practice nobody knew they were there. */
import { useAppStore } from '../store/appStore'
import ModalShell from './ModalShell'
import { Button, Kbd } from './ui'

const SHORTCUTS: Array<{ keys: string[]; desc: string }> = [
  { keys: ['Ctrl', 'K'], desc: 'Search everything: modules, distros, images, containers, volumes' },
  { keys: ['Ctrl', 'R'], desc: 'Refresh the current module' },
  { keys: ['Ctrl', '`'], desc: 'Show or hide the command pane' },
  { keys: ['↑', '↓'],    desc: 'Move through results, or through command history in the pane' },
  { keys: ['Enter'],     desc: 'Open the highlighted result' },
  { keys: ['Esc'],       desc: 'Close the index, a dialog, or a menu' },
]

export default function ShortcutsDialog() {
  const open    = useAppStore(s => s.shortcutsOpen)
  const setOpen = useAppStore(s => s.setShortcutsOpen)
  if (!open) return null

  return (
    <ModalShell className="modal-overlay" onClose={() => setOpen(false)}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <h2 className="prereq-title">Keyboard</h2>
        <p className="prereq-desc">Everything here works from anywhere in the app.</p>
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
