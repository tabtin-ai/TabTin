import { ipcMain } from 'electron'
import { getSessionManager } from './SessionManager'
import { guardedHandle } from '../utils/guarded-handle'

export function registerSessionIpcHandlers(): void {
  const manager = getSessionManager()

  // W6 批次 1：session:create / session:get / session:list / session:delete
  // 已迁到 PlatformSurface（startup-services.ts 注册）。
  // 下面只保留未迁移的 3 个 handler。

  guardedHandle('session:setCurrentTrace', (_event, sessionId: string, traceId: string) => {
    manager.setCurrentTrace(sessionId, traceId)
    return { success: true }
  })

  guardedHandle('session:addTrace', (_event, sessionId: string, trace: { traceId: string; runId: string; status: 'running' | 'completed' | 'error'; startedAt: number; endedAt: number | null; error?: string }) => {
    manager.addTrace(sessionId, trace)
    return { success: true }
  })

  guardedHandle('session:updateTraceStatus', (_event, sessionId: string, traceId: string, status: 'running' | 'completed' | 'error', error?: string) => {
    manager.updateTraceStatus(sessionId, traceId, status, error)
    return { success: true }
  })
}

export function unregisterSessionIpcHandlers(): void {
  ipcMain.removeHandler('session:create')
  ipcMain.removeHandler('session:get')
  ipcMain.removeHandler('session:list')
  ipcMain.removeHandler('session:delete')
  ipcMain.removeHandler('session:setCurrentTrace')
  ipcMain.removeHandler('session:addTrace')
  ipcMain.removeHandler('session:updateTraceStatus')
}
