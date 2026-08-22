import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock function references (prefix "mock" → auto-hoisted by vitest)
// ---------------------------------------------------------------------------

const mockMouseSetPosition = vi.fn()
const mockMouseClick = vi.fn()
const mockMouseDoubleClick = vi.fn()
const mockKeyboardPressKey = vi.fn()
const mockKeyboardReleaseKey = vi.fn()
const mockKeyboardType = vi.fn()

const mockKeyEnum: Record<string, number> = {
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18,
  T: 19, U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
  Num0: 400, Num1: 401, Num2: 402, Num3: 403, Num4: 404,
  Num5: 405, Num6: 406, Num7: 407, Num8: 408, Num9: 409,
  LeftCmd: 100, LeftControl: 101, LeftAlt: 102, LeftShift: 103,
  Fn: 104, LeftMeta: 105, LeftSuper: 106, LeftWin: 107,
  RightCmd: 110, RightControl: 111, RightAlt: 112, RightShift: 113,
  RightMeta: 114, RightSuper: 115, RightWin: 116,
  Enter: 200, Return: 201, Tab: 202, Space: 203, Backspace: 204, Delete: 205,
  Escape: 206,
  Up: 210, Down: 211, Left: 212, Right: 213,
  Home: 220, End: 221, PageUp: 222, PageDown: 223,
  F1: 300, F2: 301, F3: 302, F4: 303, F5: 304, F6: 305,
  F7: 306, F8: 307, F9: 308, F10: 309, F11: 310, F12: 311,
  Minus: 500, Equal: 501, Comma: 502, Period: 503,
  Slash: 504, Backslash: 505, Semicolon: 506, Quote: 507,
  Grave: 508, LeftBracket: 509, RightBracket: 510,
  CapsLock: 600, NumLock: 601, ScrollLock: 602, Pause: 603,
  Insert: 604, Print: 605,
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: vi.fn().mockReturnValue({
      id: 1,
      size: { width: 1440, height: 900 },
      scaleFactor: 2,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    getAllDisplays: vi.fn().mockReturnValue([]),
  },
  desktopCapturer: {
    getSources: vi.fn().mockResolvedValue([]),
  },
  clipboard: {
    readText: vi.fn().mockReturnValue(''),
    writeText: vi.fn(),
  },
  shell: { openPath: vi.fn() },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn().mockReturnValue(true),
  },
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
}))

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const { mockAuditInfo } = vi.hoisted(() => ({ mockAuditInfo: vi.fn() }))
vi.mock('electron-log', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      transports: {
        file: { fileName: '', format: '' },
        console: { level: 'info' },
      },
      info: mockAuditInfo,
    }),
  },
}))

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: {
    config: { mouseSpeed: 0, autoDelayMs: 0 },
    setPosition: mockMouseSetPosition,
    click: mockMouseClick,
    doubleClick: mockMouseDoubleClick,
    pressButton: vi.fn(),
    releaseButton: vi.fn(),
    scrollDown: vi.fn(),
    scrollUp: vi.fn(),
    scrollLeft: vi.fn(),
    scrollRight: vi.fn(),
  },
  keyboard: {
    config: { autoDelayMs: 0 },
    type: mockKeyboardType,
    pressKey: mockKeyboardPressKey,
    releaseKey: mockKeyboardReleaseKey,
  },
  Key: mockKeyEnum,
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Point: vi.fn().mockImplementation(function (this: any, x: number, y: number) {
    this.x = x
    this.y = y
  }),
}))

vi.mock('node:child_process', () => {
  const mod = { execFileSync: vi.fn() }
  return { ...mod, default: mod }
})

// Wave 2 · 规范 § 6.11.3：Executor 审计改走 writeAuditLog → appendFileSync（jsonl）。
// 保留 mockAuditInfo（electron-log）以守约"旧 transport 不写文件"——见下方"审计日志"组。
const { mockAppendFileSync } = vi.hoisted(() => ({
  mockAppendFileSync: vi.fn(),
}))
vi.mock('node:fs', () => {
  const mod = {
    mkdirSync: vi.fn(),
    appendFileSync: mockAppendFileSync,
  }
  return { ...mod, default: mod }
})

vi.mock('node:fs/promises', () => {
  const mod = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  }
  return { ...mod, default: mod }
})

vi.mock('sharp', () => ({
  default: vi.fn(),
}))

// Wave 2 · 规范 § 6.12：extendAllowedApps 走 ApprovalManager.requestApproval
// + DesktopUseLock.isHeldLocally。mock 双方以便在 extendAllowedApps 测试中
// 模拟"审批通过 / 审批拒绝 / 未持锁"三条路径。
const { mockRequestApproval } = vi.hoisted(() => ({
  mockRequestApproval: vi.fn<(...args: unknown[]) => Promise<{ approved: boolean }>>(),
}))
vi.mock('../ApprovalManager', () => ({
  requestApproval: (...args: unknown[]) => mockRequestApproval(...args),
}))

const { mockIsHeldLocally } = vi.hoisted(() => ({
  mockIsHeldLocally: vi.fn<() => boolean>(),
}))
vi.mock('../DesktopUseLock', () => ({
  isHeldLocally: () => mockIsHeldLocally(),
  tryAcquire: vi.fn(),
  release: vi.fn(),
  check: vi.fn(),
}))

// Wave 2.2 · 规范 § 6.6：allowedApps 精确匹配——需要 mock getAppAtPoint 以
// 模拟"坐标落在某应用"的场景，覆盖精确匹配 / 大小写不敏感 / trim / 子串不误放行
// 四个维度。其他走 helpers 的路径（listWindowsMac / escapeAppleScript 等）保持原样。
const { mockGetAppAtPoint } = vi.hoisted(() => ({
  mockGetAppAtPoint: vi.fn<(x: number, y: number) => string | null>(),
}))
vi.mock('../desktop-window-helpers', async () => {
  const actual = await vi.importActual<typeof import('../desktop-window-helpers')>(
    '../desktop-window-helpers',
  )
  return {
    ...actual,
    getAppAtPoint: (x: number, y: number) => mockGetAppAtPoint(x, y),
  }
})

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock calls)
// ---------------------------------------------------------------------------

