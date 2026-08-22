/**
 * TabDesktop · pixelCompare 单测（Wave 3 · 规范 § 4.5.3 / § 9.3 / § 10 Q6）。
 *
 * 本测包含两部分：
 *   **A. 纯算法**（`desktop-pixel-compare` 模块）：computeCropRect /
 *      buffersEqual / comparePixels 在边界、异常、尺寸不一致时的行为
 *   **B. 集成路径**（`DesktopExecutorService.click/drag` 接入后）：
 *      - 相等 → 点击正常
 *      - 不等 → click 抛 POLICY_BLOCKED，不触发 nut-js
 *      - **冷启动、decode 异常、新截屏失败**→ 点击正常执行（**红线**）
 *      - 开关关闭 → 跳过校验
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Part A — 纯算法单测（independent of Executor）
// ---------------------------------------------------------------------------

import {
  computeCropRect,
  buffersEqual,
  comparePixels,
  DEFAULT_GRID_SIZE,
} from '../desktop-pixel-compare'

describe('desktop-pixel-compare · computeCropRect', () => {
  it('中心坐标：100×100 图 + (50%, 50%) → 9×9 居中', () => {
    const rect = computeCropRect(100, 100, 50, 50)
    expect(rect).toEqual({ x: 46, y: 46, width: 9, height: 9 })
  })

  it('边角：100×100 图 + (0%, 0%) → 左上角 9×9（中心 clamp 到 0，rect 向图内延伸）', () => {
    // 与规格一致：centerX = 0 时 cropX = max(0, -4) = 0，
    // cropW = min(9, 100-0) = 9。rect 不"收紧到 5×5"，而是靠着左上角向右下
    // 延伸成完整 9×9——这样点击最左上角 1px 处与屏幕最左上角 9×9 像素做比对，
    // 覆盖面仍有 81 像素，语义合理。
    const rect = computeCropRect(100, 100, 0, 0)
    expect(rect).toEqual({ x: 0, y: 0, width: 9, height: 9 })
  })

  it('边角：100×100 图 + (100%, 100%) → 右下角收紧', () => {
    const rect = computeCropRect(100, 100, 100, 100)
    expect(rect!.x + rect!.width).toBe(100)
    expect(rect!.y + rect!.height).toBe(100)
  })

  it('百分比 clamp：> 100 的输入被 clamp 为 100', () => {
    const rect = computeCropRect(100, 100, 200, 300)
    expect(rect).toEqual(computeCropRect(100, 100, 100, 100))
  })

  it('百分比 clamp：< 0 的输入被 clamp 为 0', () => {
    const rect = computeCropRect(100, 100, -10, -5)
    expect(rect).toEqual(computeCropRect(100, 100, 0, 0))
  })

  it('非法尺寸：width = 0 → null（调用方按 skip 处理）', () => {
    expect(computeCropRect(0, 100, 50, 50)).toBeNull()
  })

  it('非法尺寸：height 负数 → null', () => {
    expect(computeCropRect(100, -5, 50, 50)).toBeNull()
  })

  it('NaN 百分比 → null', () => {
    expect(computeCropRect(100, 100, NaN, 50)).toBeNull()
  })

  it('gridSize ≤ 0 → null', () => {
    expect(computeCropRect(100, 100, 50, 50, 0)).toBeNull()
    expect(computeCropRect(100, 100, 50, 50, -5)).toBeNull()
  })

  it('DEFAULT_GRID_SIZE 为 9（规范 § 4.5.3）', () => {
    expect(DEFAULT_GRID_SIZE).toBe(9)
  })
})

describe('desktop-pixel-compare · buffersEqual', () => {
  it('两个相同内容 Buffer → true', () => {
    expect(buffersEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true)
  })

  it('一字节不同 → false', () => {
    expect(buffersEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false)
  })

  it('长度不同 → false（不会 crash）', () => {
    expect(buffersEqual(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toBe(false)
  })

  it('null 输入 → false（调用方按 skip）', () => {
    expect(buffersEqual(null, Buffer.from([1]))).toBe(false)
    expect(buffersEqual(Buffer.from([1]), null)).toBe(false)
    expect(buffersEqual(null, null)).toBe(false)
  })
})

describe('desktop-pixel-compare · comparePixels', () => {
  it('两个 cropFn 返回相同 buffer → true', () => {
    const buf = Buffer.from([1, 2, 3, 4])
    const result = comparePixels(100, 100, 50, 50, () => buf, () => buf)
    expect(result).toBe(true)
  })

  it('两个 cropFn 返回不同 buffer → false', () => {
    const result = comparePixels(
      100, 100, 50, 50,
      () => Buffer.from([1, 2, 3]),
      () => Buffer.from([1, 2, 4]),
    )
    expect(result).toBe(false)
  })

  it('last cropFn throw → null（红线：调用方必须视为 skip）', () => {
    const result = comparePixels(
      100, 100, 50, 50,
      () => { throw new Error('decode failed') },
      () => Buffer.from([1]),
    )
    expect(result).toBeNull()
  })

  it('fresh cropFn throw → null（红线）', () => {
    const result = comparePixels(
      100, 100, 50, 50,
      () => Buffer.from([1]),
      () => { throw new Error('fresh capture failed') },
    )
    expect(result).toBeNull()
  })

  it('last cropFn 返回 null → null', () => {
    const result = comparePixels(100, 100, 50, 50, () => null, () => Buffer.from([1]))
    expect(result).toBeNull()
  })

  it('非法图尺寸（0×100）→ null（computeCropRect 返回 null 的路径）', () => {
    const result = comparePixels(0, 100, 50, 50, () => Buffer.from([1]), () => Buffer.from([1]))
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Part B — Executor 集成路径（mock desktopCapturer + sharp + fs.readFile）
// ---------------------------------------------------------------------------

const mockMouseSetPosition = vi.fn()
const mockMouseClick = vi.fn()
const mockMouseDoubleClick = vi.fn()
const mockMousePressButton = vi.fn()
const mockMouseReleaseButton = vi.fn()
const mockKeyboardType = vi.fn()
const mockKeyboardPressKey = vi.fn()
const mockKeyboardReleaseKey = vi.fn()

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
    getSources: vi.fn(),
  },
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
  Key: { A: 0 },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Point: vi.fn().mockImplementation(function (this: { x: number; y: number }, x: number, y: number) {
    this.x = x
    this.y = y
  }),
}))

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(), default: { execFileSync: vi.fn() },
}))

const { mockAppendFileSync } = vi.hoisted(() => ({ mockAppendFileSync: vi.fn() }))
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(), appendFileSync: mockAppendFileSync,
  default: { mkdirSync: vi.fn(), appendFileSync: mockAppendFileSync },
}))

const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }))
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: mockReadFile,
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: mockReadFile,
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}))

/**
 * Sharp mock：verifyClickTarget 里的 pipeline 是
 *   sharp(buf).resize(...).removeAlpha().extract(...).raw().toBuffer()
 *
 * 每次 `sharp(buf)` 调用返回一个 chainable proxy——resize / removeAlpha / raw
 * 返回 this，extract 也返回 this（单独 mock 方便断言调用），最终 toBuffer
 * 返回我们 setupSharpPatches 注入的 patch 或抛错。
 */
