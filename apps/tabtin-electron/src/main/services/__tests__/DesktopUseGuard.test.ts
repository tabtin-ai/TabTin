import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'

const APPROVAL_FILE = join(homedir(), '.tabtin', 'desktop-approval.json')

const mockRequestApproval = vi.fn()
const mockTryAcquire = vi.fn()
const mockRelease = vi.fn()
const mockIsHeldLocally = vi.fn()
const mockRegister = vi.fn()
const mockUnregister = vi.fn()
const mockIsTrusted = vi.fn()
const mockNotificationShow = vi.fn()
const mockShowMessageBox = vi.fn()

const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockUnlinkSync = vi.fn()

// W A0.4.续 / hardening-round4 #4：mock desktop-audit-logger 以断言
// 4 个 approval 审计事件（granted/denied/expired/clock_anomaly）确实被记录，
// 且 JSON payload 含 action + sessionId 字段（hardening-round4 #2 落地）。
const mockAuditInfo = vi.fn()
const mockMediaAccessStatus = vi.fn()

vi.mock('electron', () => ({
  dialog: { showMessageBox: (...args: any[]) => mockShowMessageBox(...args) },
  globalShortcut: {
    register: (...args: any[]) => mockRegister(...args),
    unregister: (...args: any[]) => mockUnregister(...args),
  },
  systemPreferences: {
    isTrustedAccessibilityClient: (...args: any[]) => mockIsTrusted(...args),
    // OS 系统权限统一管理上线后，DesktopUseGuard 在 macOS 上预检
    // 屏幕录制权限，所以这里加一个 mock；默认 'granted' 不影响既有测试。
    getMediaAccessStatus: (...args: any[]) => mockMediaAccessStatus(...args),
  },
}))

vi.mock('../DesktopUseLock', () => ({
  tryAcquire: (...args: any[]) => mockTryAcquire(...args),
  release: (...args: any[]) => mockRelease(...args),
  isHeldLocally: () => mockIsHeldLocally(),
  check: vi.fn(),
}))

vi.mock('../ApprovalManager', () => ({
  requestApproval: (...args: any[]) => mockRequestApproval(...args),
}))

vi.mock('../notification', () => ({
  notificationService: { show: (...args: any[]) => mockNotificationShow(...args) },
}))

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../window-manager', () => ({
  getMainWindow: vi.fn().mockReturnValue(null),
}))

vi.mock('node:fs', () => {
  const mod = {
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
  }
  return { ...mod, default: mod }
})

// 仅 mock 模块导出的 desktopAuditLogger.info（保留 writeAuditLog 的 jsonl 路径
// 不被本测试关心；本测试的 4 个断言专注于 hardening-round4 #4 要求的
// approval_granted/denied/expired/clock_anomaly 4 个 console debug 事件）。
vi.mock('../desktop-audit-logger', () => ({
  desktopAuditLogger: { info: (...args: any[]) => mockAuditInfo(...args) },
  writeAuditLog: vi.fn(),
}))

