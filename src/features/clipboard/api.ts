import { invoke } from '../../utils/errors'
import type { ProcessInfo } from '../holders/api'

export type OtherProgramKind = 'keeps-history' | 'uses-windows-history' | 'shares-clipboard' | 'clears-clipboard'

export interface OtherProgram {
  label: string
  kind: OtherProgramKind
  process: ProcessInfo
}

export interface ClipboardStatus {
  history_on: boolean
  /** Null when the value was never set, which Windows treats as off. */
  user_setting: boolean | null
  blocked_by_policy: boolean
  /** Set by a device management service, which would put it back if it were removed here. */
  block_is_managed: boolean
  sync_on: boolean
  /** Windows is set not to start the clipboard service. */
  service_disabled: boolean
  /** The service is not running and cannot start. A change to service_disabled only reaches the
   *  running session at the next sign-in, so the two can differ. */
  service_stopped: boolean
  win_v_disabled: boolean
  /** A program that has kept the clipboard open, so others cannot copy or paste. */
  held_by: ProcessInfo | null
  other_programs: OtherProgram[]
}

export interface ItemContent {
  formats: string[]
  /** Cut to 100,000 characters. */
  text: string | null
  /** The whole text's length. */
  text_length: number | null
  has_image: boolean
  has_html: boolean
  has_files: boolean
}

export interface HistoryEntry {
  id: string
  /** Milliseconds since 1970. */
  copied_at: number
  /** Null for an item the page already has. */
  content: ItemContent | null
}

export interface ClipboardItem extends ItemContent {
  id: string
  copied_at: number
}

export interface CurrentClipboard extends ItemContent {
  owner: ProcessInfo | null
  kept_out_of_history: boolean
}

export interface ClipboardRead {
  history_on: boolean
  entries: HistoryEntry[]
  /** Null while the clipboard has not changed, or when another program has it open. */
  current: CurrentClipboard | null
  sequence: number | null
}

export const clipboardStatus = () => invoke<ClipboardStatus>('clipboard_status')
export const clipboardRead = (knownIds: string[], knownSequence: number | null) =>
  invoke<ClipboardRead>('clipboard_read', { knownIds, knownSequence })
export const clipboardSetHistory = (on: boolean) => invoke<void>('clipboard_set_history', { on })
export const clipboardCopyItem = (id: string) => invoke<void>('clipboard_copy_item', { id })
export const clipboardDeleteItem = (id: string) => invoke<void>('clipboard_delete_item', { id })
export const clipboardClearHistory = () => invoke<void>('clipboard_clear_history')
export const clipboardClearCurrent = () => invoke<void>('clipboard_clear_current')
export const clipboardItemImage = (id: string) => invoke<ArrayBuffer>('clipboard_item_image', { id })
export const clipboardRemoveBlock = () => invoke<void>('clipboard_remove_block')
export const clipboardRestartService = () => invoke<void>('clipboard_restart_service')
export const clipboardEnableService = () => invoke<void>('clipboard_enable_service')
export const clipboardOpenSettings = () => invoke<void>('clipboard_open_settings')
