/**
 * Browser Environment IPC 注册 —— 本地化退役 Wave 1 重写。
 *
 * Channel 命名(都以 `browser-env:` 前缀,与 credential-vault 风格对齐):
 *
 * | Channel                                   | 形参                         | 返回 |
 * | ----------------------------------------- | ---------------------------- | ---- |
 * | browser-env:list                          | -                            | { environments, bindings } |
 * | browser-env:create                        | { name }                     | BrowserEnvWriteResult |
 * | browser-env:rename                        | { id, name }                 | BrowserEnvWriteResult |
 * | browser-env:delete                        | { id }                       | BrowserEnvDeleteResult |
 * | browser-env:bind-space                    | { spaceId, environmentId }   | BrowserEnvBindResult |
 * | browser-env:get-partition                 | { spaceId }                  | string (partition 不带 persist:) |
 * | browser-env:get-environment-for-space     | { spaceId }                  | BrowserEnvGetPartitionResult |
 *
 * 事件(主进程 → 渲染进程):
 * - `browser-env:changed` —— 内存快照更新时广播所有窗口。UI 侧可订阅
 *   实现"设置页改名后,其他已打开的 TabWeb 标签自动刷新"。
 *
 * ## 与 ipc-lazy 的协作
 *
 * 本模块同时支持两种使用方式：
 *
 * 1. **stub 模式（生产路径）**：ipc-lazy.ts 在 startup 同步注册所有 channel
 *    的 stub。第一次 invoke 时触发模块 import + `initBrowserEnvSideEffects`
 *    （订阅 onChanged 广播）。stub 直接调用 `browserEnvHandlers` 里的真函数。
 *
 * 2. **register 模式（测试/EAGER）**：直接调用 `registerBrowserEnvHandlers()`
 *    一次性完成「订阅 + 注册」。
 *
 * 两种模式 onChanged 订阅都只发生一次（用模块级 `onChangedUnsubscribe` 守卫）。
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'
import {
  BrowserEnvValidationError,
  DEFAULT_PARTITION_KEY,
  getBrowserEnvironmentService,
  type BrowserEnvChangePayload,
} from './BrowserEnvironmentService'
import type {
  BrowserEnvBindResult,
  BrowserEnvDeleteResult,
  BrowserEnvGetPartitionResult,
  BrowserEnvironment,
  BrowserEnvBinding,
  BrowserEnvWriteResult,
} from '../../shared/types/browser-env'

const log = createLogger('BrowserEnvIPC')

let onChangedUnsubscribe: (() => void) | null = null

function toErrorResult<T extends { success: boolean; code?: string; error?: string }>(
  err: unknown,
): T {
  if (err instanceof BrowserEnvValidationError) {
    return { success: false, code: err.code, error: err.message } as T
  }
  const msg = err instanceof Error ? err.message : String(err)
  return { success: false, code: 'BROWSER_ENV_INTERNAL_ERROR', error: msg } as T
}

function broadcastChange(payload: BrowserEnvChangePayload): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('browser-env:changed', payload)
    } catch (err) {
      log.debug('browser-env:changed 广播失败,忽略', err)
    }
  }
}

/**
 * 初始化 BrowserEnv 模块的副作用（订阅 onChanged → 广播 renderer）。
 * **幂等**：重复调用不会重复订阅。stub 路径下由 ipc-lazy 在第一次 import
 * 时调用；register 路径下由 registerBrowserEnvHandlers 调用。
 */
export function initBrowserEnvSideEffects(): void {
  if (onChangedUnsubscribe) return
  const service = getBrowserEnvironmentService()
  onChangedUnsubscribe = service.onChanged((payload) => {
    broadcastChange(payload)
  })
}

type BrowserEnvIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

/**
 * Channel→handler 映射。新增/删除 channel 时必须同步更新 ipc-lazy.ts 的
 * BrowserEnvIPC channels 列表。
 */
