import { Fragment, memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import ModalShell from './ModalShell'

function outputTokens(line: string) {
  const pattern = /^\s*\$\s+\S+|^\s*#.*$|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|(?<![\w:/])(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+|(?<!\w)--?[A-Za-z][\w-]*|\b\d+(?:\.\d+)*\b/g
  const tokens: { text: string; kind?: string }[] = []
  let offset = 0
  for (const match of line.matchAll(pattern)) {
    if (match.index > offset) tokens.push({ text: line.slice(offset, match.index) })
    const text = match[0]
    const kind = /^\s*\$/.test(text) ? 'command' : /^\s*#/.test(text) ? 'comment'
      : text.startsWith('-') ? 'flag' : /^["']/.test(text) ? 'string'
      : /^(?:[A-Za-z]:[\\/]|\/)/.test(text) ? 'path' : 'number'
    tokens.push({ text, kind })
    offset = match.index + text.length
  }
  if (offset < line.length) tokens.push({ text: line.slice(offset) })
  return tokens
}

export const OutputText = memo(function OutputText({ text }: { text: string }) {
  return <>{text.split('\n').map((line, index) => {
    const exit = line.match(/^\s*(?:Exit code:\s*|exited\s+)(-?\d+)/i)
    const tone = exit ? (Number(exit[1]) === 0 ? 'success' : 'error')
      : /^\s*stderr:$/i.test(line) ? 'error' : /^\s*stdout:$/i.test(line) ? 'heading' : ''
    return <Fragment key={index}>{index > 0 && '\n'}<span className={tone ? `output-${tone}` : undefined}>
      {outputTokens(line).map((token, i) => token.kind
        ? <span key={i} className={`output-${token.kind}`}>{token.text}</span> : token.text)}
    </span></Fragment>
  })}</>
})

export function OutputDialog({ title, onClose, children }: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return createPortal(
    <ModalShell className="modal-overlay" label={title} onClose={onClose}>
      <div className="modal output-viewer" onKeyDown={event => event.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close output viewer"><X size={16} /></button>
        </div>
        <pre className="error-detail-text output-expanded-body" tabIndex={0} aria-label={title}>{children}</pre>
      </div>
    </ModalShell>, document.body,
  )
}

export default function CommandOutput({ text, title = 'Command output' }: { text: string; title?: string }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="command-output">
    <div className="output-toolbar">
      <button type="button" className="btn-secondary" onClick={() => setExpanded(true)} aria-label={`Expand ${title}`}>
        <Maximize2 size={12} /> Expand output
      </button>
    </div>
    <pre className="error-detail-text" tabIndex={0} aria-label={title}><OutputText text={text} /></pre>
    {expanded && <OutputDialog title={title} onClose={() => setExpanded(false)}><OutputText text={text} /></OutputDialog>}
  </div>
}
