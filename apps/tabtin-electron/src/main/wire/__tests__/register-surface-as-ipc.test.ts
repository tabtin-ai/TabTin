/**
 * registerSurfaceAsIpc 测试。
 *
 * 覆盖：
 *   - 正常注册：guardedHandle 被调用 + channel 正确
 *   - alias 注册：每个 alias 都调 guardedHandle
 *   - deprecated 警告：注册时 logger.warn
 *   - 成功路径：handler 返回值包装为 okResponse
 *   - SurfaceError 路径：errResponse(code, message, detail)
 *   - 未知错误路径：errResponse('INTERNAL_ERROR', message)
 *   - D-6 类型约束：proxied 不能传入（@ts-expect-error）
 *   - W5 审计：成功 / 失败路径均写入 audit entry（含 trace_id）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** hoisted mocks——必须在 vi.mock 之前用 vi.hoisted 声明 */
const mocks = vi.hoisted(() => ({
  handleFn: vi.fn(),
  loggerWarn: vi.fn(),
  mockWriteAudit: vi.fn(),
  mockComputeHash: vi.fn(() => 'ab12cd34'),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handleFn,
    removeHandler: vi.fn(),
  },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: () => true,
  isTinSandboxSender: () => false,
}))

vi.mock('../../utils/trace-context', () => ({
  getCurrentTraceId: () => 'test-trace-id-w5',
  runWithGeneratedTrace: <T>(fn: () => T) => fn(),
  stampTraceIntoEnvelope: <T>(v: T) => v,
}))

vi.mock('@tabtin/cli-server-core', async () => {
  const actual = await import('../../../../../../packages/cli-server-core/src/surface/types.js')
  const runtime = await import('../../../../../../packages/cli-server-core/src/surface/configure-surface-runtime.js')
  return {
    SurfaceError: actual.SurfaceError,
    getSurfaceContext: runtime.getSurfaceContext,
    writeSurfaceAuditLog: mocks.mockWriteAudit,
    _computeInputHash: mocks.mockComputeHash,
  }
})

import { registerSurfaceAsIpc } from '../register-surface-as-ipc'
import { SurfaceError } from '../../../../../../packages/cli-server-core/src/surface/types.js'
import {
  configureSurfaceRuntime,
  _clearSurfaceRuntime,
} from '../../../../../../packages/cli-server-core/src/surface/configure-surface-runtime.js'
import type { RegisteredSurface } from '../../../../../../packages/cli-server-core/src/surface/types.js'

/** 构造 mock SurfaceContext 并注入 */
const _mockDjangoRequest = vi.fn()

function _setupRuntime(): void {
  configureSurfaceRuntime({
    djangoRequest: _mockDjangoRequest,
    spaceId: 'test-space',
  })
}

/** 构造一个最小 RegisteredSurface 用于测试 */
function _makeSurface(
  overrides: Partial<{
    channel: string
    module: string
    verb: string
    handler: (input: unknown, ctx: unknown) => Promise<unknown>
    aliases: string[]
    deprecated: { since: string; replacedBy: string; removeAfter: string }
  }> = {},
): RegisteredSurface<'local'> {
  return Object.freeze({
    channel: overrides.channel ?? 'test:action',
    httpPath: `/${(overrides.module ?? 'test')}/${(overrides.verb ?? 'action')}`,
    def: Object.freeze({
      module: overrides.module ?? 'test',
      verb: overrides.verb ?? 'action',
      kind: 'local' as const,
      errorCodes: ['TEST_ERROR'] as readonly string[],
      handler: overrides.handler ?? (async () => ({ result: true })),
      bindings: { ipc: true, http: true },
      aliases: overrides.aliases,
      deprecated: overrides.deprecated,
    }),
  })
}

