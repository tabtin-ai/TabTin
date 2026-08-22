/**
 * Surface IPC adapter — 把 RegisteredSurface 注册为 ipcMain.handle。
 *
 * 设计决策 D-6 在类型层落地：函数签名只接受 `RegisteredSurface<'local'>`，
 * 传入 `kind: 'proxied'` 的 surface 直接编译报错。
 *
 * 内部使用 guardedHandle 注册，享受 sender-frame 安全 + trace context
 * 自动 stamp 双重保护。handler 返回值自动包装成 envelope：
 *   - 成功 → okResponse(result)（guardedHandle 自动 stampTraceIntoEnvelope）
 *   - SurfaceError → errResponse(code, message, {detail})
 *   - 未知错误 → errResponse('INTERNAL_ERROR', message)
 *
 * aliases 也用 guardedHandle 注册，指向同一个 handler 逻辑。
 * deprecated surface 注册时打印 warn 日志。
 *
 * W5 审计：在 handler 前后自动计时 + 写 audit-log JSONL，trace_id
 * 从 ALS trace context（getCurrentTraceId）读取。
 */

import { okResponse, errResponse } from '@tabtin/agent-wire'
import {
  SurfaceError,
  getSurfaceContext,
  writeSurfaceAuditLog,
  _computeInputHash,
  type RegisteredSurface,
} from '@tabtin/cli-server-core'
import { guardedHandle } from '../utils/guarded-handle'
import { getCurrentTraceId } from '../utils/trace-context'
import { createLogger } from '../logger'

const log = createLogger('SurfaceIPC')

/**
 * 为 surface handler 创建一个闭包——共享给主 channel 和 alias channel。
 *
 * 将 handler 执行 + 错误分类 + envelope 包装 + 审计写入封装到一个
 * 函数里，避免在注册多个 alias 时重复写同样的 try/catch 逻辑。
 */
function _createIpcListener<I, O, E extends string>(
  surface: RegisteredSurface<'local', I, O, E>,
): (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> {
  return async (_event, ...args) => {
    const startMs = Date.now()
    const input = args[0]
    const inputHash = _computeInputHash(input)
    const traceId = getCurrentTraceId()

    try {
      const ctx = getSurfaceContext()
      // IPC adapter 边界：input 是从 IPC 反序列化拿到的 unknown，
      // 由 surface handler 自身负责输入校验（在 surface 内 throw VALIDATION_ERROR）。
      const result = await surface.def.handler(input as I, ctx)

      // ── 审计：成功 ──
      writeSurfaceAuditLog({
        timestamp: new Date().toISOString(),
        channel: surface.channel,
        trace_id: traceId,
        input_hash: inputHash,
        ok: true,
        duration_ms: Date.now() - startMs,
      })

      return okResponse(result)
    } catch (err: unknown) {
      const errorCode = err instanceof SurfaceError
        ? err.code
        : 'INTERNAL_ERROR'

      // ── 审计：失败 ──
      writeSurfaceAuditLog({
        timestamp: new Date().toISOString(),
        channel: surface.channel,
        trace_id: traceId,
        input_hash: inputHash,
        ok: false,
        duration_ms: Date.now() - startMs,
        error_code: errorCode,
      })

      if (err instanceof SurfaceError) {
        // 已知的业务错误（VALIDATION_ERROR 等）由调用方处理，属预期路径，
        // 不打 error 免刷屏；审计 JSONL 已记 error_code。
        return errResponse(err.code, err.message, {
          detail: err.detail,
        })
      }
      // 未预期异常：审计 JSONL 只落独立文件，诊断包主看 main.log，此处补一条
      // error 让 surface handler 的意外崩溃在 main.log 里可见（覆盖所有迁移到
      // PlatformSurface 的 handler：session:* / run-session:* 等）。
      const message = err instanceof Error ? err.message : String(err)
      log.error('surface handler 未预期异常', {
        channel: surface.channel,
        traceId,
        durationMs: Date.now() - startMs,
      }, err)
      return errResponse('INTERNAL_ERROR', message)
    }
  }
}

/**
 * 将一个 local surface 注册为 IPC handler。
 *
 * D-6 类型约束：只接受 `RegisteredSurface<'local'>`。
 * 如果传入 `kind: 'proxied'` 的 surface，TypeScript 编译器会报错：
 * "Type 'RegisteredSurface<"proxied", ...>' is not assignable to ..."
 *
 * 使用 guardedHandle 注册而非裸 ipcMain.handle，获得：
 *   - sender-frame 来源校验（拒绝非信任渲染进程调用）
 *   - runWithGeneratedTrace 自动启动 trace context
 *   - stampTraceIntoEnvelope 自动写入 trace_id
 */
export function registerSurfaceAsIpc<I, O, E extends string>(
  surface: RegisteredSurface<'local', I, O, E>,
): void {
  // ── deprecated 警告 ──
  if (surface.def.deprecated) {
    const { since, replacedBy, removeAfter } = surface.def.deprecated
    log.warn(
      `[PlatformSurface] surface "${surface.channel}" 已弃用（since=${since}），` +
      `请迁移到 "${replacedBy}"（将在 ${removeAfter} 之后移除）`,
    )
  }

  // ── 注册主 channel ──
  const listener = _createIpcListener(surface)
  guardedHandle(surface.channel, listener)

  // ── 注册别名 channel ──
  if (surface.def.aliases?.length) {
    for (const alias of surface.def.aliases) {
      guardedHandle(alias, listener)
    }
  }
}