describe('DesktopUseGuard', () => {
  let Guard: typeof import('../DesktopUseGuard')

  beforeEach(async () => {
    vi.resetModules()
    Guard = await import('../DesktopUseGuard')

    mockRequestApproval.mockReset()
    mockTryAcquire.mockReset()
    mockRelease.mockReset()
    mockIsHeldLocally.mockReset()
    mockRegister.mockReset()
    mockUnregister.mockReset()
    mockIsTrusted.mockReset()
    mockNotificationShow.mockReset()
    mockShowMessageBox.mockReset()
    mockMediaAccessStatus.mockReset()

    mockIsTrusted.mockReturnValue(true)
    mockMediaAccessStatus.mockReturnValue('granted')

    mockReadFileSync.mockReset()
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockUnlinkSync.mockReset()
    mockAuditInfo.mockReset()
  })

  /**
   * Helper：从 mockAuditInfo 的所有调用里找 action 匹配的 JSON payload。
   * 返回 null 表示未找到（断言 fail 时给具体错误信息）。
   */
  function findAuditCall(action: string): Record<string, unknown> | null {
    for (const call of mockAuditInfo.mock.calls) {
      const raw = call[0]
      if (typeof raw !== 'string') continue
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed.action === action) return parsed
      } catch {
        // ignore non-JSON payloads
      }
    }
    return null
  }

  describe('acquire', () => {
    it('审批通过 + 锁成功 + Escape 注册成功 → ok + AbortSignal', async () => {
      mockRequestApproval.mockResolvedValue({ approved: true })
      mockTryAcquire.mockResolvedValue({ kind: 'acquired', fresh: true })
      mockRegister.mockReturnValue(true)
      mockIsHeldLocally.mockReturnValue(true)

      const result = await Guard.acquire('s-1')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.abortSignal).toBeInstanceOf(AbortSignal)
        expect(result.abortSignal.aborted).toBe(false)
      }
      expect(Guard.isApproved()).toBe(true)
    })

    it('用户拒绝审批 → 失败（三段式 reason：原因 · 影响 · 行动）', async () => {
      mockRequestApproval.mockResolvedValue({ approved: false })

      const result = await Guard.acquire('s-2')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(/用户拒绝了桌面操控请求/)
        expect(result.reason).toMatch(/本次.*未执行/)
        expect(result.reason).toMatch(/请在下次审批弹窗中选择「允许」|设置.*桌面操控/)
      }
    })

    it('锁被占用 → 失败', async () => {
      mockRequestApproval.mockResolvedValue({ approved: true })
      mockTryAcquire.mockResolvedValue({ kind: 'blocked', by: 'other-session' })

      const result = await Guard.acquire('s-3')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(/被另一个.*session.*占用/)
      }
    })

    it('Escape 注册失败 → 失败且释放锁', async () => {
      mockRequestApproval.mockResolvedValue({ approved: true })
      mockTryAcquire.mockResolvedValue({ kind: 'acquired', fresh: true })
      mockRegister.mockReturnValue(false)
      mockRelease.mockResolvedValue(true)

      const result = await Guard.acquire('s-4')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(/热键注册失败/)
      }
      expect(mockRelease).toHaveBeenCalledWith('s-4')
    })

    it('重入同一 session → 直接 ok，不再审批', async () => {
      mockRequestApproval.mockResolvedValue({ approved: true })
      mockTryAcquire.mockResolvedValue({ kind: 'acquired', fresh: true })
      mockRegister.mockReturnValue(true)
      mockIsHeldLocally.mockReturnValue(true)

      const first = await Guard.acquire('s-5')
      expect(first.ok).toBe(true)

      mockRequestApproval.mockClear()
      mockTryAcquire.mockClear()

      const second = await Guard.acquire('s-5')

      expect(second.ok).toBe(true)
      if (second.ok) {
        expect(second.abortSignal).toBeInstanceOf(AbortSignal)
      }
      expect(mockRequestApproval).not.toHaveBeenCalled()
      expect(mockTryAcquire).not.toHaveBeenCalled()
    })
  })

  describe('release', () => {
    it('正常释放 → unregister + release lock + 通知', async () => {
      mockRequestApproval.mockResolvedValue({ approved: true })
      mockTryAcquire.mockResolvedValue({ kind: 'acquired', fresh: true })
      mockRegister.mockReturnValue(true)
      mockIsHeldLocally.mockReturnValue(true)
      mockRelease.mockResolvedValue(true)

      await Guard.acquire('s-6')
      expect(Guard.isApproved()).toBe(true)

      mockNotificationShow.mockClear()

      await Guard.release('s-6')

      const expectedShortcut = process.platform === 'darwin' ? 'Command+Shift+Escape' : 'Ctrl+Alt+Escape'
      expect(mockUnregister).toHaveBeenCalledWith(expectedShortcut)
      expect(mockRelease).toHaveBeenCalledWith('s-6')
      expect(mockNotificationShow).toHaveBeenCalled()

      mockIsHeldLocally.mockReturnValue(false)
      expect(Guard.isApproved()).toBe(false)
    })

    it('DesktopUseLock.release 抛错 → 不抛异常', async () => {
      mockRelease.mockRejectedValue(new Error('boom'))
      await Guard.release('s-7')
    })
  })

  describe('checkAccessibilityPermission', () => {
    it('非 darwin 平台 → { granted: true }', () => {
      const orig = process.platform
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      })
      try {
        expect(Guard.checkAccessibilityPermission()).toEqual({ granted: true })
        expect(mockIsTrusted).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', {
          value: orig,
          configurable: true,
        })
      }
    })
  })

  describe('AbortSignal 联动', () => {
    it('中止快捷键 → 自动 release', async () => {
      mockRequestApproval.mockResolvedValue({ approved: true })
      mockTryAcquire.mockResolvedValue({ kind: 'acquired', fresh: true })
      mockRegister.mockReturnValue(true)
      mockIsHeldLocally.mockReturnValue(true)
      mockRelease.mockResolvedValue(true)

      const result = await Guard.acquire('s-9')
      if (!result.ok) throw new Error('acquire should succeed')

      const abortHandler = mockRegister.mock.calls[0][1] as () => void
      abortHandler()

      expect(result.abortSignal.aborted).toBe(true)
      expect(mockRelease).toHaveBeenCalledWith('s-9')
    })
  })

  describe('审批持久化 TTL', () => {
    function setupAcquireMocks() {
      mockTryAcquire.mockResolvedValue({ kind: 'acquired', fresh: true })
      mockRegister.mockReturnValue(true)
      mockIsHeldLocally.mockReturnValue(true)
      mockRelease.mockResolvedValue(true)
    }

    it('有效期内的持久化审批 → 跳过审批弹窗', async () => {
      const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString()
      mockReadFileSync.mockReturnValue(JSON.stringify({
        approved: true,
        grantedAt: oneHourAgo,
        ttlMs: 86_400_000,
      }))
      setupAcquireMocks()

      const result = await Guard.acquire('s-ttl-1')

      expect(result.ok).toBe(true)
      expect(mockRequestApproval).not.toHaveBeenCalled()
    })

    it('TTL 过期 → 重新弹出审批弹窗 + 删除审批文件', async () => {
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3_600_000).toISOString()
      mockReadFileSync.mockReturnValue(JSON.stringify({
        approved: true,
        grantedAt: twentyFiveHoursAgo,
        ttlMs: 86_400_000,
      }))
      mockRequestApproval.mockResolvedValue({ approved: false })

      const result = await Guard.acquire('s-ttl-2')

      expect(mockUnlinkSync).toHaveBeenCalledWith(APPROVAL_FILE)
      expect(mockRequestApproval).toHaveBeenCalled()
      expect(result.ok).toBe(false)
    })

    it('时钟倒退（grantedAt 在未来）→ 删除审批文件 + 重新审批', async () => {
      const oneHourInFuture = new Date(Date.now() + 3_600_000).toISOString()
      mockReadFileSync.mockReturnValue(JSON.stringify({
        approved: true,
        grantedAt: oneHourInFuture,
        ttlMs: 86_400_000,
      }))
      mockRequestApproval.mockResolvedValue({ approved: false })

      const result = await Guard.acquire('s-ttl-3')

      expect(mockUnlinkSync).toHaveBeenCalledWith(APPROVAL_FILE)
      expect(mockRequestApproval).toHaveBeenCalled()
      expect(result.ok).toBe(false)
    })

    it('无 ttlMs 字段 → 使用默认 24h TTL', async () => {
      const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString()
      mockReadFileSync.mockReturnValue(JSON.stringify({
        approved: true,
        grantedAt: tenHoursAgo,
      }))
      setupAcquireMocks()

      const result = await Guard.acquire('s-ttl-4')

      expect(result.ok).toBe(true)
      expect(mockRequestApproval).not.toHaveBeenCalled()
    })

    it('persistApproval 写入 ttlMs 字段', async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockRequestApproval.mockResolvedValue({ approved: true })
      setupAcquireMocks()

      await Guard.acquire('s-ttl-5')

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        APPROVAL_FILE,
        expect.any(String),
      )
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
      expect(written.ttlMs).toBe(86_400_000)
      expect(written.approved).toBe(true)
      expect(written.grantedAt).toBeDefined()
    })
  })

  /**
   * W A0.4.续 / hardening-round4 #4：Guard 4 个 approval 审计事件落地测试。
   *
   * 字段契约（hardening-round4 #2 落地结果，对齐 desktop-audit-logger jsonl
   * `sessionId?: string | null` schema）：
   * - approval_granted/denied：sessionId 来自 acquire(sessionId) 链路注入
   * - approval_expired/clock_anomaly：源自 loadPersistedApproval，无 session 上下文
   *   → sessionId: null
   *
   * 注：当前 4 个事件仍走 desktopAuditLogger.info()（v1.4 单事实源设计：
   * Guard approval 不进 jsonl，仅落 console debug）；本测试只断言事件被
   * 调用 + payload 含 action/sessionId 字段，不断言 jsonl 落盘。
   */
  describe('approval 审计 sessionId 字段（hardening-round4 #2 + #4）', () => {
    it('approval_granted：含 sessionId 来自 acquire 入参', async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockRequestApproval.mockResolvedValue({ approved: true })
      mockTryAcquire.mockResolvedValue({ kind: 'acquired', fresh: true })
      mockRegister.mockReturnValue(true)
      mockIsHeldLocally.mockReturnValue(true)

      const result = await Guard.acquire('s-audit-granted')
      expect(result.ok).toBe(true)

      const granted = findAuditCall('approval_granted')
      expect(granted, 'approval_granted 审计事件未被记录').not.toBeNull()
      expect(granted!.sessionId, 'approval_granted 缺 sessionId 字段').toBe('s-audit-granted')
      expect(granted!.ts, 'approval_granted 缺 ts 字段').toEqual(expect.any(Number))
    })

    it('approval_denied：含 sessionId 来自 acquire 入参', async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockRequestApproval.mockResolvedValue({ approved: false })

      const result = await Guard.acquire('s-audit-denied')
      expect(result.ok).toBe(false)

      const denied = findAuditCall('approval_denied')
      expect(denied, 'approval_denied 审计事件未被记录').not.toBeNull()
      expect(denied!.sessionId, 'approval_denied 缺 sessionId 字段').toBe('s-audit-denied')
      expect(denied!.ts).toEqual(expect.any(Number))
    })

    it('approval_expired：sessionId=null（loadPersistedApproval 无 session 上下文）', async () => {
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3_600_000).toISOString()
      mockReadFileSync.mockReturnValue(JSON.stringify({
        approved: true,
        grantedAt: twentyFiveHoursAgo,
        ttlMs: 86_400_000,
      }))
      // approval 因过期重弹 + 用户拒绝（避免后续 lock 流程干扰断言）
      mockRequestApproval.mockResolvedValue({ approved: false })

      await Guard.acquire('s-audit-expired')

      const expired = findAuditCall('approval_expired')
      expect(expired, 'approval_expired 审计事件未被记录').not.toBeNull()
      expect(
        expired!.sessionId,
        'approval_expired 必须用 null（无 session 上下文，与 audit jsonl schema sessionId?: string | null 对齐）',
      ).toBeNull()
      expect(expired!.ts).toEqual(expect.any(Number))
    })

    it('approval_clock_anomaly：sessionId=null（grantedAt 在未来）', async () => {
      const oneHourInFuture = new Date(Date.now() + 3_600_000).toISOString()
      mockReadFileSync.mockReturnValue(JSON.stringify({
        approved: true,
        grantedAt: oneHourInFuture,
        ttlMs: 86_400_000,
      }))
      mockRequestApproval.mockResolvedValue({ approved: false })

      await Guard.acquire('s-audit-clock')

      const anomaly = findAuditCall('approval_clock_anomaly')
      expect(anomaly, 'approval_clock_anomaly 审计事件未被记录').not.toBeNull()
      expect(
        anomaly!.sessionId,
        'approval_clock_anomaly 必须用 null',
      ).toBeNull()
      expect(anomaly!.ts).toEqual(expect.any(Number))
    })
  })
})
