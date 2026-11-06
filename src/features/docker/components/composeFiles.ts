import type { ComposeProject, DetectedFile } from '../types'

// Relative to the compose project dir, so ./nginx/Dockerfile and ./php/Dockerfile stay distinguishable.
export function relLabel(path: string, baseDir: string): string {
  const np = path.replace(/\\/g, '/')
  const nb = baseDir.replace(/\\/g, '/').replace(/\/$/, '')
  if (nb && np.toLowerCase().startsWith(nb.toLowerCase() + '/')) return np.slice(nb.length + 1)
  return np.split('/').pop() ?? path
}

export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : ''
}
export function dirNameOf(p: string): string {
  return dirOf(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? ''
}

// Compose config files first, then the detected extras, which must already be filtered.
type FileNav = { path: string; label: string; kind: 'compose' | 'dockerfile' | 'env' }
export function buildFileNav(project: ComposeProject, extras: DetectedFile[]): FileNav[] {
  const baseDir = dirOf(project.config_files[0] ?? '')
  return [
    ...project.config_files.map(f => ({ path: f, label: relLabel(f, baseDir), kind: 'compose' as const })),
    ...extras.map(pf => ({
      path:  pf.path,
      label: relLabel(pf.path, baseDir),
      kind:  (pf.kind === 'env' ? 'env' : 'dockerfile') as 'dockerfile' | 'env',
    })),
  ]
}

export const EMPTY_FILES: DetectedFile[] = []

// Resolve a build context + dockerfile into a normalized project-relative path,
// e.g. context "." + dockerfile "./nginx/Dockerfile" → "nginx/dockerfile".
export function refRelFrom(context: string, dockerfile: string): string {
  const parts: string[] = []
  const push = (seg: string) => {
    for (const s of seg.replace(/\\/g, '/').split('/')) {
      if (!s || s === '.') continue
      if (s === '..') { parts.pop(); continue }
      parts.push(s)
    }
  }
  push(context); push(dockerfile)
  return parts.join('/').toLowerCase()
}

export function parseDockerfileRefs(yaml: string): string[] {
  const lines = yaml.split('\n')
  const clean = (s: string) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
  const refs: string[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)build\s*:(.*)$/)
    if (!m) { i++; continue }
    const indent = m[1].length
    const inline = clean(m[2])
    if (inline) { refs.push(refRelFrom(inline, 'Dockerfile')); i++; continue }
    // Block form - scan deeper-indented context/dockerfile keys
    let context = '.', dockerfile = 'Dockerfile'
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (l.trim() === '') { i++; continue }
      const childIndent = l.length - l.trimStart().length
      if (childIndent <= indent) break
      const cm = l.match(/^\s*context\s*:\s*(.+)$/)
      const dm = l.match(/^\s*dockerfile\s*:\s*(.+)$/)
      if (cm) context = clean(cm[1])
      if (dm) dockerfile = clean(dm[1])
      i++
    }
    refs.push(refRelFrom(context, dockerfile))
  }
  return refs
}

// Anchors on the project dir name, so a bare "Dockerfile" ref matches the root one rather than
// a nested nginx/Dockerfile.
export function dockerfileMatchesRefs(path: string, refRels: string[], dirName: string): boolean {
  const np = path.replace(/\\/g, '/').toLowerCase()
  return refRels.some(rel => {
    if (!rel) return false
    if (dirName && np.endsWith(`/${dirName}/${rel}`)) return true
    return rel.includes('/') && np.endsWith(`/${rel}`)
  })
}
