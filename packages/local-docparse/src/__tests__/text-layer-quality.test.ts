/**
 * @tabtin/local-docparse — text-layer-quality 纯函数单测
 *
 * 与 Electron `apps/tabtin-electron/src/main/services/__tests__/localDocParse.test.ts`
 * 的 `computeTextLayerQuality` 用例集合等价（H1-D-MAIN 时建立的金标准）。
 * 这里在共享包内**最小化保留**核心断言：覆盖中/英/俄/阿/希腊 + 三种异常
 * 检测维度。保证共享包可独立跑测，不依赖 Electron 仓位。
 */

import { describe, it, expect } from 'vitest'
import { computeTextLayerQuality } from '../text-layer-quality.js'

describe('computeTextLayerQuality (shared package)', () => {
  it('正常英文文本得分 1.0', () => {
    expect(
      computeTextLayerQuality('The quick brown fox jumps over the lazy dog. Pack my box.'),
    ).toBe(1.0)
  })

  it('正常中文文本得分 1.0', () => {
    expect(
      computeTextLayerQuality(
        '本协议由甲乙双方于本日订立，就本地 PDF 解析主路径事宜达成如下共识。',
      ),
    ).toBe(1.0)
  })

  it('正常俄语文本得分 1.0（Unicode \\p{L} 修复）', () => {
    expect(
      computeTextLayerQuality(
        'Быстрая коричневая лиса прыгает через ленивую собаку.',
      ),
    ).toBe(1.0)
  })

  it('正常阿拉伯语文本得分 1.0', () => {
    expect(
      computeTextLayerQuality(
        'هذه وثيقة اختبار للتحقق من دعم النصوص العربية في مسار التحليل المحلي للمستندات.',
      ),
    ).toBe(1.0)
  })

  it('希腊字母文本得分 1.0', () => {
    expect(
      computeTextLayerQuality(
        'αβγδεζηθικλμνξοπρστυφχψω αβγδεζηθικλμνξοπρστυφχψω αβγδεζ',
      ),
    ).toBe(1.0)
  })

  it('空文本返回 0', () => {
    expect(computeTextLayerQuality('')).toBe(0)
  })

  it('极短文本（< 20 字符）返回 0', () => {
    expect(computeTextLayerQuality('hello')).toBe(0)
  })

  it('乱码控制字符 > 10% 返回 0', () => {
    const text = 'abcdefghijklmnopqrst\x01\x02\x03\x04\x05'
    expect(computeTextLayerQuality(text)).toBe(0)
  })

  it('单字符重复 > 40% 返回 0', () => {
    const text = 'a'.repeat(45) + 'bcdefghij'
    expect(computeTextLayerQuality(text)).toBe(0)
  })

  it('纯符号无字母数字返回 0', () => {
    const text = '∂∆∑∏√∞≠≈≤≥' + '¡¢£¤¥¦§¨©ª«¬®¯' + '±×÷°…‽﹡﹢﹣﹤﹥'
    expect(computeTextLayerQuality(text)).toBe(0)
  })

  it('大量重复 OCR 文本层返回 0', () => {
    const paragraph =
      'Anthropic teams use Claude Code to automate repetitive work and improve development workflows.'
    expect(computeTextLayerQuality(`${paragraph}\n${paragraph}\n${paragraph}`)).toBe(0)
  })

  it('超长无空格字母串返回 0', () => {
    expect(computeTextLayerQuality('aVeryLongBrokenPdfTextLayer'.repeat(8))).toBe(0)
  })
})
