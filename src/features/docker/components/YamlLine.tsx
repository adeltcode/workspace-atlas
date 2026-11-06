import { ExternalLink, FileCode2, FolderOpen } from 'lucide-react'
import { renderEnvRefs } from './ComposeDockerfileViewer'

// Matches: optional-ip:hostPort:containerPort[/proto]
const PORT_RE = /^(?:[\d.]+:)?(\d+):\d+(?:\/(?:tcp|udp))?$/

function renderYamlValue(
  raw: string,
  onOpenPort?: (port: string) => void,
  onRevealPath?: (path: string) => void,
): React.ReactNode {
  if (!raw) return null
  const val     = raw.trimEnd()
  const trimmed = val.trimStart()
  if (!trimmed) return <span>{val}</span>

  const ci = trimmed.search(/ #/)
  if (ci > -1) {
    const v = val.slice(0, val.length - trimmed.length + ci)
    const c = val.slice(val.length - trimmed.length + ci)
    return <><span className="yaml-value">{v}</span><span className="yaml-comment">{c}</span></>
  }

  const stripped = trimmed.replace(/^['"]|['"]$/g, '')

  // Clickable port mapping: "3000:3000", "127.0.0.1:8080:80/tcp"
  if (onOpenPort) {
    const pm = stripped.match(PORT_RE)
    if (pm) {
      return (
        <button className="yaml-port-link" onClick={() => onOpenPort(pm[1])}>
          <span className="yaml-string">{val}</span>
          <ExternalLink size={9} className="yaml-port-icon" />
        </button>
      )
    }
  }

  // Clickable relative volume path: ./app, ./app:/container
  if (onRevealPath && (stripped.startsWith('./') || stripped.startsWith('../'))) {
    const source = stripped.split(':')[0]
    return (
      <button className="yaml-path-link" onClick={() => onRevealPath(source)}>
        <span className="yaml-value">{val}</span>
        <FolderOpen size={9} className="yaml-path-icon" />
      </button>
    )
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'"))
    return <span className="yaml-string">{val}</span>
  if (/^(true|false|null|yes|no|on|off)$/i.test(trimmed))
    return <span className="yaml-bool">{val}</span>
  if (/^-?\d+(\.\d+)?$/.test(trimmed))
    return <span className="yaml-number">{val}</span>
  if (trimmed.includes('$')) {
    return renderEnvRefs(val)
  }
  return <span className="yaml-value">{val}</span>
}

export default function YamlLine({
  line, onOpenPort, onRevealPath, onOpenDockerfile,
}: {
  line:             string
  onOpenPort?:      (port: string) => void
  onRevealPath?:    (path: string) => void
  onOpenDockerfile?:(value: string) => void
}) {
  const trimmed = line.trimStart()
  const indent  = line.length - trimmed.length
  if (!trimmed) return <div className="yaml-line">&nbsp;</div>
  if (trimmed.startsWith('#'))
    return <div className="yaml-line"><span className="yaml-comment">{line}</span></div>
  const km = line.match(/^(\s*)([\w.\-/]+)(\s*:)(.*)$/)
  if (km) {
    const [, pre, key, colon, rest] = km
    const depth = Math.floor(indent / 2)
    const isDockerfileRef = key === 'dockerfile' && !!onOpenDockerfile && rest.trim() !== ''
    return (
      <div className="yaml-line">
        <span>{pre}</span>
        <span className={depth === 0 ? 'yaml-key-root' : 'yaml-key'}>{key}</span>
        <span className="yaml-colon">{colon}</span>
        {rest
          ? (isDockerfileRef
              ? <> <button className="yaml-path-link" onClick={() => onOpenDockerfile!(rest)} title="Open this Dockerfile">
                  <span className="yaml-value">{rest.trim()}</span>
                  <FileCode2 size={9} className="yaml-path-icon" />
                </button></>
              : <> {renderYamlValue(rest, onOpenPort, onRevealPath)}</>)
          : null}
      </div>
    )
  }
  const lm = line.match(/^(\s*)(-)(\s+)(.*)$/)
  if (lm) {
    const [, pre, dash, sp, rest] = lm
    return (
      <div className="yaml-line">
        <span>{pre}</span><span className="yaml-dash">{dash}</span>
        <span>{sp}</span>{renderYamlValue(rest, onOpenPort, onRevealPath)}
      </div>
    )
  }
  return <div className="yaml-line">{line}</div>
}
