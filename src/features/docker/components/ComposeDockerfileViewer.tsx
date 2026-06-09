import { useRef, type ReactNode } from 'react'

// ── Dockerfile syntax highlighter ─────────────────────────────────────────────

const INSTRUCTIONS = new Set([
  'FROM','RUN','COPY','ADD','WORKDIR','EXPOSE','ENV','ARG','LABEL',
  'CMD','ENTRYPOINT','USER','VOLUME','HEALTHCHECK','SHELL','STOPSIGNAL','ONBUILD','MAINTAINER',
])

export function DockerfileLine({ line }: { line: string }) {
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

function renderDockerArg(text: string): ReactNode {
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

// ── View-only component (editing is owned by ComposeTab so the Edit/Save
//    controls live in the shared toolbar, consistent with the compose view) ────

interface Props {
  content: string
}

export default function ComposeDockerfileViewer({ content }: Props) {
  const numsRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  const syncScroll = () => {
    if (areaRef.current && numsRef.current)
      numsRef.current.scrollTop = areaRef.current.scrollTop
  }

  return (
    <div className="compose-code-wrap">
      <div className="compose-line-nums" aria-hidden ref={numsRef}>
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="compose-code-area" ref={areaRef} onScroll={syncScroll}>
        <div className="compose-code-body">
          {lines.map((line, i) => <DockerfileLine key={i} line={line} />)}
        </div>
      </div>
    </div>
  )
}
