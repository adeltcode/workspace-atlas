import { useState } from 'react'
import { Pencil, Save, X } from 'lucide-react'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'

// ── Dockerfile syntax highlighter ─────────────────────────────────────────────

const INSTRUCTIONS = new Set([
  'FROM','RUN','COPY','ADD','WORKDIR','EXPOSE','ENV','ARG','LABEL',
  'CMD','ENTRYPOINT','USER','VOLUME','HEALTHCHECK','SHELL','STOPSIGNAL','ONBUILD','MAINTAINER',
])

function DockerfileLine({ line }: { line: string }) {
  const trimmed = line.trimStart()

  if (!trimmed) return <div className="yaml-line">&nbsp;</div>

  if (trimmed.startsWith('#')) {
    return <div className="yaml-line"><span className="yaml-comment">{line}</span></div>
  }

  // Match instruction at start of line (possibly with leading whitespace in heredocs)
  const instrMatch = trimmed.match(/^([A-Z]+)(\s+)(.*)$/)
  if (instrMatch) {
    const [, instr, sp, rest] = instrMatch
    const indent = line.length - trimmed.length
    const pre = ' '.repeat(indent)
    if (INSTRUCTIONS.has(instr)) {
      return (
        <div className="yaml-line">
          <span>{pre}</span>
          <span className="dockerfile-instr">{instr}</span>
          <span>{sp}</span>
          <span className="dockerfile-arg">{renderDockerArg(rest)}</span>
        </div>
      )
    }
  }

  return <div className="yaml-line">{line}</div>
}

function renderDockerArg(text: string): React.ReactNode {
  // Highlight ${VAR} and $VAR references
  if (!text.includes('$')) return <span>{text}</span>
  const parts = text.split(/(\$\{[^}]+\}|\$[A-Z_a-z][A-Z0-9_a-z]*)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('$')
          ? <span key={i} className="yaml-env">{p}</span>
          : <span key={i}>{p}</span>
      )}
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  filePath: string
  content:  string
  onSaved:  (newContent: string) => void
}

export default function ComposeDockerfileViewer({ filePath, content, onSaved }: Props) {
  const [editMode, setEditMode] = useState(false)
  const [draft,    setDraft]    = useState('')
  const [saving,   setSaving]   = useState(false)

  const isModified = editMode && draft !== content

  const enterEdit = () => { setDraft(content); setEditMode(true) }
  const cancelEdit = () => setEditMode(false)

  const handleSave = async () => {
    if (!filePath || saving) return
    setSaving(true)
    try {
      await api.writeFileContent(filePath, draft)
      onSaved(draft)
      setEditMode(false)
      useAppStore.getState().addTerminalLine(`  ✓ Saved ${filePath}`, 'success')
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ Save failed: ${String(e)}`, 'error')
    } finally { setSaving(false) }
  }

  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Mini toolbar just for edit controls */}
      <div className="compose-dockerfile-toolbar">
        <span className="compose-dockerfile-lang">Dockerfile</span>
        <div style={{ flex: 1 }} />
        {editMode ? (
          <>
            <button className="compose-save-btn" onClick={handleSave} disabled={saving || !isModified}>
              <Save size={11} className={saving ? 'spin' : ''} />
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="compose-cancel-edit-btn" onClick={cancelEdit} disabled={saving}>
              <X size={11} /> Cancel
            </button>
          </>
        ) : (
          <button className="compose-edit-btn" onClick={enterEdit}>
            <Pencil size={11} /> Edit
          </button>
        )}
        {isModified && <span className="compose-modified-dot" title="Unsaved changes" />}
      </div>

      {/* Content area */}
      {!editMode ? (
        <div className="compose-code-wrap" style={{ flex: 1 }}>
          <div className="compose-line-nums" aria-hidden>
            {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
          </div>
          <div className="compose-code-body">
            {lines.map((line, i) => <DockerfileLine key={i} line={line} />)}
          </div>
        </div>
      ) : (
        <div className="compose-editor-wrap" style={{ flex: 1 }}>
          <div className="compose-line-nums" aria-hidden>
            {draft.split('\n').map((_, i) => <span key={i}>{i + 1}</span>)}
          </div>
          <textarea
            className="compose-editor-textarea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
      )}
    </div>
  )
}
