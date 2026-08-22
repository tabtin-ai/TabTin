/**
 * h1-d-main-golden-set — G1-G7 验收门槛数据采集脚本
 *
 * 对 POC 已有 fixture 逐个跑 localDocParse 产品路径（含质量得分 + 错误分类），
 * 输出每个样本的：
 *   - success / errorClass / fallbackToCloud（决策正确性）
 *   - 字符数 / 页数 / 质量得分（G1 正确性）
 *   - parse_duration_ms / first_page_duration_ms（G6 性能）
 *   - 与 POC 原始数据的对比（检测是否引入回归）
 *
 * 执行：
 *   cd apps/tabtin-electron
 *   pnpm exec tsx src/main/scripts/h1-d-main-golden-set.ts
 *
 * 数据写入到 `src/main/scripts/reports/H1-D-MAIN-golden-set-<timestamp>.json`
 * 供 H1-D-MAIN 汇报引用（附在 G1-G7 证据表）。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  handleParsePdf,
} from '../workers/doc-parser-handlers'
import { computeTextLayerQuality } from '../services/text-layer-quality'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, '../../../fixtures/poc-pdfs')
const OUT_DIR = resolve(__dirname, 'reports')

interface SampleRun {
  file: string
  pages?: number
  chars?: number
  charsPerPage?: number
  isScanned?: boolean
  qualityScore?: number
  coldMs?: number
  warmMedianMs?: number
  warmP95Ms?: number
  decision:
    | { success: true }
    | { success: false; errorClass: string; fallbackToCloud: boolean }
  expected: {
    success: boolean
    errorClass?: string
    fallbackToCloud?: boolean
  }
  notes?: string
}

const SAMPLES: Array<{
  file: string
  expected: SampleRun['expected']
  notes?: string
}> = [
  { file: 'text-only.pdf', expected: { success: true }, notes: 'G1: 正常 10 页纯文本' },
  { file: 'text-only-100p.pdf', expected: { success: true }, notes: 'G6: 100 页性能基线' },
  { file: 'text-only-500p.pdf', expected: { success: true }, notes: 'G6: 500 页压力' },
  { file: 'mixed.pdf', expected: { success: true }, notes: 'G1: 文本+图像混合（chars/page=487.8 > 100）' },
  {
    file: 'mostly-scanned.pdf',
    // W1：errorClass 字面值与 `@tabtin/file-pipeline-errors` SSoT 对齐
    expected: { success: false, errorClass: 'scanned_pdf', fallbackToCloud: true },
    notes: 'G1+G2: 9 图 + 1 文，应被判扫描件切云端',
  },
  {
    file: 'scanned-fake.pdf',
    expected: { success: false, errorClass: 'scanned_pdf', fallbackToCloud: true },
    notes: 'G2: 无文本层扫描件',
  },
  {
    file: 'encrypted.pdf',
    expected: { success: false, errorClass: 'encrypted', fallbackToCloud: false },
    notes: 'G3: 加密 PDF 不切云端，给用户明确提示',
  },
  {
    file: 'corrupted.pdf',
    expected: { success: false, errorClass: 'corrupted', fallbackToCloud: false },
    notes: 'G3: 损坏 PDF 不切云端',
  },
]

const BENCH_WARM_ITERATIONS = 5

async function runOne(sample: (typeof SAMPLES)[number]): Promise<SampleRun> {
  const path = resolve(FIXTURES, sample.file)
  const out: SampleRun = {
    file: sample.file,
    decision: { success: true }, // placeholder，下面会覆写
    expected: sample.expected,
    notes: sample.notes,
  }

  // 尝试一次真实解析（含 parse + classify）—— 复用产品路径
  // 但 parseLocalAttachment 的 mock worker 是单测路径；这里直连 handlers + classify
  try {
    const t0 = performance.now()
    const r = await handleParsePdf({
      filePath: path,
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    })
    const coldMs = Math.round(performance.now() - t0)

    out.pages = r.pages
    out.chars = r.charCount
    out.charsPerPage = r.charsPerPageAvg
    out.isScanned = r.isScanned
    out.qualityScore = Math.round(computeTextLayerQuality(r.text) * 100) / 100
    out.coldMs = coldMs

    // 分类决策（复制 localDocParse 逻辑，以便独立跑不 import 整个链路）。
    // W1：errorClass 字面值与 `@tabtin/file-pipeline-errors` SSoT 对齐。
    if (r.isScanned) {
      out.decision = { success: false, errorClass: 'scanned_pdf', fallbackToCloud: true }
    } else if ((out.qualityScore ?? 1) < 0.3) {
      out.decision = { success: false, errorClass: 'garbled_text_layer', fallbackToCloud: true }
    } else {
      out.decision = { success: true }
    }

    // warm bench
    if (sample.expected.success) {
      const warmMs: number[] = []
      for (let i = 0; i < BENCH_WARM_ITERATIONS; i++) {
        const wt = performance.now()
        await handleParsePdf({
          filePath: path,
          maxPages: 2000,
          scannedThresholdCharsPerPage: 100,
        })
        warmMs.push(performance.now() - wt)
      }
      const sorted = [...warmMs].sort((a, b) => a - b)
      out.warmMedianMs = Math.round(sorted[Math.floor(sorted.length / 2)])
      out.warmP95Ms = Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))])
    }
  } catch (err) {
    const name = (err as Error)?.name ?? ''
    const message = (err as Error)?.message ?? String(err)
    const nameL = name.toLowerCase()
    const msgL = message.toLowerCase()
    // W1：errorClass 字面值与 `@tabtin/file-pipeline-errors` SSoT 对齐。
    let errorClass: string = 'upstream_error'
    let fallback = true
    if (nameL.includes('password') || msgL.includes('password')) {
      errorClass = 'encrypted'
      fallback = false
    } else if (nameL.includes('invalidpdf') || msgL.includes('invalid pdf') || msgL.includes('not a valid') || msgL.includes('corrupt')) {
      errorClass = 'corrupted'
      fallback = false
    } else if (msgL.includes('enoent')) {
      errorClass = 'file_not_found'
    }
    out.decision = { success: false, errorClass, fallbackToCloud: fallback }
    out.notes = (out.notes ? out.notes + ' · ' : '') + `raw: ${name || 'Error'}: ${message.slice(0, 80)}`
  }

  return out
}

function checkMatch(run: SampleRun): boolean {
  if (run.decision.success !== run.expected.success) return false
  if (!run.decision.success && !run.expected.success) {
    if (run.expected.errorClass && run.decision.errorClass !== run.expected.errorClass) return false
    if (
      run.expected.fallbackToCloud !== undefined
      && run.decision.fallbackToCloud !== run.expected.fallbackToCloud
    ) return false
  }
  return true
}

async function main(): Promise<void> {
  console.log(`━━━ H1-D-MAIN Golden Set (${SAMPLES.length} samples) ━━━\n`)

  // 预热：先跑一次 text-only（消耗冷启动）
  await handleParsePdf({
    filePath: resolve(FIXTURES, 'text-only.pdf'),
    maxPages: 2000,
    scannedThresholdCharsPerPage: 100,
  })

  const runs: SampleRun[] = []
  for (const s of SAMPLES) {
    const run = await runOne(s)
    runs.push(run)
    const ok = checkMatch(run) ? '✓' : '✗'
    const decisionStr = run.decision.success
      ? 'success'
      : `${run.decision.errorClass} (fallback=${run.decision.fallbackToCloud})`
    const perfStr = run.warmMedianMs != null
      ? `  warm_p50=${run.warmMedianMs}ms p95=${run.warmP95Ms}ms`
      : ''
    console.log(
      `[${ok}] ${run.file.padEnd(26)} | pages=${String(run.pages ?? '-').padStart(3)} | `
      + `chars/pg=${String(run.charsPerPage ?? '-').padStart(7)} | `
      + `quality=${run.qualityScore ?? '-'} | ${decisionStr}${perfStr}`,
    )
  }

  const pass = runs.filter(checkMatch).length
  console.log(`\n━━━ Decision match: ${pass}/${runs.length} ━━━\n`)

  // G1 摘要：期望 success 的样本里 chars/page 统计
  const successSamples = runs.filter((r) => r.decision.success)
  const charsPerPageVals = successSamples.map((r) => r.charsPerPage ?? 0)
  console.log('G1 decision correctness:', pass === runs.length ? 'PASS ✓' : 'FAIL ✗')
  console.log('G2 garbled detection: pure function (see unit tests) + Django 对齐实现')
  console.log('G3 encrypted/corrupted no-fallback:',
    runs.filter(r => ['encrypted', 'corrupted'].includes(
      !r.decision.success ? r.decision.errorClass : '',
    )).every(r => !r.decision.success && !r.decision.fallbackToCloud) ? 'PASS ✓' : 'FAIL ✗',
  )
  const warmVals = runs.map(r => r.warmMedianMs).filter((x): x is number => typeof x === 'number')
  console.log(`G6 performance (real M1 Pro): warm_median across success samples: ${warmVals.join('ms, ')}ms`)

  // 写 JSON 报告
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = resolve(OUT_DIR, `H1-D-MAIN-golden-set-${timestamp}.json`)
  writeFileSync(
    outPath,
    JSON.stringify({
      timestamp,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sample_count: runs.length,
      decisions_correct: pass,
      charPerPage_stats: {
        success_samples: successSamples.map((r) => ({
          file: basename(r.file),
          chars_per_page: r.charsPerPage,
          quality_score: r.qualityScore,
        })),
        min: charsPerPageVals.length > 0 ? Math.min(...charsPerPageVals) : null,
        max: charsPerPageVals.length > 0 ? Math.max(...charsPerPageVals) : null,
      },
      runs,
    }, null, 2),
  )
  console.log(`\n已写入 ${outPath}`)
}

void main()
