import { ipcRenderer } from 'electron'
import type { NavigateTarget } from '../main/services/notification/types'

type NavigateListener = (data: NavigateTarget) => void

let pendingNavigateTarget: NavigateTarget | null = null
const navigateListeners = new Set<NavigateListener>()

function handleNotificationNavigate(
  _event: Electron.IpcRendererEvent,
  data: NavigateTarget,
): void {
  if (!data?.type || !data?.id) return

  if (navigateListeners.size === 0) {
    pendingNavigateTarget = data
    return
  }

  for (const listener of navigateListeners) {
    listener(data)
  }
}

ipcRenderer.on('notification:navigate', handleNotificationNavigate)

export function onNotificationNavigate(callback: NavigateListener): () => void {
  navigateListeners.add(callback)

  if (pendingNavigateTarget) {
    callback(pendingNavigateTarget)
    pendingNavigateTarget = null
  }

  return () => {
    navigateListeners.delete(callback)
  }
}

export function _resetNotificationNavigateChannelForTest(): void {
  navigateListeners.clear()
  pendingNavigateTarget = null
}
