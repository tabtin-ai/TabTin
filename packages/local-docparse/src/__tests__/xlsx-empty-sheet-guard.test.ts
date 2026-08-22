/**
 *  顺带修回归 —— 空 sheet 守卫。
 *
 * SheetJS `sheet_to_json(ws, { header: 1, ... })` 对空 sheet 可能返回 `[[]]`
 * （1 行 0 列）而非 `[]`；renderSheetAsMarkdown 原本只查 `length === 0`，
 * 漏掉该情况 → 渲染出 `| |\n||` 退化 1×1 空表。修复后补查"所有行都是空行"，
 * 空 sheet 一律渲染「（该工作表为空）」。
 *
 * fixture 用 SheetJS 现场生成（本分支从 release 签出，无 harness 分支的
 * poc-xlsx fixture），写 tmp 后经 handleParseXlsx 全链路验证。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleParseXlsx } from '../workers/handlers.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tabtin-2545-'))
  const xlsxMod = await import('xlsx')
  const xlsx = (xlsxMod as unknown as { default?: typeof xlsxMod }).default ?? xlsxMod

  // book1: 有数据 sheet + 完全空 sheet
  const wb = xlsx.utils.book_new()
  const wsData = xlsx.utils.aoa_to_sheet([
    ['h1', 'h2', 'h3'],
    ['v1', 'v2', 'v3'],
  ])
  xlsx.utils.book_append_sheet(wb, wsData, 'HasData')
  const wsEmpty = xlsx.utils.aoa_to_sheet([])
  xlsx.utils.book_append_sheet(wb, wsEmpty, 'EmptySheet')
  xlsx.writeFile(wb, join(dir, 'with_empty_sheet.xlsx'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('#2545 空 sheet 守卫 — renderSheetAsMarkdown', () => {
  it('空 sheet 渲染「（该工作表为空）」而非退化 1×1 空表', async () => {
    const r = await handleParseXlsx({
      filePath: join(dir, 'with_empty_sheet.xlsx'),
      maxSheets: 20,
      maxRowsPerSheet: 200,
    })
    expect(r.sheetCount).toBe(2)
    expect(r.text).toContain('## HasData')
    expect(r.text).toContain('| h1 | h2 | h3 |')
    expect(r.text).toContain('## EmptySheet')
    expect(r.text).toContain('（该工作表为空）')
    // 修复前：EmptySheet 段渲染出 `|  |` 退化空表行
    const emptySection = r.text.slice(r.text.indexOf('## EmptySheet'))
    expect(emptySection).not.toMatch(/^\|/m)
  })

  it('有数据 sheet 维度不受守卫影响（2 行 3 列）', async () => {
    const r = await handleParseXlsx({
      filePath: join(dir, 'with_empty_sheet.xlsx'),
      maxSheets: 20,
      maxRowsPerSheet: 200,
    })
    const dataSection = r.text.slice(r.text.indexOf('## HasData'), r.text.indexOf('## EmptySheet'))
    const tableLines = dataSection.split('\n').filter((l) => l.startsWith('|'))
    // header + separator + 1 数据行 = 3
    expect(tableLines).toHaveLength(3)
    expect(tableLines[0].split('|').length - 2).toBe(3)
  })
})
