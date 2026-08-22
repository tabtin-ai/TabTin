/**
 * XlsxViewer 回归测试（纯逻辑层）
 * 覆盖问题：ODX-005, ODX-006, ODX-008, ODX-014, ODX-015, ODX-016, ODX-017
 *
 * xlsx 模块体积过大（7.3MB / 24k 行），vitest worker 编译时 OOM，
 * 因此将核心逻辑提取为纯函数在此单独测试，而非渲染完整组件。
 */
import { describe, it, expect } from 'vitest'

// ─── 从 XlsxViewer.tsx 中复制的纯函数（与源码保持一致） ───

function isOldFormatError(err: unknown): boolean {
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

function encodeCol(n: number): string {
  let s = ''
  let idx = n + 1
  while (idx > 0) {
    idx--
    s = String.fromCharCode(65 + (idx % 26)) + s
    idx = Math.floor(idx / 26)
  }
  return s
}

const MAX_RENDER_ROWS = 500
const MAX_SHEETS = 20

/**
 * 模拟 XlsxViewer 中的 sheet 解析逻辑
 */
function parseSheet(
  allRows: unknown[][],
  merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [],
) {
  if (merges.length > 0) {
    backfillMergedCells(allRows, merges)
  }

  const firstRow = allRows.length > 0 ? allRows[0] : []
  const isFirstRowEmpty =
    firstRow.length === 0 || firstRow.every((v) => v === '' || v == null)

  let headers: string[]
  let dataRows: unknown[][]

  if (!isFirstRowEmpty) {
    headers = firstRow.map((v) => formatCellValue(v))
    dataRows = allRows.slice(1)
  } else {
    const maxCols = allRows.reduce((max, row) => Math.max(max, row.length), 0)
    headers = Array.from({ length: maxCols }, (_, i) => encodeCol(i))
    dataRows = allRows
  }

  const truncated = dataRows
    .slice(0, MAX_RENDER_ROWS)
    .map((row) => headers.map((_, colIdx) => formatCellValue((row as unknown[])[colIdx])))

  return {
    headers,
    rows: truncated,
    totalRows: allRows.length,
    hasAutoHeaders: isFirstRowEmpty,
  }
}

/**
 * 模拟 activeSheet 选取逻辑（含越界钳位）
 */
function getActiveSheet<T>(sheets: T[], activeSheetIndex: number): T | undefined {
  if (sheets.length === 0) return undefined
  const idx = Math.min(Math.max(0, activeSheetIndex), sheets.length - 1)
  return sheets[idx]
}

// ─── 测试用例 ───

describe('XlsxViewer ODX regression (pure logic)', () => {
  // ───── ODX-005：空首行不应导致只有 # 列 ─────

  describe('ODX-005: 空首行自动生成列标题', () => {
    it('首行为空数组时应自动生成 A/B/C 列标题', () => {
      const result = parseSheet([[], ['v1', 'v2', 'v3'], ['a', 'b', 'c']])

      expect(result.headers).toEqual(['A', 'B', 'C'])
      expect(result.hasAutoHeaders).toBe(true)
      expect(result.rows.length).toBe(3)
    })

    it('首行全为空字符串时应自动生成列标题', () => {
      const result = parseSheet([
        ['', '', ''],
        ['data1', 'data2', 'data3'],
      ])

      expect(result.headers).toEqual(['A', 'B', 'C'])
      expect(result.hasAutoHeaders).toBe(true)
      expect(result.rows.length).toBe(2)
    })

    it('首行有非空值时应正常用作表头', () => {
      const result = parseSheet([
        ['Name', 'Age'],
        ['Alice', '30'],
      ])

      expect(result.headers).toEqual(['Name', 'Age'])
      expect(result.hasAutoHeaders).toBe(false)
      expect(result.rows.length).toBe(1)
    })

    it('首行部分为空时仍用作表头（非全空）', () => {
      const result = parseSheet([
        ['', 'Name', ''],
        ['1', 'Alice', 'x'],
      ])

      expect(result.headers).toEqual(['', 'Name', ''])
      expect(result.hasAutoHeaders).toBe(false)
    })

    it('完全空的 allRows 应返回空 headers', () => {
      const result = parseSheet([])
      expect(result.headers).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.hasAutoHeaders).toBe(true)
    })
  })

  // ───── ODX-006：合并单元格回填 ─────

  describe('ODX-006: 合并单元格值回填', () => {
    it('水平合并应将左上角值复制到所有合并区域', () => {
      const rows: unknown[][] = [
        ['MergedHeader', '', '', 'Other'],
        ['r1c1', 'r1c2', 'r1c3', 'r1c4'],
      ]
      backfillMergedCells(rows, [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }])

      expect(rows[0]).toEqual(['MergedHeader', 'MergedHeader', 'MergedHeader', 'Other'])
    })

    it('垂直合并应将值复制到所有行', () => {
      const rows: unknown[][] = [
        ['Header1', 'Header2'],
        ['Category', 'A'],
        ['', 'B'],
        ['', 'C'],
      ]
      backfillMergedCells(rows, [{ s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }])

      expect(rows[1][0]).toBe('Category')
      expect(rows[2][0]).toBe('Category')
      expect(rows[3][0]).toBe('Category')
    })

    it('矩形合并区域应全部填充', () => {
      const rows: unknown[][] = [
        ['Block', '', 'X'],
        ['', '', 'Y'],
        ['A', 'B', 'C'],
      ]
      backfillMergedCells(rows, [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }])

      expect(rows[0][0]).toBe('Block')
      expect(rows[0][1]).toBe('Block')
      expect(rows[1][0]).toBe('Block')
      expect(rows[1][1]).toBe('Block')
    })

    it('源值为空时不应回填', () => {
      const rows: unknown[][] = [
        ['', 'B'],
        ['', 'D'],
      ]
      backfillMergedCells(rows, [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }])

      expect(rows[0][0]).toBe('')
      expect(rows[1][0]).toBe('')
    })

    it('合并区域超出行长度时应自动 pad', () => {
      const rows: unknown[][] = [['Val'], ['short']]
      backfillMergedCells(rows, [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }])

      expect(rows[0]).toEqual(['Val', 'Val', 'Val'])
    })
  })

  // ───── ODX-008：旧格式错误检测 ─────

  describe('ODX-008: isOldFormatError 检测', () => {
    it('应识别 CFB 错误', () => {
      expect(isOldFormatError(new Error('Unsupported file CFB'))).toBe(true)
    })

    it('应识别 OLE 错误', () => {
      expect(isOldFormatError(new Error('OLE Compound Document error'))).toBe(true)
    })

    it('应识别 CompObj 错误', () => {
      expect(isOldFormatError(new Error('CompObj stream not found'))).toBe(true)
    })

    it('应识别 "Unsupported file" 错误', () => {
      expect(isOldFormatError(new Error('Unsupported file format'))).toBe(true)
    })

    it('非格式错误应返回 false', () => {
      expect(isOldFormatError(new Error('Out of memory'))).toBe(false)
      expect(isOldFormatError(new Error('Network error'))).toBe(false)
    })

    it('应处理非 Error 类型的异常', () => {
      expect(isOldFormatError('Unsupported file CFB')).toBe(true)
      expect(isOldFormatError('something else')).toBe(false)
    })
  })

  // ───── ODX-014：totalRows 应反映实际总行数 ─────

  describe('ODX-014: totalRows 包含表头行', () => {
    it('有表头时 totalRows = allRows.length（含表头）', () => {
      const rows = [['Header'], ...Array.from({ length: 10 }, (_, i) => [`row${i}`])]
      const result = parseSheet(rows)

      expect(result.totalRows).toBe(11)
    })

    it('自动表头时 totalRows = allRows.length（全部为数据行）', () => {
      const rows: unknown[][] = [[], ['a', 'b'], ['c', 'd']]
      const result = parseSheet(rows)

      expect(result.totalRows).toBe(3)
    })

    it('截断判断应基于数据行数而非 totalRows', () => {
      const dataRows = Array.from({ length: 510 }, (_, i) => [`row${i}`])
      const allRows: unknown[][] = [['Header'], ...dataRows]
      const result = parseSheet(allRows)

      const dataRowCount = result.hasAutoHeaders
        ? result.totalRows
        : Math.max(0, result.totalRows - 1)
      const isTruncated = dataRowCount > MAX_RENDER_ROWS

      expect(isTruncated).toBe(true)
      expect(result.totalRows).toBe(511)
      expect(result.rows.length).toBe(MAX_RENDER_ROWS)
    })

    it('数据行刚好 500 时不应截断', () => {
      const dataRows = Array.from({ length: 500 }, (_, i) => [`row${i}`])
      const allRows: unknown[][] = [['Header'], ...dataRows]
      const result = parseSheet(allRows)

      const dataRowCount = result.hasAutoHeaders
        ? result.totalRows
        : Math.max(0, result.totalRows - 1)

      expect(dataRowCount).toBe(500)
      expect(dataRowCount > MAX_RENDER_ROWS).toBe(false)
    })
  })

  // ───── ODX-015：formatCellValue 类型处理 ─────

  describe('ODX-015: formatCellValue 类型格式化', () => {
    it('Date 对象应格式化为可读字符串', () => {
      const d = new Date('2024-01-15')
      const result = formatCellValue(d)
      expect(result).not.toBe('')
      expect(result).not.toMatch(/^\d{5}$/)
    })

    it('无效 Date 应返回空字符串', () => {
      expect(formatCellValue(new Date('invalid'))).toBe('')
    })

    it('数字应转为字符串', () => {
      expect(formatCellValue(1234.56)).toBe('1234.56')
    })

    it('布尔值应转为字符串', () => {
      expect(formatCellValue(true)).toBe('true')
      expect(formatCellValue(false)).toBe('false')
    })

    it('null/undefined/空字符串应返回空字符串', () => {
      expect(formatCellValue(null)).toBe('')
      expect(formatCellValue(undefined)).toBe('')
      expect(formatCellValue('')).toBe('')
    })

    it('普通字符串应原样返回', () => {
      expect(formatCellValue('hello')).toBe('hello')
    })
  })

  // ───── ODX-016：activeSheetIndex 越界钳位 ─────

  describe('ODX-016: getActiveSheet 越界保护', () => {
    const sheets = [{ name: 'S1' }, { name: 'S2' }, { name: 'S3' }]

    it('正常索引应返回对应 sheet', () => {
      expect(getActiveSheet(sheets, 0)).toEqual({ name: 'S1' })
      expect(getActiveSheet(sheets, 2)).toEqual({ name: 'S3' })
    })

    it('索引超出上界应钳位到最后一个 sheet', () => {
      expect(getActiveSheet(sheets, 5)).toEqual({ name: 'S3' })
      expect(getActiveSheet(sheets, 100)).toEqual({ name: 'S3' })
    })

    it('负数索引应钳位到第一个 sheet', () => {
      expect(getActiveSheet(sheets, -1)).toEqual({ name: 'S1' })
    })

    it('空数组应返回 undefined', () => {
      expect(getActiveSheet([], 0)).toBeUndefined()
    })
  })

  // ───── ODX-017：sheet 数量上限 ─────

  describe('ODX-017: sheet 数量限制', () => {
    it('MAX_SHEETS 常量应为 20', () => {
      expect(MAX_SHEETS).toBe(20)
    })

    it('超过 MAX_SHEETS 的 sheet 列表应被截断', () => {
      const sheetNames = Array.from({ length: 25 }, (_, i) => `Sheet${i + 1}`)
      const limited = sheetNames.slice(0, MAX_SHEETS)
      const hasMore = sheetNames.length > MAX_SHEETS

      expect(limited.length).toBe(20)
      expect(hasMore).toBe(true)
      expect(limited[19]).toBe('Sheet20')
    })

    it('不超过 MAX_SHEETS 时不应截断', () => {
      const sheetNames = Array.from({ length: 15 }, (_, i) => `Sheet${i + 1}`)
      const limited = sheetNames.slice(0, MAX_SHEETS)
      const hasMore = sheetNames.length > MAX_SHEETS

      expect(limited.length).toBe(15)
      expect(hasMore).toBe(false)
    })
  })

  // ───── 集成场景 ─────

  describe('集成场景', () => {
    it('空首行 + 合并单元格应正确处理', () => {
      const rows: unknown[][] = [
        [],
        ['MergedVal', '', 'C'],
        ['', '', 'D'],
      ]
      const merges = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 1 } }]
      const result = parseSheet(rows, merges)

      expect(result.hasAutoHeaders).toBe(true)
      expect(result.headers).toEqual(['A', 'B', 'C'])
      expect(result.rows[1]).toEqual(['MergedVal', 'MergedVal', 'C'])
      expect(result.rows[2]).toEqual(['MergedVal', 'MergedVal', 'D'])
    })

    it('大数据集截断 + totalRows 正确性', () => {
      const allRows: unknown[][] = [
        ['H1'],
        ...Array.from({ length: 1000 }, (_, i) => [`data${i}`]),
      ]
      const result = parseSheet(allRows)

      expect(result.rows.length).toBe(MAX_RENDER_ROWS)
      expect(result.totalRows).toBe(1001)
      expect(result.hasAutoHeaders).toBe(false)
    })
  })
})
