/**
 * StorageManagerIpcService — 主进程把 `@tabtin/storage-manager` 注册中心
 * 暴露给渲染进程。
 *
 * 设计要点：
 *   - W2.1 已经在包内定义好了 5 个 IPC 通道 + 错误信封；本服务的责任是把
 *     真正的 Electron `ipcMain.handle` 注入进去。
 *   - 注册时机必须在所有主进程 bucket 注册之后（W2.2 G1/G3 已在
 *     `registerCoreProcessHandlers` 里完成）——否则首屏 listAllBuckets()
 *     会拿到不完整的 bucket 列表。
 *   - 注册本身是同步、无 IO；不会阻塞主进程启动。返回的 unregister 函数
 *     给热重启 / 卸载场景用，目前主进程生命周期未消费它。
 */

import { ipcMain } from 'electron'
import { registerStorageManagerIpc } from '@tabtin/storage-manager'
import { createLogger } from '../logger'

const log = createLogger('StorageManagerIpc')

let unregister: (() => void) | null = null

/**
 * 在主进程把 storage-manager 的 5 个 IPC handler 挂到 `ipcMain`。
 * 幂等：重复调用会先卸载旧的再注册（HMR / 测试场景安全）。
 */
export function initStorageManagerIpc(): void {
  if (unregister) {
    try {
      unregister()
    } catch (err) {
      log.warn('[storage-manager-ipc] previous unregister threw:', err)
    }
    unregister = null
  }

  unregister = registerStorageManagerIpc({
    handle: (channel, listener) => {
      // ipcMain.handle 自带幂等保护吗？答案是没有——重复 handle 会抛
      // "Attempted to register a second handler"。所以本服务用模块级
      // unregister 控幂等，注册前不主动 removeHandler（避免抢走别人的）。
      ipcMain.handle(channel, async (_event, ...args) => listener(_event, ...args))
    },
    removeHandler: (channel) => {
      ipcMain.removeHandler(channel)
    },
  })
}
