/**
 * 同步 IPC（`ipcMain.on` + `event.returnValue`）的 envelope 包装。
 *
 * ─── 背景 ─────────────────────────────────────────────────────────
 *
 * 普通 IPC（`ipcMain.handle` + `ipcRenderer.invoke`）由 `guardedHandle`
 * 包裹：sender guard 失败返 envelope `{ ok: false, error: { code: 'UNAUTHORIZED' } }`，
 * 业务异常透传 `throw` → renderer 拿到 reject。
 *
 * **同步 IPC**（`ipcMain.on(...)` 内写 `event.returnValue = ...`，配合
 * renderer 端 `ipcRenderer.sendSync(...)`）的语义不一样：
 *   - listener 必须是同步函数（不能 async / await）
 *   - 异常无法跨进程传播——`throw` 只会让 main 进程 listener 内部崩，
 *     renderer 端拿到 `undefined` returnValue，调用方根本不知道发生了什么
 *   - sender guard 失败时只能"写一个错误形态到 returnValue"
 *
 * 这种语义差异导致历史代码（`terminal/ipc.ts:365` 老 pty:snapshot-save-sync）
 * 写自己的 legacy `{ success: false, error: string }` 拒绝形态——跟 W0/W1
 * 推动的 envelope SSoT 完全脱节。
 *
 * ─── 本 helper 解决什么 ───────────────────────────────────────────
 *
 * `guardedSyncOn(channel, listener)` 把 envelope SSoT 应用到同步 IPC：
 *
 *   1. **sender guard**：不可信来源 → `event.returnValue = errResponse('UNAUTHORIZED', ...)`
 *   2. **业务返值**：listener return 的对象自动 wrap 成 `okResponse(value)`，
 *      writes to `event.returnValue`
 *   3. **业务异常**：listener throw → `event.returnValue = errResponse('INTERNAL_ERROR', err.message)`
 *      （同步路径无 promise，不能透传，但**至少** renderer 端能在 envelope
 *      里看到失败）
 *   4. **trace_id**：用 `runWithGeneratedTrace` 包整个 listener body，让
 *      `stampTraceIntoEnvelope` 自动注入 nanoid(12) trace_id。renderer 截屏
 *      末 6 位仍可 grep main log。
 *
 * ─── 设计取舍 ─────────────────────────────────────────────────────
 *
 * 1. **listener 返值 vs 业务对象**：listener 直接 return 业务对象（譬如
 *    `{ saved: 5, failed: 0 }`），由 helper 自动 wrap 成 `{ ok: true, data: {...} }`。
 *    listener 不应自己构造 envelope——这一层抽象的意义就是让 listener 内部
 *    跟 sync 函数一样（return value / throw error）。
 *
 * 2. **不复用 `runWithGeneratedTrace` block 内的同步异常**：sync listener
 *    throw 时 `traceContextStorage.run` 会把异常 re-throw。本 helper 在
 *    `try/catch` 把它转成 envelope 形态，不让异常逃出 ipcMain.on 边界。
 *
 * 3. **类型签名**：listener 返 `unknown`，因为 sync IPC 边界拿到的参数
 *    形状是 IPC 序列化的 JSON——具体业务校验由 listener 内部处理。返值
 *    类型由 helper 用 `okResponse` 包成 envelope，TS 端无 `T` 泛型必要
 *    （renderer 端拿到的总是 `CliResponse<unknown>`）。
 *
 * 4. **是否复用通用 `guardedOn`**：`utils/guarded-handle.ts` 的 `guardedOn`
 *    是单向事件（无 returnValue），用 `runWithGeneratedTrace` 跑 listener
 *    后**直接 return**。同步 IPC 必须 set returnValue，语义不同——
 *    所以这里独立一份 helper。
 *
 * ─── 未来扩展 ─────────────────────────────────────────────────────
 *
 * 当前仓内 `ipcMain.on('xxx-sync', ...)` 同步 IPC 仅 1 处
 * （`pty:snapshot-save-sync`，beforeunload 兜底快照）。如果未来再有同步
 * IPC 需要加（譬如 storage:read-sync 之类配置启动），用本 helper 即可。
 *
 * 注：renderer 端 `ipcRenderer.sendSync('xxx', ...)` 拿到的是 envelope，
 * 调用方需要解 `r.ok ? r.data : null`。preload shim 严格化（W2-α）会
 * 把这条统一掉。
 */

