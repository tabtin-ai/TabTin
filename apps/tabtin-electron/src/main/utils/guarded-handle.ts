import { ipcMain, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron'
import { errResponse, type CliErrorResponse } from '@tabtin/agent-wire'
import { isTrustedSender, isTinSandboxSender } from '../auth'
import { createLogger } from '../logger'
import {
  getCurrentTraceId,
  runWithGeneratedTrace,
  stampTraceIntoEnvelope,
} from './trace-context'

const log = createLogger('GuardedHandle')

/**
 * Recursively freeze every plain-object property reachable from `value`.
 *
 * `Object.freeze` is shallow — `Object.freeze({error:{...}})` leaves the
 * inner `error` mutable. Deep-freeze closes that footgun for the
 * UNAUTHORIZED reject path so a buggy renderer / future
 * `(envelope.error as any).detail = ...` style mutation in main code
 * cannot poison a previously-returned envelope reference.
 *
 * Implementation note: arrays / typed arrays / Maps / Sets do not appear
 * in our envelopes today, so a plain-object recursion is enough.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deepFreeze((value as any)[key])
    }
  }
  return value
}

/**
 * Per-call factory for the sender-guard rejection envelope.
 *
 * Wave 0 contract — wire shape is the JSON form
 * `{"ok": false, "error": {"code": "UNAUTHORIZED", "message": "..."}}`
 * which matches `@tabtin/agent-wire`'s `CliErrorResponse`. Renderer code
 * branches on `ok === false` rather than the legacy `success` field.
 *
 * Wave 1 (D3) status: the rejection is **stamped per-call** with the
 * current `AsyncLocalStorage` trace_id (set by `guardedHandle` /
 * `ipc-lazy` stub at the IPC entry boundary). This is why we no longer
 * export a frozen singleton — each call needs its own envelope to
 * carry the call-specific trace_id, otherwise the user's screenshot
 * "操作失败 (req: a3b2c1)" cannot be grep'd back to the rejecting log
 * line.
 *
 * Each produced envelope is still deep-frozen, so a caller cannot
 * mutate the envelope after we return it (the freeze guarantee from
 * W0 is preserved on a per-call basis). The Wave 0 "shared singleton"
 * test was relaxed accordingly — see
 * `apps/tabtin-electron/src/main/utils/__tests__/guarded-handle.test.ts`.
 *
 * Historical context: the legacy `{ success:false, error:string }` form
 * collided with handlers that legitimately return
 * `{ success:false, ... }` as data; W0 replaced it with the wire
 * envelope so failure signals are observable end-to-end.
 *
 * Exported (`buildUnauthorizedReject`) so other sender-guard paths
 * (notably `ipc-lazy.ts`, which owns its own stub-level rejection) can
 * import and reuse the same factory instead of redefining the shape —
 * any future shape change happens in this file once.
 */
export function buildUnauthorizedReject(): Readonly<CliErrorResponse> {
  return deepFreeze(
    errResponse('UNAUTHORIZED', 'Unauthorized: untrusted origin', {
      trace_id: getCurrentTraceId(),
    }),
  )
}

/**
 * ipcMain.handle 的安全封装 — 自动验证 senderFrame 来源 + 启动 trace
 * context。
 *
 * 仅允许来自受信任渲染进程的调用，外部页面 / 第三方 WebContents 的
 * 调用将被直接拒绝并记录日志。
 *
 * 拒绝路径返回的形状是 `{ ok:false, error:{ code:'UNAUTHORIZED', message }, trace_id }`
 * （`@tabtin/agent-wire` 的 envelope + W1 D3 trace_id stamp）。
 * renderer 端看到 ``ok === false`` 即可统一处理，不必再去 sniff 老的
 * `{ success:false, error:string }` 形状。
 *
 * Wave 1 D3 — 每次 invoke 进来 wrapper 会：
 *   1. `runWithGeneratedTrace` 启动一个新的 ALS context（generate 12
 *      字符 nanoid 作为 trace_id）
 *   2. listener 内部所有 `errResponse` / `okResponse` / `api-proxy` 的
 *      HTTP 请求自动拿到这个 trace_id
 *   3. listener return 后 `stampTraceIntoEnvelope` 自动把 trace_id 写到
 *      返回 envelope 的顶层（如果它是 envelope 形状且未带 trace_id）
 *
 * 这样 IPC handler 的实现层完全不需要感知 trace_id——写新 handler
 * 默认就有，符合"靠工具不靠纪律"。
 */
export function guardedHandle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => any,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    return runWithGeneratedTrace(async () => {
      if (!isTrustedSender(event)) {
        log.warn(
          `IPC 调用被拒绝: ${channel} (trace_id=${getCurrentTraceId()})，来源: ${event.senderFrame?.url}`,
        )
        return buildUnauthorizedReject()
      }
      try {
        const result = await listener(event, ...args)
        return stampTraceIntoEnvelope(result)
      } catch (err) {
        // IPC 边界统一兜底：handler 抛出的异常会透传给 renderer，但主进程侧
        // 若不记录，打包版 main.log 里就完全看不到"哪个 channel 失败了"。
        log.error(`IPC handler 抛出异常: ${channel} (trace_id=${getCurrentTraceId()}):`, err)
        throw err
      }
    })
  })
}

