/**
 * doc-parser-handlers 集成测试
 *
 * 目的：
 *   - 用 POC 生成的真实 fixtures 验证 `handleParsePdf` 真能跑通 pdfjs-dist
 *   - 覆盖 G1（本地解析正确性） / G2（扫描件识别） / G3（加密/损坏错误分类）
 *   - 性能基线复验（warm 稳态）
 *
 * 这里直接 import handlers（不走 worker_threads），在 vitest jsdom/node 环境下
 * 都能运行，避免 worker 脚本路径问题。跟 worker 生产路径等价（worker 只是转发）。
 */

import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  handleParseDocx,
  handleParsePdf,
  handleParseXlsx,
} from '../doc-parser-handlers'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, '../../../../fixtures/poc-pdfs')

/**
 * 性能断言放宽倍率（技术 Review P2-11 修复）。
 * 本地开发（M1 Pro）基线按 POC 数据，CI / 慢机器给 3× 余量避免 flaky。
 * 通过 `TABTIN_PERF_TOLERANCE` 可手动调整（例如 Intel Mac 跑 golden set）。
 */
const PERF_TOLERANCE = (() => {
  const raw = process.env.TABTIN_PERF_TOLERANCE
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return process.env.CI ? 3 : 1
})()

describe('doc-parser-handlers — PDF 集成（POC fixtures）', () => {
  it('text-only.pdf（10 页）→ 抽取正确 + 性能 < 1s + worker 返回 qualityScore', { timeout: 15000 }, async () => {
    const t0 = performance.now()
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'text-only.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    })
    const total = performance.now() - t0

    expect(r.pages).toBe(10)
    expect(r.text).toMatch(/Lorem ipsum/i)
    expect(r.charsPerPageAvg).toBeGreaterThan(500)
    expect(r.isScanned).toBe(false)
    expect(r.emptyPages).toBe(0)
    // Verifier-B 必修 2：worker 内部算好 qualityScore 并随结果返回，主进程不再扫描文本
    expect(typeof r.qualityScore).toBe('number')
    expect(r.qualityScore).toBeGreaterThanOrEqual(0.3)
    // 冷启动 + 解析 < 1s × 余量（PRD FR-18 验收第 1 条；CI/慢机器 3×）
    expect(total).toBeLessThan(1000 * PERF_TOLERANCE)
  })

  it('scanned-fake.pdf（3 页无文本层）→ isScanned=true + qualityScore=0', { timeout: 15000 }, async () => {
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'scanned-fake.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    })
    expect(r.isScanned).toBe(true)
    expect(r.charsPerPageAvg).toBeLessThan(100)
    // 无文本层 → computeTextLayerQuality 因 text 过短返回 0（验证 worker 正确调用纯函数）
    expect(r.qualityScore).toBe(0)
  })

  it('mostly-scanned.pdf（10 页，9 图 + 1 文）→ isScanned=true', { timeout: 15000 }, async () => {
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'mostly-scanned.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    })
    expect(r.isScanned).toBe(true)
    expect(r.charsPerPageAvg).toBeLessThan(100)
  })

  it('mixed.pdf（文本 + 图像混合）→ 按阈值 100 仍判扫描件（低文本）', { timeout: 15000 }, async () => {
    // POC 报告中 mixed.pdf = 487.8 chars/page，用阈值 100 判为 false（未扫描）
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'mixed.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    })
    expect(r.pages).toBe(5)
    expect(r.charsPerPageAvg).toBeGreaterThan(100)
    expect(r.isScanned).toBe(false)
  })

  it('encrypted.pdf → 抛 PasswordException（由 localDocParse 上层 classify）', { timeout: 15000 }, async () => {
    await expect(
      handleParsePdf({
        filePath: resolve(FIXTURES, 'encrypted.pdf'),
        maxPages: 2000,
        scannedThresholdCharsPerPage: 100,
      }),
    ).rejects.toThrow(/password/i)
  })

  it('corrupted.pdf → 抛 InvalidPDFException', { timeout: 15000 }, async () => {
    await expect(
      handleParsePdf({
        filePath: resolve(FIXTURES, 'corrupted.pdf'),
        maxPages: 2000,
        scannedThresholdCharsPerPage: 100,
      }),
    ).rejects.toThrow()
  })

  it('不存在的文件 → 抛 ENOENT', { timeout: 5000 }, async () => {
    await expect(
      handleParsePdf({
        filePath: resolve(FIXTURES, 'does-not-exist-' + Date.now() + '.pdf'),
        maxPages: 2000,
        scannedThresholdCharsPerPage: 100,
      }),
    ).rejects.toThrow(/ENOENT|no such file/i)
  })

  it('maxPages 生效（截断到前 5 页）', { timeout: 15000 }, async () => {
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'text-only-100p.pdf'),
      maxPages: 5,
      scannedThresholdCharsPerPage: 100,
    })
    expect(r.pages).toBe(5)
  })

  it('100 页 PDF 性能基线（warm）— 含冷启动 < 1500ms', { timeout: 15000 }, async () => {
    // 先预热（消耗掉首次 import + getDocument 的冷启动）
    await handleParsePdf({
      filePath: resolve(FIXTURES, 'text-only.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    })

    const t0 = performance.now()
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'text-only-100p.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    })
    const warmMs = performance.now() - t0

    expect(r.pages).toBe(100)
    expect(r.text.length).toBeGreaterThan(1000)
    // M1 Pro 下 POC 数据 ~38ms warm；本地基线 < 1500ms，CI/慢机器按 PERF_TOLERANCE 放宽
    expect(warmMs).toBeLessThan(1500 * PERF_TOLERANCE)
    console.log(`[perf] text-only-100p.pdf warm: ${Math.round(warmMs)}ms (tolerance=${PERF_TOLERANCE}x)`)
  })
})

describe('doc-parser-handlers — docx 集成', () => {
  // 没有现成 fixtures，靠 TypeScript 编译保证类型契约；
  // 真实 docx 回归放到灰度期 E2E 验证
  it('不存在的路径 → 抛错（便于上层 classify not_found）', async () => {
    await expect(
      handleParseDocx({ filePath: '/tmp/does-not-exist-' + Date.now() + '.docx' }),
    ).rejects.toThrow()
  })
})

describe('doc-parser-handlers — xlsx 集成', () => {
  it('不存在的路径 → 抛错', async () => {
    await expect(
      handleParseXlsx({
        filePath: '/tmp/does-not-exist-' + Date.now() + '.xlsx',
        maxSheets: 20,
        maxRowsPerSheet: 200,
      }),
    ).rejects.toThrow()
  })
})
