import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ResourceMonitorSnapshotMode } from '@shared/types/resource-monitor'
import { getResourceMonitorService } from './ResourceMonitorService'
import { guardedHandle } from '../utils/guarded-handle'

type ResourceMonitorIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

/**
 * Channel→handler 映射。新增/删除 channel 时必须同步更新 ipc-lazy.ts 的
 * ResourceMonitorIPC channels 列表。
 */
export const resourceMonitorHandlers = {
  'resource-monitor:getSnapshot': async (
    _event: IpcMainInvokeEvent,
    options?: { mode?: ResourceMonitorSnapshotMode; force?: boolean },
  ) => {
    return getResourceMonitorService().getSnapshot(options)
  },
} satisfies Record<string, ResourceMonitorIpcHandler>

export function registerResourceMonitorIpcHandlers(): void {
  for (const channel of Object.keys(resourceMonitorHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  for (const [channel, handler] of Object.entries(resourceMonitorHandlers)) {
    guardedHandle(channel, handler as ResourceMonitorIpcHandler)
  }
}

export function unregisterResourceMonitorIpcHandlers(): void {
  for (const channel of Object.keys(resourceMonitorHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
}
