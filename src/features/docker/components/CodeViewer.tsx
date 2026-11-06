import { useLayoutEffect, useRef } from 'react'

/** Read-only code with line numbers that stay pinned during horizontal scroll. */
export default function CodeViewer({ content, renderLine, initialScrollTop = 0, onScrollTop }: {
  content:           string
  renderLine:        (line: string, index: number) => React.ReactNode
  initialScrollTop?: number
  onScrollTop?:      (top: number) => void
}) {
  const numsRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  const syncScroll = () => {
    const area = areaRef.current
    if (!area) return
    if (numsRef.current) numsRef.current.scrollTop = area.scrollTop
    onScrollTop?.(area.scrollTop)
  }

  // Restore the scroll position from the previous mode before paint.
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.scrollTop = initialScrollTop
    if (numsRef.current) numsRef.current.scrollTop = area.scrollTop
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="compose-code-wrap">
      <div className="compose-line-nums" aria-hidden ref={numsRef}>
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="compose-code-area" ref={areaRef} onScroll={syncScroll}>
        <div className="compose-code-body">
          {lines.map(renderLine)}
        </div>
      </div>
    </div>
  )
}
