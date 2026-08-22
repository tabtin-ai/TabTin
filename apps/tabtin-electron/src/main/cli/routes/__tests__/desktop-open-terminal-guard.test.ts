/**
 * desktop /open · 终端类应用软拦截：默认提示改用 tabtin terminal open，
 * 显式 --external 才放行系统 PowerShell / cmd / Windows Terminal。
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
    openApp: vi.fn(),
    endSession: vi.fn(),
  },
  mockGuard: {
    isApproved: vi.fn(() => true),
    acquire: vi.fn(),
    release: vi.fn(),
  },
  mockWriteAuditLog: vi.fn(),
}))

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

vi.mock('../../../services/desktop-audit-logger', () => ({
  writeAuditLog: (entry: unknown) => mockWriteAuditLog(entry),
}))

vi.mock('../../../services/DesktopUseLock', () => ({
  isHeldLocally: () => true,
}))

import { handleDesktopRoute } from '../desktop'

type CapturedResponse = { status: number; payload: any }

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

describe('handleDesktopRoute · /open 终端类应用软拦截', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockGetCurrentSpaceDevicePermissions.mockReset()
    mockGetCurrentSpaceDevicePermissions.mockReturnValue(null)
    mockExecutor.getSession.mockReset()
    mockExecutor.getSession.mockReturnValue({ sessionId: 'session-fixture' })
    mockExecutor.getIdleMs.mockReset()
    mockExecutor.getIdleMs.mockReturnValue(0)
    mockExecutor.openApp.mockReset()
    mockWriteAuditLog.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('拦截 PowerShell，提示改用 tabtin terminal open', async () => {
    const { sendJSON, captured } = collectSendJSON()
    await handleDesktopRoute('/desktop/open', 'POST', { name: 'PowerShell' }, createMockResponse(), sendJSON)

    expect(mockExecutor.openApp).not.toHaveBeenCalled()
    expect(captured[0]?.status).toBe(400)
    expect(String(captured[0]?.payload?.message ?? '')).toContain('tabtin terminal open')
    expect(captured[0]?.payload?.suggestions).toEqual(
      expect.arrayContaining(['tabtin terminal open']),
    )
  })

  it('拦截 Windows Terminal / cmd / wt', async () => {
    for (const name of ['Windows Terminal', 'cmd', 'wt', 'pwsh.exe']) {
      mockExecutor.openApp.mockClear()
      const { sendJSON, captured } = collectSendJSON()
      await handleDesktopRoute('/desktop/open', 'POST', { name }, createMockResponse(), sendJSON)
      expect(mockExecutor.openApp, name).not.toHaveBeenCalled()
      expect(captured[0]?.status, name).toBe(400)
    }
  })

  it('external=true 时放行 PowerShell', async () => {
    const { sendJSON, captured } = collectSendJSON()
    await handleDesktopRoute(
      '/desktop/open',
      'POST',
      { name: 'PowerShell', external: true },
      createMockResponse(),
      sendJSON,
    )

    expect(mockExecutor.openApp).toHaveBeenCalledWith('PowerShell')
    expect(captured[0]?.status).toBe(200)
  })

  it('非终端应用不受影响', async () => {
    const { sendJSON, captured } = collectSendJSON()
    await handleDesktopRoute('/desktop/open', 'POST', { name: 'Slack' }, createMockResponse(), sendJSON)

    expect(mockExecutor.openApp).toHaveBeenCalledWith('Slack')
    expect(captured[0]?.status).toBe(200)
  })
})
