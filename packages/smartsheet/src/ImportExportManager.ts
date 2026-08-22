// 导入导出管理器
// 统一管理所有导入导出功能

import { StorageAdapter } from './storage/StorageAdapter'
import { CsvImporter, XlsxImporter } from './importers'
import { CsvExporter, XlsxExporter } from './exporters'
import {
  ImportResult,
  ExportResult,
  ImportOptions,
  ExportOptions,
  Importer,
  Exporter,
  TableData,
  Project,
  Table,
  TableColumn
} from './types'
import { t } from './i18n'

/**
 * 导入导出管理器
 * 统一管理所有导入导出功能
 */
export class ImportExportManager {
  private storage: StorageAdapter
  private importers: Map<string, Importer> = new Map()
  private exporters: Map<string, Exporter> = new Map()

  constructor(storage: StorageAdapter) {
    this.storage = storage
    this.initializeHandlers()
  }

  /**
   * 初始化导入导出处理器
   */
  private initializeHandlers(): void {
    // 注册导入器
    const csvImporter = new CsvImporter()
    const xlsxImporter = new XlsxImporter()

    this.importers.set(csvImporter.format, csvImporter)
    this.importers.set(xlsxImporter.format, xlsxImporter)

    // 注册导出器
    const csvExporter = new CsvExporter()
    const xlsxExporter = new XlsxExporter()

    this.exporters.set(csvExporter.format, csvExporter)
    this.exporters.set(xlsxExporter.format, xlsxExporter)
  }

