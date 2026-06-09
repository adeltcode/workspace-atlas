import { useRef } from 'react'

interface Props {
  value:      string
  onChange:   (v: string) => void
  /** Render one highlighted line for the layer behind the textarea. */
  renderLine: (line: string, index: number) => React.ReactNode
}

/**
 * Editable code with live syntax highlighting: a highlighted layer rendered
 * behind a transparent textarea. Both share identical typography/padding (via
 * the .compose-editor-* CSS) so the caret lines up exactly with the colored
 * text; the textarea's scroll is mirrored onto the highlight layer.
 *
 * Reused by the YAML editor and the Dockerfile editor — only `renderLine`
 * differs.
 */
export default function CodeOverlayEditor({ value, onChange, renderLine }: Props) {
  const taRef  = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLDivElement>(null)
  const lines  = value.split('\n')

  const syncScroll = () => {
    const ta = taRef.current, pre = preRef.current
    if (ta && pre) {
      pre.scrollTop  = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
  }

  return (
    <div className="compose-code-wrap compose-code-wrap--edit">
      <div className="compose-line-nums" aria-hidden>
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="compose-editor-overlay">
        <div className="compose-code-body compose-editor-highlight" ref={preRef} aria-hidden>
          {lines.map((line, i) => renderLine(line, i))}
        </div>
        <textarea
          ref={taRef}
          className="compose-overlay-textarea"
          value={value}
          onChange={e => onChange(e.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
        />
      </div>
    </div>
  )
}
