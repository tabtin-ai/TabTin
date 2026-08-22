// Excel格式导入器
// 支持.xlsx文件导入和多工作表处理

import * as fs from 'fs'
import * as XLSX from 'xlsx'
import { ImportResult, ImportOptions, Importer, TableData } from '../types'
import { t } from '../i18n'

/**
 * Excel格式导入器
 * 支持.xlsx文件导入和多工作表处理
 */
export class XlsxImporter implements Importer {
  readonly format = 'xlsx'

  /**
   * 从Excel文件导入数据
   */
  async import(filePath: string, options: ImportOptions): Promise<ImportResult> {
    try {
      // 验证文件是否存在
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: t('import.fileNotFound', { path: filePath })
        }
      }

      // 读取Excel文件
      const workbook = XLSX.readFile(filePath)

      // 获取工作表名称
      const sheetName = options.sheetName || workbook.SheetNames[0]

      if (!workbook.Sheets[sheetName]) {
        return {
          success: false,
          error: t('import.xlsxSheetMissing', { sheet: sheetName })
        }
      }

      // 解析工作表数据
      const tableData = this.parseWorksheet(workbook.Sheets[sheetName], options)

      return {
        success: true,
        data: tableData,
        rowsImported: tableData.rows.length,
        metadata: {
          sheetNames: workbook.SheetNames,
          selectedSheet: sheetName
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('import.xlsxUnknownError')
      }
    }
  }

  /**
   * 预览Excel文件数据
   */
  async preview(filePath: string, options: ImportOptions): Promise<TableData | null> {
    try {
      // 验证文件是否存在
      if (!fs.existsSync(filePath)) {
        return null
      }

      // 读取Excel文件
      const workbook = XLSX.readFile(filePath)

      // 获取工作表名称
      const sheetName = options.sheetName || workbook.SheetNames[0]

      if (!workbook.Sheets[sheetName]) {
        return null
      }

      // 解析工作表数据
      const tableData = this.parseWorksheet(workbook.Sheets[sheetName], options)

      // 返回前几行作为预览
      const previewRows = options.maxRows ? tableData.rows.slice(0, options.maxRows) : tableData.rows.slice(0, 10)

      return {
        ...tableData,
        rows: previewRows
      }
    } catch (error) {
      return null
    }
  }

  /**
   * 获取工作表列表
   */
  async getSheetNames(filePath: string): Promise<string[]> {
    try {
      if (!fs.existsSync(filePath)) {
        return []
      }

      const workbook = XLSX.readFile(filePath)
      return workbook.SheetNames
    } catch (error) {
      return []
    }
  }

  /**
   * 验证导入选项
   */
  validateOptions(options: ImportOptions): boolean {
    // 检查必需的选项
    if (!options.format || options.format !== 'xlsx') {
      return false
    }

    return true
  }

  /**
   * 解析工作表数据
   */
  private parseWorksheet(worksheet: XLSX.WorkSheet, options: ImportOptions): TableData {
    // 将工作表转换为JSON数组
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, // 使用数组格式而不是对象格式
      defval: '', // 空单元格的默认值
      raw: false, // 不使用原始值，进行格式化
      dateNF: 'yyyy-mm-dd' // 日期格式
    }) as any[][]

    if (jsonData.length === 0) {
      return { columns: [], rows: [], totalRows: 0 }
    }

    const hasHeaders = options.hasHeaders !== false

    // 确定列数（取最大行的列数）
    const maxColumns = Math.max(...jsonData.map(row => row.length))

    // 创建列定义
    const columns = []
    const headerRow = hasHeaders ? jsonData[0] : null

    for (let i = 0; i < maxColumns; i++) {
      const columnName = headerRow && headerRow[i]
        ? String(headerRow[i]).trim() || `Column${i + 1}`
        : `Column${i + 1}`

      columns.push({
        id: `col_${i}`,
        name: columnName,
        type: 'text' as const,
        required: false
      })
    }

    // 创建行数据
    const rows = []
    const dataStartIndex = hasHeaders ? 1 : 0

    for (let i = dataStartIndex; i < jsonData.length; i++) {
      const rowArray = jsonData[i]

      // 跳过完全空的行
      if (!rowArray || rowArray.every(cell => cell === '' || cell === null || cell === undefined)) {
        continue
      }

      const rowData: Record<string, any> = {}

      for (let j = 0; j < columns.length; j++) {
        const cellValue = j < rowArray.length ? rowArray[j] : ''
        rowData[columns[j].id] = this.parseValue(cellValue, columns[j])
      }

      rows.push({
        id: `row_${i}`,
        data: rowData,
        createdAt: new Date().toISOString()
      })
    }

    // 推断列类型
    this.inferColumnTypes(columns, rows)

    return { columns, rows, totalRows: rows.length }
  }

  /**
   * 解析单元格值
   */
  private parseValue(value: any, column: any): any {
    if (value === null || value === undefined || value === '') {
      return null
    }

    // 处理Excel日期序列号
    if (typeof value === 'number' && this.isExcelDate(value)) {
      return XLSX.SSF.parse_date_code(value)
    }

    // 处理字符串
    if (typeof value === 'string') {
      const trimmed = value.trim()

      // 尝试解析数字
      if (!isNaN(Number(trimmed)) && trimmed !== '') {
        return Number(trimmed)
      }

      // 尝试解析布尔值
      const lower = trimmed.toLowerCase()
      if (['true', 'false', 'yes', 'no', '是', '否'].includes(lower)) {
        return ['true', 'yes', '是'].includes(lower)
      }

      // 尝试解析日期
      const date = new Date(trimmed)
      if (!isNaN(date.getTime()) && trimmed.match(/\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/)) {
        return date
      }

      return trimmed
    }

    return value
  }

  /**
   * 检查是否为Excel日期序列号
   */
  private isExcelDate(value: number): boolean {
    // Excel日期从1900年1月1日开始计算
    // 序列号1对应1900年1月1日
    // 合理的日期范围：1900年到2100年
    return value > 1 && value < 73050 // 大约对应2100年
  }

  /**
   * 推断列类型
   */
  private inferColumnTypes(columns: any[], rows: any[]): void {
    for (const column of columns) {
      const values = rows
        .map(row => row.data[column.id])
        .filter(value => value !== null && value !== undefined && value !== '')

      if (values.length === 0) {
        continue
      }

      // 检查是否为数字
      if (values.every(value => typeof value === 'number' || !isNaN(Number(value)))) {
        column.type = 'number'
        continue
      }

      // 检查是否为布尔值
      if (values.every(value => typeof value === 'boolean')) {
        column.type = 'boolean'
        continue
      }

      // 检查是否为日期
      if (values.every(value => value instanceof Date ||
        (typeof value === 'string' && !isNaN(new Date(value).getTime())))) {
        column.type = 'date'
        continue
      }

      // 默认为文本类型
      column.type = 'text'
    }
  }
}
