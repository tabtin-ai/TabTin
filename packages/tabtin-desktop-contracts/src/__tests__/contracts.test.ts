/**
 * `@tabtin/desktop-contracts` —— 接口契约 + 命名空间常量的"包能 import"
 * 级别守约。规范 § 9.1 完成标准 1 + 4 的支撑：
 *
 * - 类型契约存在（编译期）→ 通过 import 触发
 * - MCP 命名空间常量集合完整（运行期）→ 显式断言每条工具名以 `tabtin:desktop:` 开头
 * - 默认对象与现有 `DesktopExecutorService` 的等价行为对齐
 */

import { describe, it, expect } from 'vitest'
import {
  TABTIN_DESKTOP_TOOL_NAMES,
  TABTIN_DESKTOP_TOOL_NAMESPACE_PREFIX,
  TABTIN_DESKTOP_RESOURCE_URI_PREFIX,
  DEFAULT_DESKTOP_AUTHORIZATION_PROFILE,
  DEFAULT_DESKTOP_SUB_GATES,
  DEFAULT_DESKTOP_COORDINATE_MODE,
  type DesktopAuthorizationProfile,
  type DesktopSubGates,
  type DesktopCoordinateMode,
  type DesktopExecutor,
  type DesktopSessionContext,
} from '../index.js'

describe('@tabtin/desktop-contracts · MCP 命名空间常量', () => {
  it('TABTIN_DESKTOP_TOOL_NAMESPACE_PREFIX 必须是 tabtin:desktop:', () => {
    expect(TABTIN_DESKTOP_TOOL_NAMESPACE_PREFIX).toBe('tabtin:desktop:')
  })

  it('每条工具名都必须以 tabtin:desktop: 开头（grep 验收锚点）', () => {
    const names = Object.values(TABTIN_DESKTOP_TOOL_NAMES)
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) {
      expect(n.startsWith(TABTIN_DESKTOP_TOOL_NAMESPACE_PREFIX)).toBe(true)
    }
  })

  it('工具名常量集合至少覆盖 v1 已落地的 17 条 CLI/HTTP 路由', () => {
    // 与 cli/routes/desktop.ts KNOWN_ROUTES 一致：screenshot/click/scroll/drag/move/
    // type/key/hotkey/windows/activate/open/batch/session/start/session/end/
    // session/extend-allowlist/accessibility/revoke-approval = 17 条
    const names = Object.values(TABTIN_DESKTOP_TOOL_NAMES)
    expect(names.length).toBeGreaterThanOrEqual(17)
  })

  it('TABTIN_DESKTOP_RESOURCE_URI_PREFIX 必须是 tabtin-desktop:// 形态', () => {
    expect(TABTIN_DESKTOP_RESOURCE_URI_PREFIX).toBe('tabtin-desktop://')
  })

  it('工具名互不重复', () => {
    const names = Object.values(TABTIN_DESKTOP_TOOL_NAMES)
    const set = new Set(names)
    expect(set.size).toBe(names.length)
  })
})

describe('@tabtin/desktop-contracts · 默认对象（v1 等价行为）', () => {
  it('DEFAULT_DESKTOP_AUTHORIZATION_PROFILE 默认 tier=full（与 v1.8 之前的"无 tier"等价）', () => {
    expect(DEFAULT_DESKTOP_AUTHORIZATION_PROFILE.tier).toBe('full')
    // 模块零阶段：deniedApps / sentinelApps / clipboardGuard 都是 undefined
    expect(DEFAULT_DESKTOP_AUTHORIZATION_PROFILE.deniedApps).toBeUndefined()
    expect(DEFAULT_DESKTOP_AUTHORIZATION_PROFILE.sentinelApps).toBeUndefined()
    expect(DEFAULT_DESKTOP_AUTHORIZATION_PROFILE.clipboardGuard).toBeUndefined()
  })

  it('DEFAULT_DESKTOP_SUB_GATES 6 个子开关全部 enabled=true', () => {
    const gates: Array<keyof DesktopSubGates> = [
      'screenshot',
      'click',
      'type',
      'clipboard',
      'activate',
      'windowMgmt',
    ]
    for (const k of gates) {
      expect(DEFAULT_DESKTOP_SUB_GATES[k].enabled).toBe(true)
    }
  })

  it('DEFAULT_DESKTOP_COORDINATE_MODE 默认 absolute_pixel（v1）', () => {
    expect(DEFAULT_DESKTOP_COORDINATE_MODE).toBe('absolute_pixel')
  })
})

