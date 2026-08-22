/**
 * HTTP adapter 测试。
 *
 * 覆盖：
 *   - 成功响应 → okResponse envelope
 *   - SurfaceError → errResponse(code, message, detail)
 *   - 未知错误 → errResponse('INTERNAL_ERROR', message)
 *   - 未配置 runtime 时抛错
 *   - W5 审计：成功 / 失败路径均写入 audit entry
 *   - W5 审计：trace_id 从 X-Request-Id header 读取
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import http from 'node:http'
import { createSurfaceHttpHandler } from '../create-surface-http-handler.js'
import { definePlatformSurface } from '../define-platform-surface.js'
import { configureSurfaceRuntime, _clearSurfaceRuntime } from '../configure-surface-runtime.js'
import { _clearRegistry } from '../registry.js'
import { SurfaceError } from '../types.js'
import type { RegisteredSurface, SurfaceContext } from '../types.js'

/** mock 审计写入——捕获调用而不真写文件 */
const _mockWriteAudit = vi.fn()
vi.mock('../surface-audit.js', async () => {
  const actual = await vi.importActual<typeof import('../surface-audit.js')>('../surface-audit.js')
  return {
    ...actual,
    writeSurfaceAuditLog: (...args: unknown[]) => _mockWriteAudit(...args),
  }
})

/** mock Django 请求函数 */
const _mockDjangoRequest = vi.fn()

/** 用于构造 mock req/res 的辅助工具 */
function _createMockReqRes(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): {
  req: http.IncomingMessage
  res: http.ServerResponse & { _status: number; _body: string }
} {
  const bodyStr = JSON.stringify(body)
  const req = Object.assign(
    new (require('node:stream').PassThrough)(),
    {
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
      url: '/test',
    },
  ) as unknown as http.IncomingMessage

  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    headersSent: false,
    writeHead(status: number, hdrs: Record<string, string>) {
      this._status = status
      Object.assign(this._headers, hdrs)
      this.headersSent = true
    },
    end(body: string) {
      this._body = body
    },
  } as unknown as http.ServerResponse & { _status: number; _body: string }

  // 写入 body 数据
  setTimeout(() => {
    (req as any).emit('data', Buffer.from(bodyStr))
    ;(req as any).emit('end')
  }, 0)

  return { req, res }
}

beforeEach(() => {
  _clearRegistry()
  _clearSurfaceRuntime()
  _mockDjangoRequest.mockReset()
  _mockWriteAudit.mockReset()
})

