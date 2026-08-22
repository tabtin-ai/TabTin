/**
 * IpcInspector dev bridge（contract W2-ζ）— preload 侧
 *
 * 业务目标：让 renderer 端 IpcInspector 浮层能拿到两路调用记录：
 *
 *   1. **IPC 路径**：W2-α 的 `preload/ipc-shim.ts::invokeIpc()` 每次完成后
 *      call `notifyIpcCall(record)`，本桥维护订阅者列表，renderer 端通过
 *      `subscribeIpcCalls(cb)` 拿到通知。
 *   2. **HTTP 路径**：main/api-proxy 完成请求后 webContents.send(
 *      'ipc-inspector:http-call', record)，本桥的 `subscribeHttpCalls(cb)`
 *      转发给 renderer。
 *
 * **当前接通状态**（2026-05-03 W2-α/W2-ζ 同期完成）：
 * `ipc-shim.ts::invokeIpc()` 已经在每次完成时调用 `notifyIpcCallForInspector`
 * （内部通过本桥推到订阅者）；`subscribeIpcCalls` 由 renderer 侧 `ipc-call-bridge.ts`
 * 接收并写入 `ipc-call-buffer` ring buffer。HTTP 路径同样接通：main 端
 * `api-proxy.ts` 调 `pushHttpCallToInspector` → `webContents.send('ipc-inspector:http-call', ...)`。
 * 两路统一进 IpcInspector 浮层。
 *
 * ─── dev / prod guard ───────────────────────────────────────────────
 *
 * `process.env.NODE_ENV` 在 electron-vite 构建时被静态替换为字面量；
 * prod build 时 `buildDevInspectorBridge()` 返 null，preload 主 api
 * 对象的 `devInspector` 字段也是 null，renderer 看到 null 就不挂载。
 *
 * `notifyIpcCallForInspector` 自身永远导出（避免 W2-α 引用时类型错误），
 * 但函数体内用相同 guard——prod 模式下是 no-op。
 */

import type { IpcRenderer, IpcRendererEvent } from 'electron'

/**
 * 给 inspector 用的 record。形状跟 renderer/dev/ipc-call-buffer.ts 的
 * `IpcCallRecord` 一致——但本文件不能 import renderer 代码（preload
 * 是 sandbox 进程）；所以两边用相同形状定义两次，保持手动同步。
 *
 * **同步约定**：renderer 端 IpcCallRecord 字段变更时，必须同步本文件
 * 的 IpcCallRecordForInspector，否则跨进程消息形状漂移。
 */
export interface IpcCallRecordForInspector {
  readonly id: string
  readonly source: 'ipc' | 'http'
  readonly channel: string
  readonly args: unknown
  readonly result?: unknown
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly detail?: unknown
  }
  readonly status: 'ok' | 'error' | 'legacy' | 'pending'
  readonly trace_id?: string
  readonly duration_ms: number
  readonly startedAt: number
  readonly method?: string
  readonly url?: string
  readonly httpStatus?: number
}

type Subscriber = (record: IpcCallRecordForInspector) => void

/**
 * preload 进程内的 IPC 订阅者池。W2-α 的 invokeIpc() 完成后通过
 * `notifyIpcCallForInspector` 触发。renderer 通过 `subscribeIpcCalls`
 * 订阅。**preload 进程是单例**——所有 BrowserWindow 共享一个 preload
 * 实例的内存空间。
 */
const ipcCallSubscribers = new Set<Subscriber>()

/**
 * 判断是否启用 dev inspector。集中在一处便于测试覆盖；prod build 此
 * 值常量 false，所有相关分支被 esbuild dead-code-eliminate。
 */
function isInspectorEnabled(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * W2-α invokeIpc 完成时调用本函数。dev 模式下通知所有订阅者；prod
 * 模式 no-op。
 *
 * **为什么导出**：W2-α 的 ipc-shim.ts 内部调用，只能从 preload 内部
 * import；不能通过 contextBridge 暴露给 renderer（renderer 通过
 * `subscribeIpcCalls` 订阅，不主动 push）。
 */
export function notifyIpcCallForInspector(record: IpcCallRecordForInspector): void {
  if (!isInspectorEnabled()) return
  for (const sub of ipcCallSubscribers) {
    try {
      sub(record)
    } catch (e) {
      // 单订阅者错不能影响其他订阅者
      console.warn('[IpcInspector preload] subscriber threw:', e)
    }
  }
}

/**
 * 构建 renderer 端可用的 inspector bridge。dev 模式返对象，prod 返 null。
 *
 * 调用方（preload/index.ts）应判 null 决定是否挂到 `tabtin.devInspector`：
 *
 * ```ts
 * import { buildDevInspectorBridge } from './dev-inspector-bridge'
 *
 * const devInspector = buildDevInspectorBridge(ipcRenderer)
 *
 * const api = {
 *   ...,
 *   devInspector,  // null in prod build
 * }
 * ```
 *
 * 接受 `ipcRenderer` 作参数而不是直接 import：preload 主文件已 import
 * 了一次，避免本文件再 import 一次产生模块循环；同时单测里可以注入
 * mock ipcRenderer。
 */
export function buildDevInspectorBridge(ipcRenderer: IpcRenderer): {
  subscribeIpcCalls: (cb: Subscriber) => () => void
  subscribeHttpCalls: (cb: Subscriber) => () => void
} | null {
  if (!isInspectorEnabled()) return null

  return {
    /**
     * W2-α 接管点：当前 stub 等 W2-α 在 invokeIpc 完成时调用
     * `notifyIpcCallForInspector`。在 W2-α 上线前，没人调 notify，所以
     * 订阅者收不到 IPC 调用——这是预期的，因为 W2-α 自己的 invoke 路
     * 径还没接通。HTTP 路径不依赖 W2-α，已经能跑。
     */
    subscribeIpcCalls(callback: Subscriber): () => void {
      ipcCallSubscribers.add(callback)
      return () => {
        ipcCallSubscribers.delete(callback)
      }
    },

    /**
     * 订阅 main 端 api-proxy push 的 HTTP 调用记录。
     *
     * channel 名 'ipc-inspector:http-call' 是约定的 inspector 专用通道，
     * 只在 dev 模式下被 main 端 push（main/api-proxy.ts 同样用 NODE_ENV
     * guard）。prod 模式 main 不发，subscribe 也是 no-op（这里走不到，
     * 因为整个 bridge 已经是 null）。
     */
    subscribeHttpCalls(callback: Subscriber): () => void {
      const handler = (_event: IpcRendererEvent, record: IpcCallRecordForInspector) => {
        callback(record)
      }
      ipcRenderer.on('ipc-inspector:http-call', handler)
      return () => {
        ipcRenderer.removeListener('ipc-inspector:http-call', handler)
      }
    },
  }
}

/** 仅供单测：清空订阅者池。 */
export function __resetIpcInspectorBridgeForTests(): void {
  ipcCallSubscribers.clear()
}
