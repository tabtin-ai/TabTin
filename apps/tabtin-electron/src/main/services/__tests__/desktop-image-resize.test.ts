/**
 * TabDesktop · imageResize 算法单测（Wave 3 · 规范 § 4.5.1 / § 9.3）。
 *
 * 验收重点：
 *   1. 核心 5 组 AR 输出尺寸与既定 vision 预处理规格逐 bit 一致
 *      （AGENTS.md 说"不照抄"——指的是不 copy-paste 代码风格；数值结果必须等价，
 *       否则就偏离了"对齐云端 vision tokenizer 网格"的设计目标）
 *   2. 双约束满足：任何输出 [w, h] 都要同时满足
 *      `max(w, h) ≤ maxTargetPx` 和 `⌈w/28⌉ × ⌈h/28⌉ ≤ maxTargetTokens`
 *   3. 极端输入（8K / 极小 100×100 / 竖屏）不崩、结果合理
 *   4. 非法输入（0 / 负数 / NaN）显式抛错
 */

import { describe, it, expect } from 'vitest'
import {
  targetImageSize,
  nTokensForPx,
  DEFAULT_IMAGE_RESIZE_PARAMS,
  type ImageResizeParams,
} from '../desktop-image-resize'

const P = DEFAULT_IMAGE_RESIZE_PARAMS

/** 用规范约束独立校验一次结果。 */
function assertWithinConstraints(
  [w, h]: [number, number],
  params: ImageResizeParams = P,
): void {
  expect(Math.max(w, h)).toBeLessThanOrEqual(params.maxTargetPx)
  const tokens =
    nTokensForPx(w, params.pxPerToken) * nTokensForPx(h, params.pxPerToken)
  expect(tokens).toBeLessThanOrEqual(params.maxTargetTokens)
  expect(Number.isInteger(w)).toBe(true)
  expect(Number.isInteger(h)).toBe(true)
  expect(w).toBeGreaterThan(0)
  expect(h).toBeGreaterThan(0)
}