describe('createSurfaceHttpHandler', () => {
  it('成功响应包装为 okResponse envelope', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'export-md',
      kind: 'local',
      errorCodes: [] as const,
      handler: async (input: { sessionId: string }) => ({
        markdown: '# Hello',
        messageCount: 5,
      }),
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({ sessionId: 'test-session' })

    await handler(req, res)

    const responseBody = JSON.parse(res._body)
    expect(res._status).toBe(200)
    expect(responseBody.ok).toBe(true)
    expect(responseBody.data.markdown).toBe('# Hello')
    expect(responseBody.data.messageCount).toBe(5)
  })

  it('SurfaceError → 400 + errResponse(code, message, detail)', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'export-err',
      kind: 'local',
      errorCodes: ['SESSION_NOT_FOUND'] as const,
      handler: async () => {
        throw new SurfaceError('SESSION_NOT_FOUND', '会话不存在', {
          sessionId: 'missing-123',
        })
      },
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    const responseBody = JSON.parse(res._body)
    expect(res._status).toBe(400)
    expect(responseBody.ok).toBe(false)
    expect(responseBody.error.code).toBe('SESSION_NOT_FOUND')
    expect(responseBody.error.message).toBe('会话不存在')
    expect(responseBody.error.detail).toEqual({ sessionId: 'missing-123' })
  })

  it('未知错误 → 500 + errResponse(INTERNAL_ERROR, message)', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'export-crash',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => {
        throw new Error('意外的空指针')
      },
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    const responseBody = JSON.parse(res._body)
    expect(res._status).toBe(500)
    expect(responseBody.ok).toBe(false)
    expect(responseBody.error.code).toBe('INTERNAL_ERROR')
    expect(responseBody.error.message).toBe('意外的空指针')
  })

  it('非 Error 对象抛出 → INTERNAL_ERROR + String(err)', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'export-str-throw',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => {
        throw 'raw string error'  // eslint-disable-line no-throw-literal
      },
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    const responseBody = JSON.parse(res._body)
    expect(res._status).toBe(500)
    expect(responseBody.ok).toBe(false)
    expect(responseBody.error.code).toBe('INTERNAL_ERROR')
    expect(responseBody.error.message).toBe('raw string error')
  })

  it('handler 接收到正确的 SurfaceContext', async () => {
    const ctx: SurfaceContext = {
      djangoRequest: _mockDjangoRequest,
      spaceId: 'test-space-42',
    }
    configureSurfaceRuntime(ctx)

    let capturedCtx: SurfaceContext | null = null
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'ctx-check',
      kind: 'local',
      errorCodes: [] as const,
      handler: async (_input: unknown, handlerCtx: SurfaceContext) => {
        capturedCtx = handlerCtx
        return { ok: true }
      },
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    expect(capturedCtx).not.toBeNull()
    expect(capturedCtx!.spaceId).toBe('test-space-42')
    expect(capturedCtx!.djangoRequest).toBe(_mockDjangoRequest)
  })

  it('未配置 runtime 时抛错转为 INTERNAL_ERROR', async () => {
    // 不调 configureSurfaceRuntime
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'no-runtime',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({}),
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    const responseBody = JSON.parse(res._body)
    expect(res._status).toBe(500)
    expect(responseBody.ok).toBe(false)
    expect(responseBody.error.code).toBe('INTERNAL_ERROR')
    expect(responseBody.error.message).toContain('configureSurfaceRuntime')
  })
})

// ─── W5 审计测试 ─────────────────────────────────────────────────

describe('W5 审计', () => {
  it('成功路径写入 audit entry（ok: true）', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'audit-ok',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({ result: 'done' }),
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({ data: 'test' })

    await handler(req, res)

    expect(_mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = _mockWriteAudit.mock.calls[0][0]
    expect(entry.channel).toBe('chat:audit-ok')
    expect(entry.ok).toBe(true)
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0)
    expect(entry.input_hash).toHaveLength(8)
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.error_code).toBeUndefined()
  })

  it('SurfaceError 路径写入 audit entry（ok: false + error_code）', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'audit-err',
      kind: 'local',
      errorCodes: ['NOT_FOUND'] as const,
      handler: async () => {
        throw new SurfaceError('NOT_FOUND', '找不到')
      },
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    expect(_mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = _mockWriteAudit.mock.calls[0][0]
    expect(entry.channel).toBe('chat:audit-err')
    expect(entry.ok).toBe(false)
    expect(entry.error_code).toBe('NOT_FOUND')
  })

  it('未知错误路径写入 audit entry（error_code: INTERNAL_ERROR）', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'audit-crash',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => { throw new Error('boom') },
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    expect(_mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = _mockWriteAudit.mock.calls[0][0]
    expect(entry.ok).toBe(false)
    expect(entry.error_code).toBe('INTERNAL_ERROR')
  })

  it('trace_id 从 X-Request-Id header 读取', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'audit-trace',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({ ok: true }),
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes(
      {},
      { 'x-request-id': 'polaris-test-trace-123' },
    )

    await handler(req, res)

    expect(_mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = _mockWriteAudit.mock.calls[0][0]
    expect(entry.trace_id).toBe('polaris-test-trace-123')
  })

  it('无 X-Request-Id 时 trace_id 为 undefined', async () => {
    configureSurfaceRuntime({
      djangoRequest: _mockDjangoRequest,
      spaceId: 'space-1',
    })

    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'audit-no-trace',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({ ok: true }),
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfaceHttpHandler(surface)
    const { req, res } = _createMockReqRes({})

    await handler(req, res)

    expect(_mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = _mockWriteAudit.mock.calls[0][0]
    expect(entry.trace_id).toBeUndefined()
  })
})