const { mockSharpExtract, mockSharpFactory, mockToBufferQueue } = vi.hoisted(() => {
  const extract = vi.fn()
  const factory = vi.fn()
  const queue: Array<{ patch: Buffer | null }> = []
  return { mockSharpExtract: extract, mockSharpFactory: factory, mockToBufferQueue: queue }
})
vi.mock('sharp', () => {
  mockSharpFactory.mockImplementation(() => {
    const chain: Record<string, unknown> = {
      resize: vi.fn(() => chain),
      removeAlpha: vi.fn(() => chain),
      extract: vi.fn(() => {
        mockSharpExtract()
        return chain
      }),
      raw: vi.fn(() => chain),
      jpeg: vi.fn(() => chain),
      toBuffer: vi.fn(async () => {
        const entry = mockToBufferQueue.shift()
        if (!entry || entry.patch === null) throw new Error('sharp decode failed')
        return entry.patch
      }),
    }
    return chain
  })
  return { default: mockSharpFactory }
})

vi.mock('../ApprovalManager', () => ({
  requestApproval: vi.fn().mockResolvedValue({ approved: true }),
}))

vi.mock('../DesktopUseLock', () => ({
  isHeldLocally: () => true,
  tryAcquire: vi.fn(), release: vi.fn(), check: vi.fn(),
}))

vi.mock('../desktop-window-helpers', async () => {
  const actual = await vi.importActual<typeof import('../desktop-window-helpers')>(
    '../desktop-window-helpers',
  )
  return { ...actual, getAppAtPoint: vi.fn().mockReturnValue('TestApp') }
})

import { DesktopExecutorService } from '../DesktopExecutorService'
import { desktopCapturer } from 'electron'