  /**
   * 导入数据
   */
  async importData(filePath: string, options: ImportOptions): Promise<ImportResult> {
    try {
      const importer = this.importers.get(options.format)
      if (!importer) {
        return {
          success: false,
          error: t('import.unsupportedFormat', { format: options.format })
        }
      }

      // 验证选项
      if (!importer.validateOptions(options)) {
        return {
          success: false,
          error: t('import.optionsInvalid')
        }
      }

      // 执行导入
      const result = await importer.import(filePath, options)

      // 如果导入成功且需要保存到存储
      if (result.success && result.data && options.saveToStorage) {
        await this.saveImportedData(result.data, options)
      }

      return result
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('import.unknownError')
      }
    }
  }

  /**
   * 预览导入数据
   */
  async previewImport(filePath: string, options: ImportOptions): Promise<TableData | null> {
    try {
      const importer = this.importers.get(options.format)
      if (!importer) {
        return null
      }

      return await importer.preview(filePath, options)
    } catch (error) {
      console.error(t('import.previewFailed'), error)
      return null
    }
  }

  /**
   * 导出数据
   */
  async exportData(data: TableData, options: ExportOptions): Promise<ExportResult> {
    try {
      const exporter = this.exporters.get(options.format)
      if (!exporter) {
        return {
          success: false,
          error: t('export.unsupportedFormat', { format: options.format })
        }
      }

      // 验证选项
      if (!exporter.validateOptions(options)) {
        return {
          success: false,
          error: t('export.optionsInvalid')
        }
      }

      // 执行导出
      return await exporter.export(data, options)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('export.unknownError')
      }
    }
  }

  /**
   * 从存储导出表格数据
   */
  async exportTableFromStorage(projectId: string, tableId: string, options: ExportOptions): Promise<ExportResult> {
    try {
      // 从存储获取表格数据
      const tableData = await this.getTableDataFromStorage(projectId, tableId)
      if (!tableData) {
        return {
          success: false,
          error: t('export.tableDataMissing')
        }
      }

      return await this.exportData(tableData, options)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('export.storageError')
      }
    }
  }

  /**
   * 获取支持的导入格式
   */
  getSupportedImportFormats(): string[] {
    return Array.from(this.importers.keys())
  }

  /**
   * 获取支持的导出格式
   */
  getSupportedExportFormats(): string[] {
    return Array.from(this.exporters.keys())
  }

  /**
   * 获取Excel文件的工作表列表
   */
  async getExcelSheetNames(filePath: string): Promise<string[]> {
    try {
      const xlsxImporter = this.importers.get('xlsx') as XlsxImporter
      if (!xlsxImporter) {
        return []
      }

      return await xlsxImporter.getSheetNames(filePath)
    } catch (error) {
      console.error('获取Excel工作表列表失败:', error)
      return []
    }
  }

  /**
   * 导出多个工作表到Excel
   */
  async exportMultipleSheets(sheets: Array<{ name: string; data: TableData }>, options: ExportOptions): Promise<ExportResult> {
    try {
      const xlsxExporter = this.exporters.get('xlsx') as XlsxExporter
      if (!xlsxExporter) {
        return {
          success: false,
          error: t('export.multiSheetUnsupported')
        }
      }

      return await xlsxExporter.exportMultipleSheets(sheets, options)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : t('export.multiSheetError')
      }
    }
  }

  /**
   * 注册自定义导入器
   */
  registerImporter(importer: Importer): void {
    this.importers.set(importer.format, importer)
  }

  /**
   * 注册自定义导出器
   */
  registerExporter(exporter: Exporter): void {
    this.exporters.set(exporter.format, exporter)
  }

  /**
   * 保存导入的数据到存储
   */
  private async saveImportedData(data: TableData, options: ImportOptions): Promise<void> {
    if (!options.projectId || !options.tableId) {
      return
    }

    try {
      // 将数据转换为存储格式
      const storageData = data.rows.map(row => row.data)
      await this.storage.saveTableData(options.projectId, options.tableId, storageData)
      await this.updateTableMetadata(options.projectId, options.tableId, {
        rowCount: storageData.length,
        lastModified: new Date().toISOString()
      })
    } catch (error) {
      console.error('保存导入数据失败:', error)
      throw error
    }
  }

  /**
   * 从存储获取表格数据
   */
  private async getTableDataFromStorage(projectId: string, tableId: string): Promise<TableData | null> {
    try {
      // 读取存储中的行数据
      const rawData = await this.storage.getTableData(projectId, tableId)
      const columns = await this.getTableColumns(projectId, tableId, rawData)

      const rows = rawData.map((record, index) => ({
        id: `${tableId}_row_${index}`,
        data: record,
        createdAt: new Date().toISOString()
      }))

      return { columns, rows, totalRows: rows.length }
    } catch (error) {
      console.error('从存储获取表格数据失败:', error)
      return null
    }
  }

  /**
   * 获取表格列定义，优先从项目元数据读取
   */
  private async getTableColumns(projectId: string, tableId: string, rows: any[]): Promise<TableColumn[]> {
    const projects = (await this.storage.getProjects()) as Project[]
    const project = projects.find(p => p.id === projectId)
    const table = project?.tables?.find((t: Table) => t.id === tableId)

    if (table?.columns?.length) {
      return table.columns
    }

    // 根据数据推断列定义
    const firstRow = rows[0] || {}
    return Object.keys(firstRow).map((key, index) => ({
      id: key,
      name: key,
      type: typeof firstRow[key] === 'number' ? 'number' : 'text',
      required: false
    }))
  }

  /**
   * 更新表格元数据，如行数、更新时间等
   */
  private async updateTableMetadata(
    projectId: string,
    tableId: string,
    metadata: { rowCount?: number; lastModified?: string }
  ): Promise<void> {
    try {
      const projects = (await this.storage.getProjects()) as Project[]
      const projectIndex = projects.findIndex(project => project.id === projectId)
      if (projectIndex === -1) return

      const project = projects[projectIndex]
      const tableIndex = project.tables.findIndex((table: Table) => table.id === tableId)
      if (tableIndex === -1) return

      const targetTable = project.tables[tableIndex]
      const updatedTable = {
        ...targetTable,
        ...(metadata.rowCount !== undefined ? { rowCount: metadata.rowCount } : {}),
        ...(metadata.lastModified ? { lastModified: metadata.lastModified } : {})
      }

      projects[projectIndex] = {
        ...project,
        tables: [
          ...project.tables.slice(0, tableIndex),
          updatedTable,
          ...project.tables.slice(tableIndex + 1)
        ]
      }

      await this.storage.saveProjects(projects)
    } catch (error) {
      console.error('更新表格元数据失败:', error)
    }
  }
}
