// CSV格式导入器
// 支持自定义分隔符、编码和数据类型推断

import * as fs from 'fs'
import { ImportResult, ImportOptions, Importer, TableData } from '../types'
import { t } from '../i18n'

/**
 * CSV格式导入器
 * 支持自定义分隔符、编码和数据类型推断
 */
export class CsvImporter implements Importer {
  readonly format = 'csv'

  /**
   * 从CSV文件导入数据
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

      // 读取文件内容
      const encoding = options.encoding || 'utf8'
      const content = fs.readFileSync(filePath, { encoding: encoding as BufferEncoding })

      // 解析CSV内容
      const tableData = this.parseCsvContent(content, options)

      return {
        success: true,
        data: tableData,
        rowsImported: tableData.rows.length
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('import.csvUnknownError')
      }
    }
  }

  /**
   * 预览CSV文件数据
   */
  async preview(filePath: string, options: ImportOptions): Promise<TableData | null> {
    try {
      // 验证文件是否存在
      if (!fs.existsSync(filePath)) {
        return null
      }

      // 读取文件内容
      const encoding = options.encoding || 'utf8'
      const content = fs.readFileSync(filePath, { encoding: encoding as BufferEncoding })

      // 解析CSV内容
      const tableData = this.parseCsvContent(content, options)

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
   * 验证导入选项
   */
  validateOptions(options: ImportOptions): boolean {
    // 检查必需的选项
    if (!options.format || options.format !== 'csv') {
      return false
    }

    // 检查分隔符
    if (options.delimiter && options.delimiter.length !== 1) {
      return false
    }

    return true
  }

  /**
   * 解析CSV内容
   */
  private parseCsvContent(content: string, options: ImportOptions): TableData {
    const delimiter = options.delimiter || ','
    const hasHeaders = options.hasHeaders !== false

    // 分割行
    const lines = this.splitLines(content)
    if (lines.length === 0) {
      return { columns: [], rows: [], totalRows: 0 }
    }

    // 解析第一行以确定列数
    const firstRowData = this.parseCsvLine(lines[0], delimiter)
    const columnCount = firstRowData.length

    // 创建列定义
    const columns = []
    for (let i = 0; i < columnCount; i++) {
      const columnName = hasHeaders ? firstRowData[i] || `Column${i + 1}` : `Column${i + 1}`
      columns.push({
        id: `col_${i}`,
        name: columnName,
        type: 'text' as const, // 默认类型，后续可以推断
        required: false
      })
    }

    // 解析数据行
    const rows = []
    const dataStartIndex = hasHeaders ? 1 : 0

    for (let i = dataStartIndex; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue // 跳过空行

      const rowData = this.parseCsvLine(line, delimiter)

      // 构建行数据对象
      const data: Record<string, any> = {}
      for (let j = 0; j < columns.length; j++) {
        const value = j < rowData.length ? rowData[j] : ''
        data[columns[j].id] = this.parseValue(value, columns[j])
      }

      rows.push({
        id: `row_${i}`,
        data,
        createdAt: new Date().toISOString()
      })
    }

    // 推断列类型
    this.inferColumnTypes(columns, rows)

    return { columns, rows, totalRows: rows.length }
  }

  /**
   * 分割行，处理换行符
   */
  private splitLines(content: string): string[] {
    // 处理不同的换行符
    return content.split(/\r\n|\r|\n/)
  }

  /**
   * 解析CSV行，处理引号和转义
   */
  private parseCsvLine(line: string, delimiter: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    let i = 0

    while (i < line.length) {
      const char = line[i]
      const nextChar = i + 1 < line.length ? line[i + 1] : ''

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // 转义的引号
          current += '"'
          i += 2
        } else {
          // 开始或结束引号
          inQuotes = !inQuotes
          i++
        }
      } else if (char === delimiter && !inQuotes) {
        // 字段分隔符
        result.push(current)
        current = ''
        i++
      } else {
        current += char
        i++
      }
    }

    // 添加最后一个字段
    result.push(current)
    return result
  }

  /**
   * 解析值
   */
  private parseValue(value: string, column: any): any {
    if (!value || value.trim() === '') {
      return null
    }

    const trimmedValue = value.trim()

    // 移除引号
    const unquotedValue = trimmedValue.startsWith('"') && trimmedValue.endsWith('"')
      ? trimmedValue.slice(1, -1).replace(/""/g, '"')
      : trimmedValue

    // 根据列类型解析
    switch (column.type) {
      case 'number':
        const num = Number(unquotedValue)
        return isNaN(num) ? unquotedValue : num

      case 'boolean':
        const lower = unquotedValue.toLowerCase()
        if (lower === 'true' || lower === '1' || lower === 'yes') return true
        if (lower === 'false' || lower === '0' || lower === 'no') return false
        return unquotedValue

      case 'date':
        const date = new Date(unquotedValue)
        return isNaN(date.getTime()) ? unquotedValue : date

      case 'json':
        try {
          return JSON.parse(unquotedValue)
        } catch {
          return unquotedValue
        }

      default:
        return unquotedValue
    }
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
      if (values.every(value => !isNaN(Number(value)))) {
        column.type = 'number'
        continue
      }

      // 检查是否为布尔值
      if (values.every(value => {
        const lower = String(value).toLowerCase()
        return ['true', 'false', '1', '0', 'yes', 'no'].includes(lower)
      })) {
        column.type = 'boolean'
        continue
      }

      // 检查是否为日期
      if (values.every(value => !isNaN(new Date(String(value)).getTime()))) {
        column.type = 'date'
        continue
      }

      // 检查是否为JSON
      if (values.every(value => {
        try {
          JSON.parse(String(value))
          return true
        } catch {
          return false
        }
      })) {
        column.type = 'json'
        continue
      }

      // 默认为文本类型
      column.type = 'text'
    }
  }
}
