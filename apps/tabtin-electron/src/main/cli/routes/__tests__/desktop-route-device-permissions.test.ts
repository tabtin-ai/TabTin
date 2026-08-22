/**
 * desktop.ts · device_permissions 路由层入口拦截测试（Wave 2.1 · 规范 § 6.5）。
 *
 * 规范承诺：`device_permissions.desktop_observe === 'block'` 时桌面操控"完全
 * 不可用"。Wave 2 首轮 Python Prompt 侧已落地（跳过 SECTION_TABDESKTOP），
 * Electron 路由层在 Wave 2.1 补齐：在任何策略评估 / session 获锁前直接拒绝。
 *
 * 覆盖矩阵：
 *   1. desktop_observe === 'block' → 路由层拒绝 POLICY_BLOCKED（click 举例）
 *   2. desktop_observe === 'block' → /screenshot 也被拦截
 *   3. device_permissions 字段缺失（未推送 / Space 未配置） → 不拦截，走下游
 *   4. desktop_observe 字段缺失 → 不拦截
 *   5. desktop_observe === 'allow' → 不拦截
 *   6. desktop_observe === 'confirm' → 不拦截
 *   7. 仅 desktop_input='block' 但 desktop_observe='allow' → 不拦截（§ 6.5 只看 observe）
 *   8. `/accessibility` 即便 block 也豁免（诊断工具，与 Linux 豁免同源）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'

const { mockGetCurrentSpaceDevicePermissions } = vi.hoisted(() => ({
  mockGetCurrentSpaceDevicePermissions: vi.fn<() => Record<string, string> | null>(),
}))

const { mockExecutor, mockGuard, mockWriteAuditLog } = vi.hoisted(() => ({
  mockExecutor: {
    getSession: vi.fn(),
    getIdleMs: vi.fn(),
    click: vi.fn(),
    screenshot: vi.fn(),
    checkAccessibility: vi.fn(),
    checkScreenRecording: vi.fn(),
  },
  mockGuard: {
    isApproved: vi.fn(() => true),
    acquire: vi.fn(),
    release: vi.fn(),
    revokeDesktopApproval: vi.fn(),
  },
  mockWriteAuditLog: vi.fn(),
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
  getCurrentSpaceDevicePermissions: () => mockGetCurrentSpaceDevicePermissions(),
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

// PD-11（W6 M3）：删除 `@tabtin/security-policy` mock —— routes/desktop.ts
// 已不再 import `PolicyEvaluator` / `getPresetPolicy`（device 动作只看
// device_permissions + DesktopUseLock guard）。

vi.mock('../../../services/desktop-audit-logger', () => ({
  writeAuditLog: (entry: unknown) => mockWriteAuditLog(entry),
}))

vi.mock('../../../services/DesktopUseLock', () => ({
  isHeldLocally: () => true,
}))

import { handleDesktopRoute } from '../desktop'

type CapturedResponse = { status: number; payload: unknown }

function createMockResponse(): http.ServerResponse {
  return {} as http.ServerResponse
}

function collectSendJSON(): {
  sendJSON: (res: http.ServerResponse, status: number, payload: unknown) => void
  captured: CapturedResponse[]
} {
  const captured: CapturedResponse[] = []
  const sendJSON = (_res: http.ServerResponse, status: number, payload: unknown) => {
    captured.push({ status, payload })
  }
  return { sendJSON, captured }
}

describe('handleDesktopRoute · device_permissions.desktop_observe 入口拦截 · § 6.5', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    mockGetCurrentSpaceDevicePermissions.mockReset()
    mockExecutor.getSession.mockReset()
    mockExecutor.getSession.mockReturnValue({ sessionId: 'session-fixture' })
    mockExecutor.getIdleMs.mockReset()
    mockExecutor.getIdleMs.mockReturnValue(0)
    mockExecutor.click.mockReset()
    mockExecutor.screenshot.mockReset()
    mockExecutor.checkAccessibility.mockReset()
    mockExecutor.checkAccessibility.mockReturnValue(false)
    mockExecutor.checkScreenRecording.mockReset()
    mockExecutor.checkScreenRecording.mockReturnValue({
      granted: false,
      status: 'unavailable',
    })
    mockWriteAuditLog.mockReset()
    // PD-11（W6 M3）：mockEvaluate / mockGetPresetPolicy 已删 —— routes 不再
    // 走 PolicyEvaluator + getPresetPolicy。
    mockGuard.isApproved.mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('desktop_observe === "block" → /click 被路由层拒绝 (POLICY_BLOCKED)，不进入策略评估', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue({ desktop_observe: 'block' })
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute(
      '/desktop/click',
      'POST',
      { x: 100, y: 200 },
      createMockResponse(),
      sendJSON,
    )

    expect(captured).toHaveLength(1)
    expect(captured[0].status).toBe(403)
    const payload = captured[0].payload as {
      code: string
      message: string
      detail?: { ruleName?: string; ruleReason?: string }
    }
    expect(payload.code).toBe('POLICY_BLOCKED')
    // Wave 2.2 · 规范 § 8.2：用户可见 message 使用自然语言 + UI 路径，
    // 不再暴露内部字段路径（"device_permissions.desktop_observe"）。
    expect(payload.message).toContain('授权策略')
    expect(payload.message).toContain('桌面观察权限')
    expect(payload.message).not.toContain('device_permissions.desktop_observe')
    expect(payload.message).not.toContain('= block')
    // 技术字段走 detail.ruleName / ruleReason，供工程师排障用。
    expect(payload.detail?.ruleName).toBe('device_permissions.desktop_observe')
    expect(payload.detail?.ruleReason).toBe('block')
    // 关键：应在 device_permissions 入口就拒绝，不进 executor
    expect(mockExecutor.click).not.toHaveBeenCalled()
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'click',
        result: 'error',
        errorCode: 'POLICY_BLOCKED',
        // 审计 errorMessage 保留机器字段名（运维排障视角，非用户可见）
        errorMessage: expect.stringContaining('desktop_observe=block'),
      }),
    )
  })

  it('desktop_observe === "block" → /screenshot 也被拦截（不仅 click）', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue({ desktop_observe: 'block' })
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute('/desktop/screenshot', 'POST', {}, createMockResponse(), sendJSON)

    expect(captured).toHaveLength(1)
    expect(captured[0].status).toBe(403)
    expect((captured[0].payload as { code: string }).code).toBe('POLICY_BLOCKED')
    expect(mockExecutor.screenshot).not.toHaveBeenCalled()
  })

  // 「不拦截」路径的统一断言：device_permissions 入口的 fail-fast block 没触发，
  // 即 captured 里没有 POLICY_BLOCKED；后续 session/锁/审批等链路不在本测试覆盖。
  // PD-11（W6 M3）后 routes 不再走 PolicyEvaluator，所以无需再断言 mockEvaluate。
  function expectNotBlockedAtEntry(captured: CapturedResponse[]): void {
    const blockedHits = captured.filter((c) => {
      const code = (c.payload as { code?: string } | null)?.code
      return c.status === 403 && code === 'POLICY_BLOCKED'
    })
    expect(blockedHits).toHaveLength(0)
  }

  it('device_permissions 未推送（null） → 不拦截，走下游 session/锁/审批链路', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue(null)
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute(
      '/desktop/click',
      'POST',
      { x: 100, y: 200 },
      createMockResponse(),
      sendJSON,
    )

    expectNotBlockedAtEntry(captured)
  })

  it('device_permissions 存在但无 desktop_observe 字段 → 不拦截', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue({ desktop_input: 'allow' })
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute(
      '/desktop/click',
      'POST',
      { x: 100, y: 200 },
      createMockResponse(),
      sendJSON,
    )

    expectNotBlockedAtEntry(captured)
  })

  it('desktop_observe === "allow" → 不拦截', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue({ desktop_observe: 'allow' })
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute(
      '/desktop/click',
      'POST',
      { x: 100, y: 200 },
      createMockResponse(),
      sendJSON,
    )

    expectNotBlockedAtEntry(captured)
  })

  it('desktop_observe === "confirm" → 不拦截', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue({ desktop_observe: 'confirm' })
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute(
      '/desktop/click',
      'POST',
      { x: 100, y: 200 },
      createMockResponse(),
      sendJSON,
    )

    expectNotBlockedAtEntry(captured)
  })

  it('desktop_input === "block" 但 desktop_observe === "allow" → 不拦截（§ 6.5 只看 observe）', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue({
      desktop_observe: 'allow',
      desktop_input: 'block',
      desktop_window: 'block',
    })
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute(
      '/desktop/click',
      'POST',
      { x: 100, y: 200 },
      createMockResponse(),
      sendJSON,
    )

    expectNotBlockedAtEntry(captured)
  })

  it('/accessibility 即便 desktop_observe === "block" 也豁免（诊断工具定位）', async () => {
    mockGetCurrentSpaceDevicePermissions.mockReturnValue({ desktop_observe: 'block' })
    const { sendJSON, captured } = collectSendJSON()

    await handleDesktopRoute(
      '/desktop/accessibility',
      'POST',
      { prompt: false },
      createMockResponse(),
      sendJSON,
    )

    expect(captured).toHaveLength(1)
    expect(captured[0].status).toBe(200)
    const payload = captured[0].payload as { ok: boolean; data: { platform: string } }
    expect(payload.ok).toBe(true)
    expect(payload.data.platform).toBe('darwin')
    // 关键：不要把 block 态误报为 POLICY_BLOCKED
    expect(mockWriteAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'POLICY_BLOCKED' }),
    )
  })
})
