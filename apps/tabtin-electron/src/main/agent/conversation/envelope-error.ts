/**
 * envelope-error — main 端 IPC handler 错误形态统一封装
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  解决什么问题
 * ═══════════════════════════════════════════════════════════════════════
 *
 * preload `ipc-shim.ts` 的 envelope 契约要求失败形态是：
 *
 *   { ok: false, error: { code: string, message: string, detail?: ... } }
 *
 * 但 main 端历史上大量 handler / 内部 reader 函数返回的是简写：
 *
 *   { ok: false, error: 'parent_session_not_alive' }   // ← error 是裸字符串
 *
 * ipc-shim 不识别这种半成品 envelope，会进入 "broken envelope" 兜底路径，
 * 把它包成 `PlatformIpcError({ code: 'UNKNOWN_ERROR', message: 'IPC ... returned
 * ok:false without a message' })` 抛出——**原始错误码被吞掉**，renderer 拿到
 * 的是无意义的通用错误，无法做精确文案匹配（譬如 SubagentDetailPane 的
 * `CROSS_DEVICE_AMBIGUOUS_CODES` 启发式映射全部失效）。
 *
 * v3.2 dogfood 时已经在 ElectronAgentHost 局部手工 wrap 过一处 reader 结果，
 * 但 4 处"预检查早返"路径全部漏修，所以 bug 仍能复现。本文件抽出统一 helper，
 * 让所有 main 端 IPC handler 走同一套规范，**杜绝反模式扩散**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  使用约定
 * ═══════════════════════════════════════════════════════════════════════
 *
 * - **直接对外的 IPC handler**（通过 `guardedHandle` / `ipcMain.handle` 注册）：
 *   返回前用 `wrapLegacyError(code, message?)` 或 `liftLegacyResult(reader 结果)`
 *   规范化。
 *
 * - **内部 reader / 纯函数**（如 `readSubagentSessionFile` /
 *   `listSubagentRunsForSession`）：保留 `{ ok: false, error: string }` 简写
 *   形态——它们的测试基于这个契约写，且不直接对外。caller（IPC handler 层）
 *   负责 lift。
 *
 * - **code 命名约定**：snake_case 短码（`parent_session_not_alive` /
 *   `subagent_not_found`），跟 reader 已有的命名风格保持一致；message 默认
 *   等于 code 字符串（reader 错误本来就是机器可读码），caller 想给人话再
 *   显式传 message 参数。
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  与 wire envelope 的差异
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `@tabtin/agent-wire/cli-envelope` 的 `errResponse(...)` 是 wire-format
 * 的完整 envelope（带 trace_id / duration_ms / retryable / suggestions）。
 * 本 helper 只补 `error.code + error.message` 这两个 ipc-shim 必读字段，
 * **不带 trace_id**——main 端 IPC handler 不像 wire 调用那样跨进程网络，
 * trace_id 由 `guardedHandle` 链路另行注入到顶层 envelope，跟本 helper 解耦。
 *
 * 真正需要 wire 完整 envelope（含 retryable 等高级语义）的 handler 应直接
 * import `@tabtin/agent-wire`，不是用本 helper。本 helper 服务于"现存 raw
 * string error 的快速规范化"场景。
 */

/** ipc-shim envelope 契约里 error 对象的形态（与 `ipc-shim.ts.IpcEnvelopeErr` 同构） */
export interface LegacyEnvelopeError {
  code: string
  message: string
  detail?: Record<string, unknown>
}

/** main 端 IPC handler 失败时返回的统一形态 */
export interface LegacyEnvelopeErrResult {
  ok: false
  error: LegacyEnvelopeError
}

/** 配合泛型成功负载使用的 envelope 联合 */
export type LegacyEnvelopeResult<TOkPayload> =
  | ({ ok: true } & TOkPayload)
  | LegacyEnvelopeErrResult

/**
 * 把 raw string error code 包成 ipc-shim envelope 规范的 `{ ok: false, error: { code, message } }`。
 *
 * @param code     机器可读短码（snake_case），譬如 `'parent_session_not_alive'`
 * @param message  人类可读文案。默认等于 `code`（reader 错误本来就是机器码，没必要再造一份）
 * @param detail   附加 detail 对象（譬如原始抛出的 err.stack 摘要、上下文 id 等）
 */
export function wrapLegacyError(
  code: string,
  message?: string,
  detail?: Record<string, unknown>,
): LegacyEnvelopeErrResult {
  const out: LegacyEnvelopeErrResult = {
    ok: false,
    error: {
      code,
      message: message ?? code,
    },
  }
  if (detail !== undefined) {
    out.error.detail = detail
  }
  return out
}

/**
 * 把"内部 reader/纯函数返回的简写错误"提升为"IPC handler 对外的规范 envelope"。
 *
 * 典型用法：
 *
 *   const result = await readSubagentSessionFile(...)   // { ok: true, lines } | { ok: false, error: 'subagent_not_found' }
 *   return liftLegacyResult(result)                    // 成功原样；失败 wrap code/message
 *
 * 成功路径不动（既不解包也不重包），失败路径转 envelope。reader 函数自身契约
 * 不需要改，测试也不用改——只有"IPC handler 层"开始走规范。
 */
export function liftLegacyResult<TOkPayload extends object>(
  result: { ok: true } & TOkPayload | { ok: false; error: string },
): LegacyEnvelopeResult<TOkPayload> {
  if (result.ok) {
    return result
  }
  return wrapLegacyError(result.error)
}