describe('@tabtin/desktop-contracts · 类型契约可用性（编译期）', () => {
  it('DesktopAuthorizationProfile 字段集合完整', () => {
    const profile: DesktopAuthorizationProfile = {
      tier: 'full',
      allowedApps: ['Code'],
      deniedApps: ['1Password'],
      sentinelApps: ['Terminal'],
      clipboardGuard: { active: true, scope: 'com.apple.Terminal' },
    }
    expect(profile.tier).toBe('full')
  })

  it('DesktopCoordinateMode 仅接受两个枚举值', () => {
    const modes: DesktopCoordinateMode[] = ['absolute_pixel', 'normalized_0_100']
    expect(modes.length).toBe(2)
  })

  it('DesktopSessionContext 必填字段 sessionId / grantFlags / startedAt', () => {
    const ctx: DesktopSessionContext = {
      sessionId: 's-1',
      grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
      startedAt: Date.now(),
    }
    expect(ctx.sessionId).toBe('s-1')
    expect(ctx.grantFlags.clipboardWrite).toBe(true)
  })

  it('DesktopExecutor 接口形状可被 structural typing 实现', () => {
    // 不真实例化——纯 type-level 校验。如果 DesktopExecutor 接口签名变了，
    // 这段 mock 实现就编译不过；这是接口"加方法不破坏"承诺的守约。
    const mock: DesktopExecutor = {
      startSession: () => {},
      endSession: () => {},
      getSession: () => null,
      setAbortSignal: () => {},
      getIdleMs: () => 0,
      checkAccessibility: () => true,
      checkScreenRecording: () => ({ granted: true, status: 'granted' }),
      screenshot: async () => ({
        path: '/tmp/x.jpg',
        width: 100,
        height: 100,
        displayWidth: 100,
        displayHeight: 100,
        scaleFactor: 1,
      }),
      click: async () => {},
      scroll: async () => {},
      drag: async () => {},
      move: async () => {},
      type: async () => {},
      keyPress: async () => {},
      hotkey: async () => {},
      listWindows: async () => [],
      activateWindow: async () => {},
      openApp: async () => {},
      batch: async () => ({ stepsCompleted: 0, stepFailed: null }),
      extendAllowedApps: async () => [],
      setPixelCompareEnabled: () => {},
      // bindWindow / unbindWindow 是 optional method（v2.2 模块零扫尾占位）——
      // v1 实现可不写，M3a 落地时填实现。下面任一形态都合法：
      // 1. 完全省略：不写 bindWindow / unbindWindow（structural typing 仍满足）
      // 2. 显式占位：throw 'not implemented'（与 v1 wrapper stub 风格一致）
    }
    expect(typeof mock.startSession).toBe('function')
    // optional method 在 v1 mock 中是 undefined
    expect(mock.bindWindow).toBeUndefined()
    expect(mock.unbindWindow).toBeUndefined()
  })

  describe('v2.2 模块零扫尾（独立验收 P0-2）· accessibilityText 字段占位', () => {
    it('DesktopExecutorScreenshotResult 类型层接受 accessibilityText 字段（v1 默认 undefined）', async () => {
      // 模块三-3a 落地前所有平台都为 undefined，类型层占位让 M3a / M4 加实现
      // 时不需要扩 contracts 包
      const v1Result = {
        path: '/tmp/x.jpg',
        width: 100,
        height: 100,
        displayWidth: 100,
        displayHeight: 100,
        scaleFactor: 1,
      }
      // 不传 accessibilityText 仍合法
      expect(v1Result).toBeDefined()

      // M3a 落 UIA 后填入字段示意
      const m3aResult = {
        ...v1Result,
        accessibilityText: '<window name="Notepad"><edit name="text" /></window>',
      }
      expect(m3aResult.accessibilityText).toContain('Notepad')

      // 类型层 mock 实现 screenshot 返回带 accessibilityText 的结果
      const mock: Pick<DesktopExecutor, 'screenshot'> = {
        screenshot: async () => m3aResult,
      }
      const out = await mock.screenshot({})
      expect(out.accessibilityText).toBe(m3aResult.accessibilityText)
    })
  })

  describe('v2.2 模块零扫尾（独立验收 P0-3）· boundWindow / bindWindow / unbindWindow 占位', () => {
    it('DesktopSessionContext.boundWindow 字段位存在（v1 默认 undefined）', () => {
      const ctx: DesktopSessionContext = {
        sessionId: 's-1',
        grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
        startedAt: Date.now(),
      }
      // v1 / v2.1 阶段：boundWindow 默认 undefined
      expect(ctx.boundWindow).toBeUndefined()

      // M3a 落地后填入字段示意
      const m3aCtx: DesktopSessionContext = {
        ...ctx,
        boundWindow: {
          handle: 0x12345678,
          processId: 1234,
          bundleId: 'notepad.exe',
          mode: 'bound',
        },
      }
      expect(m3aCtx.boundWindow?.mode).toBe('bound')
      expect(m3aCtx.boundWindow?.handle).toBe(0x12345678)
    })

    it('handle 字段接受 number | string（兼容 Win32 HWND / 未来 Wayland surface id）', () => {
      const winCtx: DesktopSessionContext = {
        sessionId: 's-win',
        grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
        startedAt: 0,
        boundWindow: { handle: 12345, mode: 'bound' },
      }
      const linuxCtx: DesktopSessionContext = {
        sessionId: 's-linux',
        grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
        startedAt: 0,
        boundWindow: { handle: 'wayland-surface-abc-123', mode: 'bound' },
      }
      expect(typeof winCtx.boundWindow?.handle).toBe('number')
      expect(typeof linuxCtx.boundWindow?.handle).toBe('string')
    })

    it('DesktopExecutor.bindWindow / unbindWindow 是 optional method（v1 实现可不写）', () => {
      // v1 / v2.1 的 DesktopExecutorService 不实现 → mock 也可不实现 → 仍满足契约
      const mockV1: DesktopExecutor = {
        startSession: () => {},
        endSession: () => {},
        getSession: () => null,
        setAbortSignal: () => {},
        getIdleMs: () => 0,
        checkAccessibility: () => true,
        checkScreenRecording: () => ({ granted: true, status: 'granted' }),
        screenshot: async () => ({
          path: '/tmp/x.jpg', width: 100, height: 100, displayWidth: 100, displayHeight: 100, scaleFactor: 1,
        }),
        click: async () => {},
        scroll: async () => {},
        drag: async () => {},
        move: async () => {},
        type: async () => {},
        keyPress: async () => {},
        hotkey: async () => {},
        listWindows: async () => [],
        activateWindow: async () => {},
        openApp: async () => {},
        batch: async () => ({ stepsCompleted: 0, stepFailed: null }),
        extendAllowedApps: async () => [],
        setPixelCompareEnabled: () => {},
      }
      // optional method 在 mock 上为 undefined
      expect(mockV1.bindWindow).toBeUndefined()
      expect(mockV1.unbindWindow).toBeUndefined()
    })

    it('M3a 落实现时 bindWindow / unbindWindow 形态可被结构化校验', async () => {
      const m3aMock: Pick<DesktopExecutor, 'bindWindow' | 'unbindWindow'> = {
        bindWindow: async (target) => {
          // 模拟 M3a Win32 实现：拿到 HWND 后返回 ok
          if (typeof target.handle !== 'number') {
            throw new Error('non-numeric handle on Windows')
          }
          return { ok: true }
        },
        unbindWindow: async () => ({ ok: true }),
      }
      const r1 = await m3aMock.bindWindow!({ handle: 0x12345678 })
      expect(r1).toEqual({ ok: true })
      const r2 = await m3aMock.unbindWindow!()
      expect(r2).toEqual({ ok: true })
    })
  })
})
