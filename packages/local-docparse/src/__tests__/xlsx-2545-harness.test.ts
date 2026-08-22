/**
 *  acceptance harness —— 本地 xlsx 解析路径 (SheetJS / xlsx 0.18.5)。
 *
 * 用真实 .xlsx fixture 跑 handleParseXlsx，解析返回的 markdown 表格提取行列维度，
 * 与云端 openpyxl 路径 (tests_2545_harness.py) 对比，定位"偶现 1×1"根因。
 *
 * 放在 packages/local-docparse/src/__tests__/ 下，被 `pnpm --filter @tabtin/local-docparse test`
 * 发现。fixture 跨包引用 apps/tabtin-electron/fixtures/poc-xlsx/（沿用 daemon 测试的
 * 跨包 fixture 约定）。
 *
 * 结果 JSON 写到 apps/tabtin-electron/fixtures/poc-xlsx/_harness-results/local.json
 * （_harness-results/ 已 gitignore）。
 *
 * 复跑：pnpm --filter @tabtin/local-docparse test xlsx-2545
 */
import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { handleParseXlsx } from '../workers/handlers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// packages/local-docparse/src/__tests__ -> apps/tabtin-electron/fixtures/poc-xlsx
const FIXTURES = resolve(__dirname, '..', '..', '..', '..', 'apps', 'tabtin-electron', 'fixtures', 'poc-xlsx')
const RESULTS_DIR = resolve(FIXTURES, '_harness-results')
const RESULTS_JSON = resolve(RESULTS_DIR, 'local.json')

interface SheetDims {
  sheetName: string
  rows: number
  cols: number
  empty: boolean
  preview: string
}

/**
 * 从 handleParseXlsx 返回的 markdown text 里解析每个 sheet 的行列维度。
 *
 * 形态：
 *   ## SheetName\n\n| h1 | h2 |\n| --- | --- |\n| v1 | v2 |\n
 * 空 sheet：
 *   ## SheetName\n\n（该工作表为空）
 *
 * rows = `|` 开头行数 - 1（separator）；cols = header 里 `|` 分段数 - 2（首尾 `|`）。
 */
function parseMarkdownDims(text: string): SheetDims[] {
  const sections = text.split(/^## /m).filter((s) => s.trim().length > 0)
  return sections.map((sec) => {
    const lines = sec.split('\n')
    const sheetName = lines[0].trim()
    const tableLines = lines.filter((l) => l.startsWith('|'))
    if (tableLines.length === 0) {
      return { sheetName, rows: 0, cols: 0, empty: true, preview: sec.slice(0, 80) }
    }
    const header = tableLines[0]
    const cols = header.split('|').length - 2
    const rows = tableLines.length - 1 // 减 separator
    return {
      sheetName,
      rows: Math.max(rows, 0),
      cols: Math.max(cols, 0),
      empty: false,
      preview: tableLines.slice(0, 2).join(' / ').slice(0, 120),
    }
  })
}

const FIXTURES_TO_RUN = [
  'normal_3x4.xlsx',
  'inf_nan.xlsx',
  'empty_sheet.xlsx',
  'merged_cell.xlsx',
  'wrong_dimension.xlsx',
  'missing_dimension.xlsx',
  'formula_no_cache.xlsx',
] as const

describe('#2545 xlsx parse harness — local SheetJS path', () => {
  const results: Record<string, unknown> = {}

  it('captures all fixture dims and writes local.json', async () => {
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true })
    for (const name of FIXTURES_TO_RUN) {
      const filePath = resolve(FIXTURES, name)
      expect(existsSync(filePath), `fixture 缺失: ${filePath}`).toBe(true)
      const r = await handleParseXlsx({ filePath, maxSheets: 20, maxRowsPerSheet: 200 })
      const sheets = parseMarkdownDims(r.text)
      results[name] = {
        sheetCount: r.sheetCount,
        cellCount: r.cellCount,
        fileSizeBytes: r.fileSizeBytes,
        sheets,
      }
      // eslint-disable-next-line no-console
      console.log(`[local] ${name}: sheets=${sheets.length} dims=${JSON.stringify(sheets.map((s) => [s.rows, s.cols]))}`)
    }
    writeFileSync(RESULTS_JSON, JSON.stringify(results, null, 2))
    expect(existsSync(RESULTS_JSON)).toBe(true)
  })

  it('normal_3x4.xlsx → 3×4（基线）', async () => {
    const r = await handleParseXlsx({ filePath: resolve(FIXTURES, 'normal_3x4.xlsx'), maxSheets: 20, maxRowsPerSheet: 200 })
    const sheets = parseMarkdownDims(r.text)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows).toBe(3)
    expect(sheets[0].cols).toBe(4)
  })

it('wrong_dimension.xlsx → SheetJS 不受 <dimension ref=A1/> 影响，读全 3×4', async () => {
    // 与云端 openpyxl read_only 形成分叉：openpyxl 信任 <dimension> 截断成 1×1，
    // SheetJS 扫实际单元格 → 3×4。这是  的根因复现点。
    const r = await handleParseXlsx({ filePath: resolve(FIXTURES, 'wrong_dimension.xlsx'), maxSheets: 20, maxRowsPerSheet: 200 })
    const sheets = parseMarkdownDims(r.text)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows).toBe(3)
    expect(sheets[0].cols).toBe(4)
  })

  it('inf_nan.xlsx → 维度保留 3×4', async () => {
    const r = await handleParseXlsx({ filePath: resolve(FIXTURES, 'inf_nan.xlsx'), maxSheets: 20, maxRowsPerSheet: 200 })
    const sheets = parseMarkdownDims(r.text)
    expect(sheets[0].rows).toBe(3)
    expect(sheets[0].cols).toBe(4)
  })

  it('empty_sheet.xlsx → 两个 sheet 段；空 sheet 被渲染成退化空表（非用户数据丢失）', async () => {
    const r = await handleParseXlsx({ filePath: resolve(FIXTURES, 'empty_sheet.xlsx'), maxSheets: 20, maxRowsPerSheet: 200 })
    const sheets = parseMarkdownDims(r.text)
    expect(r.sheetCount).toBe(2)
    expect(sheets).toHaveLength(2)
    expect(sheets[0].rows).toBe(3) // HasData
    // 空 sheet：SheetJS sheet_to_json 返回 [[]]（1 行 0 列），renderSheetAsMarkdown
    // 的"空"守卫只看 limited.length===0，于是渲染成 `| |\n||` 退化 1×1 空表。
    // 这是本地路径对"空 sheet"的渲染怪癖，cellCount=0，不是用户数据丢失。
    expect(sheets[1].rows).toBeLessThanOrEqual(1)
    expect(sheets[1].cols).toBeLessThanOrEqual(1)
  })

  it('missing_dimension.xlsx → 记录行为', async () => {
    const r = await handleParseXlsx({ filePath: resolve(FIXTURES, 'missing_dimension.xlsx'), maxSheets: 20, maxRowsPerSheet: 200 })
    const sheets = parseMarkdownDims(r.text)
    expect(sheets.length).toBeGreaterThanOrEqual(1)
    // eslint-disable-next-line no-console
    console.log(`[local][missing_dimension] rows=${sheets[0].rows} cols=${sheets[0].cols}`)
  })

  it('formula_no_cache.xlsx → 不抛错', async () => {
    const r = await handleParseXlsx({ filePath: resolve(FIXTURES, 'formula_no_cache.xlsx'), maxSheets: 20, maxRowsPerSheet: 200 })
    expect(typeof r.text).toBe('string')
  })
})
