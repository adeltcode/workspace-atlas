import type { ReactNode } from 'react'

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
          <span className="dockerfile-arg">{renderEnvRefs(rest)}</span>
        </div>
      )
    }
  }

  return <div className="yaml-line">{line}</div>
}

export function renderEnvRefs(text: string): ReactNode {
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
