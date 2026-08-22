/**
 * Surface HTTP adapter — 把 RegisteredSurface 转化成 RouteHandler。
 *
 * CLI Server（Electron / Daemon）的 handleRequest 路由分发函数调用
 * 此 adapter 为每个 http-enabled surface 创建一个 RouteHandler，然后
 * 按 httpPath 挂到路由表。
 *
 * 调用链路：
 *   HTTP request → parseBody → getSurfaceContext → handler(input, ctx)
 *   → 成功: sendJSON(200, okResponse(result)) + 审计 ok
 *   → SurfaceError: sendJSON(400, errResponse(code, message, {detail})) + 审计 error
 *   → 未知错误: sendJSON(500, errResponse('INTERNAL_ERROR', message)) + 审计 error
 *
 * envelope 直接复用 @tabtin/agent-wire 的 okResponse / errResponse，
 * 与整个仓库的 envelope SSoT 保持一致。
 *
 * W5 审计：在 handler 前后自动计时 + 写 audit-log JSONL，trace_id
 * 从 HTTP 请求头 X-Request-Id 读取。
 */

import { okResponse, errResponse } from '@tabtin/agent-wire'
import { parseBody, sendJSON } from '../http-utils.js'
import type { RouteHandler } from '../server.js'
import { SurfaceError } from './types.js'
import type { RegisteredSurface } from './types.js'
import { getSurfaceContext } from './configure-surface-runtime.js'
import { writeSurfaceAuditLog, _computeInputHash } from './surface-audit.js'

/** 已发出 deprecated 警告的 channel（按进程去重；防止刷屏）。 */
const _deprecatedWarned = new Set<string>()

/**
 * 从 HTTP 请求头提取 trace_id。
 *
 * 优先读 `X-Request-Id`（W1 D3 全栈透传链路的标准头）。
 * header 值可能是 string 或 string[]，只取第一个。
 */
function _extractTraceId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const val = headers['x-request-id']
  if (typeof val === 'string') return val
  if (Array.isArray(val) && val.length > 0) return val[0]
  return undefined
}

/**
 * 为指定 surface 创建一个 HTTP RouteHandler。
 *
 * 返回的 handler 符合 cli-server-core 的 RouteHandler 签名
 * `(req, res) => Promise<void>`，可直接挂到 createCLIHttpServer
 * 的路由分发逻辑中。
 */
export function createSurfaceHttpHandler(
  surface: RegisteredSurface,
): RouteHandler {
  // ── deprecated 警告（首次注册时打一次） ──
  // 与 register-surface-as-ipc.ts:107-113 IPC adapter 行为对齐，避免
  // "IPC 端打 warn / HTTP 端静默"的不对称。types.ts:104 注释承诺
  // "注册时 logger.warn"，HTTP adapter 此前缺失。
  if (surface.def.deprecated && !_deprecatedWarned.has(surface.channel)) {
    const { since, replacedBy, removeAfter } = surface.def.deprecated
    console.warn(
      `[PlatformSurface][HTTP] surface "${surface.channel}" 已弃用（since=${since}），` +
      `请迁移到 "${replacedBy}"（将在 ${removeAfter} 之后移除）`,
    )
    _deprecatedWarned.add(surface.channel)
  }

  return async (req, res) => {
    const startMs = Date.now()
    const traceId = _extractTraceId(req.headers)
    let input: unknown

    try {
      // ── 1. 解析请求体 ──
      input = await parseBody(req)

      // ── 2. 获取运行时上下文 ──
      const ctx = getSurfaceContext()

      // ── 3. 执行 handler ──
      const result = await surface.def.handler(input, ctx)

      // ── 4. 审计：成功 ──
      writeSurfaceAuditLog({
        timestamp: new Date().toISOString(),
        channel: surface.channel,
        trace_id: traceId,
        input_hash: _computeInputHash(input),
        ok: true,
        duration_ms: Date.now() - startMs,
      })

      // ── 5. 成功响应 ──
      sendJSON(res, 200, okResponse(result))
    } catch (err: unknown) {
      const errorCode = err instanceof SurfaceError
        ? err.code
        : 'INTERNAL_ERROR'

      // ── 审计：失败 ──
      writeSurfaceAuditLog({
        timestamp: new Date().toISOString(),
        channel: surface.channel,
        trace_id: traceId,
        input_hash: _computeInputHash(input),
        ok: false,
        duration_ms: Date.now() - startMs,
        error_code: errorCode,
      })

      if (err instanceof SurfaceError) {
        // ── 业务错误：用 handler 声明的 code ──
        sendJSON(res, 400, errResponse(err.code, err.message, {
          detail: err.detail,
        }))
      } else {
        // ── 未知错误：INTERNAL_ERROR ──
        const message = err instanceof Error
          ? err.message
          : String(err)
        sendJSON(res, 500, errResponse('INTERNAL_ERROR', message))
      }
    }
  }
}
