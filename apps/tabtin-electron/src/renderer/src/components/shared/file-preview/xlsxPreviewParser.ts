import * as XLSX from 'xlsx'
import { evaluateXlsxFormula, type FormulaEvaluation, type FormulaScalar } from './xlsxFormulaEvaluator'

export const XLSX_PREVIEW_MAX_RENDER_ROWS = 500
export const XLSX_PREVIEW_MAX_SHEETS = 20
export const XLSX_PREVIEW_MAX_FORMULA_CALCULATIONS = 1_000
export const XLSX_PREVIEW_MAX_FORMULA_DEPTH = 64
export const XLSX_PREVIEW_MAX_FORMULA_REFERENCE_READS = 20_000

export interface XlsxPreviewSheet {
  name: string
  cells: string[][]
  totalRows: number
  maxCols: number
}

export interface XlsxPreviewParseResult {
  sheets: XlsxPreviewSheet[]
  sheetsLimited: boolean
  formulaCalculation: {
    cached: number
    calculated: number
    unavailable: number
  }
}

type XlsxFileEntry = { content?: Uint8Array }
type WorkbookWithFiles = XLSX.WorkBook & { files?: Record<string, XlsxFileEntry> }

type FormulaCell = { reference: string; formula: string }

export function isOldXlsxFormatError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /CFB|OLE|CompObj|Unsupported file/i.test(msg)
}

function backfillMergedCells(
  allRows: unknown[][],
  merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>,
): void {
  for (const { s, e } of merges) {
    const sourceVal = allRows[s.r]?.[s.c]
    if (sourceVal == null || sourceVal === '') continue
    for (let r = s.r; r <= e.r; r++) {
      if (!allRows[r]) continue
      for (let c = s.c; c <= e.c; c++) {
        if (r === s.r && c === s.c) continue
        while (allRows[r].length <= c) allRows[r].push('')
        allRows[r][c] = sourceVal
      }
    }
  }
}

function formatCellValue(v: unknown): string {
  if (v == null || v === '') return ''
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toLocaleDateString()
  return String(v)
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)
  return match?.[1]
}

function unescapeXml(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name] ?? '')
}

function xmlFileText(files: Record<string, XlsxFileEntry>, fileName: string): string | undefined {
  const content = files[fileName]?.content
  return content ? new TextDecoder().decode(content) : undefined
}

function formulaCellsInWorksheet(xml: string): FormulaCell[] {
  const formulas: FormulaCell[] = []
  for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const reference = xmlAttribute(match[1], 'r')
    const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(match[2])?.[1]
    if (reference && formula !== undefined) formulas.push({ reference, formula: unescapeXml(formula) })
  }
  return formulas
}

function worksheetPathsByName(workbook: WorkbookWithFiles): Map<string, string> {
  const files = workbook.files
  const workbookXml = files && xmlFileText(files, 'xl/workbook.xml')
  const relationsXml = files && xmlFileText(files, 'xl/_rels/workbook.xml.rels')
  if (!files || !workbookXml || !relationsXml) return new Map()

  const relationTargets = new Map<string, string>()
  for (const match of relationsXml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)) {
    const id = xmlAttribute(match[1], 'Id')
    const target = xmlAttribute(match[1], 'Target')
    if (id && target) relationTargets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }

  const paths = new Map<string, string>()
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/g)) {
    const name = xmlAttribute(match[1], 'name')
    const relationId = xmlAttribute(match[1], 'r:id')
    const path = relationId && relationTargets.get(relationId)
    if (name && path) paths.set(unescapeXml(name), path)
  }
  return paths
}

function toFormulaCellValue(value: FormulaScalar): { t: 'n' | 's' | 'b'; v: Exclude<FormulaScalar, Date> } | null {
  if (value == null || value instanceof Date) return null
  if (typeof value === 'number') return { t: 'n', v: value }
  if (typeof value === 'boolean') return { t: 'b', v: value }
  return { t: 's', v: value }
}

