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
    ? 'It keeps its own copy of what you copy, so your copies are saved twice. Deleting or clearing here does not touch its copy.'
    : 'It keeps its own copy of what you copy, even while Windows history is off. This page cannot show its copy.'),
  'uses-windows-history': historyOn => (historyOn
    ? 'It can show this same history.'
    : 'It can show Windows clipboard history, but it has nothing to show while history is off.'),
  'shares-clipboard': () => 'It shares your clipboard with another device or virtual machine, so what you copy may also go there.',
  'clears-clipboard': () => 'It may empty the clipboard after you copy a password, and may keep passwords out of history.',
}

export type NoticeAction = 'remove-block' | 'restart-service' | 'enable-service' | 'open-settings'

export interface ClipboardNotice {
  key: string
  tone: 'warn' | 'info'
  title: string
  detail: string
  action?: NoticeAction
  /** A program the user can close from this notice. */
  program?: ProcessInfo
}

/** What is getting in the way of clipboard history, most urgent first. */
export function noticesFor(status: ClipboardStatus): ClipboardNotice[] {
  const notices: ClipboardNotice[] = []
  const state = historyState(status)

  if (status.held_by) {
    notices.push({
      key: 'held',
      tone: 'warn',
      title: `${status.held_by.name} has the clipboard open`,
      detail: 'Other programs cannot copy or paste until it lets go.',
      program: status.held_by,
    })
  }
  if (state === 'blocked') {
    notices.push(status.block_is_managed
      ? {
        key: 'blocked',
        tone: 'warn',
        title: 'Your organization blocks clipboard history on this PC',
        detail: 'A device management service set this policy, so it would come back if it were removed. Ask whoever manages this PC.',
      }
      : {
        key: 'blocked',
        tone: 'warn',
        title: 'A policy on this PC blocks clipboard history',
        detail: 'Windows ignores the on and off setting until the policy is removed. A cleanup tool, or whoever manages this PC, may have set it.',
        action: 'remove-block',
      })
  } else if (status.blocked_by_policy) {
    notices.push({
      key: 'blocked-later',
      tone: 'warn',
      title: 'A policy on this PC blocks clipboard history',
      detail: 'History is still on because the clipboard service has not looked at the policy yet. It stops working the next time the setting changes.',
    })
  }
  if (state === 'not-applied') {
    notices.push({
      key: 'not-applied',
      tone: 'warn',
      title: 'Windows has not applied this setting',
      detail: 'History is set to on, but the clipboard service is not using it. Try turning it on again. If that does not work, restart the service.',
      action: 'restart-service',
    })
  }
  if (status.service_disabled) {
    notices.push({
      key: 'service',
      tone: 'warn',
      title: 'The clipboard service is disabled',
      detail: status.service_stopped
        ? 'Windows cannot keep history without it. A cleanup tool may have turned it off. After you turn it back on, sign out of Windows and back in.'
        : 'It is still running, but history stops working the next time you sign in. A cleanup tool may have turned it off.',
      action: 'enable-service',
    })
  } else if (status.service_stopped) {
    notices.push({
      key: 'service',
      tone: 'warn',
      title: 'Sign out of Windows and back in to start the clipboard service',
      detail: 'The service is set to start again, but Windows only starts it when you sign in.',
    })
  }
  if (status.sync_on) {
    notices.push({
      key: 'sync',
      tone: 'warn',
      title: 'Clipboard sync is on',
      detail: 'What you copy can go to your other devices through your Microsoft account.',
      action: 'open-settings',
    })
  }
  for (const { label, kind, process } of status.other_programs) {
    notices.push({
      key: `program-${process.pid}`,
      tone: kind === 'keeps-history' ? 'warn' : 'info',
      title: `${label} is running`,
      detail: OTHER_PROGRAM_NOTE[kind](status.history_on),
      program: kind === 'keeps-history' ? process : undefined,
    })
  }
  if (status.win_v_disabled) {
    notices.push({
      key: 'win-v',
      tone: 'info',
      title: 'The Win+V shortcut is turned off',
      detail: "Windows' own clipboard panel will not open with it. This page still works.",
    })
  }
  return notices
}