/**
 * ipcMain.on 的安全封装 — 用于单向事件监听（无返回值）。
 * 不可信来源的事件将被静默丢弃并记录日志。
 *
 * Wave 1 D3 — 同步事件没有返回值，但仍然在 ALS context 内执行 listener，
 * 让 listener 内部如果调 api-proxy 等异步路径也能享受到 trace 关联。
 */
export function guardedOn(
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => void,
): void {
  ipcMain.on(channel, (event: IpcMainEvent, ...args: any[]) => {
    if (!isTrustedSender(event)) {
      log.warn(`IPC 事件被拒绝: ${channel}，来源: ${event.senderFrame?.url}`)
      return
    }
    runWithGeneratedTrace(() => {
      try {
        listener(event, ...args)
      } catch (err) {
        // 单向事件没有返回通道，listener 抛错会变成未处理异常；这里兜底记录。
        log.error(`IPC 事件 listener 抛出异常: ${channel} (trace_id=${getCurrentTraceId()}):`, err)
      }
    })
  })
}

/**
 * 创建带 channel 追踪的 guardedHandle 工厂。
 * 返回的函数签名与 guardedHandle 相同，但会将 channel 名追加到 channelList，
 * 便于模块级 cleanup 时统一 removeHandler。
 */
export function createGuardedTrackHandle(channelList: string[]) {
  return (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => any,
  ): void => {
    channelList.push(channel)
    guardedHandle(channel, listener)
  }
}

/**
 * 接受 tin sandbox webview 来源的 guardedHandle 变体。
 *
 * **背景**：`tin-bridge:request` 是给已安装 Tin 的 sandbox webview 调用的
 * 专用 channel——sandbox 是用户安装的第三方代码（譬如 `tabtin-demo-app`），
 * 来源 URL 是 `https://*.tin-sandbox.tabtin.local/...`，**不是** trusted
 * sender。所以默认的 `isTrustedSender` 会把它拒掉。
 *
 * 但 sandbox 调 tin-bridge 是合法产品语义（沙箱 → 宿主通信，类似 Chrome
 * Extension 的 chrome.* API），需要单独放行。
 *
 * **为什么不让 `isTrustedSender` 直接放宽**：trusted = "我们写的 first-
 * party 代码"，包括 file:// preload 和 devtools。tin sandbox 是第三方
 * 代码，可能是恶意的——把它跟 first-party 等同会污染整套 sender 模型。
 * 所以这里独立一个 helper，明确"这个 channel 接受 tin sandbox 是个
 * 特殊 case"，每用一处都需要 review 是否真的应该放行。
 *
 * **行为**：与 `guardedHandle` 完全一致，**只在 sender guard 一步**多放一个
 * `isTinSandboxSender` 检查；trace context、envelope wrapping、stamp
 * trace_id 等其它逻辑全复用。
 *
 * 当前唯一调用方：`tins/tin-bridge.ts` 注册的 `tin-bridge:request`（
 * sandbox 内 `window.tin.*` API 全部走这一个 channel）。
 */
export function guardedHandleAllowingTinSandbox(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => any,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    return runWithGeneratedTrace(async () => {
      if (!isTrustedSender(event) && !isTinSandboxSender(event)) {
        log.warn(
          `IPC 调用被拒绝（含 tin sandbox 检查）: ${channel} (trace_id=${getCurrentTraceId()})，来源: ${event.senderFrame?.url}`,
        )
        return buildUnauthorizedReject()
      }
      try {
        const result = await listener(event, ...args)
        return stampTraceIntoEnvelope(result)
      } catch (err) {
        log.error(`IPC handler 抛出异常（tin sandbox）: ${channel} (trace_id=${getCurrentTraceId()}):`, err)
        throw err
      }
    })
  })
}
