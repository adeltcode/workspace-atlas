import type { ProcessInfo } from '../holders/api'
import type { ClipboardItem, ClipboardStatus, HistoryEntry, ItemContent, OtherProgramKind } from './api'

export type ItemKind = 'text' | 'link' | 'path' | 'color' | 'json' | 'email' | 'html' | 'image' | 'files' | 'other'
export type ClipboardFilter = 'all' | 'text' | 'image' | 'link' | 'secret'
export type ClipboardSortKey = 'copied' | 'type' | 'content' | 'size'
export type HistoryState = 'on' | 'off' | 'blocked' | 'not-applied' | 'service-off'

export const KIND_LABEL: Record<ItemKind, string> = {
  text: 'Text',
  link: 'Link',
  path: 'File path',
  color: 'Color',
  json: 'JSON',
  email: 'Email address',
  html: 'Formatted text',
  image: 'Image',
  files: 'Files',
  other: 'Other',
}

// clipboard.rs runs the admin commands, and a test there keeps them the same as these.
export const REMOVE_BLOCK_COMMAND = `Remove-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Name AllowClipboardHistory`
export const RESTART_SERVICE_COMMAND = 'Get-Service cbdhsvc_* | Restart-Service -Force'
export const ENABLE_SERVICE_COMMAND = 'Set-Service -Name cbdhsvc -StartupType Automatic'
export const CLEAR_HISTORY_COMMAND = '[Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime]::ClearHistory()'

export const historyCommand = (on: boolean) =>
  `reg add HKCU\\Software\\Microsoft\\Clipboard /v EnableClipboardHistory /t REG_DWORD /d ${on ? 1 : 0} /f`

const LINK = /^(?:https?|ftp):\/\/\S+$/i
const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\\\[^\\\s]+\\)[^\r\n<>"|?*]*$/i
const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([^()]*\))$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*\S+/i,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
]

/** Bits per character. Generated passwords score above about 3.5, and ordinary words below it. */
function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const share = n / text.length
    bits -= share * Math.log2(share)
  }
  return bits
}

function looksGenerated(text: string): boolean {
  return /^\S{16,128}$/.test(text)
    && /[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text)
    && entropy(text) > 3.5
}

export function isJson(text: string): boolean {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

export function formatJson(text: string): string | null {
  return isJson(text) ? JSON.stringify(JSON.parse(text.trim()), null, 2) : null
}

export function kindOf(item: ItemContent): ItemKind {
  if (item.text === null) {
    if (item.has_image) return 'image'
    if (item.has_files) return 'files'
    return item.has_html ? 'html' : 'other'
  }
  const text = item.text.trim()
  if (LINK.test(text)) return 'link'
  if (WINDOWS_PATH.test(text)) return 'path'
  if (COLOR.test(text)) return 'color'
  if (EMAIL.test(text)) return 'email'
  return isJson(text) ? 'json' : 'text'
}

/** A guess to warn the user, so a miss is possible. Every item starts hidden either way. */
export function looksSecret(item: ItemContent): boolean {
  if (item.text === null) return false
  const text = item.text.trim()
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) return true
  return kindOf(item) === 'text' && looksGenerated(text)
}

export const previewLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300)

export function textStats(text: string): { characters: number; words: number; lines: number } {
  const trimmed = text.trim()
  return {
    characters: text.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: text ? text.split(/\r\n|\r|\n/).length : 0,
  }
}

export const isCut = (item: ItemContent) =>
  item.text !== null && item.text_length !== null && item.text.length < item.text_length

