/**
 * TabDesktop · computer_batch 单测（Wave 3 · 规范 § 4.5.2 / § 9.3 / § 10 Q5）。
 *
 * 验收重点：
 *   1. **首项 screenshot 硬拦截（Q5）**：Executor 入口即抛 VALIDATION_ERROR，
 *      不进策略评估、不触发审批、不执行任何子动作
 *   2. **非首项 screenshot 允许**：正常按序执行
 *   3. **顺序正确**：actions 数组顺序 = 执行顺序
 *   4. **stop-on-first-error**：第 N 步失败 → 第 N+1 步不执行
 *   5. **中止传播**：batch 中途 abort → 后续步抛"已被用户中止"
 *   6. **每步独立审计 + batch 汇总审计**（规范 § 6.11.2）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock hoisting (与 DesktopExecutorService.test.ts 同结构，避免重复 mock 逻辑)
// ---------------------------------------------------------------------------

const mockMouseSetPosition = vi.fn()
const mockMouseClick = vi.fn()
const mockMouseDoubleClick = vi.fn()
const mockMousePressButton = vi.fn()
const mockMouseReleaseButton = vi.fn()
const mockMouseScrollDown = vi.fn()
const mockMouseScrollUp = vi.fn()
const mockKeyboardType = vi.fn()
const mockKeyboardPressKey = vi.fn()
const mockKeyboardReleaseKey = vi.fn()

const mockKeyEnum: Record<string, number> = {
  A: 0, C: 2, Q: 16, V: 21,
  LeftCmd: 100, LeftControl: 101, LeftAlt: 102, LeftShift: 103,
  LeftMeta: 105, LeftSuper: 106, LeftWin: 107,
  RightCmd: 110, RightControl: 111, RightAlt: 112, RightShift: 113,
  Enter: 200, Return: 201, Tab: 202,
}

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
  desktopCapturer: { getSources: vi.fn().mockResolvedValue([]) },
  clipboard: { readText: vi.fn().mockReturnValue(''), writeText: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: vi.fn().mockReturnValue(true) },
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
}))

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}))

vi.mock('electron-log', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      transports: { file: { level: false, fileName: '', format: '' }, console: { level: 'debug' } },
      debug: vi.fn(), info: vi.fn(),
    }),
  },
}))

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: {
    config: { mouseSpeed: 0, autoDelayMs: 0 },
    setPosition: mockMouseSetPosition,
    click: mockMouseClick,
    doubleClick: mockMouseDoubleClick,
    pressButton: mockMousePressButton,
    releaseButton: mockMouseReleaseButton,
    scrollDown: mockMouseScrollDown,
    scrollUp: mockMouseScrollUp,
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
  Point: vi.fn().mockImplementation(function (this: { x: number; y: number }, x: number, y: number) {
    this.x = x
    this.y = y
  }),
}))

vi.mock('node:child_process', () => {
  const mod = { execFileSync: vi.fn() }
  return { ...mod, default: mod }
})

const { mockAppendFileSync } = vi.hoisted(() => ({ mockAppendFileSync: vi.fn() }))
vi.mock('node:fs', () => {
  const mod = { mkdirSync: vi.fn(), appendFileSync: mockAppendFileSync }
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

vi.mock('sharp', () => ({ default: vi.fn() }))

vi.mock('../ApprovalManager', () => ({
  requestApproval: vi.fn().mockResolvedValue({ approved: true }),
}))

vi.mock('../DesktopUseLock', () => ({
  isHeldLocally: () => true,
  tryAcquire: vi.fn(),
  release: vi.fn(),
  check: vi.fn(),
}))

vi.mock('../desktop-window-helpers', async () => {
  const actual = await vi.importActual<typeof import('../desktop-window-helpers')>(
    '../desktop-window-helpers',
  )
  return { ...actual, getAppAtPoint: vi.fn().mockReturnValue('TestApp') }
})

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import {
  DesktopExecutorService,
  type BatchAction,
} from '../DesktopExecutorService'
import { DesktopError, DesktopErrorCode } from '../desktop-error-codes'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DesktopExecutorService.batch (Wave 3 · computer_batch)', () => {
  let service: DesktopExecutorService

  /** 从最新 appendFileSync 调用读 jsonl action 列表。 */
  function auditActions(): string[] {
    return mockAppendFileSync.mock.calls.map(call => {
      const payload = JSON.parse(String(call[1]).trim())
      return payload.action as string
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    service = new DesktopExecutorService(() => null)
    service.startSession('batch-test')
    // 给 batch 里的鼠标类动作提供坐标系
    const session = (service as unknown as { currentSession: { lastScreenshotDims: unknown } }).currentSession
    session.lastScreenshotDims = {
      width: 1920, height: 1080,
      displayWidth: 1920, displayHeight: 1080,
      scaleFactor: 1.0,
    }
  })

  describe('入口硬性校验（Q5）', () => {
    it('首项 screenshot → 立即抛 VALIDATION_ERROR，不执行任何步', async () => {
      const actions: BatchAction[] = [
        { action: 'screenshot' },
        { action: 'click', x: 100, y: 200 },
      ]
      // Wave 3 技术优雅度 Review 补强：除了 message 匹配，还硬断言 errorCode === VALIDATION_ERROR
      // 理由：错误码是路由层响应 / 审计聚合 / 测试跨版本稳定性的正源，message 文案可以改，code 不能错。
      try {
        await service.batch(actions)
        expect.fail('应该抛 DesktopError')
      } catch (err) {
        expect(err).toBeInstanceOf(DesktopError)
        expect((err as DesktopError).code).toBe(DesktopErrorCode.VALIDATION_ERROR)
        expect((err as DesktopError).message).toContain('batch 首项不能是 screenshot')
      }
      // 严格验证：任何子动作都不应该执行
      expect(mockMouseSetPosition).not.toHaveBeenCalled()
      expect(mockMouseClick).not.toHaveBeenCalled()
      // 审计也不应有 batch / batch_step.0 记录（规范 § 4.5.2：违法请求不入审计）
      const actionsLogged = auditActions()
      expect(actionsLogged.some(a => a.startsWith('batch'))).toBe(false)
    })

    it('空 actions 数组 → VALIDATION_ERROR（errorCode 精确断言）', async () => {
      try {
        await service.batch([])
        expect.fail('应该抛 DesktopError')
      } catch (err) {
        expect(err).toBeInstanceOf(DesktopError)
        expect((err as DesktopError).code).toBe(DesktopErrorCode.VALIDATION_ERROR)
      }
    })

    it('非数组输入 → VALIDATION_ERROR（errorCode 精确断言）', async () => {
      try {
        await service.batch(null as unknown as BatchAction[])
        expect.fail('应该抛 DesktopError')
      } catch (err) {
        expect(err).toBeInstanceOf(DesktopError)
        expect((err as DesktopError).code).toBe(DesktopErrorCode.VALIDATION_ERROR)
      }
    })

    it('错误 message 包含"batch 首项不能是 screenshot"特征词（文案 Agent 可识别）', async () => {
      const actions: BatchAction[] = [{ action: 'screenshot' }]
      try {
        await service.batch(actions)
        expect.fail('应该抛错')
      } catch (err) {
        const msg = (err as Error).message
        expect(msg).toContain('batch 首项不能是 screenshot')
        expect(msg).toContain('先单独调 tabtin desktop screenshot')
      }
    })
  })

  describe('非首项 screenshot（规范 § 4.5.2 明确允许）', () => {
    it('[click, screenshot] → 正常执行，不抛错', async () => {
      // screenshot 在 mock 环境下可能因 desktopCapturer 返回空而抛错，
      // 但"非首项 screenshot 不被入口校验拒绝"是本测的核心——只验证没走入口拦截。
      const actions: BatchAction[] = [
        { action: 'click', x: 100, y: 200 },
        { action: 'screenshot' },
      ]
      const result = await service.batch(actions)
      // click 执行过
      expect(mockMouseClick).toHaveBeenCalled()
      // 至少第一步成功（screenshot 可能失败但不是入口校验失败）
      expect(result.stepsCompleted).toBeGreaterThanOrEqual(1)
    })
  })

  describe('顺序正确', () => {
    it('5 步 batch 按数组顺序触发 nut-js 调用', async () => {
      const actions: BatchAction[] = [
        { action: 'click', x: 100, y: 200 },
        { action: 'type', text: 'hello' },
        { action: 'key', key: 'Tab' },
        { action: 'type', text: 'world' },
        { action: 'key', key: 'Enter' },
      ]
      const result = await service.batch(actions)
      expect(result.stepsCompleted).toBe(5)
      expect(result.stepFailed).toBeNull()
      // 审计顺序校验：应出现 batch + batch_step.0.click → batch_step.4.key
      const logged = auditActions().filter(a => a.startsWith('batch'))
      expect(logged[0]).toBe('batch')
      expect(logged).toContain('batch_step.0.click')
      expect(logged).toContain('batch_step.1.type')
      expect(logged).toContain('batch_step.2.key')
      expect(logged).toContain('batch_step.3.type')
      expect(logged).toContain('batch_step.4.key')
    })
  })

  describe('stop-on-first-error', () => {
    it('第 3 步 hotkey(cmd,q) 被危险键拦截 → 第 4/5 步不执行', async () => {
      const actions: BatchAction[] = [
        { action: 'click', x: 100, y: 200 },
        { action: 'click', x: 150, y: 250 },
        { action: 'hotkey', keys: ['cmd', 'q'] }, // 被 DANGEROUS_KEY_COMBOS 拦截
        { action: 'click', x: 300, y: 400 }, // 不该执行
        { action: 'type', text: 'bad' },      // 不该执行
      ]
      const result = await service.batch(actions)
      expect(result.stepsCompleted).toBe(2)
      expect(result.stepFailed).toBe(2)
      expect(result.failedAction).toBe('hotkey')
      expect(result.error?.code).toBe('POLICY_BLOCKED')
      expect(result.error?.message).toContain('系统级快捷键')
      // click 只调了 2 次——第 4/5 步未执行（第 5 步 type 不经过 mouse）
      expect(mockMouseClick).toHaveBeenCalledTimes(2)
      expect(mockKeyboardType).not.toHaveBeenCalled()
    })

    it('失败步有专门的 error 审计记录（含 errorCode）', async () => {
      const actions: BatchAction[] = [
        { action: 'hotkey', keys: ['cmd', 'q'] },
      ]
      await service.batch(actions)
      const errorEntries = mockAppendFileSync.mock.calls
        .map(call => JSON.parse(String(call[1]).trim()))
        .filter(p => p.result === 'error')
      expect(errorEntries.length).toBeGreaterThan(0)
      expect(errorEntries[0].action).toMatch(/^batch_step\.0\.hotkey$/)
      expect(errorEntries[0].errorCode).toBe('POLICY_BLOCKED')
    })
  })

  describe('中止传播（ABORTED 经 batch 传出）', () => {
    it('batch 执行到第 2 步时 abort → 第 3 步抛 ABORTED', async () => {
      const controller = new AbortController()
      service.setAbortSignal(controller.signal)
      // 让第 2 步执行完立刻 abort（mockMouseClick 的第 2 次调用时触发）
      let callCount = 0
      mockMouseClick.mockImplementation(() => {
        callCount++
        if (callCount === 2) controller.abort()
      })

      const actions: BatchAction[] = [
        { action: 'click', x: 10, y: 20 },
        { action: 'click', x: 30, y: 40 },
        { action: 'click', x: 50, y: 60 }, // 此时应抛 ABORTED
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBe(2)
      expect(result.error?.code).toBe('ABORTED')
      expect(result.error?.message).toContain('中止')
      expect(mockMouseClick).toHaveBeenCalledTimes(2) // 第 3 步未到 nut-js
    })
  })

  describe('审计完整性', () => {
    it('batch 入口审计一条 + 每步独立审计一条（成功路径）', async () => {
      const actions: BatchAction[] = [
        { action: 'click', x: 100, y: 200 },
        { action: 'type', text: 'hi' },
      ]
      await service.batch(actions)
      const batchEntries = auditActions().filter(a => a.startsWith('batch'))
      // 期望：batch（入口汇总） + batch_step.0.click + click（内部 audit）
      //       + batch_step.1.type + type（内部 audit）
      expect(batchEntries).toContain('batch')
      expect(batchEntries).toContain('batch_step.0.click')
      expect(batchEntries).toContain('batch_step.1.type')
    })

    it('batch_step 的 type 审计 text 字段仍然脱敏（不泄露原文）', async () => {
      const actions: BatchAction[] = [
        { action: 'type', text: 'MyPassw0rd!123' },
      ]
      await service.batch(actions)
      const typeStepEntry = mockAppendFileSync.mock.calls
        .map(call => JSON.parse(String(call[1]).trim()))
        .find(p => p.action === 'batch_step.0.type')
      expect(typeStepEntry).toBeDefined()
      expect((typeStepEntry.params as { text: string }).text).toBe(
        '[typed_text, len=14]',
      )
      expect((typeStepEntry.params as { text: string }).text).not.toContain(
        'MyPassw0rd',
      )
    })
  })

  describe('wait 子动作参数校验（Wave 3.1 · 规范 § 4.5.2）', () => {
    // 背景：Wave 3 独立验证 F4——wait 的 Math.max(0, Math.min(step.ms, 30_000)) 对
    // undefined / 字符串 / null / NaN 会静默降级为 0ms，Agent 本意"等 500ms"
    // 实际不等，UI 未加载完就 click。Wave 3.1 补硬校验。

    it('wait ms=1 → 正常执行（正数整数路径）', async () => {
      const actions: BatchAction[] = [
        { action: 'click', x: 100, y: 200 },
        { action: 'wait', ms: 1 },
        { action: 'click', x: 150, y: 250 },
      ]
      const result = await service.batch(actions)
      expect(result.stepsCompleted).toBe(3)
      expect(result.stepFailed).toBeNull()
      expect(mockMouseClick).toHaveBeenCalledTimes(2)
    })

    it('wait ms=undefined → VALIDATION_ERROR，batch 在该步中止', async () => {
      const actions = [
        { action: 'wait' } as unknown as BatchAction,
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBe(0)
      expect(result.failedAction).toBe('wait')
      expect(result.error?.code).toBe(DesktopErrorCode.VALIDATION_ERROR)
      expect(result.error?.message).toContain('ms 必须是正整数')
    })

    it('wait ms 字符串 "500" → VALIDATION_ERROR', async () => {
      const actions = [
        { action: 'wait', ms: '500' } as unknown as BatchAction,
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBe(0)
      expect(result.error?.code).toBe(DesktopErrorCode.VALIDATION_ERROR)
      expect(result.error?.message).toContain('ms 必须是正整数')
    })

    it('wait ms=-1 → VALIDATION_ERROR（负数非法）', async () => {
      const actions: BatchAction[] = [
        { action: 'wait', ms: -1 },
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBe(0)
      expect(result.error?.code).toBe(DesktopErrorCode.VALIDATION_ERROR)
    })

    it('wait ms=NaN → VALIDATION_ERROR', async () => {
      const actions: BatchAction[] = [
        { action: 'wait', ms: Number.NaN },
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBe(0)
      expect(result.error?.code).toBe(DesktopErrorCode.VALIDATION_ERROR)
    })

    it('wait ms=60000 → 超 30000 上限 VALIDATION_ERROR（batch 不应被单步卡死）', async () => {
      const actions: BatchAction[] = [
        { action: 'wait', ms: 60_000 },
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBe(0)
      expect(result.error?.code).toBe(DesktopErrorCode.VALIDATION_ERROR)
      expect(result.error?.message).toContain('上限 30000')
    })

    it('wait ms=1.5 非整数 → VALIDATION_ERROR', async () => {
      const actions: BatchAction[] = [
        { action: 'wait', ms: 1.5 },
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBe(0)
      expect(result.error?.code).toBe(DesktopErrorCode.VALIDATION_ERROR)
    })

    it('wait 失败后，后续子动作不再执行（stop-on-first-error 对 wait 同样生效）', async () => {
      const actions = [
        { action: 'click', x: 100, y: 200 } as BatchAction,
        { action: 'wait', ms: 'bad' } as unknown as BatchAction,
        { action: 'click', x: 300, y: 400 } as BatchAction,
      ]
      const result = await service.batch(actions)
      expect(result.stepsCompleted).toBe(1)
      expect(result.stepFailed).toBe(1)
      expect(mockMouseClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('返回结构（Agent 可读）', () => {
    it('全成功 → stepFailed=null, stepsCompleted=N', async () => {
      const actions: BatchAction[] = [
        { action: 'click', x: 100, y: 200 },
        { action: 'type', text: 'hi' },
      ]
      const result = await service.batch(actions)
      expect(result.stepFailed).toBeNull()
      expect(result.stepsCompleted).toBe(2)
      expect(result.error).toBeUndefined()
    })

    it('部分失败 → error 字段带 code + message 两段式 Agent 容易分桶', async () => {
      const actions: BatchAction[] = [
        { action: 'click', x: 100, y: 200 },
        { action: 'hotkey', keys: ['cmd', 'q'] },
      ]
      const result = await service.batch(actions)
      expect(result.error).toBeDefined()
      expect(result.error?.code).toBe('POLICY_BLOCKED')
      expect(typeof result.error?.message).toBe('string')
    })
  })
})
