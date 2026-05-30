export interface TerminalLine {
  id: string
  text: string
  type: 'cmd' | 'stdout' | 'stderr' | 'info' | 'success' | 'error'
  ts: number
}
