import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '../../store/appStore'
import * as api from './api'

/** Lives outside the page and saves to the store, so a scan and its result survive leaving the page. */
export async function runCacheScan() {
  const store = useAppStore.getState()
  if (store.cacheScanProgress) return
  store.setCacheScanError(null)
  store.setCacheScanProgress({ folder: '', found: 0 })
  const unlisten = await listen<{ folder: string; found: number }>('cache-scan-progress', e => store.setCacheScanProgress(e.payload))
  try {
    store.setCacheScan(await api.cachesScan(useAppStore.getState().cacheRoots))
  } catch (e) {
    store.setCacheScanError(e)
  } finally {
    unlisten()
    store.setCacheScanProgress(null)
  }
}