function calculateMissingFormulaResults(workbook: WorkbookWithFiles): XlsxPreviewParseResult['formulaCalculation'] {
  const calculation = { cached: 0, calculated: 0, unavailable: 0 }
  let formulaCalculations = 0
  let formulaReferenceReads = 0
  const paths = worksheetPathsByName(workbook)
  const files = workbook.files
  if (!files) return calculation

  for (const [sheetName, worksheet] of Object.entries(workbook.Sheets)) {
    const worksheetPath = paths.get(sheetName)
    const xml = worksheetPath && xmlFileText(files, worksheetPath)
    if (!xml) continue
    const pending = new Map<string, string>()
    for (const { reference, formula } of formulaCellsInWorksheet(xml)) {
      const cell = worksheet[reference] as { v?: unknown } | undefined
      if (cell?.v == null || cell.v === '') pending.set(reference, formula)
      else calculation.cached++
    }
    const states = new Map<string, 'evaluating' | 'done' | 'unavailable'>()

    const markUnavailable = (reference: string): FormulaEvaluation => {
      states.set(reference, 'unavailable')
      calculation.unavailable++
      return { ok: false }
    }
    const calculateCell = (reference: string, depth = 0): FormulaEvaluation => {
      const formula = pending.get(reference)
      if (!formula) {
        const value = (worksheet[reference] as { v?: FormulaScalar } | undefined)?.v ?? null
        return { ok: true, value }
      }
      const state = states.get(reference)
      if (state === 'done') return { ok: true, value: (worksheet[reference] as { v: FormulaScalar }).v }
      if (state === 'evaluating' || state === 'unavailable') return { ok: false }
      if (depth >= XLSX_PREVIEW_MAX_FORMULA_DEPTH || formulaCalculations >= XLSX_PREVIEW_MAX_FORMULA_CALCULATIONS) {
        return markUnavailable(reference)
      }

      states.set(reference, 'evaluating')
      formulaCalculations++
      const result = evaluateXlsxFormula(formula, (dependencyReference) => {
        if (formulaReferenceReads >= XLSX_PREVIEW_MAX_FORMULA_REFERENCE_READS) return { ok: false }
        formulaReferenceReads++
        return calculateCell(dependencyReference, depth + 1)
      })
      const cellValue = result.ok ? toFormulaCellValue(result.value) : null
      if (!cellValue) {
        return markUnavailable(reference)
      }
      worksheet[reference] = { ...(worksheet[reference] as object | undefined), f: formula, ...cellValue }
      states.set(reference, 'done')
      calculation.calculated++
      return result
    }

    for (const reference of pending.keys()) calculateCell(reference)
  }
  return calculation
}

export function parseXlsxPreview(buffer: ArrayBuffer | Uint8Array): XlsxPreviewParseResult {
  const workbook = XLSX.read(new Uint8Array(buffer), {
    type: 'array',
    cellDates: true,
    bookFiles: true,
  }) as WorkbookWithFiles

  if (!workbook.SheetNames.length) {
    return { sheets: [], sheetsLimited: false, formulaCalculation: { cached: 0, calculated: 0, unavailable: 0 } }
  }

  const formulaCalculation = calculateMissingFormulaResults(workbook)

  const sheetNames = workbook.SheetNames.slice(0, XLSX_PREVIEW_MAX_SHEETS)
  const sheetsLimited = workbook.SheetNames.length > XLSX_PREVIEW_MAX_SHEETS

  const sheets = sheetNames.map((name) => {
    const worksheet = workbook.Sheets[name]
    const allRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      defval: '',
      raw: false,
    }) as unknown[][]

    const merges = worksheet['!merges']
    if (merges?.length) {
      backfillMergedCells(allRows, merges)
    }

    const maxCols = allRows.reduce((max, row) => Math.max(max, row.length), 0)
    const cells = allRows
      .slice(0, XLSX_PREVIEW_MAX_RENDER_ROWS)
      .map((row) => Array.from(
        { length: maxCols },
        (_, colIdx) => formatCellValue((row as unknown[])[colIdx]),
      ))

    return {
      name,
      cells,
      totalRows: allRows.length,
      maxCols,
    }
  })

  return { sheets, sheetsLimited, formulaCalculation }
}
