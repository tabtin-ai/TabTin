/**
 * Renderer 端 LEGACY 形态 IPC 响应的统一 unwrap helper。
 *
 * ## 背景
 *
 * Wave 2-α 完成后，`apps/tabtin-electron/src/preload/ipc-shim.ts` 的 `invokeIpc`
 * 已经做完所有 envelope 解包 / throw（含 envelope `ok:false` 短路抛出，即使 channel
 * 在 LEGACY_HANDLERS 内也会被识别）。但当前 main 端绝大多数 IPC handler 仍返
 * legacy `{success: bool, ...rest}` happy-path 形态——`invokeIpc` 透传 raw result
 * 给 caller，**caller 仍要主动判 `success` 字段**才能区分成功 / 失败。
 *
 * Wave 2-β 改造目标是把 renderer 70+ 处「裸判 success 字段 / 双分支返回错误码」
 * 形态全部迁到 `try/catch + invokeIpc` 模式，但**字面 wire 形态仍是 LEGACY**——这个
 * 矛盾用本 helper 统一收口：
 *
 *   - caller 只写 `try { const data = await window.tabtin.X.foo(...); ensureLegacyOk(data, 'foo'); ... }
 *     catch (err) { ... }`
 *   - 不再有「30 个文件各自写一遍 if-不-ok 弹错误 toast 再 return」
 *   - main 端迁 envelope 后 helper 退化为 identity（return raw），caller 代码无需再改
 *
 * ## 设计原则
 *
 * 1. **薄到不能再薄**：仅做 shape detection + throw，不做 toast / log / 上报——caller 自己接 catch
 * 2. **类型 assertion 友好**：`asserts raw is ...` 让 TS 在调用后自动 narrow `success: false` 分支掉
 * 3. **`error.code` 可携带**：throw 出来的 Error 是普通 Error；想拿 trace_id 末 6 位见
 *    `services/ipc-error.ts.formatIpcErrorForUser`（W1 已就位）。
 *    本 helper 不参与 trace_id——legacy 形态本来就没有 trace_id 字段。
 * 4. **业务目标对齐 D-2**：helper 自身知道 legacy 形态长啥样（`success` / `error` / `code`），
 *    但**caller 不再写**这些字段名——D-2"不留兼容代码"在 caller 层落地，helper 是过渡桥。
 *    W7 末 LEGACY_HANDLERS 清空时本 helper 整体删除。
 *
 * ## 何时**不该**用本 helper
 *
 * - **LLM tool result 协议层**（`run() → {success: bool, ...}`）：FC tool 跨厂商协议字段名，
 *   不是 IPC envelope。详见 W1 §五登记的 [P2] LLM tool result 协议字段名 vs envelope 同名分裂。
 * - **`tabtin-chat-client/HttpClient.unwrapResponse`** 已有的 envelope 双形态识别：
 *   HTTP 路径走 W2-ε `ChatAPIError` throw，不是 IPC 路径。
 * - **业务上需要"成功 / 失败"双分支处理且语义不是错误**（譬如 list 返 `{success: true, items}` /
 *   `{success: false, errorType: 'not_a_repo'}` 后者 caller 当成空列表显示）：这种场景
 *   `success: false` 不是 error，应保留 caller 自己的字段判断。
 */

/**
 * Legacy IPC 响应的 duck-type 形状。所有可选字段——main 端不同 handler
 * 字段集合不一，最小公倍 = `success` 决定性 / `error` / `code` 二选一作 message。
 */
export interface LegacyResultShape {
  success?: boolean
  error?: string
  code?: string
  /** 部分 handler 用 `message` 而非 `error`；helper 兜底两者。 */
  message?: string
}

/**
 * 检测 raw 是否为 legacy `{success: false}` 失败形态——是则 throw `Error`。
 *
 * 使用 TS 3.7+ assertion signature 让 caller 调用后 raw 类型自动 narrow 掉 `success: false` 分支。
 *
 * @param raw - IPC 调用 raw return（preload LEGACY 透传形态）
 * @param op  - 操作名，用于 error message fallback——出现在 toast / log 里给开发者定位
 * @throws Error 当 `raw.success === false` 时；message 优先 `raw.error || raw.code || raw.message || \`${op} failed\``
 *
 * @example
 * ```ts
 * try {
 *   const result = await window.tabtin.fileSystem.readDir(path)
 *   ensureLegacyOk(result, 'readDir')
 *   const entries = result.entries  // 此时 TS 知道 result 不会是 {success: false}
 * } catch (err) {
 *   toast.error(formatIpcErrorForUser(err))
 * }
 * ```
 */
export function ensureLegacyOk<T>(
  raw: T,
  op: string,
): asserts raw is Exclude<T, { success: false }> {
  if (raw === null || raw === undefined) {
    throw new Error(`${op}: empty result`)
  }
  if (typeof raw !== 'object') return
  const r = raw as LegacyResultShape
  if (r.success === false) {
    const msg = r.error || r.code || r.message || `${op} failed`
    throw new Error(msg)
  }
}

/**
 * 把 legacy `{success: false, error?, code?}` 形态转成 boolean——用于"双分支判断
 * 但不抛错"的 caller（譬如 `if (!ok) silent return`）。
 *
 * 与 `ensureLegacyOk` 的区别：本 helper **不抛**——caller 显式区分成功 / 失败语义。
 *
 * @returns `true` 当响应是成功（无 success 字段也算成功，wire 不一致 = legacy 默认行为）
 */
export function isLegacyOk(raw: unknown): boolean {
  if (raw === null || raw === undefined || typeof raw !== 'object') return true
  const r = raw as LegacyResultShape
  return r.success !== false
}

/**
 * 提取 legacy 错误描述文本——按字段优先级 `error > code > message`。
 *
 * @param raw - IPC 调用 raw return
 * @param fallback - 上述字段全空时的兜底文案
 * @returns 字符串错误描述
 */
export function extractLegacyErrorMessage(raw: unknown, fallback: string): string {
  if (raw === null || raw === undefined || typeof raw !== 'object') return fallback
  const r = raw as LegacyResultShape
  return r.error || r.code || r.message || fallback
}
