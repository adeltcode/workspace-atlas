import { useLayoutEffect, useRef } from 'react'

interface Props {
  value:            string
  onChange:         (v: string) => void
  renderLine:       (line: string, index: number) => React.ReactNode
  initialScrollTop?: number
  onScrollTop?:     (top: number) => void
}

export default function CodeOverlayEditor({
  value, onChange, renderLine, initialScrollTop = 0, onScrollTop,
}: Props) {
  const taRef   = useRef<HTMLTextAreaElement>(null)
  const preRef  = useRef<HTMLDivElement>(null)
  const numsRef = useRef<HTMLDivElement>(null)
  const lines   = value.split('\n')

  const syncScroll = () => {
    const ta   = taRef.current
    const pre  = preRef.current
    const nums = numsRef.current
    if (ta && pre) {
      pre.scrollTop  = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
    if (ta && nums) {
      nums.scrollTop = ta.scrollTop
    }
    if (ta) onScrollTop?.(ta.scrollTop)
  }

  // Restore the scroll position handed in from the previous mode before paint,
  // so toggling read-only ⇄ edit keeps the user at the same place in the file.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.scrollTop = initialScrollTop
    if (preRef.current)  preRef.current.scrollTop  = ta.scrollTop
    if (numsRef.current) numsRef.current.scrollTop = ta.scrollTop
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="compose-code-wrap compose-code-wrap--edit">
      <div className="compose-line-nums" aria-hidden ref={numsRef}>
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