/**
 * 注入两次 sharp pipeline 的 toBuffer 返回值。
 * 第一次 toBuffer → last，第二次 → fresh（与 verifyClickTarget 里
 * `Promise.all([extractRaw(lastBuffer), extractRaw(fresh)])` 的顺序一致）。
 * 传 null → 该次 toBuffer 抛错（模拟 decode 失败）。
 */
function setupSharpPatches(lastPatch: Buffer | null, freshPatch: Buffer | null): void {
  mockToBufferQueue.length = 0
  mockToBufferQueue.push({ patch: lastPatch }, { patch: freshPatch })
}

describe('DesktopExecutorService · pixelCompare 集成（Wave 3 · 规范 § 4.5.3）', () => {
  let service: DesktopExecutorService

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockReset()
    mockSharpExtract.mockReset()
    mockToBufferQueue.length = 0
    service = new DesktopExecutorService(() => null)
    service.startSession('pc-test')
    const session = (service as unknown as {
      currentSession: {
        lastScreenshotDims: unknown
        lastScreenshotPath: string
        frozenDisplayConfig: unknown
      }
    }).currentSession
    session.lastScreenshotDims = {
      width: 1920, height: 1080,
      displayWidth: 1920, displayHeight: 1080,
      scaleFactor: 1.0,
    }
    session.lastScreenshotPath = '/mock/home/.tabtin/screenshots/last.jpg'
    session.frozenDisplayConfig = {
      width: 1920, height: 1080, scaleFactor: 1,
      boundsX: 0, boundsY: 0,
    }

    // desktopCapturer 默认：返回一个非空 thumbnail（fresh 截图成功）
    ;(desktopCapturer.getSources as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        display_id: undefined,
        thumbnail: {
          isEmpty: () => false,
          toPNG: () => Buffer.from([9, 9, 9]),
        },
      },
    ])

    // last 截图文件默认可读
    mockReadFile.mockResolvedValue(Buffer.from([1, 1, 1]))
  })

  it('9×9 相等 → click 正常执行', async () => {
    setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  it('9×9 不等 → click 抛 POLICY_BLOCKED，nut-js 未被调用', async () => {
    setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))
    try {
      await service.click(100, 200)
      expect.fail('应该抛 POLICY_BLOCKED')
    } catch (err) {
      const error = err as { code?: string; message: string }
      expect(error.code).toBe('POLICY_BLOCKED')
      expect(error.message).toContain('屏幕内容与上次截图不一致')
      expect(error.message).toContain('重新截图')
    }
    expect(mockMouseClick).not.toHaveBeenCalled()
  })

  it('【红线】冷启动 lastScreenshotPath 不存在 → click 正常执行', async () => {
    ;(service as unknown as { currentSession: { lastScreenshotPath?: string } })
      .currentSession.lastScreenshotPath = undefined
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
    // 冷启动路径下不应该调 desktopCapturer / sharp
    expect(mockSharpExtract).not.toHaveBeenCalled()
  })

  it('【红线】decode 异常（last patch 抛错） → click 正常执行', async () => {
    setupSharpPatches(null, Buffer.from([1, 2, 3])) // last throw
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  it('【红线】decode 异常（fresh patch 抛错） → click 正常执行', async () => {
    setupSharpPatches(Buffer.from([1, 2, 3]), null) // fresh throw
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  it('【红线】新截屏失败（desktopCapturer 抛错）→ click 正常执行', async () => {
    ;(desktopCapturer.getSources as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('capturer failed'),
    )
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  it('【红线】last 文件读不出 → click 正常执行', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  it('【红线】desktopCapturer 返回空 thumbnail → click 正常执行', async () => {
    ;(desktopCapturer.getSources as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        display_id: undefined,
        thumbnail: {
          isEmpty: () => true,
          toPNG: () => Buffer.from([]),
        },
      },
    ])
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  it('开关关闭（pixelCompareEnabled = false） → click 跳过校验直接执行', async () => {
    const svc2 = new DesktopExecutorService(() => null, { pixelCompareEnabled: false })
    svc2.startSession('pc-off-test')
    const s = (svc2 as unknown as {
      currentSession: {
        lastScreenshotDims: unknown
        lastScreenshotPath: string
        frozenDisplayConfig: unknown
      }
    }).currentSession
    s.lastScreenshotDims = {
      width: 1920, height: 1080,
      displayWidth: 1920, displayHeight: 1080,
      scaleFactor: 1.0,
    }
    s.lastScreenshotPath = '/mock/home/.tabtin/screenshots/last.jpg'
    s.frozenDisplayConfig = { width: 1920, height: 1080, scaleFactor: 1, boundsX: 0, boundsY: 0 }

    // 即使 9×9 不等，pixelCompare 关闭时也不会拦截
    setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([9, 9, 9]))
    await expect(svc2.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
    // 关闭开关时不应该读 last 文件 / 调 sharp
    expect(mockReadFile).not.toHaveBeenCalled()
    expect(mockSharpExtract).not.toHaveBeenCalled()
  })

  it('setPixelCompareEnabled(false) 动态关闭（app.json 热更新路径）', async () => {
    service.setPixelCompareEnabled(false)
    setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([9, 9, 9])) // 会不等
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  it('drag 也接 pixelCompare（起点校验）', async () => {
    setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))
    await expect(
      service.drag({ x: 100, y: 200 }, { x: 300, y: 400 }),
    ).rejects.toThrow('屏幕内容与上次截图不一致')
  })

  it('drag 像素不等时不开始拖拽（pressButton 未调用）—— 与 click 单测对称', async () => {
    setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))
    await service
      .drag({ x: 100, y: 200 }, { x: 300, y: 400 })
      .catch(() => {})
    // pixelCompare 挡住 → nut-js pressButton 应该完全没被调用（否则会有
    // "按下但没松开"的鼠标悬挂风险）
    expect(mockMousePressButton).not.toHaveBeenCalled()
    expect(mockMouseReleaseButton).not.toHaveBeenCalled()
  })

  it('imageResize 算法异常时 click 仍然正常（pixelCompare 的 fallback 与 resize 降级两条防线都生效）', async () => {
    // 模拟：pipeline 第一次 toBuffer 抛错（last decode 失败）→ 红线跳过校验 → click 正常
    setupSharpPatches(null, Buffer.from([1, 2, 3]))
    await expect(service.click(100, 200)).resolves.toBeUndefined()
    expect(mockMouseClick).toHaveBeenCalled()
  })

  describe('region 截图 × pixelCompare（Wave 3.1 · 规范 § 4.5.3 区域截图行为契约）', () => {
    // 背景：Wave 3 独立验证 F1——当 session 的 lastScreenshotDims 带 regionOffset
    // 时，last 截图只是屏幕的一小块，但 captureFreshForPixelCompare 抓的是整屏
    // PNG。两者像素尺寸 / 覆盖范围完全不同，9×9 对比必然不等，每次 click 都被
    // 误判为"屏幕变化"拒绝。Wave 3.1 决策：region 模式下按 pixelCompare 红线
    // "异常不阻塞点击"的精神跳过校验，放行点击；代价是区域截图场景暂时失去
    // 9×9 保护（等后续 Wave 提供按 regionOffset crop fresh 的完整方案）。

    it('lastScreenshotDims 带 regionOffset → click 正常执行（即使 9×9 理应不等）', async () => {
      const session = (service as unknown as {
        currentSession: { lastScreenshotDims: { regionOffset?: { x: number; y: number } } }
      }).currentSession
      // 模拟一次 region 截图后的 session 状态
      session.lastScreenshotDims = {
        ...(session.lastScreenshotDims as object),
        regionOffset: { x: 400, y: 300 },
      } as typeof session.lastScreenshotDims

      // 即使我们准备了"会判为不等"的 patches，region 模式下应该根本不走 pipeline
      setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([9, 9, 9]))

      await expect(service.click(100, 200)).resolves.toBeUndefined()
      expect(mockMouseClick).toHaveBeenCalled()
      // region 模式下应直接 early-return，不读 last 文件、不走 sharp pipeline
      expect(mockSharpExtract).not.toHaveBeenCalled()
      expect(mockReadFile).not.toHaveBeenCalled()
    })

    it('全屏截图（regionOffset 缺省）→ pixelCompare 正常校验，9×9 不等时照常 POLICY_BLOCKED', async () => {
      // 对照组：不回归 Wave 3 主路径——非 region 场景 pixelCompare 必须生效
      setupSharpPatches(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))
      try {
        await service.click(100, 200)
        expect.fail('全屏模式下 9×9 不等应该抛 POLICY_BLOCKED')
      } catch (err) {
        const error = err as { code?: string; message: string }
        expect(error.code).toBe('POLICY_BLOCKED')
        expect(error.message).toContain('屏幕内容与上次截图不一致')
      }
      expect(mockMouseClick).not.toHaveBeenCalled()
      expect(mockSharpExtract).toHaveBeenCalled()
    })
  })
})
