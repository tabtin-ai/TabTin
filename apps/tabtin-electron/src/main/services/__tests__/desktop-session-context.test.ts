/**
 * `bindSessionContext` + `deriveSessionContextFromExecutor` —— v2.1 模块零
 * 路由层与 Executor 解耦初步骨架的单测。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.2 + § 9.1。
 *
 * 测试维度：
 * 1. wrapper 形状 = DesktopExecutor 接口（structural typing）
 * 2. 一致性校验：ctx.sessionId 与 executor.getSession().sessionId 不一致 →
 *    动作类方法抛 PERMISSION_DENIED + 中文三段式
 * 3. 一致性校验：executor 当前无 session → 动作类方法抛 PERMISSION_DENIED
 * 4. 会话管理类方法（startSession / endSession / getSession / setAbortSignal /
 *    getIdleMs / extendAllowedApps）+ 权限类方法（checkAccessibility /
 *    checkScreenRecording / setPixelCompareEnabled）**不**做一致性校验
 * 5. 一致性通过时所有动作方法 100% 透传给 executor
 * 6. deriveSessionContextFromExecutor 字段映射完整 + 无 session 时返回 null
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DesktopError, DesktopErrorCode } from '../desktop-error-codes'
import {
  bindSessionContext,
  deriveSessionContextFromExecutor,
} from '../desktop-session-context'
import type {
  DesktopExecutor,
  DesktopSessionContext,
} from '@tabtin/desktop-contracts'

// ---------------------------------------------------------------------------
// Mock executor —— 不依赖 nut-js / electron / sharp 的极简实现
// ---------------------------------------------------------------------------

function createMockExecutor(initialSession: { sessionId: string; [k: string]: unknown } | null = null): {
  executor: DesktopExecutor
  spies: Record<string, ReturnType<typeof vi.fn>>
  setSession: (s: { sessionId: string; [k: string]: unknown } | null) => void
} {
  let session = initialSession
  const spies = {
    startSession: vi.fn(),
    endSession: vi.fn(),
    getSession: vi.fn(() => session),
    setAbortSignal: vi.fn(),
    getIdleMs: vi.fn(() => 0),
    checkAccessibility: vi.fn(() => true),
    checkScreenRecording: vi.fn(() => ({ granted: true, status: 'granted' })),
    setPixelCompareEnabled: vi.fn(),
    screenshot: vi.fn(async () => ({
      path: '/mock.jpg',
      width: 100, height: 100, displayWidth: 100, displayHeight: 100, scaleFactor: 1,
    })),
    click: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    drag: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    hotkey: vi.fn(async () => {}),
    listWindows: vi.fn(async () => []),
    activateWindow: vi.fn(async () => {}),
    openApp: vi.fn(async () => {}),
    batch: vi.fn(async () => ({ stepsCompleted: 0, stepFailed: null })),
    extendAllowedApps: vi.fn(async () => []),
  }
  const executor: DesktopExecutor = {
    startSession: spies.startSession,
    endSession: spies.endSession,
    getSession: () => spies.getSession() as ReturnType<DesktopExecutor['getSession']>,
    setAbortSignal: spies.setAbortSignal,
    getIdleMs: spies.getIdleMs,
    checkAccessibility: spies.checkAccessibility,
    checkScreenRecording: spies.checkScreenRecording,
    setPixelCompareEnabled: spies.setPixelCompareEnabled,
    screenshot: spies.screenshot as DesktopExecutor['screenshot'],
    click: spies.click,
    scroll: spies.scroll,
    drag: spies.drag,
    move: spies.move,
    type: spies.type,
    keyPress: spies.keyPress,
    hotkey: spies.hotkey,
    listWindows: spies.listWindows as DesktopExecutor['listWindows'],
    activateWindow: spies.activateWindow,
    openApp: spies.openApp,
    batch: spies.batch as DesktopExecutor['batch'],
    extendAllowedApps: spies.extendAllowedApps as DesktopExecutor['extendAllowedApps'],
  }
  return { executor, spies, setSession: (s) => { session = s } }
}

function makeCtx(sessionId: string): DesktopSessionContext {
  return {
    sessionId,
    grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
    startedAt: 1700000000000,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bindSessionContext (v2.1 模块零 · 规范 § 3.5.2 + § 9.1)', () => {
  let mock: ReturnType<typeof createMockExecutor>

  beforeEach(() => {
    mock = createMockExecutor({
      sessionId: 's-1',
      grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
      startedAt: Date.now(),
    })
  })

  describe('wrapper 形状 = DesktopExecutor 接口', () => {
    it('返回的对象包含所有 DesktopExecutor 方法', () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('s-1'))
      const expected: Array<keyof DesktopExecutor> = [
        'startSession', 'endSession', 'getSession', 'setAbortSignal', 'getIdleMs',
        'checkAccessibility', 'checkScreenRecording', 'setPixelCompareEnabled',
        'screenshot', 'click', 'scroll', 'drag', 'move', 'type', 'keyPress',
        'hotkey', 'listWindows', 'activateWindow', 'openApp', 'batch',
        'extendAllowedApps',
      ]
      for (const method of expected) {
        expect(typeof wrapper[method]).toBe('function')
      }
    })
  })

  describe('一致性校验：动作类方法在 ctx 不匹配时抛 PERMISSION_DENIED', () => {
    it('executor 无 session → click 抛 PERMISSION_DENIED + 中文三段式', async () => {
      mock.setSession(null)
      const wrapper = bindSessionContext(mock.executor, makeCtx('s-1'))
      await expect(wrapper.click(10, 20)).rejects.toMatchObject({
        code: DesktopErrorCode.PERMISSION_DENIED,
      })
      try {
        await wrapper.click(10, 20)
      } catch (err) {
        expect(err).toBeInstanceOf(DesktopError)
        const msg = (err as DesktopError).message
        expect(msg).toContain('桌面操控 session 未启动')
        expect(msg).toContain('未执行')
        expect(msg).toContain('请先运行 tabtin desktop screenshot')
      }
      expect(mock.spies.click).not.toHaveBeenCalled()
    })

    it('sessionId 不匹配 → screenshot 抛 PERMISSION_DENIED + 含两侧 sid 信息', async () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      await expect(wrapper.screenshot({})).rejects.toMatchObject({
        code: DesktopErrorCode.PERMISSION_DENIED,
      })
      try {
        await wrapper.screenshot({})
      } catch (err) {
        expect(err).toBeInstanceOf(DesktopError)
        const msg = (err as DesktopError).message
        expect(msg).toContain('ctx.sessionId=ctx-stale')
        expect(msg).toContain('s-1')
      }
      expect(mock.spies.screenshot).not.toHaveBeenCalled()
    })

    it('所有动作方法都做一致性校验（13 个方法逐项守约）', async () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['screenshot', () => wrapper.screenshot({})],
        ['click', () => wrapper.click(0, 0)],
        ['scroll', () => wrapper.scroll(0, 0, 0, 0)],
        ['drag', () => wrapper.drag({ x: 0, y: 0 }, { x: 1, y: 1 })],
        ['move', () => wrapper.move(0, 0)],
        ['type', () => wrapper.type('x')],
        ['keyPress', () => wrapper.keyPress('a')],
        ['hotkey', () => wrapper.hotkey(['cmd', 'c'])],
        ['listWindows', () => wrapper.listWindows()],
        ['activateWindow', () => wrapper.activateWindow('Foo')],
        ['openApp', () => wrapper.openApp('Foo')],
        ['batch', () => wrapper.batch([{ action: 'click', x: 0, y: 0 }])],
      ]
      for (const [name, fn] of cases) {
        await expect(fn(), `动作方法 ${name} 应抛 PERMISSION_DENIED`).rejects.toMatchObject({
          code: DesktopErrorCode.PERMISSION_DENIED,
        })
      }
    })
  })

  describe('会话管理类 / 权限类方法不做一致性校验（直接透传）', () => {
    it('startSession 即使 ctx 不匹配也透传', () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      wrapper.startSession('s-new')
      expect(mock.spies.startSession).toHaveBeenCalledWith('s-new', undefined)
    })

    it('endSession 即使 ctx 不匹配也透传', () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      wrapper.endSession()
      expect(mock.spies.endSession).toHaveBeenCalledTimes(1)
    })

    it('getSession 透传（用于 ctx 派生自身，循环依赖必须打断）', () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      const s = wrapper.getSession()
      expect(s?.sessionId).toBe('s-1')
    })

    it('setAbortSignal 透传', () => {
      const ctrl = new AbortController()
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      wrapper.setAbortSignal(ctrl.signal)
      expect(mock.spies.setAbortSignal).toHaveBeenCalledWith(ctrl.signal)
    })

    it('getIdleMs / checkAccessibility / checkScreenRecording / setPixelCompareEnabled / extendAllowedApps 透传', async () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      expect(wrapper.getIdleMs()).toBe(0)
      expect(wrapper.checkAccessibility()).toBe(true)
      expect(wrapper.checkScreenRecording().granted).toBe(true)
      wrapper.setPixelCompareEnabled(false)
      expect(mock.spies.setPixelCompareEnabled).toHaveBeenCalledWith(false)
      // extendAllowedApps 不做 ctx 校验（它本身就是 session 操作）
      await wrapper.extendAllowedApps('s-1', ['Foo'])
      expect(mock.spies.extendAllowedApps).toHaveBeenCalledWith('s-1', ['Foo'], undefined)
    })
  })

  describe('一致性通过时动作 100% 透传', () => {
    it('click / screenshot / batch 入参原样转发', async () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('s-1'))
      await wrapper.click(640, 400, { button: 'right', count: 2 })
      expect(mock.spies.click).toHaveBeenCalledWith(640, 400, { button: 'right', count: 2 })

      await wrapper.screenshot({ displayId: 7, maxDimension: 800 })
      expect(mock.spies.screenshot).toHaveBeenCalledWith({ displayId: 7, maxDimension: 800 })

      await wrapper.batch([{ action: 'click', x: 1, y: 2 }])
      expect(mock.spies.batch).toHaveBeenCalledWith([{ action: 'click', x: 1, y: 2 }])
    })

    it('动作方法的返回值原样冒泡', async () => {
      mock.spies.screenshot.mockResolvedValueOnce({
        path: '/x.jpg', width: 1, height: 2, displayWidth: 3, displayHeight: 4, scaleFactor: 1,
      })
      const wrapper = bindSessionContext(mock.executor, makeCtx('s-1'))
      const result = await wrapper.screenshot({})
      expect(result).toMatchObject({ path: '/x.jpg', width: 1, height: 2 })
    })

    it('动作方法的异常原样冒泡（DesktopError）', async () => {
      mock.spies.click.mockRejectedValueOnce(
        new DesktopError(DesktopErrorCode.TCC_DENIED, '辅助功能未授权'),
      )
      const wrapper = bindSessionContext(mock.executor, makeCtx('s-1'))
      await expect(wrapper.click(0, 0)).rejects.toMatchObject({
        code: DesktopErrorCode.TCC_DENIED,
      })
    })
  })

  describe('v2.2 模块零扫尾（独立验收 P0-3）· bindWindow / unbindWindow stub', () => {
    it('executor 未实现 bindWindow → wrapper 抛 PERMISSION_DENIED + 中文三段式', async () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('s-1'))
      await expect(wrapper.bindWindow!({ handle: 12345 })).rejects.toMatchObject({
        code: DesktopErrorCode.PERMISSION_DENIED,
      })
      try {
        await wrapper.bindWindow!({ handle: 12345 })
      } catch (err) {
        expect(err).toBeInstanceOf(DesktopError)
        const msg = (err as DesktopError).message
        expect(msg).toContain('bound window 模式不可用')
        expect(msg).toContain('窗口绑定')
        expect(msg).toContain('Windows')
      }
    })

    it('executor 未实现 unbindWindow → wrapper 抛 PERMISSION_DENIED + 中文三段式', async () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('s-1'))
      await expect(wrapper.unbindWindow!()).rejects.toMatchObject({
        code: DesktopErrorCode.PERMISSION_DENIED,
      })
    })

    it('M3a 落实现后 bindWindow / unbindWindow 透传给 executor', async () => {
      // 模拟 M3a 在 DesktopExecutorService 加 bindWindow / unbindWindow 实现
      const m3aMock = createMockExecutor({
        sessionId: 's-1',
        grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
        startedAt: Date.now(),
      })
      ;(m3aMock.executor as { bindWindow: (target: unknown) => Promise<{ ok: true }> }).bindWindow =
        vi.fn(async () => ({ ok: true }))
      ;(m3aMock.executor as { unbindWindow: () => Promise<{ ok: true }> }).unbindWindow =
        vi.fn(async () => ({ ok: true }))

      const wrapper = bindSessionContext(m3aMock.executor, makeCtx('s-1'))
      const r1 = await wrapper.bindWindow!({ handle: 0x12345678 })
      expect(r1).toEqual({ ok: true })
      const r2 = await wrapper.unbindWindow!()
      expect(r2).toEqual({ ok: true })
    })

    it('bindWindow / unbindWindow 也做 ctx 一致性校验（ctx 不匹配时抛 PERMISSION_DENIED）', async () => {
      const wrapper = bindSessionContext(mock.executor, makeCtx('ctx-stale'))
      await expect(wrapper.bindWindow!({ handle: 1 })).rejects.toMatchObject({
        code: DesktopErrorCode.PERMISSION_DENIED,
      })
      // 文案应该是 ctx 不匹配，而不是 "bound window 未实现"
      try {
        await wrapper.bindWindow!({ handle: 1 })
      } catch (err) {
        const msg = (err as DesktopError).message
        expect(msg).toContain('ctx.sessionId=ctx-stale')
        // 不应该露出"bound window 未实现"——ctx 校验失败优先
        expect(msg).not.toContain('bound window 模式未实现')
      }
    })
  })
})

describe('deriveSessionContextFromExecutor (v2.1 模块零)', () => {
  it('executor 无 session → 返回 null', () => {
    const mock = createMockExecutor(null)
    expect(deriveSessionContextFromExecutor(mock.executor)).toBeNull()
  })

  it('executor 有 session → 返回 ctx，关键字段映射正确', () => {
    const mock = createMockExecutor({
      sessionId: 's-1',
      grantFlags: { clipboardRead: true, clipboardWrite: true, systemKeyCombos: false },
      startedAt: 1700000000000,
      lastActivityAt: 1700000005000,
      allowedApps: ['Code', 'Chrome'],
      mainWindowHidden: true,
      screenRecordingChecked: true,
      frozenDisplayConfig: {
        width: 1440, height: 900, scaleFactor: 2, boundsX: 0, boundsY: 0,
      },
      lastScreenshotDims: {
        width: 1440, height: 900, displayWidth: 1440, displayHeight: 900, scaleFactor: 2,
      },
      lastScreenshotPath: '/tmp/x.jpg',
      selectedDisplayId: 1,
    })
    const ctx = deriveSessionContextFromExecutor(mock.executor)
    expect(ctx).not.toBeNull()
    expect(ctx!.sessionId).toBe('s-1')
    expect(ctx!.grantFlags).toEqual({ clipboardRead: true, clipboardWrite: true, systemKeyCombos: false })
    expect(ctx!.startedAt).toBe(1700000000000)
    expect(ctx!.lastActivityAt).toBe(1700000005000)
    expect(ctx!.allowedApps).toEqual(['Code', 'Chrome'])
    expect(ctx!.mainWindowHidden).toBe(true)
    expect(ctx!.screenRecordingChecked).toBe(true)
    expect(ctx!.frozenDisplayConfig).toEqual({
      width: 1440, height: 900, scaleFactor: 2, boundsX: 0, boundsY: 0,
    })
    expect(ctx!.lastScreenshotDims).toEqual({
      width: 1440, height: 900, displayWidth: 1440, displayHeight: 900, scaleFactor: 2,
    })
    expect(ctx!.lastScreenshotPath).toBe('/tmp/x.jpg')
    expect(ctx!.selectedDisplayId).toBe(1)
  })

  it('派生 ctx 与 executor session 隔离（ctx mutate 不影响 executor）', () => {
    const session = {
      sessionId: 's-1',
      grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
      startedAt: 1700000000000,
      allowedApps: ['Code'],
    }
    const mock = createMockExecutor(session)
    const ctx = deriveSessionContextFromExecutor(mock.executor)
    expect(ctx).not.toBeNull()
    // mutate ctx 不应影响 executor 内部 session
    ctx!.allowedApps!.push('Chrome')
    ctx!.grantFlags.clipboardRead = true
    const session2 = mock.executor.getSession() as typeof session
    expect(session2.allowedApps).toEqual(['Code'])
    expect(session2.grantFlags.clipboardRead).toBe(false)
  })

  it('占位字段（authorizationProfile / subGates / coordinateMode / hostBundleId）模块零阶段为 undefined', () => {
    const mock = createMockExecutor({
      sessionId: 's-1',
      grantFlags: { clipboardRead: false, clipboardWrite: true, systemKeyCombos: false },
      startedAt: 0,
    })
    const ctx = deriveSessionContextFromExecutor(mock.executor)
    expect(ctx!.authorizationProfile).toBeUndefined()
    expect(ctx!.subGates).toBeUndefined()
    expect(ctx!.coordinateMode).toBeUndefined()
    expect(ctx!.hostBundleId).toBeUndefined()
  })
})
