/**
 * desktop.ts · `/accessibility` 路由 Linux 豁免的**路由层**单测
 * （规范 v1.3 Q4 决策 · Wave 2.1 补测试债）。
 *
 * 决策背景：
 *   - v1.3 修订：Linux 下 `/accessibility` **豁免**顶层 `UNSUPPORTED_PLATFORM`
 *     拦截，直接走 handler，返回 `{ platform: 'linux', trusted: false,
 *     screenRecording: false, screenRecordingStatus: 'unavailable' }` 的
 *     精细诊断体（见 spec § 4.4.3.1 + § 7.2 + § 10 Q4 v1.3 修订段）。
 *   - Wave 2 独立验证 v2 § 2.N3 指出：代码已落，**路由层缺单测**——
 *     风险是"handler 未 override Linux 实现时被泛化成 500"。
 *   - Wave 2.1 补：断言路由层在 Linux 下调 `executor.checkAccessibility` +
 *     `checkScreenRecording` 后返回 v1.3 要求的 shape，而不是被顶层 guard
 *     吞成 UNSUPPORTED_PLATFORM。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'

const { mockExecutor, mockGuard } = vi.hoisted(() => ({
  mockExecutor: {
    getSession: vi.fn(() => null as null | { sessionId: string }),
    getIdleMs: vi.fn(() => 0),
    checkAccessibility: vi.fn(),
    checkScreenRecording: vi.fn(),
  },
  mockGuard: {
    isApproved: vi.fn(() => true),
    revokeDesktopApproval: vi.fn(),
  },
}))

// PD-11（W6 M3）：移除原 CLI 'current Space auth preset' 缓存读取 mock ——
// 该 API 已删；CLI client 不再能"压低"Space yolo（详见 cli-space-desktop-cache.ts 顶部）。
//
// desktop.ts 现在从 cli-context（executor/guard）+ cli-space-desktop-cache
// （device permissions）两个 leaf 模块取依赖，所以 mock 也拆成两个。
vi.mock('../../cli-context', () => ({
  getCLIDesktopExecutor: () => mockExecutor,
  getCLIDesktopGuard: () => mockGuard,
}))

vi.mock('../../cli-space-desktop-cache', () => ({
  getCurrentSpaceDevicePermissions: () => null,
}))

vi.mock('@tabtin/agent-wire', () => ({
  okResponse: (data: unknown) => ({ ok: true, data }),
}))

vi.mock('../shared/error-handler', () => ({
  errorResponse: (code: string, message: string, extras?: Record<string, unknown>) => ({
    code,
    message,
    ...(extras ?? {}),
  }),
}))

vi.mock('@tabtin/security-policy', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/security-policy')>('@tabtin/security-policy')
  return { ...actual }
})

vi.mock('../../../services/desktop-audit-logger', () => ({
  writeAuditLog: vi.fn(),
}))

import { handleDesktopRoute } from '../desktop'

function createMockResponse(): http.ServerResponse {
  return {} as http.ServerResponse
}

describe('/desktop/accessibility · Linux 豁免（规范 v1.3 Q4）', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    mockExecutor.getSession.mockReturnValue(null)
    mockExecutor.getIdleMs.mockReturnValue(0)
    mockExecutor.checkAccessibility.mockReset()
    mockExecutor.checkAccessibility.mockReturnValue(false)
    mockExecutor.checkScreenRecording.mockReset()
    mockExecutor.checkScreenRecording.mockReturnValue({
      granted: false,
      status: 'unavailable',
    })
    Object.defineProperty(process, 'platform', { value: 'linux' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('Linux 下 /accessibility 不被顶层拦截，返回诊断体 shape', async () => {
    const captured: { status: number; payload: unknown }[] = []
    const sendJSON = (_res: http.ServerResponse, status: number, payload: unknown) => {
      captured.push({ status, payload })
    }

    await handleDesktopRoute(
      '/desktop/accessibility',
      'POST',
      { prompt: false },
      createMockResponse(),
      sendJSON,
    )

    expect(captured).toHaveLength(1)
    // 关键：必须 200，不是 UNSUPPORTED_PLATFORM 400/500
    expect(captured[0].status).toBe(200)

    const payload = captured[0].payload as {
      ok: boolean
      data: {
        platform: string
        trusted: boolean
        screenRecording: boolean
        screenRecordingStatus: string
      }
    }

    expect(payload.ok).toBe(true)
    // 规范 § 4.4.3.1 v1.3 要求的精细诊断体：
    expect(payload.data.platform).toBe('linux')
    expect(payload.data.trusted).toBe(false)
    expect(payload.data.screenRecording).toBe(false)
    expect(payload.data.screenRecordingStatus).toBe('unavailable')
  })

  it('Linux 下非 /accessibility 路由（例如 /click）仍被顶层拦截', async () => {
    const captured: { status: number; payload: unknown }[] = []
    const sendJSON = (_res: http.ServerResponse, status: number, payload: unknown) => {
      captured.push({ status, payload })
    }

    await handleDesktopRoute(
      '/desktop/click',
      'POST',
      { x: 1, y: 1 },
      createMockResponse(),
      sendJSON,
    )

    expect(captured).toHaveLength(1)
    expect((captured[0].payload as { code: string }).code).toBe('UNSUPPORTED_PLATFORM')
  })

  it('handler 调用了 Executor 的 checkAccessibility + checkScreenRecording（没被 skip）', async () => {
    const sendJSON = vi.fn()
    await handleDesktopRoute(
      '/desktop/accessibility',
      'POST',
      { prompt: true },
      createMockResponse(),
      sendJSON,
    )
    expect(mockExecutor.checkAccessibility).toHaveBeenCalledWith(true)
    expect(mockExecutor.checkScreenRecording).toHaveBeenCalled()
  })
})