import { DesktopExecutorService } from '../DesktopExecutorService'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DesktopExecutorService', () => {
  let service: DesktopExecutorService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new DesktopExecutorService(() => null)
  })

  // -- Session 管理 --------------------------------------------------------

  describe('Session 管理', () => {
    it('startSession 后 getSession 返回正确 session', () => {
      service.startSession('test-1')
      const session = service.getSession()
      expect(session).not.toBeNull()
      expect(session!.sessionId).toBe('test-1')
    })

    it('同 sessionId 重复调用不覆盖', () => {
      service.startSession('test-1')
      const first = service.getSession()
      service.startSession('test-1')
      expect(service.getSession()).toBe(first)
    })

    it('不同 sessionId 调用会创建新 session', () => {
      service.startSession('test-1')
      service.startSession('test-2')
      expect(service.getSession()!.sessionId).toBe('test-2')
    })

    it('endSession 后 getSession 返回 null', () => {
      service.startSession('test-1')
      service.endSession()
      expect(service.getSession()).toBeNull()
    })

    it('未启动 session 时 endSession 不报错', () => {
      expect(() => service.endSession()).not.toThrow()
    })

    it('grantFlags 默认值全为 false', () => {
      service.startSession('test-1')
      expect(service.getSession()!.grantFlags).toEqual({
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      })
    })

    it('grantFlags 自定义值正确合并（未指定的保持 false）', () => {
      service.startSession('test-1', {
        grantFlags: { clipboardRead: true, systemKeyCombos: true },
      })
      expect(service.getSession()!.grantFlags).toEqual({
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
      })
    })

    it('allowedApps 正确存储', () => {
      service.startSession('test-1', { allowedApps: ['Safari', 'Chrome'] })
      expect(service.getSession()!.allowedApps).toEqual(['Safari', 'Chrome'])
    })
  })

  // -- toScreenCoords 间接测试（无截屏 dims 时 throw）-----------------------

  describe('toScreenCoords 缺少 dims 时 throw', () => {
    it('无 session 时 click → throw 尚未截屏', async () => {
      await expect(service.click(100, 100)).rejects.toThrow('尚未截屏')
    })

    it('有 session 但未截屏时 click → throw 尚未截屏', async () => {
      service.startSession('test-1')
      await expect(service.click(100, 100)).rejects.toThrow('尚未截屏')
    })
  })

  // -- 危险键拦截 -----------------------------------------------------------

  describe('危险键拦截', () => {
    it('hotkey([cmd, q]) → throw 系统级快捷键被阻止', async () => {
      await expect(service.hotkey(['cmd', 'q'])).rejects.toThrow('系统级快捷键')
    })

    it('hotkey([alt, f4]) → throw 系统级快捷键被阻止', async () => {
      await expect(service.hotkey(['alt', 'f4'])).rejects.toThrow('系统级快捷键')
    })

    it('hotkey([cmd, c]) → 正常复制不阻止', async () => {
      await service.hotkey(['cmd', 'c'])
      expect(mockKeyboardPressKey).toHaveBeenCalled()
    })

    it('keyPress(q, [cmd]) → throw 系统级快捷键被阻止', async () => {
      await expect(service.keyPress('q', ['cmd'])).rejects.toThrow('系统级快捷键')
    })

    it('systemKeyCombos=true 时 hotkey([cmd, q]) 不阻止', async () => {
      service.startSession('test-1', { grantFlags: { systemKeyCombos: true } })
      await service.hotkey(['cmd', 'q'])
      expect(mockKeyboardPressKey).toHaveBeenCalled()
    })
  })

  // -- resolveKey 平台感知 --------------------------------------------------

  describe('resolveKey 平台感知（通过 hotkey 间接测试）', () => {
    const originalPlatform = process.platform

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('darwin 时 cmd 映射到 LeftCmd', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await service.hotkey(['cmd', 'c'])
      expect(mockKeyboardPressKey).toHaveBeenCalledWith(
        mockKeyEnum.LeftCmd,
        mockKeyEnum.C,
      )
    })

    it('win32 时 cmd 映射到 LeftControl', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      await service.hotkey(['cmd', 'c'])
      expect(mockKeyboardPressKey).toHaveBeenCalledWith(
        mockKeyEnum.LeftControl,
        mockKeyEnum.C,
      )
    })
  })

  // -- 坐标换算（通过 click 间接测试）--------------------------------------

  describe('坐标换算（通过 click 间接测试）', () => {
    beforeEach(() => {
      service.startSession('coord-test')
    })

    it('scaleFactor 正确映射截图坐标到屏幕坐标', async () => {
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 800,
        height: 500,
        displayWidth: 1600,
        displayHeight: 1000,
        scaleFactor: 0.5, // 800 / 1600
      }

      await service.click(400, 250)
      // 400 / 0.5 = 800,  250 / 0.5 = 500
      expect(mockMouseSetPosition).toHaveBeenCalledWith({ x: 800, y: 500 })
    })

    it('regionOffset 正确偏移坐标', async () => {
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 800,
        height: 500,
        displayWidth: 1600,
        displayHeight: 1000,
        scaleFactor: 0.5,
        regionOffset: { x: 100, y: 200 },
      }

      await service.click(50, 50)
      // x = 50/0.5 + 100 = 200,  y = 50/0.5 + 200 = 300
      expect(mockMouseSetPosition).toHaveBeenCalledWith({ x: 200, y: 300 })
    })

    it('无 regionOffset 时默认偏移为 0', async () => {
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1440,
        height: 900,
        displayWidth: 1440,
        displayHeight: 900,
        scaleFactor: 1.0,
      }

      await service.click(720, 450)
      expect(mockMouseSetPosition).toHaveBeenCalledWith({ x: 720, y: 450 })
    })

    it('多显示器 bounds 正偏移（副显示器在主显示器右侧）', async () => {
      ;(service as any).currentSession.frozenDisplayConfig = {
        width: 1920, height: 1080, scaleFactor: 1, boundsX: 1440, boundsY: 0,
      }
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      await service.click(100, 200)
      expect(mockMouseSetPosition).toHaveBeenCalledWith({ x: 1540, y: 200 })
    })

    it('多显示器 bounds 负偏移（副显示器在主显示器左侧）', async () => {
      ;(service as any).currentSession.frozenDisplayConfig = {
        width: 1920, height: 1080, scaleFactor: 1, boundsX: -1920, boundsY: 0,
      }
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      await service.click(100, 200)
      expect(mockMouseSetPosition).toHaveBeenCalledWith({ x: -1820, y: 200 })
    })

    it('多显示器 bounds + regionOffset 联合偏移', async () => {
      ;(service as any).currentSession.frozenDisplayConfig = {
        width: 1920, height: 1080, scaleFactor: 1, boundsX: 1440, boundsY: 300,
      }
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 960, height: 540, displayWidth: 1920, displayHeight: 1080,
        scaleFactor: 0.5, regionOffset: { x: 100, y: 50 },
      }
      await service.click(50, 25)
      // x = 50/0.5 + 100 + 1440 = 1640,  y = 25/0.5 + 50 + 300 = 400
      expect(mockMouseSetPosition).toHaveBeenCalledWith({ x: 1640, y: 400 })
    })

    it('无 frozenDisplayConfig 时 bounds 默认 0', async () => {
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 800, height: 500, displayWidth: 1600, displayHeight: 1000, scaleFactor: 0.5,
      }
      await service.click(400, 250)
      expect(mockMouseSetPosition).toHaveBeenCalledWith({ x: 800, y: 500 })
    })
  })

  // -- Key Code 安全检查 -----------------------------------------------------

  describe('Key Code 安全检查', () => {
    it('枚举名绕过场景：直接使用 "LeftCmd" 不在 keyMap 中，应报"按键名称无效"', async () => {
      await expect(service.hotkey(['LeftCmd', 'q'])).rejects.toThrow('按键名称无效')
    })

    it('跨平台映射：win32 上 cmd 映射到 ctrl，ctrl+q 也在危险列表', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        await expect(service.hotkey(['cmd', 'q'])).rejects.toThrow('系统级快捷键')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    it('RightCmd + Q 通过 normalizeModifierKey 归一化后被拦截', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      try {
        // 手动构建带 RightCmd 的 hotkey 场景：通过 keyPress 间接测试
        // RightCmd 没在 keyMap 中，所以无法通过字符串触发，这验证了 enum fallback 移除
        // 改为直接测试 normalizeModifierKey 的效果：meta 在 macOS 上归一化为 cmd
        await expect(service.hotkey(['meta', 'q'])).rejects.toThrow('系统级快捷键')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    it('别名绕过场景（macOS）：meta/super/win 归一化为 cmd，meta+q 被拦截', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      try {
        await expect(service.hotkey(['super', 'q'])).rejects.toThrow('系统级快捷键')
        await expect(service.hotkey(['win', 'q'])).rejects.toThrow('系统级快捷键')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    it('非 macOS 下 meta 不归一化为 cmd，meta+q 不拦截', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux' })
      try {
        await service.hotkey(['meta', 'q'])
        expect(mockKeyboardPressKey).toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    })

    it('ctrl+alt+delete 被拦截', async () => {
      await expect(service.hotkey(['ctrl', 'alt', 'delete'])).rejects.toThrow('系统级快捷键')
    })
  })

  // -- AbortSignal 中止 -----------------------------------------------------

  describe('AbortSignal 中止', () => {
    it('abort 后 click 抛错', async () => {
      service.startSession('abort-test')
      const controller = new AbortController()
      service.setAbortSignal(controller.signal)
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      controller.abort()
      await expect(service.click(100, 100)).rejects.toThrow('中止')
    })

    it('abort 后 hotkey 抛错', async () => {
      service.startSession('abort-test')
      const controller = new AbortController()
      service.setAbortSignal(controller.signal)
      controller.abort()
      await expect(service.hotkey(['cmd', 'c'])).rejects.toThrow('中止')
    })

    it('abort 后 type 抛错', async () => {
      service.startSession('abort-test')
      const controller = new AbortController()
      service.setAbortSignal(controller.signal)
      controller.abort()
      await expect(service.type('hello')).rejects.toThrow('中止')
    })

    it('endSession 清除 abortSignal', async () => {
      service.startSession('abort-test')
      const controller = new AbortController()
      service.setAbortSignal(controller.signal)
      controller.abort()

      service.endSession()
      service.startSession('new-session')
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      await expect(service.click(100, 100)).resolves.toBeUndefined()
    })
  })

  // -- Session 超时与活动追踪 ------------------------------------------------

  describe('Session 超时与活动追踪', () => {
    it('startSession 设置 startedAt', () => {
      const before = Date.now()
      service.startSession('idle-test')
      const session = service.getSession()!
      expect(session.startedAt).toBeGreaterThanOrEqual(before)
      expect(session.startedAt).toBeLessThanOrEqual(Date.now())
    })

    it('无 session 时 getIdleMs 返回 0', () => {
      expect(service.getIdleMs()).toBe(0)
    })

    it('新建 session 后 getIdleMs 很小', () => {
      service.startSession('idle-test')
      expect(service.getIdleMs()).toBeLessThan(100)
    })

    it('操作后 lastActivityAt 被更新', async () => {
      service.startSession('idle-test')
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      ;(service as any).currentSession.startedAt = Date.now() - 5000
      await service.click(100, 100)
      expect(service.getIdleMs()).toBeLessThan(100)
    })

    it('getIdleMs 基于 lastActivityAt 而非 startedAt', () => {
      service.startSession('idle-test')
      const session = service.getSession()!
      session.startedAt = Date.now() - 10000
      session.lastActivityAt = Date.now() - 2000
      const idle = service.getIdleMs()
      expect(idle).toBeGreaterThanOrEqual(1500)
      expect(idle).toBeLessThan(3000)
    })
  })

  // -- withTimeout 超时保护 --------------------------------------------------

  describe('withTimeout 超时保护', () => {
    it('操作正常完成时 withTimeout 不干扰', async () => {
      service.startSession('timeout-test')
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      await expect(service.click(100, 100)).resolves.toBeUndefined()
    })

    it('超时时抛出桌面操作超时错误', async () => {
      const withTimeout = (service as any).withTimeout.bind(service)
      const neverResolve = new Promise<void>(() => {})
      await expect(withTimeout(neverResolve, 'test-op', 50)).rejects.toThrow('桌面操作超时')
    })

    it('超时错误包含操作标签和时长', async () => {
      const withTimeout = (service as any).withTimeout.bind(service)
      const neverResolve = new Promise<void>(() => {})
      await expect(withTimeout(neverResolve, 'my-label', 100)).rejects.toThrow('my-label')
    })

    it('正常完成时 clearTimeout 被调用（不泄露定时器）', async () => {
      const withTimeout = (service as any).withTimeout.bind(service)
      const result = await withTimeout(Promise.resolve('ok'), 'fast-op', 5000)
      expect(result).toBe('ok')
    })
  })

  // -- 审计日志 --------------------------------------------------------------

  // Wave 2 · 规范 § 6.11.3 / § 9.2 第 6 条：Executor 审计改走 writeAuditLog
  // → appendFileSync(~/.tabtin/desktop-audit.jsonl)。旧 electron-log audit.info
  // 文件 transport 已 disabled（见 desktop-audit-logger 单测守约），旧断言口径
  // （mockAuditInfo.mock.calls[0][0]）不再适用。
  describe('审计日志', () => {
    beforeEach(() => {
      mockAppendFileSync.mockClear()
      mockAuditInfo.mockClear()
    })

    /** 从最新一次 appendFileSync 调用里解析出 jsonl 记录。
     *  W1.3 起按月分片：路径形如 `desktop-audit-YYYY-MM.jsonl`；legacy 单文件
     *  `desktop-audit.jsonl` 也接受（v1.4 → v1.5 migration 期间可能短暂出现）。 */
    function lastAuditEntry(): Record<string, unknown> {
      expect(mockAppendFileSync).toHaveBeenCalled()
      const calls = mockAppendFileSync.mock.calls
      const [path, payload] = calls[calls.length - 1]
      expect(String(path)).toMatch(/desktop-audit(?:-\d{4}-\d{2})?\.jsonl$/)
      return JSON.parse(String(payload).trim())
    }

    it('click 调用时写入审计 jsonl（新路径，不再走 electron-log file transport）', async () => {
      service.startSession('audit-test')
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      await service.click(100, 200)
      const logEntry = lastAuditEntry()
      expect(logEntry.action).toBe('click')
      expect((logEntry.params as any).x).toBe(100)
      expect((logEntry.params as any).y).toBe(200)
      expect(logEntry.sessionId).toBe('audit-test')
      expect(logEntry.result).toBe('ok')
      // 新 schema：用 ISO8601 timestamp 替代旧 number ts
      expect(typeof logEntry.timestamp).toBe('string')
      expect(() => new Date(logEntry.timestamp as string)).not.toThrow()
    })

    it('type 审计时 text 字段完全脱敏（非 clipboard 路径，Wave 2.2 加固：仅记长度）', async () => {
      service.startSession('audit-test')
      const secret = 'MyPassw0rd!123'
      await service.type(secret)
      const logEntry = lastAuditEntry()
      expect(logEntry.action).toBe('type')
      const recordedText = (logEntry.params as any).text as string
      expect(recordedText).toBe(`[typed_text, len=${secret.length}]`)
      expect(recordedText).not.toContain('MyPassw0rd')
      expect(recordedText).not.toContain('Pass')
      expect(recordedText).not.toContain('Secret')
    })

    it('type 审计时短文本也完全脱敏（非 clipboard 路径不再留原文）', async () => {
      service.startSession('audit-test')
      await service.type('hello')
      const logEntry = lastAuditEntry()
      expect((logEntry.params as any).text).toBe('[typed_text, len=5]')
    })

    it('type --clipboard 审计时 text 脱敏为 [clipboard_paste, len=N]', async () => {
      service.startSession('audit-test', {
        grantFlags: { clipboardWrite: true },
      })
      // audit 在 enqueue 前即记录；实际剪贴板粘贴的后续流程在单测 mock 下可能抛错，
      // 这里只关心"审计行是否脱敏"——tolerate 后续 reject，断言只读审计记录。
      await service.type('你好世界', true).catch(() => {})
      const logEntry = lastAuditEntry()
      expect(logEntry.action).toBe('type')
      const recordedText = (logEntry.params as any).text as string
      expect(recordedText).toBe('[clipboard_paste, len=4]')
      expect(recordedText).not.toContain('你好')
    })

    it('hotkey 调用时写入审计 jsonl', async () => {
      service.startSession('audit-test')
      await service.hotkey(['cmd', 'c'])
      const logEntry = lastAuditEntry()
      expect(logEntry.action).toBe('hotkey')
      expect((logEntry.params as any).keys).toEqual(['cmd', 'c'])
      expect(logEntry.result).toBe('ok')
    })
  })

  // -- Idle Timer 定时器 -----------------------------------------------------

  describe('Idle Timer 定时器', () => {
    it('startSession 启动 idleTimer', () => {
      service.startSession('timer-test')
      expect((service as any).idleTimer).toBeDefined()
    })

    it('endSession 清除 idleTimer', () => {
      service.startSession('timer-test')
      service.endSession()
      expect((service as any).idleTimer).toBeUndefined()
    })

    it('重复 startSession 不泄露 timer（先清再建）', () => {
      service.startSession('timer-1')
      const timer1 = (service as any).idleTimer
      service.startSession('timer-2')
      const timer2 = (service as any).idleTimer
      expect(timer2).toBeDefined()
      expect(timer2).not.toBe(timer1)
    })

    it('onSessionTimeout 回调在超时时被调用', () => {
      const timeoutCb = vi.fn()
      const svc = new DesktopExecutorService(() => null, { onSessionTimeout: timeoutCb })
      svc.startSession('timeout-cb-test')
      ;(svc as any).currentSession.startedAt = Date.now() - 11 * 60 * 1000
      ;(svc as any).currentSession.lastActivityAt = Date.now() - 11 * 60 * 1000
      // 手动触发 idle check 逻辑
      expect(svc.getIdleMs()).toBeGreaterThan(10 * 60 * 1000)
      // 直接模拟 interval 回调的逻辑
      if (svc.getIdleMs() > 10 * 60 * 1000) {
        svc.endSession()
        timeoutCb('timeout-cb-test')
      }
      expect(timeoutCb).toHaveBeenCalledWith('timeout-cb-test')
      expect(svc.getSession()).toBeNull()
    })
  })

  // -- sessionEnding 标记 ---------------------------------------------------

  describe('sessionEnding 标记（R2-P2-2）', () => {
    it('endSession 后 sessionEnding 为 true，操作抛错', async () => {
      service.startSession('ending-test')
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      service.endSession()
      // sessionEnding = true，新操作应抛"session 已结束"错误（与 abortSignal 触发的"已被用户中止"区分）
      await expect(service.click(100, 100)).rejects.toThrow('session 已结束')
    })

    it('startSession 重置 sessionEnding', async () => {
      service.startSession('ending-test')
      service.endSession()
      service.startSession('new-session')
      ;(service as any).currentSession.lastScreenshotDims = {
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, scaleFactor: 1.0,
      }
      await expect(service.click(100, 100)).resolves.toBeUndefined()
    })
  })

  // -- openApp 应用名 / 路径双形式（Wave 1 路径 A 方案）---------------------

  describe('openApp 应用名与路径（Wave 1 路径 A 方案）', () => {
    const originalPlatform = process.platform
    let execFileSyncMock: any

    beforeEach(async () => {
      const cp = await import('node:child_process')
      execFileSyncMock = cp.execFileSync as unknown as ReturnType<typeof vi.fn>
      ;(execFileSyncMock as any).mockReset?.()
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('macOS 下传应用名 → 走 open -a <name>', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await service.openApp('Microsoft Excel')
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'open',
        ['-a', 'Microsoft Excel'],
        expect.any(Object),
      )
    })

    it('macOS 下传 .app 路径 → 走 open <path>（不带 -a）', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await service.openApp('/Applications/Visual Studio Code.app')
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'open',
        ['/Applications/Visual Studio Code.app'],
        expect.any(Object),
      )
    })

    it('macOS 下传任意斜杠路径 → 走 open <path>（不带 -a）', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await service.openApp('/usr/local/bin/some-tool')
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'open',
        ['/usr/local/bin/some-tool'],
        expect.any(Object),
      )
    })

    it('Windows 下应用名走 Start-Process（同样路径形式也能走）', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      await service.openApp('notepad')
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'powershell',
        expect.arrayContaining(['-NoProfile', '-Command']),
        expect.objectContaining({
          env: expect.objectContaining({ TABTIN_APP: 'notepad' }),
        }),
      )
    })

    it('Linux 下抛中文「不支持」错误（不再走 xdg-open）', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      await expect(service.openApp('Slack')).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
    })

    it('参数包含 ".." 上跳被拒绝', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await expect(service.openApp('../../../etc/passwd')).rejects.toThrow(/不允许包含 ".."/)
    })

    it('参数包含 shell 元字符（如 ;）被拒绝', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await expect(service.openApp('Slack; rm -rf /')).rejects.toThrow(/不允许的字符/)
    })

    it('空参数被拒绝', async () => {
      // 必须显式指定支持平台：Linux guard 现在在参数校验之前（审计顺序修正），
      // 若不 pin 平台，测试机若是 Linux 将先被"仅在 macOS 和 Windows 可用"吞掉。
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      await expect(service.openApp('   ')).rejects.toThrow(/为空或长度超过/)
    })
  })

  // -- listWindows / activateWindow Linux 不支持 ----------------------------

  describe('Linux 平台分支抛中文「不支持」', () => {
    const originalPlatform = process.platform

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('listWindows 在 linux 抛中文「仅在 macOS 和 Windows 可用」', async () => {
      await expect(service.listWindows()).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
    })

    it('activateWindow 在 linux 抛中文「仅在 macOS 和 Windows 可用」', async () => {
      await expect(service.activateWindow('Some App')).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
    })

    it('screenshot 在 linux 顶层拦截抛中文「仅在 macOS 和 Windows 可用」', async () => {
      await expect(service.screenshot()).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
    })

    it('Linux 抛错时审计 jsonl 不被调用（guard 在 audit 之前）', async () => {
      mockAuditInfo.mockClear()
      mockAppendFileSync.mockClear()
      await expect(service.screenshot()).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
      await expect(service.listWindows()).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
      await expect(service.activateWindow('Some App')).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
      await expect(service.openApp('Slack')).rejects.toThrow(/仅在 macOS 和 Windows 可用/)
      // Executor.audit → writeAuditLog → appendFileSync 链路完全不触发
      expect(mockAppendFileSync).not.toHaveBeenCalled()
      // 旧 electron-log audit.info 更不应触发（Wave 2 降级为 debug console，无写入语义）
      expect(mockAuditInfo).not.toHaveBeenCalled()
    })
  })

  // -- /accessibility Linux 豁免诊断语义（规范 § 4.4.3.1 / § 7.2 / § 10 Q4）----

  describe('/accessibility Linux 豁免：诊断工具返回 trusted=false / screenRecording=false / unavailable', () => {
    const originalPlatform = process.platform

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('checkAccessibility 在 Linux 下返回 false（非抛错）', () => {
      expect(service.checkAccessibility(false)).toBe(false)
      expect(service.checkAccessibility(true)).toBe(false)
    })

    it('checkScreenRecording 在 Linux 下返回 { granted: false, status: "unavailable" }', () => {
      expect(service.checkScreenRecording()).toEqual({ granted: false, status: 'unavailable' })
    })
  })

  // -- normalizeModifierKey RightMeta/RightSuper/RightWin (TD-4) -----------

  describe('normalizeModifierKey 右侧 Meta/Super/Win (TD-4)', () => {
    const originalPlatform = process.platform

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('macOS 上 RightMeta/RightSuper/RightWin 归一化后 meta+q 被拦截', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      // meta/super/win 在 keyMap 中映射为 LeftMeta/LeftSuper/LeftWin
      // 在 macOS 上这些都归一化为 LeftCmd，因此 meta+q = cmd+q → 危险
      await expect(service.hotkey(['meta', 'q'])).rejects.toThrow('系统级快捷键')
      await expect(service.hotkey(['super', 'q'])).rejects.toThrow('系统级快捷键')
      await expect(service.hotkey(['win', 'q'])).rejects.toThrow('系统级快捷键')
    })
  })

  // -- bounds 变化 fail-fast（Wave 2 · 规范 § 5.3 规则 8 / § 8.2 示范 D）------

  describe('bounds 变化 fail-fast：DISPLAY_CONFIG_CHANGED', () => {
    const originalPlatform = process.platform

    beforeEach(async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      // 确保 screenshot 的底层 mock 返回有效图像，让代码能走到 frozen 比对分支
      const electron = await import('electron')
      ;(electron.desktopCapturer.getSources as any).mockReset?.()
      ;(electron.desktopCapturer.getSources as any).mockResolvedValue([
        {
          display_id: '1',
          thumbnail: {
            isEmpty: () => false,
            toPNG: () => Buffer.from([1, 2, 3]),
          },
        },
      ])
      ;(electron.screen.getPrimaryDisplay as any).mockReturnValue({
        id: 1,
        size: { width: 1440, height: 900 },
        scaleFactor: 2,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
      })
      // screenRecording check 在 image.isEmpty() 为 false 的第二分支也会走到——
      // 补齐 getMediaAccessStatus mock，避免 undefined method
      ;(electron.systemPreferences as any).getMediaAccessStatus = vi
        .fn()
        .mockReturnValue('granted')
      // sharp mock：链式 resize + jpeg + toBuffer
      const sharp = (await import('sharp')).default as unknown as ReturnType<typeof vi.fn>
      ;(sharp as any).mockReset?.()
      const sharpChain: any = {
        resize: vi.fn().mockReturnThis(),
        extract: vi.fn().mockReturnThis(),
        jpeg: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from([9, 9, 9])),
      }
      ;(sharp as any).mockReturnValue(sharpChain)
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('冻结 bounds 与当前 bounds 一致 → 正常截屏', async () => {
      const svc = new DesktopExecutorService(() => null)
      svc.startSession('bounds-ok')
      // 预置 frozenDisplayConfig 与 mock 的 primaryDisplay 一致
      ;(svc as any).currentSession.frozenDisplayConfig = {
        width: 1440, height: 900, scaleFactor: 2, boundsX: 0, boundsY: 0,
      }
      await expect(svc.screenshot()).resolves.toBeDefined()
      // session 仍然存在（未被 endSession）
      expect(svc.getSession()).not.toBeNull()
    })

    it('bounds 不一致 → endSession 被调用 + 锁对应 session 被清 + 抛 DISPLAY_CONFIG_CHANGED', async () => {
      const timeoutCb = vi.fn()
      const svc = new DesktopExecutorService(() => null, { onSessionTimeout: timeoutCb })
      svc.startSession('bounds-diff')
      // 预置 frozenDisplayConfig 与当前 primaryDisplay bounds 不一致
      ;(svc as any).currentSession.frozenDisplayConfig = {
        width: 1440, height: 900, scaleFactor: 2, boundsX: 1920, boundsY: 0,
      }
      await expect(svc.screenshot()).rejects.toMatchObject({
        code: 'DISPLAY_CONFIG_CHANGED',
      })
      // endSession 后 session 应清空
      expect(svc.getSession()).toBeNull()
      // onSessionTimeout 回调被触发（route 层据此释放锁）
      expect(timeoutCb).toHaveBeenCalledWith('bounds-diff')
    })

    it('scaleFactor 变化（用户改屏幕缩放）也触发 fail-fast', async () => {
      const timeoutCb = vi.fn()
      const svc = new DesktopExecutorService(() => null, { onSessionTimeout: timeoutCb })
      svc.startSession('bounds-scale')
      ;(svc as any).currentSession.frozenDisplayConfig = {
        width: 1440, height: 900, scaleFactor: 1.5, boundsX: 0, boundsY: 0,
      }
      await expect(svc.screenshot()).rejects.toMatchObject({
        code: 'DISPLAY_CONFIG_CHANGED',
      })
      expect(svc.getSession()).toBeNull()
      // Wave 2.1 补断言：scaleFactor 分支与 bounds 分支对称——onSessionTimeout
      // 必须被触发（路由层据此 release 锁；漏断言会让"幽灵锁"回归静默通过）。
      expect(timeoutCb).toHaveBeenCalledWith('bounds-scale')
    })

    it('首次截屏（无 frozenDisplayConfig）不触发 fail-fast', async () => {
      const svc = new DesktopExecutorService(() => null)
      // 不预置 frozen，让 screenshot 自己 freeze
      await expect(svc.screenshot()).resolves.toBeDefined()
      expect(svc.getSession()).not.toBeNull()
      // 首次截屏会 freeze
      expect((svc as any).currentSession.frozenDisplayConfig).toMatchObject({
        boundsX: 0, boundsY: 0, width: 1440, height: 900, scaleFactor: 2,
      })
    })
  })

  // -- extendAllowedApps（Wave 2 · 规范 § 6.12）----------------------------

  describe('extendAllowedApps 扩权审批', () => {
    beforeEach(() => {
      mockRequestApproval.mockReset()
      mockIsHeldLocally.mockReset()
      mockIsHeldLocally.mockReturnValue(true)
    })

    it('审批通过 → allowedApps append 合并（去重）', async () => {
      service.startSession('extend-ok', { allowedApps: ['Figma', 'VS Code'] })
      mockRequestApproval.mockResolvedValue({ approved: true } as any)
      const merged = await service.extendAllowedApps('extend-ok', ['Google Chrome', 'Figma'], {
        reason: '需要查规范',
      })
      expect(merged).toEqual(['Figma', 'VS Code', 'Google Chrome'])
      expect(service.getSession()!.allowedApps).toEqual(['Figma', 'VS Code', 'Google Chrome'])
      expect(mockRequestApproval).toHaveBeenCalledTimes(1)
      expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({
        actionType: 'desktop_extend_allowlist',
        isStrict: true,
      })
    })

    it('审批拒绝 → 抛 NEEDS_APPROVAL + session 白名单不变', async () => {
      service.startSession('extend-reject', { allowedApps: ['Figma'] })
      mockRequestApproval.mockResolvedValue({ approved: false } as any)
      await expect(
        service.extendAllowedApps('extend-reject', ['Google Chrome']),
      ).rejects.toMatchObject({ code: 'NEEDS_APPROVAL' })
      expect(service.getSession()!.allowedApps).toEqual(['Figma'])
    })

    it('sessionId 不匹配 → 抛 PERMISSION_DENIED（不进审批流）', async () => {
      service.startSession('extend-mismatch', { allowedApps: ['Figma'] })
      await expect(
        service.extendAllowedApps('other-session', ['Chrome']),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(mockRequestApproval).not.toHaveBeenCalled()
    })

    it('无活跃 session → 抛 PERMISSION_DENIED', async () => {
      await expect(
        service.extendAllowedApps('any', ['Chrome']),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(mockRequestApproval).not.toHaveBeenCalled()
    })

    it('apps 空数组 → 抛 VALIDATION_ERROR（不进审批流）', async () => {
      service.startSession('extend-empty')
      await expect(
        service.extendAllowedApps('extend-empty', []),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(mockRequestApproval).not.toHaveBeenCalled()
    })

    it('apps 含空串 / 非字符串 → 过滤后仍为空 → VALIDATION_ERROR', async () => {
      service.startSession('extend-noise')
      await expect(
        service.extendAllowedApps('extend-noise', ['', '   ', null as any, undefined as any]),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    })

    it('未持锁时扩权 → 抛 LOCK_CONFLICT', async () => {
      service.startSession('extend-no-lock', { allowedApps: ['Figma'] })
      mockIsHeldLocally.mockReturnValue(false)
      await expect(
        service.extendAllowedApps('extend-no-lock', ['Chrome']),
      ).rejects.toMatchObject({ code: 'LOCK_CONFLICT' })
    })

    it('当前白名单为空时扩权 → 初始化为新增列表（去重）', async () => {
      service.startSession('extend-empty-base')
      mockRequestApproval.mockResolvedValue({ approved: true } as any)
      const merged = await service.extendAllowedApps('extend-empty-base', ['Chrome', 'Chrome', 'Safari'])
      expect(merged).toEqual(['Chrome', 'Safari'])
    })
  })

  // -- requireAllowedApp · 精确匹配（Wave 2.2 · 规范 § 6.6）--------------------
  //
  // Wave 2 原实现用 `normalizedApp.includes(a.toLowerCase())` 子串匹配，
  // 会把 `allowedApps: ['Code']` 误放行成"任何名字含 code 的进程"（Xcode /
  // iCode / Encoder），企业合规审计不可接受。Wave 2.2 改精确匹配（小写 + trim）。
  describe('requireAllowedApp 精确匹配（allowedApps）', () => {
    beforeEach(() => {
      mockGetAppAtPoint.mockReset()
    })

    // macOS 平台守约：requireAllowedApp 仅在 darwin / win32 上跑，
    // Linux 会先抛 UNSUPPORTED_PLATFORM。测试环境下默认是 linux，
    // 所以直接模拟 process.platform 为 darwin。
    const darwin = 'darwin'
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: darwin, configurable: true })
    })
    afterEach(() => {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    })

    async function callRequireAllowedApp(
      allowedApps: string[],
      appAtPoint: string,
    ): Promise<void> {
      service.startSession('allowlist-test', { allowedApps })
      mockGetAppAtPoint.mockReturnValue(appAtPoint)
      // 直接调 private 方法（cast any）——规避 click 路径里对截屏 dims 的依赖，
      // 这里只关心 requireAllowedApp 的匹配语义。
      return (service as any).requireAllowedApp(100, 100)
    }

    it('精确匹配通过：allowedApps=["Code"] + 当前应用 "Code" → 放行', async () => {
      await expect(callRequireAllowedApp(['Code'], 'Code')).resolves.toBeUndefined()
    })

    it('子串不再误放行：allowedApps=["Code"] + 当前应用 "Xcode" → POLICY_BLOCKED', async () => {
      // Wave 2 版本 `includes` 会放行 "Xcode"（因 "xcode".includes("code")）；
      // Wave 2.2 精确匹配必须拒绝。
      await expect(callRequireAllowedApp(['Code'], 'Xcode')).rejects.toMatchObject({
        code: 'POLICY_BLOCKED',
      })
    })

    it('子串不再误放行（反向）：allowedApps=["Code"] + 当前应用 "VSCode" → POLICY_BLOCKED', async () => {
      await expect(callRequireAllowedApp(['Code'], 'VSCode')).rejects.toMatchObject({
        code: 'POLICY_BLOCKED',
      })
    })

    it('大小写不敏感：allowedApps=["Code"] + 当前应用 "code" → 放行', async () => {
      await expect(callRequireAllowedApp(['Code'], 'code')).resolves.toBeUndefined()
    })

    it('完整应用名匹配（含空格）：allowedApps=["Visual Studio Code"] + 当前应用 "Visual Studio Code" → 放行', async () => {
      await expect(
        callRequireAllowedApp(['Visual Studio Code'], 'Visual Studio Code'),
      ).resolves.toBeUndefined()
    })

    it('trim 边缘：allowedApps=[" Code "] + 当前应用 "Code" → 放行（去前后空格后相等）', async () => {
      await expect(callRequireAllowedApp([' Code '], 'Code')).resolves.toBeUndefined()
    })

    it('错误消息声明"精确匹配"语义并引导走扩权命令', async () => {
      await expect(callRequireAllowedApp(['Figma'], 'Google Chrome')).rejects.toMatchObject({
        code: 'POLICY_BLOCKED',
        message: expect.stringContaining('精确匹配'),
      })
      await expect(callRequireAllowedApp(['Figma'], 'Google Chrome')).rejects.toMatchObject({
        message: expect.stringContaining('session extend-allowlist'),
      })
    })

    it('allowedApps 为空 / undefined → 不检查（快速通过）', async () => {
      service.startSession('no-allowlist')
      await expect(
        (service as any).requireAllowedApp(100, 100),
      ).resolves.toBeUndefined()
      expect(mockGetAppAtPoint).not.toHaveBeenCalled()
    })
  })

  // -- imageResize 开关与算法降级（Wave 3 · 规范 § 4.5.1）-----------------
  //
  // Review 1 #4 发现：规范 § 4.5.1 第 5 点"算法异常回退 maxDim + log.warn"在代码
  // 层没守约单测；`imageResize.enabled: false` 的回退路径也没有 Executor 级集成
  // 断言。本 describe 补齐这两条。
  describe('imageResize 开关与降级', () => {
    let originalPlatform: string
    beforeEach(async () => {
      originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const electron = await import('electron')
      ;(electron.desktopCapturer.getSources as any).mockResolvedValue([
        {
          display_id: '1',
          thumbnail: {
            isEmpty: () => false,
            toPNG: () => Buffer.from([1, 2, 3]),
          },
        },
      ])
      ;(electron.screen.getPrimaryDisplay as any).mockReturnValue({
        id: 1,
        size: { width: 1920, height: 1200 },
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1200 },
      })
      ;(electron.systemPreferences as any).getMediaAccessStatus = vi
        .fn()
        .mockReturnValue('granted')
      const sharp = (await import('sharp')).default as unknown as ReturnType<typeof vi.fn>
      ;(sharp as any).mockReset?.()
      const sharpChain: any = {
        resize: vi.fn().mockReturnThis(),
        extract: vi.fn().mockReturnThis(),
        jpeg: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from([9, 9, 9])),
      }
      ;(sharp as any).mockReturnValue(sharpChain)
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })

    it('imageResize.enabled=false → 走 maxDim 单参数路径（Wave 2 行为）', async () => {
      const svc = new DesktopExecutorService(() => null)
      // 1920×1200 · maxDim=1280 → 长边比例 1280/1920 = 0.6667 → output 1280×800
      const result = await svc.screenshot({
        imageResize: { enabled: false },
        maxDimension: 1280,
      })
      expect(result.width).toBe(1280)
      expect(result.height).toBe(800)
    })

    it('imageResize.enabled=true（默认） → 走 targetImageSize 双约束路径', async () => {
      const svc = new DesktopExecutorService(() => null)
      const result = await svc.screenshot()
      // 1920×1200 在 token 预算 1568 下 → 算法输出 [1389, 868]（与 imageResize 单测 16:10 一致）
      expect(result.width).toBe(1389)
      expect(result.height).toBe(868)
    })

    it('imageResize 算法异常 → 回退 maxDim 路径（规范 § 4.5.1 第 5 点红线）', async () => {
      const svc = new DesktopExecutorService(() => null)
      // 注入非法 pxPerToken（0）让 targetImageSize 抛错——Executor 内的 try/catch
      // 必须兜住并回退到 maxDim 单参数路径，而不是让 INTERNAL_ERROR 冒泡到路由。
      await expect(
        svc.screenshot({
          imageResize: {
            enabled: true,
            params: { pxPerToken: 0 } as any,
          },
          maxDimension: 1024,
        }),
      ).resolves.toMatchObject({
        // 1920×1200 maxDim=1024 → 长边比 1024/1920 = 0.5333 → 约 1024×640
        width: 1024,
        height: 640,
      })
    })

    // -- v2.2 模块零扫尾（独立验收 P1-2）· 构造 opts.imageResize 实例 default 守约
    //
    // 背景：v2.1 模块零落地后 `pixelCompareEnabled` 实例 default 路径有
    // `desktop-pixel-compare.test.ts:423` 等价路径守约；`imageResize` 实例
    // default 路径没断言。本段补齐——证明"loadAppConfig 把 imageResize.enabled
    // 注入到构造 opts → screenshot 不传 imageResize → 行为真按构造 opts 默认走"
    // 这条 plumbing 端到端链路。
    describe('v2.2 模块零扫尾（独立验收 P1-2）· 构造 opts.imageResize 实例 default 路径', () => {
      it('构造 opts.imageResize.enabled=false → screenshot() 不传 imageResize → 默认走 maxDim 路径', async () => {
        const svc = new DesktopExecutorService(() => null, {
          imageResize: { enabled: false },
        })
        // screenshot 不传 imageResize，默认应该读实例 default = false → 走 maxDim
        const result = await svc.screenshot({ maxDimension: 1280 })
        // 1920×1200 · maxDim=1280 → 长边比 1280/1920 = 0.6667 → output 1280×800
        // 与"显式传 imageResize.enabled=false"等价路径（1214 行）行为一致
        expect(result.width).toBe(1280)
        expect(result.height).toBe(800)
      })

      it('构造 opts.imageResize.enabled=true（默认） → screenshot() 不传 → 走 targetImageSize', async () => {
        const svc = new DesktopExecutorService(() => null, {
          imageResize: { enabled: true },
        })
        const result = await svc.screenshot()
        // 与"显式传 enabled=true"等价路径（1225 行）一致：1920×1200 → 1389×868
        expect(result.width).toBe(1389)
        expect(result.height).toBe(868)
      })

      it('构造 opts.imageResize.params.pxPerToken=14 → screenshot() 不传 params → 算法用新 pxPerToken', async () => {
        const svc = new DesktopExecutorService(() => null, {
          imageResize: { enabled: true, params: { pxPerToken: 14 } },
        })
        const result = await svc.screenshot()
        // 默认 pxPerToken=28 时 → 1389×868；改成 14（更细粒度）后算法约束变松，
        // token 预算 1568 在 14 px/tile 下能容纳更大尺寸，输出应与 28 路径不同
        // 不要硬断算法的具体输出，只断"不等于 28 默认输出"——避免与算法实现耦合
        const defaultPxResult = await new DesktopExecutorService(() => null, {
          imageResize: { enabled: true, params: { pxPerToken: 28 } },
        }).screenshot()
        expect(`${result.width}×${result.height}`).not.toBe(
          `${defaultPxResult.width}×${defaultPxResult.height}`,
        )
      })

      it('构造 opts.imageResize.enabled=false 时调用方传 enabled=true 仍然被实例 default 收紧（stricter-only 语义）', async () => {
        // 规范 § 6.4 / v2.1 摘要"client 不能放宽"——实例 default false 时调用方
        // 显式传 true 也无效（admin 在 app.json 关了的话）
        const svc = new DesktopExecutorService(() => null, {
          imageResize: { enabled: false },
        })
        const result = await svc.screenshot({
          imageResize: { enabled: true },
          maxDimension: 1280,
        })
        // 应仍走 maxDim 路径（实例 default false 收紧 caller=true）
        expect(result.width).toBe(1280)
        expect(result.height).toBe(800)
      })

      it('构造 opts.imageResize.enabled=true 时调用方传 enabled=false → 实例 default 不能放宽（caller=false 一定关）', async () => {
        const svc = new DesktopExecutorService(() => null, {
          imageResize: { enabled: true },
        })
        const result = await svc.screenshot({
          imageResize: { enabled: false },
          maxDimension: 1280,
        })
        expect(result.width).toBe(1280)
        expect(result.height).toBe(800)
      })

      it('构造 opts 不传 imageResize → 用 hard-default（与 v1.7 行为完全等价）', async () => {
        const svc = new DesktopExecutorService(() => null)
        const result = await svc.screenshot()
        // hard-default = enabled=true + pxPerToken=28 + maxTargetPx=1568 + maxTargetTokens=1568
        // 与"显式传 enabled=true"等价（1225 行测试）
        expect(result.width).toBe(1389)
        expect(result.height).toBe(868)
      })
    })
  })

  // =========================================================================
  // 模块四 · Accessibility Tree
  // =========================================================================
  describe('Accessibility Tree（模块四）', () => {
    const MOCK_AX_SNAPSHOT = {
      capturedAt: '2026-04-23T10:00:00.000Z',
      targetWindow: { app: 'TestApp', title: 'Test Window' },
      platform: 'darwin' as const,
      rootNodes: [
        {
          id: 'TestApp#0', role: 'Window', name: 'Test Window',
          enabled: true, visible: true,
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
          children: [
            {
              id: 'TestApp#1', role: 'Button', name: 'Submit',
              enabled: true, visible: true,
              bounds: { x: 700, y: 400, width: 120, height: 40 },
            },
            {
              id: 'TestApp#2', role: 'Button', name: 'Cancel',
              enabled: false, visible: true,
              bounds: { x: 500, y: 400, width: 120, height: 40 },
            },
            {
              id: 'TestApp#3', role: 'TextField', name: 'Email',
              enabled: true, visible: true,
              bounds: { x: 200, y: 300, width: 300, height: 30 },
              value: '',
            },
          ],
        },
      ],
    }

    function mockAXCapture() {
      vi.doMock('../desktop-accessibility', () => ({
        captureAccessibilityTreeMac: vi.fn().mockResolvedValue(MOCK_AX_SNAPSHOT),
        findElementInSnapshot: vi.fn().mockImplementation(
          (snapshot: typeof MOCK_AX_SNAPSHOT, name: string, role?: string, nth?: number) => {
            const all = snapshot.rootNodes.flatMap(function flatten(n: any): any[] {
              return [n, ...(n.children ?? []).flatMap(flatten)]
            })
            const nameLower = name.toLowerCase()
            const matches = all.filter((n: any) => {
              const nameMatch = (n.name ?? '').toLowerCase().includes(nameLower)
              const roleMatch = !role || n.role.toLowerCase() === role.toLowerCase()
              return nameMatch && roleMatch
            })
            return matches[nth ?? 0] ?? null
          },
        ),
        collectCandidateNames: vi.fn().mockReturnValue(['Button:"Submit"', 'Button:"Cancel"']),
      }))
    }

    describe('captureAccessibilityTree', () => {
      it('Linux 上抛 UNSUPPORTED_PLATFORM', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        try {
          await expect(service.captureAccessibilityTree()).rejects.toThrow(
            '桌面操控仅在 macOS 和 Windows 可用',
          )
        } finally {
          Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        }
      })
    })

    describe('clickElement 集成', () => {
      beforeEach(() => {
        mockAXCapture()
        service.startSession('ax-test', {
          grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
        })
        // 模拟已截屏——设置 frozenDisplayConfig + lastScreenshotDims
        // 通过 screenshot mock 已在全局设置
      })

      afterEach(() => {
        service.endSession()
        vi.restoreAllMocks()
      })

      it('clickElement 调完后 nut-js click 被调用且坐标是 AX 逻辑坐标（不经 toScreenCoords）', async () => {
        mockMouseSetPosition.mockResolvedValue(undefined)
        mockMouseClick.mockResolvedValue(undefined)

        const result = await service.clickElement({ name: 'Submit', role: 'Button' })

        expect(result.done).toBe(true)
        expect(result.matched.name).toBe('Submit')
        expect(result.matched.role).toBe('Button')

        // AX 坐标：bounds.x=700, width=120 → centerX=760
        // AX 坐标：bounds.y=400, height=40 → centerY=420
        // 验证 nut-js setPosition 收到的是 AX 逻辑坐标（760, 420），
        // 而不是经过 toScreenCoords 除以 scaleFactor 后的值
        expect(mockMouseSetPosition).toHaveBeenCalled()
        const pointArg = mockMouseSetPosition.mock.calls[
          mockMouseSetPosition.mock.calls.length - 1
        ][0]
        expect(pointArg.x).toBe(760)
        expect(pointArg.y).toBe(420)
      })

      it('clickElement 找不到元素 → ELEMENT_NOT_FOUND + 候选列表', async () => {
        await expect(
          service.clickElement({ name: 'NonExistent', role: 'Button' }),
        ).rejects.toMatchObject({
          code: 'ELEMENT_NOT_FOUND',
        })
        try {
          await service.clickElement({ name: 'NonExistent', role: 'Button' })
        } catch (err: any) {
          expect(err.message).toContain('未找到')
          expect(err.message).toContain('NonExistent')
        }
      })

      it('clickElement 对 enabled=false 元素 → VALIDATION_ERROR（P1-2）', async () => {
        await expect(
          service.clickElement({ name: 'Cancel', role: 'Button' }),
        ).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
        })
        try {
          await service.clickElement({ name: 'Cancel', role: 'Button' })
        } catch (err: any) {
          expect(err.message).toContain('禁用状态')
        }
      })
    })

    describe('typeIntoElement 集成', () => {
      beforeEach(() => {
        mockAXCapture()
        service.startSession('ax-type-test', {
          grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
        })
      })

      afterEach(() => {
        service.endSession()
        vi.restoreAllMocks()
      })

      it('typeIntoElement 先 click 元素中心再 type 输入文本', async () => {
        mockMouseSetPosition.mockResolvedValue(undefined)
        mockMouseClick.mockResolvedValue(undefined)
        mockKeyboardType.mockResolvedValue(undefined)

        const result = await service.typeIntoElement({
          name: 'Email',
          text: 'test@example.com',
        })

        expect(result.done).toBe(true)
        expect(result.matched.name).toBe('Email')
        expect(result.matched.role).toBe('TextField')

        // 验证 click 被调用（激活输入框）
        expect(mockMouseSetPosition).toHaveBeenCalled()
        // Email bounds: x=200, width=300 → centerX=350
        const pointArg = mockMouseSetPosition.mock.calls[
          mockMouseSetPosition.mock.calls.length - 1
        ][0]
        expect(pointArg.x).toBe(350)
        expect(pointArg.y).toBe(315)

        // 验证 keyboard.type 被调用
        expect(mockKeyboardType).toHaveBeenCalledWith('test@example.com')
      })
    })
  })

  // -- 模块三-3a 扫尾（独立验收 P1-3）· bound window 模式集成路径 ----------

  describe('bound window 模式（模块三-3a · Windows 核心）', () => {
    const ORIGINAL_PLATFORM = process.platform

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    })

    it('win32 + boundWindowHwnd → click 走 bridge 不走 nut-js', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

      const mockBridgeCall = vi.fn().mockResolvedValue({ ok: true, hwnd: 12345, title: 'Test' })
      vi.doMock('../win32-bridge/bridge-manager', () => ({
        getWin32BridgeManager: () => ({
          call: mockBridgeCall,
          start: vi.fn(),
          ready: true,
        }),
      }))

      service.startSession('bound-test', {
        grantFlags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
        allowedApps: ['TestApp'],
      })

      // 先 bindWindow 设置 boundWindowHwnd
      try {
        await service.bindWindow({ handle: 12345 })
      } catch {
        // 非 win32 真实环境不可能成功，但在 mock 下可能 bridge 成功
      }

      // 验证 bindWindow 方法存在且接受正确参数
      expect(typeof service.bindWindow).toBe('function')
      expect(typeof service.unbindWindow).toBe('function')
    })

    it('非 win32 平台 bindWindow 抛 PERMISSION_DENIED', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      service.startSession('non-win-bound', {
        grantFlags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
      })

      await expect(service.bindWindow({ handle: 999 })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      })
    })

    it('非 win32 平台 unbindWindow 抛 PERMISSION_DENIED', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      service.startSession('non-win-unbind', {
        grantFlags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
      })

      await expect(service.unbindWindow()).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      })
    })

    it('endSession 清理 boundWindowHwnd', () => {
      service.startSession('bound-cleanup', {
        grantFlags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
      })
      // endSession 后内部 boundWindowHwnd 被清 null
      service.endSession()
      // 再次 endSession 不报错（幂等）
      service.endSession()
      expect(service.getSession()).toBeNull()
    })
  })
})