export const browserEnvHandlers = {
  'browser-env:list': async () => {
    try {
      const service = getBrowserEnvironmentService()
      const environments = service.listEnvironmentsSync() satisfies BrowserEnvironment[]
      const bindings = service.listBindingsSync() satisfies BrowserEnvBinding[]
      return { success: true, environments, bindings }
    } catch (err) {
      return toErrorResult(err)
    }
  },

  'browser-env:create': async (_e: IpcMainInvokeEvent, payload: { name: string }) => {
    try {
      const env = await getBrowserEnvironmentService().createEnvironment(payload?.name ?? '')
      return { success: true, environment: env } satisfies BrowserEnvWriteResult
    } catch (err) {
      return toErrorResult<BrowserEnvWriteResult>(err)
    }
  },

  'browser-env:rename': async (
    _e: IpcMainInvokeEvent,
    payload: { id: string; name: string },
  ) => {
    try {
      const env = await getBrowserEnvironmentService().renameEnvironment(payload?.id, payload?.name)
      return { success: true, environment: env } satisfies BrowserEnvWriteResult
    } catch (err) {
      return toErrorResult<BrowserEnvWriteResult>(err)
    }
  },

  'browser-env:delete': async (_e: IpcMainInvokeEvent, payload: { id: string }) => {
    try {
      const r = await getBrowserEnvironmentService().deleteEnvironment(payload?.id)
      return {
        success: true,
        deleted_id: r.deleted_id,
        rebound_bindings: r.rebound_bindings,
        rebound_space_ids: r.rebound_space_ids,
      } satisfies BrowserEnvDeleteResult
    } catch (err) {
      return toErrorResult<BrowserEnvDeleteResult>(err)
    }
  },

  'browser-env:bind-space': async (
    _e: IpcMainInvokeEvent,
    payload: { spaceId: string; environmentId: string },
  ) => {
    try {
      const env = await getBrowserEnvironmentService().bindSpaceToEnvironment(
        payload?.spaceId,
        payload?.environmentId,
      )
      return { success: true, environment: env } satisfies BrowserEnvBindResult
    } catch (err) {
      return toErrorResult<BrowserEnvBindResult>(err)
    }
  },

  'browser-env:get-partition': async (
    _e: IpcMainInvokeEvent,
    payload: { spaceId: string },
  ) => {
    const spaceId = payload?.spaceId ?? ''
    if (!spaceId) return DEFAULT_PARTITION_KEY
    return getBrowserEnvironmentService().getPartitionForSpace(spaceId)
  },

  'browser-env:get-environment-for-space': async (
    _e: IpcMainInvokeEvent,
    payload: { spaceId: string },
  ): Promise<BrowserEnvGetPartitionResult> => {
    const spaceId = payload?.spaceId ?? ''
    if (!spaceId) {
      return { partition: DEFAULT_PARTITION_KEY, environment: null, is_explicit: null }
    }
    const service = getBrowserEnvironmentService()
    const env = service.getEnvironmentBySpace(spaceId)
    const bindings = service.listBindingsSync()
    const binding = bindings.find((b) => b.space_id === spaceId)
    return {
      partition: env?.partition_key ?? DEFAULT_PARTITION_KEY,
      environment: env,
      is_explicit: binding ? binding.is_explicit : null,
    }
  },
} satisfies Record<string, BrowserEnvIpcHandler>

export function registerBrowserEnvHandlers(): void {
  for (const channel of Object.keys(browserEnvHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  initBrowserEnvSideEffects()
  for (const [channel, handler] of Object.entries(browserEnvHandlers)) {
    guardedHandle(channel, handler as BrowserEnvIpcHandler)
  }
  log.info('browser-env IPC handlers 注册完成')
}

export function unregisterBrowserEnvHandlers(): void {
  for (const channel of Object.keys(browserEnvHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  if (onChangedUnsubscribe) {
    try {
      onChangedUnsubscribe()
    } catch {
      /* ignore */
    }
    onChangedUnsubscribe = null
  }
}