/** 提取 guardedHandle 注册的 listener 并执行 */
async function _callRegisteredListener(
  channelIndex: number,
  ...args: unknown[]
): Promise<unknown> {
  const call = mocks.handleFn.mock.calls[channelIndex]
  const registeredListener = call[1]
  const fakeEvent = { senderFrame: { url: 'file://trusted' } }
  return registeredListener(fakeEvent, ...args)
}

describe('registerSurfaceAsIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearSurfaceRuntime()
    _setupRuntime()
  })

  it('用 guardedHandle 注册主 channel', () => {
    const surface = _makeSurface({ channel: 'chat:export-md' })
    registerSurfaceAsIpc(surface)

    expect(mocks.handleFn).toHaveBeenCalledWith('chat:export-md', expect.any(Function))
  })

  it('alias 也用 guardedHandle 注册', () => {
    const surface = _makeSurface({
      channel: 'chat:export-md',
      aliases: ['chat:export', 'chat:old-export'],
    })
    registerSurfaceAsIpc(surface)

    expect(mocks.handleFn).toHaveBeenCalledTimes(3)
    const registeredChannels = mocks.handleFn.mock.calls.map(
      (c: unknown[]) => c[0],
    )
    expect(registeredChannels).toContain('chat:export-md')
    expect(registeredChannels).toContain('chat:export')
    expect(registeredChannels).toContain('chat:old-export')
  })

  it('deprecated surface 注册时打印 warn', () => {
    const surface = _makeSurface({
      deprecated: {
        since: '0.5.0',
        replacedBy: 'test:new-action',
        removeAfter: '1.0.0',
      },
    })
    registerSurfaceAsIpc(surface)

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('已弃用'),
    )
  })

  it('没有 deprecated 时不打印 warn', () => {
    const surface = _makeSurface()
    registerSurfaceAsIpc(surface)

    expect(mocks.loggerWarn).not.toHaveBeenCalled()
  })

  describe('handler 执行', () => {
    it('成功路径 → okResponse envelope', async () => {
      const surface = _makeSurface({
        handler: async (input: unknown) => ({ markdown: '# Test', count: 3 }),
      })
      registerSurfaceAsIpc(surface)

      const result = await _callRegisteredListener(0, { sessionId: 'abc' })
      expect(result).toEqual({
        ok: true,
        data: { markdown: '# Test', count: 3 },
      })
    })

    it('SurfaceError → errResponse(code, message, detail)', async () => {
      const surface = _makeSurface({
        handler: async () => {
          throw new SurfaceError('TEST_ERROR', '测试错误', { key: 'val' })
        },
      })
      registerSurfaceAsIpc(surface)

      const result = await _callRegisteredListener(0) as Record<string, unknown>
      expect(result.ok).toBe(false)
      const error = (result as any).error
      expect(error.code).toBe('TEST_ERROR')
      expect(error.message).toBe('测试错误')
      expect(error.detail).toEqual({ key: 'val' })
    })

    it('未知错误 → errResponse(INTERNAL_ERROR, message)', async () => {
      const surface = _makeSurface({
        handler: async () => {
          throw new Error('意外崩溃')
        },
      })
      registerSurfaceAsIpc(surface)

      const result = await _callRegisteredListener(0) as Record<string, unknown>
      expect(result.ok).toBe(false)
      const error = (result as any).error
      expect(error.code).toBe('INTERNAL_ERROR')
      expect(error.message).toBe('意外崩溃')
    })

    it('非 Error 对象 → INTERNAL_ERROR + String(err)', async () => {
      const surface = _makeSurface({
        handler: async () => {
          throw 'raw string'  // eslint-disable-line no-throw-literal
        },
      })
      registerSurfaceAsIpc(surface)

      const result = await _callRegisteredListener(0) as Record<string, unknown>
      expect(result.ok).toBe(false)
      const error = (result as any).error
      expect(error.code).toBe('INTERNAL_ERROR')
      expect(error.message).toBe('raw string')
    })

    it('handler 接收到正确的 input 参数', async () => {
      let capturedInput: unknown = null
      const surface = _makeSurface({
        handler: async (input: unknown) => {
          capturedInput = input
          return { ok: true }
        },
      })
      registerSurfaceAsIpc(surface)

      await _callRegisteredListener(0, { sessionId: 'test-123' })
      expect(capturedInput).toEqual({ sessionId: 'test-123' })
    })

    it('alias listener 和主 channel listener 共享同一个 handler', async () => {
      let callCount = 0
      const surface = _makeSurface({
        channel: 'chat:export-md',
        aliases: ['chat:export'],
        handler: async () => {
          callCount++
          return { count: callCount }
        },
      })
      registerSurfaceAsIpc(surface)

      await _callRegisteredListener(0)
      expect(callCount).toBe(1)

      await _callRegisteredListener(1)
      expect(callCount).toBe(2)
    })
  })

  it('D-6 类型约束：proxied surface 不能传入', () => {
    const proxiedSurface = Object.freeze({
      channel: 'agent:update-settings',
      httpPath: '/agent/update-settings',
      def: Object.freeze({
        module: 'agent',
        verb: 'update-settings',
        kind: 'proxied' as const,
        errorCodes: [] as readonly string[],
        handler: async () => ({}),
        bindings: { ipc: false as const, http: true },
      }),
    })

    // @ts-expect-error D-6: proxied surface 不能注册为 IPC
    registerSurfaceAsIpc(proxiedSurface)
  })
})

