// JSON格式导出器
// 支持多种JSON结构和自定义格式化

import * as fs from 'fs'
import * as path from 'path'
import { ExportResult, ExportOptions, Exporter, TableData } from '../types'
import { t } from '../i18n'

/**
 * JSON格式导出器
 * 支持多种JSON结构和自定义格式化
 */
export class JsonExporter implements Exporter {
  readonly format = 'json'

  /**
   * 导出数据为JSON格式
   */
  async export(data: TableData, options: ExportOptions): Promise<ExportResult> {
    try {
      const encoding = options.encoding || 'utf8'
      const pretty = options.pretty !== false // 默认格式化

      // 构建JSON内容
      const jsonContent = this.buildJsonContent(data, options, pretty)

      // 生成文件路径（如果没有提供）
      const filePath = options.filePath || this.generateFilePath(options)

      // 确保目录存在
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 写入文件
      fs.writeFileSync(filePath, jsonContent, { encoding: encoding as BufferEncoding })

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
        error: error instanceof Error ? error.message : t('export.jsonUnknownError')
      }
    }
  }

  /**
   * 验证导出选项
   */
  validateOptions(options: ExportOptions): boolean {
    // 检查必需的选项
    if (!options.format || options.format !== 'json') {
      return false
    }

    // 检查JSON结构类型
    if (options.jsonStructure && !['array', 'table', 'keyValue'].includes(options.jsonStructure)) {
      return false
    }

    return true
  }

  /**
   * 构建JSON内容
   */
  private buildJsonContent(data: TableData, options: ExportOptions, pretty: boolean): string {
    const structure = options.jsonStructure || 'array'
    let jsonData: any

    switch (structure) {
      case 'table':
        jsonData = this.buildTableStructure(data, options)
        break
      case 'keyValue':
        jsonData = this.buildKeyValueStructure(data, options)
        break
      case 'array':
      default:
        jsonData = this.buildArrayStructure(data, options)
        break
    }

    return pretty ? JSON.stringify(jsonData, null, 2) : JSON.stringify(jsonData)
  }

  /**
   * 构建数组结构 (默认)
   * [{ col1: value1, col2: value2 }, ...]
   */
  private buildArrayStructure(data: TableData, options: ExportOptions): any[] {
    return data.rows.map(row => {
      const obj: Record<string, any> = {}

      data.columns.forEach(column => {
        const key = options.useColumnIds ? column.id : column.name
        const value = row.data[column.id]
        obj[key] = this.formatValue(value, column.type, options)
      })

      // 如果需要包含元数据
      if (options.includeMetadata) {
        obj._id = row.id
        obj._createdAt = row.createdAt
        obj._updatedAt = row.updatedAt
      }

      return obj
    })
  }

  /**
   * 构建表格结构
   * { columns: [...], rows: [...] }
   */
  private buildTableStructure(data: TableData, options: ExportOptions): any {
    const result: any = {
      columns: data.columns.map(col => ({
        id: col.id,
        name: col.name,
        type: col.type,
        required: false
      })),
      rows: data.rows.map(row => ({
        id: row.id,
        data: this.formatRowData(row.data, data.columns, options),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }))
    }

    // 添加表格元数据
    if (options.includeMetadata) {
      result.metadata = {
        totalRows: data.rows.length,
        totalColumns: data.columns.length,
        exportedAt: new Date().toISOString()
      }
    }

    return result
  }

  /**
   * 构建键值对结构 (仅适用于两列数据)
   * { key1: value1, key2: value2, ... }
   */
  private buildKeyValueStructure(data: TableData, options: ExportOptions): Record<string, any> {
    if (data.columns.length < 2) {
      throw new Error(t('export.keyValueRequiresTwoColumns'))
    }

    const keyColumn = data.columns[0]
    const valueColumn = data.columns[1]
    const result: Record<string, any> = {}

    data.rows.forEach(row => {
      const key = String(row.data[keyColumn.id] || '')
      const value = this.formatValue(row.data[valueColumn.id], valueColumn.type, options)

      if (key) {
        result[key] = value
      }
    })

    return result
  }

  /**
   * 格式化行数据
   */
  private formatRowData(rowData: Record<string, any>, columns: any[], options: ExportOptions): Record<string, any> {
    const formatted: Record<string, any> = {}

    columns.forEach(column => {
      const key = options.useColumnIds ? column.id : column.name
      const value = rowData[column.id]
      formatted[key] = this.formatValue(value, column.type, options)
    })

    return formatted
  }

  /**
   * 格式化值
   */
  private formatValue(value: any, columnType: string, options: ExportOptions): any {
    if (value === null || value === undefined) {
      return null
    }

    // 处理日期类型
    if (columnType === 'date' && value instanceof Date) {
      if (options.dateFormat === 'timestamp') {
        return value.getTime()
      } else if (options.dateFormat === 'iso') {
        return value.toISOString()
      } else if (options.dateFormat) {
        return this.formatDate(value, options.dateFormat)
      }
      return value.toISOString()
    }

    // 处理JSON类型
    if (columnType === 'json' && typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }

    // 处理数字类型
    if (columnType === 'number' && typeof value === 'string') {
      const num = Number(value)
      return isNaN(num) ? value : num
    }

    // 处理布尔类型
    if (columnType === 'boolean' && typeof value === 'string') {
      const lower = value.toLowerCase()
      if (['true', '1', 'yes', '是'].includes(lower)) return true
      if (['false', '0', 'no', '否'].includes(lower)) return false
    }

    return value
  }

  /**
   * 格式化日期
   */
  private formatDate(date: Date, format: string): string {
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
    return `${filename}.json`
  }
}