export const countLabel = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`

export const sizeLabel = (item: ItemContent) =>
  item.text_length === null ? null : countLabel(item.text_length, 'character')

/** Plain text differs from a Copy only when the item also carries formatting. */
export const canCopyAsPlainText = (item: ItemContent) =>
  item.text !== null && !isCut(item) && (item.has_html || item.formats.includes('Rich Text Format'))

export function matchesFilter(item: ItemContent, filter: ClipboardFilter): boolean {
  switch (filter) {
    case 'all':    return true
    case 'image':  return kindOf(item) === 'image'
    case 'link':   return kindOf(item) === 'link'
    case 'secret': return looksSecret(item)
    case 'text':   return (item.text !== null || item.has_html) && kindOf(item) !== 'link'
  }
}

export function filterItems(items: ClipboardItem[], query: string, filter: ClipboardFilter): ClipboardItem[] {
  const q = query.trim().toLowerCase()
  return items.filter(item => {
    if (!matchesFilter(item, filter)) return false
    if (!q) return true
    return (item.text ?? '').toLowerCase().includes(q) || KIND_LABEL[kindOf(item)].toLowerCase().includes(q)
  })
}

function sortValue(item: ClipboardItem, key: ClipboardSortKey): string | number | null {
  switch (key) {
    case 'copied':  return item.copied_at
    case 'type':    return KIND_LABEL[kindOf(item)]
    case 'content': return item.text === null ? null : previewLine(item.text)
    case 'size':    return item.text_length
  }
}

/** Unknown values sort last in both directions, and ties fall back to the newest first. */
export function sortItems(items: ClipboardItem[], key: ClipboardSortKey, dir: 'asc' | 'desc'): ClipboardItem[] {
  return [...items].sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key)
    const newest = b.copied_at - a.copied_at
    if (va === null || vb === null) return va === vb ? newest : va === null ? 1 : -1
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base', numeric: true })
    return (dir === 'asc' ? cmp : -cmp) || newest
  })
}

/** The backend leaves out the content of items the page already has. */
export function mergeEntries(entries: HistoryEntry[], known: ClipboardItem[]): ClipboardItem[] {
  const byId = new Map(known.map(item => [item.id, item]))
  return entries.flatMap(({ id, copied_at, content }) => {
    if (content) return [{ ...content, id, copied_at }]
    const item = byId.get(id)
    return item ? [item] : []
  })
}

export function historyState(status: ClipboardStatus): HistoryState {
  if (status.service_stopped) return 'service-off'
  if (status.history_on) return 'on'
  if (status.blocked_by_policy) return 'blocked'
  return status.user_setting ? 'not-applied' : 'off'
}

const OTHER_PROGRAM_NOTE: Record<OtherProgramKind, (historyOn: boolean) => string> = {
  'keeps-history': historyOn => (historyOn
    ? 'Stores its own clipboard history, so items are saved twice. Deleting or clearing here does not affect its copy.'
    : 'Stores its own clipboard history even while Windows history is off. This page cannot read it.'),
  'uses-windows-history': historyOn => (historyOn
    ? 'Reads the same Windows clipboard history.'
    : 'Reads Windows clipboard history, which is empty while history is off.'),
  'shares-clipboard': () => 'Synchronizes the clipboard with another device or virtual machine.',
  'clears-clipboard': () => 'May clear the clipboard after a password is copied, and may exclude passwords from history.',
}

export type ClipboardAction = 'turn-on' | 'try-again' | 'remove-block' | 'restart-service' | 'enable-service' | 'open-settings'

export interface HistoryProblem {
  title: string
  detail: string
  /** The best fix first. */
  actions: ClipboardAction[]
}

/** Why history is not running, and what can fix it. */
export function problemFor(status: ClipboardStatus): HistoryProblem | null {
  switch (historyState(status)) {
    case 'on':
      return null
    case 'off':
      return {
        title: 'Clipboard history is off',
        detail: 'Windows retains only the current clipboard item. Enable history to retain the 25 most recent items.',
        actions: ['turn-on'],
      }
    case 'blocked':
      return status.block_is_managed
        ? {
          title: 'Clipboard history is blocked by device management',
          detail: 'A device management service sets this policy and would reapply it if removed. Contact the device administrator.',
          actions: ['open-settings'],
        }
        : {
          title: 'Clipboard history is blocked by policy',
          detail: 'AllowClipboardHistory is set to 0, so Windows ignores the history setting until the policy is removed. It may have been set by a cleanup tool or an administrator.',
          actions: ['remove-block', 'open-settings'],
        }
    case 'not-applied':
      return {
        title: 'Clipboard history is not active',
        detail: 'The setting is enabled, but the clipboard service has not applied it. Retry, or restart the service.',
        actions: ['try-again', 'restart-service'],
      }
    case 'service-off':
      return status.service_disabled
        ? {
          title: 'The clipboard service is disabled',
          detail: 'History requires the clipboard service (cbdhsvc). The current clipboard still works. A cleanup tool may have disabled it. After enabling it, sign out and back in.',
          actions: ['enable-service'],
        }
        : {
          title: 'Sign out to start the clipboard service',
          detail: 'The service is enabled, but Windows starts it only at sign-in. The current clipboard still works.',
          actions: [],
        }
  }
}

export interface ClipboardNotice {
  key: string
  /** `warn` needs attention, so it stays on the page. `info` is only worth knowing, so it waits behind a button. */
  tone: 'warn' | 'info'
  title: string
  detail: string
  action?: ClipboardAction
  /** A program the user can close from this notice. */
  program?: ProcessInfo
}

/** Everything else worth saying once problemFor has said why history is not running, most urgent first. */
export function noticesFor(status: ClipboardStatus): ClipboardNotice[] {
  const notices: ClipboardNotice[] = []
  const state = historyState(status)

  if (status.held_by) {
    notices.push({
      key: 'held',
      tone: 'warn',
      title: `${status.held_by.name} has the clipboard open`,
      detail: 'Copy and paste are blocked in other programs until it closes the clipboard.',
      program: status.held_by,
    })
  }
  if (state === 'on' && status.blocked_by_policy) {
    notices.push({
      key: 'blocked-later',
      tone: 'warn',
      title: 'Clipboard history is blocked by policy',
      detail: 'History remains active until the setting next changes.',
    })
  }
  if (status.service_disabled && !status.service_stopped) {
    notices.push({
      key: 'service',
      tone: 'warn',
      title: 'The clipboard service is disabled',
      detail: 'It is still running, but history stops at next sign-in.',
      action: 'enable-service',
    })
  }
  if (status.sync_on) {
    notices.push({
      key: 'sync',
      tone: 'warn',
      title: 'Clipboard sync is on',
      detail: 'Clipboard items can sync to other devices through the Microsoft account.',
      action: 'open-settings',
    })
  }
  for (const { label, kind, process } of status.other_programs) {
    notices.push({
      key: `program-${process.pid}`,
      tone: 'info',
      title: `${label} is running`,
      detail: OTHER_PROGRAM_NOTE[kind](status.history_on),
      program: kind === 'keeps-history' ? process : undefined,
    })
  }
  if (status.win_v_disabled) {
    notices.push({
      key: 'win-v',
      tone: 'info',
      title: 'The Win+V shortcut is disabled',
      detail: 'The Windows clipboard panel cannot be opened with it. This page is not affected.',
    })
  }
  return notices
}
