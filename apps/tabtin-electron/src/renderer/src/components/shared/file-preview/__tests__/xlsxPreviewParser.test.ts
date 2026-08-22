import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import {
  XLSX_PREVIEW_MAX_RENDER_ROWS,
  isOldXlsxFormatError,
  parseXlsxPreview,
} from '../xlsxPreviewParser'

async function createWorkbookWithoutFormulaCaches(formulas: Record<string, string>, range: string): Promise<ArrayBuffer> {
  const worksheet: XLSX.WorkSheet = { '!ref': range }
  for (const [reference, formula] of Object.entries(formulas)) {
    worksheet[reference] = { t: 'n', f: formula.replace(/^=/, '') }
  }
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }))
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
  zip.file('xl/worksheets/sheet1.xml', sheetXml.replace(/<v[^>]*>[\s\S]*?<\/v>/g, '<v></v>'))
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('xlsxPreviewParser', () => {
  it('throws a catchable error for corrupted xlsx payloads', () => {
    const corrupted = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer

    expect(() => parseXlsxPreview(corrupted)).toThrow()
  })

  it('exposes bounded preview constants used by the renderer', () => {
    expect(XLSX_PREVIEW_MAX_RENDER_ROWS).toBe(500)
  })

  it('classifies old Excel parser errors for user-friendly fallback text', () => {
    expect(isOldXlsxFormatError(new Error('Unsupported file CFB OLE'))).toBe(true)
    expect(isOldXlsxFormatError(new Error('unexpected zip error'))).toBe(false)
  })

  it('calculates supported formulas that were saved without a cached value', () => {
    const filePath = resolve(import.meta.dirname, '../../../../../../../fixtures/poc-xlsx/formula_no_cache.xlsx')
    const bytes = readFileSync(filePath)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

    const result = parseXlsxPreview(buffer)

    expect(result.sheets[0].cells[3]).toEqual(['0', '0', '0', '0'])
    expect(result.formulaCalculation).toEqual({ cached: 0, calculated: 4, unavailable: 0 })
  })

  it('stops calculating after the global formula budget is exhausted', async () => {
    const formulas = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [`A${index + 1}`, '=1']),
    )
    const result = parseXlsxPreview(await createWorkbookWithoutFormulaCaches(formulas, 'A1:A1001'))

    expect(result.formulaCalculation).toEqual({ cached: 0, calculated: 1_000, unavailable: 1 })
  })

  it('fails a dependency chain that exceeds the calculation depth budget', async () => {
    const formulas = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `A${index + 1}`,
        index === 64 ? '=1' : `=A${index + 2}+1`,
      ]),
    )
    const result = parseXlsxPreview(await createWorkbookWithoutFormulaCaches(formulas, 'A1:A65'))

    expect(result.formulaCalculation).toEqual({ cached: 0, calculated: 0, unavailable: 65 })
  })

  it('fails circular formula references without recursively retrying them', async () => {
    const result = parseXlsxPreview(await createWorkbookWithoutFormulaCaches({
      A1: '=A2+1',
      A2: '=A1+1',
    }, 'A1:A2'))

    expect(result.formulaCalculation).toEqual({ cached: 0, calculated: 0, unavailable: 2 })
  })

  it('fails a formula whose range exceeds the per-formula range budget', async () => {
    const result = parseXlsxPreview(await createWorkbookWithoutFormulaCaches({
      A1: '=SUM(B1:O1000)',
    }, 'A1:O1000'))

    expect(result.formulaCalculation).toEqual({ cached: 0, calculated: 0, unavailable: 1 })
  })

  it('fails closed when formula reference reads exhaust the workbook budget', async () => {
    const result = parseXlsxPreview(await createWorkbookWithoutFormulaCaches({
      B1: '=SUM(A2:A10001)',
      C1: '=SUM(A2:A10001)',
      D1: '=SUM(A2:A10001)',
    }, 'A1:D10001'))

    expect(result.formulaCalculation).toEqual({ cached: 0, calculated: 2, unavailable: 1 })
  })
})
