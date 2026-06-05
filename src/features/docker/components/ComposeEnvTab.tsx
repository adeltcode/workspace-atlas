import { useState, useMemo } from 'react'
import { Eye, EyeOff, Save, Pencil, X } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'

interface EnvPair { key: string; value: string; line: string }

function parseEnv(content: string): EnvPair[] {
  return content.split('\n').map(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return null
    const eq = line.indexOf('=')
    if (eq === -1) return { key: line.trim(), value: '', line }
    return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1), line }
  }).filter(Boolean) as EnvPair[]
}

/** Extract all ${VAR} and $VAR references from a YAML string */
function extractYamlVarRefs(yaml: string): Set<string> {
  const refs = new Set<string>()
  const re = /\$\{([^}]+)\}|\$([A-Z_a-z][A-Z0-9_a-z]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(yaml)) !== null) refs.add(m[1] ?? m[2])
  return refs
}

interface Props {
  filePath:    string
  content:     string          // current file content from parent
  yamlContent: string          // compose YAML for cross-reference
  onSaved:     (newContent: string) => void
}

export default function ComposeEnvTab({ filePath, content, yamlContent, onSaved }: Props) {
  const [masked,   setMasked]   = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [draft,    setDraft]    = useState('')
  const [saving,   setSaving]   = useState(false)

  const pairs    = useMemo(() => parseEnv(content), [content])
  const yamlRefs = useMemo(() => extractYamlVarRefs(yamlContent), [yamlContent])

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

  return (
    <div className="env-tab-wrap">
      {/* Toolbar */}
      <div className="env-tab-toolbar">
        <button
          className={clsx('env-mask-btn', !masked && 'unmasked')}
          onClick={() => setMasked(m => !m)}
          title={masked ? 'Show values' : 'Mask values'}
        >
          {masked ? <Eye size={12} /> : <EyeOff size={12} />}
          {masked ? 'Show' : 'Hide'}
        </button>
        <span className="env-tab-count">{pairs.length} variable{pairs.length !== 1 ? 's' : ''}</span>
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

      {/* View mode: key/value table */}
      {!editMode && (
        <div className="env-table-wrap">
          {pairs.length === 0 ? (
            <p className="compose-backup-empty">No variables found in this file.</p>
          ) : (
            <table className="env-table env-table--full">
              <thead>
                <tr>
                  <th className="env-th">Variable</th>
                  <th className="env-th">Value</th>
                  <th className="env-th env-th--status">Used in compose</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map(({ key, value }) => {
                  const usedInYaml = yamlRefs.has(key)
                  return (
                    <tr key={key} className={clsx('env-row', !usedInYaml && 'env-row--unused')}>
                      <td className="env-key">{key}</td>
                      <td className="env-val">
                        {masked
                          ? <span className="env-masked">{'•'.repeat(Math.min(value.length || 8, 16))}</span>
                          : value || <span className="env-empty">(empty)</span>
                        }
                      </td>
                      <td className="env-td--status">
                        {usedInYaml
                          ? <span className="env-ref-chip env-ref-chip--used">used</span>
                          : <span className="env-ref-chip env-ref-chip--unused">unused</span>
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {/* Warn about YAML vars with no .env declaration */}
          {(() => {
            const envKeys = new Set(pairs.map(p => p.key))
            const missing = [...yamlRefs].filter(r => !envKeys.has(r))
            if (missing.length === 0) return null
            return (
              <div className="env-missing-warn">
                <span className="env-missing-warn-label">Not declared in .env:</span>
                {missing.map(v => <code key={v} className="env-missing-var">${'{'}v{'}'}</code>)}
              </div>
            )
          })()}
        </div>
      )}

      {/* Edit mode: raw textarea */}
      {editMode && (
        <div className="compose-editor-wrap">
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
