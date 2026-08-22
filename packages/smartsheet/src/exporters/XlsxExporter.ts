// Excel格式导出器
// 支持.xlsx文件导出和多工作表

import * as fs from 'fs'
import * as path from 'path'
import * as XLSX from 'xlsx'
import { ExportResult, ExportOptions, Exporter, TableData } from '../types'
import { t } from '../i18n'

/**
 * Excel格式导出器
 * 支持.xlsx文件导出和多工作表
 */
export class XlsxExporter implements Exporter {
  readonly format = 'xlsx'

  /**
   * 导出数据为Excel格式
   */
  async export(data: TableData, options: ExportOptions): Promise<ExportResult> {
    try {
      // 创建工作簿
      const workbook = XLSX.utils.book_new()

      // 创建工作表
      const worksheet = this.createWorksheet(data, options)

      // 添加工作表到工作簿
      const sheetName = options.sheetName || 'Sheet1'
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)

      // 生成文件路径（如果没有提供）
      const filePath = options.filePath || this.generateFilePath(options)

      // 确保目录存在
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 写入文件
      XLSX.writeFile(workbook, filePath, {
        bookType: 'xlsx',
        type: 'buffer',
        compression: true
      })

      // 获取文件大小
      const stats = fs.statSync(filePath)

      return {
        success: true,
        filePath,
        rowsExported: data.rows.length,
        fileSize: stats.size
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('export.xlsxUnknownError')
      }
    }
  }

  /**
   * 导出多个工作表
   */
  async exportMultipleSheets(sheets: Array<{ name: string; data: TableData }>, options: ExportOptions): Promise<ExportResult> {
    try {
      // 创建工作簿
      const workbook = XLSX.utils.book_new()

      // 添加每个工作表
      for (const sheet of sheets) {
        const worksheet = this.createWorksheet(sheet.data, options)
        XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name)
      }

      // 生成文件路径（如果没有提供）
      const filePath = options.filePath || this.generateFilePath(options)

      // 确保目录存在
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 写入文件
      XLSX.writeFile(workbook, filePath, {
        bookType: 'xlsx',
        type: 'buffer',
        compression: true
      })

      // 获取文件大小
      const stats = fs.statSync(filePath)
      const totalRows = sheets.reduce((sum, sheet) => sum + sheet.data.rows.length, 0)

      return {
        success: true,
        filePath,
        rowsExported: totalRows,
        fileSize: stats.size,
        metadata: {
          sheetsExported: sheets.length,
          sheetNames: sheets.map(s => s.name)
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('export.xlsxUnknownError')
      }
    }
  }

  /**
   * 验证导出选项
   */
  validateOptions(options: ExportOptions): boolean {
    // 检查必需的选项
    if (!options.format || options.format !== 'xlsx') {
      return false
    }

    return true
  }

  /**
   * 创建工作表
   */
  private createWorksheet(data: TableData, options: ExportOptions): XLSX.WorkSheet {
    const includeHeaders = options.includeHeaders !== false

    // 准备数据数组
    const wsData: any[][] = []

    // 添加表头
    if (includeHeaders && data.columns.length > 0) {
      const headers = data.columns.map(col => col.name)
      wsData.push(headers)
    }

    // 添加数据行
    for (const row of data.rows) {
      const rowData = data.columns.map(col => {
        const value = row.data[col.id]
        return this.formatValue(value, col.type, options)
      })
      wsData.push(rowData)
    }

    // 创建工作表
    const worksheet = XLSX.utils.aoa_to_sheet(wsData)

    // 设置列宽
    if (options.autoWidth !== false) {
      this.setColumnWidths(worksheet, wsData)
    }

    // 设置样式（如果支持）
    if (options.styling !== false) {
      this.applyBasicStyling(worksheet, data.columns.length, includeHeaders)
    }

    return worksheet
  }

  /**
   * 格式化值
   */
  private formatValue(value: any, columnType: string, options: ExportOptions): any {
    if (value === null || value === undefined) {
      return ''
    }

    // 处理日期类型
    if (columnType === 'date' && value instanceof Date) {
      return value
    }

    // 处理数字类型
    if (columnType === 'number') {
      const num = Number(value)
      return isNaN(num) ? value : num
    }

    // 处理布尔类型
    if (columnType === 'boolean') {
      if (typeof value === 'boolean') return value
      const str = String(value).toLowerCase()
      return ['true', '1', 'yes', '是'].includes(str)
    }

    // 处理JSON类型
    if (columnType === 'json' && typeof value === 'object') {
      return JSON.stringify(value)
    }

    return String(value)
  }

  /**
   * 设置列宽
   */
  private setColumnWidths(worksheet: XLSX.WorkSheet, data: any[][]): void {
    const colWidths: Array<{ wch: number }> = []

    if (data.length === 0) return

    // 计算每列的最大宽度
    const maxCols = Math.max(...data.map(row => row.length))

    for (let col = 0; col < maxCols; col++) {
      let maxWidth = 10 // 最小宽度

      for (let row = 0; row < data.length; row++) {
        if (data[row] && data[row][col] !== undefined) {
          const cellValue = String(data[row][col])
          const cellWidth = cellValue.length
          maxWidth = Math.max(maxWidth, cellWidth)
        }
      }

      // 限制最大宽度
      maxWidth = Math.min(maxWidth, 50)
      colWidths.push({ wch: maxWidth })
    }

    worksheet['!cols'] = colWidths
  }

  /**
   * 应用基本样式
   */
  private applyBasicStyling(worksheet: XLSX.WorkSheet, columnCount: number, hasHeaders: boolean): void {
    if (!hasHeaders) return

    // 为表头行设置样式
    const headerRange = XLSX.utils.encode_range({
      s: { c: 0, r: 0 },
      e: { c: columnCount - 1, r: 0 }
    })

    // 设置表头样式（粗体、背景色）
    for (let col = 0; col < columnCount; col++) {
      const cellAddress = XLSX.utils.encode_cell({ c: col, r: 0 })
      if (!worksheet[cellAddress]) continue

      worksheet[cellAddress].s = {
        font: { bold: true },
        fill: { fgColor: { rgb: 'E6E6FA' } },
        alignment: { horizontal: 'center' }
      }
    }
  }

  /**
   * 生成文件路径
   */
  private generateFilePath(options: ExportOptions): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = options.filename || `export_${timestamp}`
    return `${filename}.xlsx`
  }
}
