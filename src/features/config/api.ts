import { invoke } from '@tauri-apps/api/core'

/** Write the given config JSON to a user-chosen file. Returns the saved path, or null if cancelled. */
export const exportConfig = (contents: string) =>
  invoke<string | null>('export_config', { contents })

/** Read a user-chosen config file. Returns its contents, or null if cancelled. */
export const importConfig = () =>
  invoke<string | null>('import_config')
