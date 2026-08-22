// CSV格式导出器
// 支持自定义分隔符、编码格式和日期格式

import * as fs from 'fs'
import * as path from 'path'
import { ExportResult, ExportOptions, Exporter, TableData } from '../types'
import { t } from '../i18n'

/**
 * CSV格式导出器
 * 支持自定义分隔符、编码格式和日期格式
 */
export class CsvExporter implements Exporter {
  readonly format = 'csv'

  /**
   * 导出数据为CSV格式
   */
  async export(data: TableData, options: ExportOptions): Promise<ExportResult> {
    try {
      const delimiter = options.delimiter || ','
      const encoding = options.encoding || 'utf8'
      const includeHeaders = options.includeHeaders !== false

      // 构建CSV内容
      const csvContent = this.buildCsvContent(data, delimiter, includeHeaders, options)

      // 生成文件路径（如果没有提供）
      const filePath = options.filePath || this.generateFilePath(options)

      // 确保目录存在
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 写入文件
      fs.writeFileSync(filePath, csvContent, { encoding: encoding as BufferEncoding })

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
        error: error instanceof Error ? error.message : t('export.csvUnknownError')
      }
    }
  }

  /**
   * 验证导出选项
   */
  validateOptions(options: ExportOptions): boolean {
    // 检查必需的选项
    if (!options.format || options.format !== 'csv') {
      return false
    }

    // 检查分隔符是否有效
    if (options.delimiter && options.delimiter.length !== 1) {
      return false
    }

    // 检查编码格式是否支持
    if (options.encoding && !['utf8', 'utf16le', 'latin1', 'ascii'].includes(options.encoding)) {
      return false
    }

    return true
  }

  /**
   * 构建CSV内容
   */
  private buildCsvContent(data: TableData, delimiter: string, includeHeaders: boolean, options: ExportOptions): string {
    const lines: string[] = []

    // 添加表头
    if (includeHeaders && data.columns.length > 0) {
      const headers = data.columns.map(col => this.escapeCsvValue(col.name, delimiter))
      lines.push(headers.join(delimiter))
    }

    // 添加数据行
    for (const row of data.rows) {
      const values = data.columns.map(col => {
        const value = row.data[col.id]
        return this.formatValue(value, col.type, options, delimiter)
      })
      lines.push(values.join(delimiter))
    }

    return lines.join('\n')
  }

  /**
   * 转义CSV值
   */
  private escapeCsvValue(value: string, delimiter: string): string {
    if (!value) return ''

    // 如果包含分隔符、换行符或双引号，需要用双引号包围
    if (value.includes(delimiter) || value.includes('\n') || value.includes('\r') || value.includes('"')) {
      // 转义内部的双引号
      const escaped = value.replace(/"/g, '""')
      return `"${escaped}"`
    }

    return value
  }

  /**
   * 格式化值
   */
  private formatValue(value: any, columnType: string, options: ExportOptions, delimiter: string): string {
    if (value === null || value === undefined) {
      return ''
    }

    // 处理日期类型
    if (columnType === 'date' && value instanceof Date) {
      if (options.dateFormat) {
        return this.formatDate(value, options.dateFormat)
      }
      return columnType === 'date' ? value.toISOString().split('T')[0] : value.toISOString()
    }

    // 处理布尔类型
    if (columnType === 'boolean') {
      return value ? 'true' : 'false'
    }

    // 处理JSON类型
    if (columnType === 'json' && typeof value === 'object') {
      return JSON.stringify(value)
    }

    // 处理其他类型
    const stringValue = String(value)
    return this.escapeCsvValue(stringValue, delimiter)
  }

  /**
   * 格式化日期
   */
  private formatDate(date: Date, format: string): string {
    // 简单的日期格式化实现
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')

    return format
      .replace('YYYY', String(year))
      .replace('MM', month)
      .replace('DD', day)
      .replace('HH', hours)
      .replace('mm', minutes)
      .replace('ss', seconds)
  }

  /**
   * 生成文件路径
   */
  private generateFilePath(options: ExportOptions): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = options.filename || `export_${timestamp}`
    return `${filename}.csv`
  }
}