describe('desktop-image-resize · targetImageSize', () => {
  describe('核心 5 组 AR（与既定规格逐 bit 对齐）', () => {
    // 这 5 组是规范 § 4.5.1 测试要点钦点的 AR，也是规格参考
    // `resize.rs` test vectors 的子集。任何一个输出偏离都意味着算法走样。

    it('16:9 → 1920×1080：双约束二分搜索收敛', () => {
      // 快照值由规格参考算法 + 相同参数（28 / 1568 / 1568）算出。
      // 任何参数调整或算法偏移都会让该值改变——这正是"与参考对齐"的守约点。
      // 约束校验：max(1456,819)=1456≤1568 ✓；tokens=⌈1456/28⌉×⌈819/28⌉=52×30=1560≤1568 ✓。
      const result = targetImageSize(1920, 1080, P)
      expect(result).toEqual([1456, 819])
      assertWithinConstraints(result)
    })

    it('16:10 → 1920×1200：token 约束驱动', () => {
      const result = targetImageSize(1920, 1200, P)
      // tokens = ⌈1389/28⌉ × ⌈868/28⌉ = 50 × 31 = 1550 ≤ 1568 ✓
      expect(result).toEqual([1389, 868])
      assertWithinConstraints(result)
    })

    it('4:3 → 1600×1200：长边和 token 同时约束', () => {
      const result = targetImageSize(1600, 1200, P)
      // tokens = ⌈1269/28⌉ × ⌈952/28⌉ = 46 × 34 = 1564 ≤ 1568 ✓
      expect(result).toEqual([1269, 952])
      assertWithinConstraints(result)
    })

    it('3:2 → 2880×1920：MBP Retina 物理尺寸', () => {
      const result = targetImageSize(2880, 1920, P)
      // tokens = ⌈1344/28⌉ × ⌈896/28⌉ = 48 × 32 = 1536 ≤ 1568 ✓
      expect(result).toEqual([1344, 896])
      assertWithinConstraints(result)
    })

    it('MBP 16" 1.538:1 → 1568×1014：规范原文给的 edge case', () => {
      // 规范 § 4.5.1 "解决什么问题"段原文引用：1568×1014 在 28 px/token 下
      // 是 56×37 = 2072 tokens，超 1568 预算——若客户端不缩，云端会再缩一次，
      // 导致 toScreenCoords 反算坐标偏移 ~14%。本算法把客户端就缩到云端早退出
      // 路径；输出用 reference 实际计算值快照。
      const result = targetImageSize(1568, 1014, P)
      assertWithinConstraints(result)
      // 输入本身就超 token 预算 → 必然缩小
      expect(result[0]).toBeLessThan(1568)
      expect(result[1]).toBeLessThan(1014)
      // ratio 要保持约 1.546（原 1568/1014 = 1.5463）——允许 ±1 个像素的整数舍入误差
      const ratioOut = result[0] / result[1]
      expect(Math.abs(ratioOut - 1568 / 1014)).toBeLessThan(0.01)
    })
  })

  describe('双约束独立验证（任意输入都要满足）', () => {
    it('任意 AR × 任意大尺寸 → 输出都满足两条约束', () => {
      const cases: Array<[number, number]> = [
        [3840, 2160],   // 4K
        [7680, 4320],   // 8K
        [3440, 1440],   // 超宽 21:9
        [5120, 2880],   // iMac 5K
        [2560, 1600],   // MBP 13"
        [1280, 800],    // baseline
      ]
      for (const [w, h] of cases) {
        assertWithinConstraints(targetImageSize(w, h, P))
      }
    })

    it('竖屏输入：转置后满足约束，长边仍 ≤ maxTargetPx', () => {
      const result = targetImageSize(1080, 1920, P)
      assertWithinConstraints(result)
      // 竖屏 ratio 与横屏对称——宽高换位后应与 1920×1080 结果换位一致
      const landscape = targetImageSize(1920, 1080, P)
      expect(result).toEqual([landscape[1], landscape[0]])
    })
  })

  describe('No-op（无需缩放）', () => {
    it('小输入且 token 充裕 → 原样返回', () => {
      expect(targetImageSize(800, 600, P)).toEqual([800, 600])
      expect(targetImageSize(100, 100, P)).toEqual([100, 100])
    })

    it('恰好等于 maxTargetPx 的长边 → 原样返回（边界）', () => {
      // 1568×1568 的 token 数 = 56 × 56 = 3136 > 1568 预算，会缩。
      // 但 1568×784（≈ 2:1）tokens = 56 × 28 = 1568，恰好等于预算 → 原样返回。
      expect(targetImageSize(1568, 784, P)).toEqual([1568, 784])
    })
  })

  describe('极端输入边界', () => {
    it('正方形 1×1 → 原样返回', () => {
      expect(targetImageSize(1, 1, P)).toEqual([1, 1])
    })

    it('极窄 4000×10 → 不崩，结果合理', () => {
      const result = targetImageSize(4000, 10, P)
      assertWithinConstraints(result)
      // 极窄比例下 h 会被 Math.max(..., 1) 兜底
      expect(result[1]).toBeGreaterThanOrEqual(1)
    })

    it('8K 7680×4320 → 收敛到双约束内', () => {
      const result = targetImageSize(7680, 4320, P)
      assertWithinConstraints(result)
    })
  })

  describe('非法输入显式抛错（defense in depth）', () => {
    it('width = 0 → throw', () => {
      expect(() => targetImageSize(0, 100, P)).toThrow()
    })

    it('height = 0 → throw', () => {
      expect(() => targetImageSize(100, 0, P)).toThrow()
    })

    it('NaN 输入 → throw', () => {
      expect(() => targetImageSize(NaN, 100, P)).toThrow()
      expect(() => targetImageSize(100, NaN, P)).toThrow()
    })

    it('Infinity 输入 → throw', () => {
      expect(() => targetImageSize(Infinity, 100, P)).toThrow()
    })

    it('负数输入 → throw', () => {
      expect(() => targetImageSize(-1920, 1080, P)).toThrow()
    })
  })

  describe('自定义参数（未来云端改 token 预算也能跟随）', () => {
    it('pxPerToken = 14 缩一半 → token 上限等价翻 4 倍', () => {
      const params: ImageResizeParams = {
        pxPerToken: 14,
        maxTargetPx: 1568,
        maxTargetTokens: 1568,
      }
      const result = targetImageSize(1920, 1080, params)
      assertWithinConstraints(result, params)
    })

    it('maxTargetPx = 800 收紧长边 → 结果长边 ≤ 800', () => {
      const params: ImageResizeParams = {
        pxPerToken: 28,
        maxTargetPx: 800,
        maxTargetTokens: 1568,
      }
      const result = targetImageSize(1920, 1080, params)
      expect(Math.max(...result)).toBeLessThanOrEqual(800)
      assertWithinConstraints(result, params)
    })
  })

  describe('nTokensForPx 辅助函数（守约）', () => {
    it('边界：1 px 占 1 token', () => {
      expect(nTokensForPx(1, 28)).toBe(1)
      expect(nTokensForPx(28, 28)).toBe(1)
      expect(nTokensForPx(29, 28)).toBe(2)
    })

    it('整数倍：56 px 恰好 2 token', () => {
      expect(nTokensForPx(56, 28)).toBe(2)
    })

    it('0 或负输入 → 0', () => {
      expect(nTokensForPx(0, 28)).toBe(0)
      expect(nTokensForPx(-5, 28)).toBe(0)
    })

    it('pxPerToken ≤ 0 → throw（非法常量保护）', () => {
      expect(() => nTokensForPx(100, 0)).toThrow()
      expect(() => nTokensForPx(100, -1)).toThrow()
    })
  })

  describe('默认参数不变（不要无意中改云端对齐常量）', () => {
    it('DEFAULT_IMAGE_RESIZE_PARAMS 与规范 § 4.5.1 一致', () => {
      expect(DEFAULT_IMAGE_RESIZE_PARAMS).toEqual({
        pxPerToken: 28,
        maxTargetPx: 1568,
        maxTargetTokens: 1568,
      })
    })
  })
})