import { ipcMain, type IpcMainEvent } from 'electron'
import { errResponse, okResponse, type CliResponse } from '@tabtin/agent-wire'
import { isTrustedSender } from '../auth'
import { createLogger } from '../logger'
import {
  getCurrentTraceId,
  runWithGeneratedTrace,
  stampTraceIntoEnvelope,
} from '../utils/trace-context'

const log = createLogger('GuardedSyncOn')

/**
 * 同步 IPC handler 的 listener 签名。
 *
 * - 必须是**同步**函数（不能 async / await）——`ipcMain.on` 写
 *   returnValue 的语义要求 listener 在返回前给 returnValue 赋值。
 * - 返值可以是任意 JSON-serializable 对象；helper 会 wrap 成
 *   `okResponse(value)`。
 * - 抛异常会被 helper 接住转成 `errResponse('INTERNAL_ERROR', err.message)`。
 */
export type SyncIpcListener = (event: IpcMainEvent, ...args: any[]) => unknown

/**
 * 注册一个 envelope 化的同步 IPC handler。
 *
 * @param channel  IPC channel 名（与 renderer `ipcRenderer.sendSync` 配对）
 * @param listener 业务逻辑——同步函数；返值会被自动 wrap 成
 *                 `okResponse`，throw 会被 wrap 成 `errResponse`
 *
 * 行为：
 * - sender guard 失败 → `event.returnValue` 为 `{ ok:false, error:{ code:'UNAUTHORIZED', ... }, trace_id }`
 * - listener 返 `T` → `event.returnValue` 为 `{ ok:true, data: T, trace_id }`
 * - listener throw → `event.returnValue` 为 `{ ok:false, error:{ code:'INTERNAL_ERROR', message:err.message }, trace_id }`
 *
 * 调用方使用：
 * ```ts
 * guardedSyncOn('pty:snapshot-save-sync', (_event, snapshots: unknown) => {
 *   if (!Array.isArray(snapshots)) {
 *     throw new Error('invalid params')
 *   }
 *   const valid = filterValidSnapshots(snapshots)
 *   if (valid.length === 0) {
 *     return { saved: 0, failed: snapshots.length }
 *   }
 *   return saveAllSnapshots(valid)
 * })
 * ```
 */
export function guardedSyncOn(channel: string, listener: SyncIpcListener): void {
  ipcMain.on(channel, (event, ...args) => {
    runWithGeneratedTrace(() => {
      if (!isTrustedSender(event)) {
        log.warn(
          `IPC 同步事件被拒绝: ${channel} (trace_id=${getCurrentTraceId()})，来源: ${event.senderFrame?.url}`,
        )
        const reject: CliResponse = stampTraceIntoEnvelope(
          errResponse('UNAUTHORIZED', 'Unauthorized: untrusted origin'),
        )
        event.returnValue = reject
        return
      }
      try {
        const result = listener(event, ...args)
        const envelope: CliResponse = stampTraceIntoEnvelope(okResponse(result))
        event.returnValue = envelope
      } catch (err) {
        log.error(`IPC 同步 listener 抛异常: ${channel}`, err)
        const message = err instanceof Error ? err.message : String(err)
        const envelope: CliResponse = stampTraceIntoEnvelope(
          errResponse('INTERNAL_ERROR', message),
        )
        event.returnValue = envelope
      }
    })
  })
}
