// JSON格式导入器
// 支持多种JSON结构和数据类型推断

import * as fs from 'fs'
import { ImportResult, ImportOptions, Importer, TableData } from '../types'
import { t } from '../i18n'

/**
 * JSON格式导入器
 * 支持多种JSON结构和数据类型推断
 */
export class JsonImporter implements Importer {
  readonly format = 'json'

  /**
   * 从JSON文件导入数据
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

      // 解析JSON内容
      const tableData = this.parseJsonContent(content, options)

      return {
        success: true,
        data: tableData,
        rowsImported: tableData.rows.length
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('import.jsonUnknownError')
      }
    }
  }

  /**
   * 预览JSON文件数据
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

      // 解析JSON内容
      const tableData = this.parseJsonContent(content, options)

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
    if (!options.format || options.format !== 'json') {
      return false
    }

    return true
  }

  /**
   * 解析JSON内容
   */
  private parseJsonContent(content: string, options: ImportOptions): TableData {
    try {
      const jsonData = JSON.parse(content)

      // 处理不同的JSON结构
      if (Array.isArray(jsonData)) {
        return this.parseArrayData(jsonData, options)
      } else if (typeof jsonData === 'object' && jsonData !== null) {
        return this.parseObjectData(jsonData, options)
      } else {
      throw new Error(t('import.jsonFormatUnsupported'))
      }
    } catch (error) {
      throw new Error(
        t('import.jsonParseFailed', {
          message: error instanceof Error ? error.message : String(error)
        })
      )
    }
  }

  /**
   * 解析数组格式的JSON数据
   */
  private parseArrayData(data: any[], options: ImportOptions): TableData {
    if (data.length === 0) {
      return { columns: [], rows: [], totalRows: 0 }
    }

    // 分析所有对象的键来确定列
    const allKeys = new Set<string>()
    data.forEach(item => {
      if (typeof item === 'object' && item !== null) {
        Object.keys(item).forEach(key => allKeys.add(key))
      }
    })

    // 创建列定义
    const columns = Array.from(allKeys).map((key, index) => ({
      id: `col_${index}`,
      name: key,
      type: 'text' as const,
      required: false
    }))

    // 创建行数据
    const rows = data.map((item, index) => {
      const rowData: Record<string, any> = {}

      if (typeof item === 'object' && item !== null) {
        columns.forEach(column => {
          const value = item[column.name]
          rowData[column.id] = this.parseValue(value)
        })
      } else {
        // 如果不是对象，将值放在第一列
        if (columns.length === 0) {
          columns.push({
            id: 'col_0',
            name: 'value',
            type: 'text' as const,
            required: false
          })
        }
        rowData[columns[0].id] = this.parseValue(item)
      }

      return {
        id: `row_${index}`,
        data: rowData,
        createdAt: new Date().toISOString()
      }
    })

    // 推断列类型
    this.inferColumnTypes(columns, rows)

    return { columns, rows, totalRows: rows.length }
  }

  /**
   * 解析对象格式的JSON数据
   */
  private parseObjectData(data: Record<string, any>, options: ImportOptions): TableData {
    // 检查是否有特定的数据结构
    if (data.columns && data.rows) {
      // 标准表格格式
      return this.parseTableFormat(data, options)
    } else {
      // 将对象转换为键值对
      return this.parseKeyValueFormat(data, options)
    }
  }

  /**
   * 解析标准表格格式
   */
  private parseTableFormat(data: any, options: ImportOptions): TableData {
    const columns = Array.isArray(data.columns) ? data.columns.map((col: any, index: number) => ({
      id: col.id || `col_${index}`,
      name: col.name || `Column${index + 1}`,
      type: col.type || 'text',
      required: false
    })) : []

    const rows = Array.isArray(data.rows) ? data.rows.map((row: any, index: number) => ({
      id: row.id || `row_${index}`,
      data: row.data || row,
      createdAt: row.createdAt || new Date().toISOString()
    })) : []

    return { columns, rows, totalRows: rows.length }
  }

  /**
   * 解析键值对格式
   */
  private parseKeyValueFormat(data: Record<string, any>, options: ImportOptions): TableData {
    const columns = [
      { id: 'col_0', name: 'key', type: 'text' as const, required: false },
      { id: 'col_1', name: 'value', type: 'text' as const, required: false }
    ]

    const rows = Object.entries(data).map(([key, value], index) => ({
      id: `row_${index}`,
      data: {
        col_0: key,
        col_1: this.parseValue(value)
      },
      createdAt: new Date().toISOString()
    }))

    // 推断第二列的类型
    this.inferColumnTypes(columns, rows)

    return { columns, rows, totalRows: rows.length }
  }

  /**
   * 解析值
   */
  private parseValue(value: any): any {
    if (value === null || value === undefined) {
      return null
    }

    // 如果是对象或数组，转换为JSON字符串
    if (typeof value === 'object') {
      return JSON.stringify(value)
    }

    return value
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
      if (values.every(value => typeof value === 'boolean' ||
        (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())))) {
        column.type = 'boolean'
        continue
      }

      // 检查是否为日期
      if (values.every(value => {
        if (value instanceof Date) return true
        if (typeof value === 'string') {
          const date = new Date(value)
          return !isNaN(date.getTime())
        }
        return false
      })) {
        column.type = 'date'
        continue
      }

      // 检查是否为JSON字符串
      if (values.every(value => {
        if (typeof value !== 'string') return false
        try {
          JSON.parse(value)
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