// ─── W5 审计测试 ─────────────────────────────────────────────────

describe('W5 审计', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearSurfaceRuntime()
    _setupRuntime()
  })

  it('成功路径写入 audit entry（ok: true + trace_id）', async () => {
    const surface = _makeSurface({
      channel: 'chat:export-md',
      handler: async () => ({ markdown: '# Test' }),
    })
    registerSurfaceAsIpc(surface)

    await _callRegisteredListener(0, { sessionId: 'test-audit' })

    expect(mocks.mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = mocks.mockWriteAudit.mock.calls[0][0]
    expect(entry.channel).toBe('chat:export-md')
    expect(entry.ok).toBe(true)
    expect(entry.trace_id).toBe('test-trace-id-w5')
    expect(entry.input_hash).toBe('ab12cd34')
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0)
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.error_code).toBeUndefined()
  })

  it('SurfaceError 路径写入 audit entry（ok: false + error_code）', async () => {
    const surface = _makeSurface({
      channel: 'chat:audit-err',
      handler: async () => {
        throw new SurfaceError('TEST_ERROR', '测试失败')
      },
    })
    registerSurfaceAsIpc(surface)

    await _callRegisteredListener(0)

    expect(mocks.mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = mocks.mockWriteAudit.mock.calls[0][0]
    expect(entry.channel).toBe('chat:audit-err')
    expect(entry.ok).toBe(false)
    expect(entry.error_code).toBe('TEST_ERROR')
    expect(entry.trace_id).toBe('test-trace-id-w5')
  })

  it('未知错误路径写入 audit entry（error_code: INTERNAL_ERROR）', async () => {
    const surface = _makeSurface({
      channel: 'chat:audit-crash',
      handler: async () => { throw new Error('boom') },
    })
    registerSurfaceAsIpc(surface)

    await _callRegisteredListener(0)

    expect(mocks.mockWriteAudit).toHaveBeenCalledTimes(1)
    const entry = mocks.mockWriteAudit.mock.calls[0][0]
    expect(entry.ok).toBe(false)
    expect(entry.error_code).toBe('INTERNAL_ERROR')
  })

  it('_computeInputHash 被调用处理 input', async () => {
    const surface = _makeSurface({
      handler: async () => ({ result: true }),
    })
    registerSurfaceAsIpc(surface)

    const testInput = { sessionId: 'hash-test' }
    await _callRegisteredListener(0, testInput)

    expect(mocks.mockComputeHash).toHaveBeenCalledWith(testInput)
  })
})
