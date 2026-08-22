// SmartSheet 核心业务逻辑类

import {
  Project,
  Table,
  ProjectSettings,
  SmartSheetConfig,
  CreateProjectResult,
  CreateTableResult,
  ProjectSummary,
  TableSummary,
  Cell,
  View
} from './types'
import { StorageAdapter } from './storage/StorageAdapter'
import { t } from './i18n'
import { CellManager } from './CellManager'
import { ViewManager } from './ViewManager'
import { ImportExportManager } from './ImportExportManager'

export class SmartSheet {
  private storage: StorageAdapter
  private projects: Project[] = []
  private settings: Record<string, any> = {}

  // 新增的管理器
  public readonly cellManager: CellManager
  public readonly viewManager: ViewManager
  public readonly importExportManager: ImportExportManager

  constructor(storage: StorageAdapter) {
    this.storage = storage
    this.cellManager = new CellManager(storage)
    this.viewManager = new ViewManager(storage)
    this.importExportManager = new ImportExportManager(storage)
  }

  async initialize(): Promise<void> {
    await this.storage.initialize()
    await this.loadProjects()
    await this.loadSettings()

    // 初始化所有管理器
    await this.cellManager.initialize()
    await this.viewManager.initialize()
  }

  private async loadProjects(): Promise<void> {
    try {
      this.projects = await this.storage.getProjects()
    } catch (error) {
      console.log('No existing projects, starting with empty array')
      this.projects = []
    }
  }

  private async saveProjects(): Promise<void> {
    await this.storage.saveProjects(this.projects)
  }

  private async loadSettings(): Promise<void> {
    try {
      this.settings = await this.storage.getSettings()
    } catch (error) {
      console.log('No existing settings, using defaults')
      this.settings = {}
    }
  }

  private async saveSettings(): Promise<void> {
    await this.storage.saveSettings(this.settings)
  }

  // 项目管理
  async createProject(name: string, description?: string): Promise<CreateProjectResult> {
    const project: Project = {
      id: `project_${Date.now()}`,
      name,
      description,
      createdAt: new Date().toISOString(),
      tables: [],
      settings: {
        autoSave: true,
        exportFormat: 'csv',
        maxRows: 10000
      }
    }

    this.projects.push(project)
    await this.saveProjects()

    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt
    }
  }

  async getProjects(): Promise<ProjectSummary[]> {
    return this.projects.map(project => ({
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      tables: project.tables.map((t: Table) => t.name)
    }))
  }

  async getProject(id: string): Promise<Project | null> {
    return this.projects.find(p => p.id === id) || null
  }

  async deleteProject(id: string): Promise<boolean> {
    const index = this.projects.findIndex(p => p.id === id)
    if (index === -1) return false

    this.projects.splice(index, 1)
    await this.saveProjects()
    return true
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<boolean> {
    const project = this.projects.find(p => p.id === id)
    if (!project) return false

    Object.assign(project, updates, { updatedAt: new Date().toISOString() })
    await this.saveProjects()
    return true
  }

  // 表格管理
  async createTable(projectId: string, tableName: string): Promise<CreateTableResult> {
    const project = this.projects.find(p => p.id === projectId)
    if (!project) {
      throw new Error(t('errors.projectNotFound', { id: projectId }))
    }

    const table: Table = {
      id: `table_${Date.now()}`,
      name: tableName,
      projectId,
      columns: [
        { id: 'col_1', name: t('defaults.columnName', { index: 1 }), type: 'text', required: false },
        { id: 'col_2', name: t('defaults.columnName', { index: 2 }), type: 'text', required: false }
      ],
      rowCount: 0,
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString()
    }

    project.tables.push(table)
    await this.saveProjects()

    return {
      id: table.id,
      name: table.name,
      columns: table.columns.map((c: any) => c.name)
    }
  }

  async getTables(projectId: string): Promise<TableSummary[]> {
    const project = this.projects.find(p => p.id === projectId)
    if (!project) return []

    return project.tables.map((table: Table) => ({
      id: table.id,
      name: table.name,
      columns: table.columns.map((c: any) => c.name),
      rowCount: table.rowCount
    }))
  }

  async getTable(projectId: string, tableId: string): Promise<Table | null> {
    const project = this.projects.find(p => p.id === projectId)
    if (!project) return null

    return project.tables.find((t: Table) => t.id === tableId) || null
  }

  async deleteTable(projectId: string, tableId: string): Promise<boolean> {
    const project = this.projects.find(p => p.id === projectId)
    if (!project) return false

    const index = project.tables.findIndex((t: Table) => t.id === tableId)
    if (index === -1) return false

    project.tables.splice(index, 1)
    await this.saveProjects()
    return true
  }

  // 数据操作
  async getTableData(projectId: string, tableId: string): Promise<Array<Record<string, any>>> {
    return await this.storage.getTableData(projectId, tableId)
  }

  async updateTableData(projectId: string, tableId: string, data: Array<Record<string, any>>): Promise<boolean> {
    const project = this.projects.find(p => p.id === projectId)
    if (!project) return false

    const table = project.tables.find(t => t.id === tableId)
    if (!table) return false

    // 更新表格元数据
    table.rowCount = data.length
    table.lastModified = new Date().toISOString()

    // 保存项目信息和数据
    await Promise.all([
      this.saveProjects(),
      this.storage.saveTableData(projectId, tableId, data)
    ])

    return true
  }

  async exportTableData(projectId: string, tableId: string, format: 'csv' | 'json' | 'xlsx', options?: any): Promise<string> {
    try {
      const exportOptions = {
        format,
        includeHeaders: true,
        ...options
      }

      const result = await this.importExportManager.exportTableFromStorage(projectId, tableId, exportOptions)

      if (result.success && result.filePath) {
        return result.filePath
      } else {
        throw new Error(result.error || t('export.failed'))
      }
    } catch (error) {
      console.error(`Failed to export table ${tableId}:`, error)
      throw error
    }
  }

  // 导入数据到表格
  async importTableData(projectId: string, tableId: string, filePath: string, options: any): Promise<boolean> {
    try {
      const importOptions = {
        ...options,
        projectId,
        tableId,
        saveToStorage: true
      }

      const result = await this.importExportManager.importData(filePath, importOptions)
      if (result.success) {
        // 重新加载项目信息以同步最新行数和更新时间
        await this.loadProjects()
      }
      return result.success
    } catch (error) {
      console.error(`Failed to import data to table ${tableId}:`, error)
      throw error
    }
  }

  // 预览导入数据
  async previewImportData(filePath: string, options: any): Promise<any> {
    try {
      return await this.importExportManager.previewImport(filePath, options)
    } catch (error) {
      console.error('Failed to preview import data:', error)
      throw error
    }
  }

  // 获取支持的导入导出格式
  getSupportedFormats(): { import: string[], export: string[] } {
    return {
      import: this.importExportManager.getSupportedImportFormats(),
      export: this.importExportManager.getSupportedExportFormats()
    }
  }

  // 获取Excel工作表列表
  async getExcelSheetNames(filePath: string): Promise<string[]> {
    try {
      return await this.importExportManager.getExcelSheetNames(filePath)
    } catch (error) {
      console.error('Failed to get Excel sheet names:', error)
      return []
    }
  }

  // 设置管理
  async getSettings(): Promise<Record<string, any>> {
    return { ...this.settings }
  }

  async updateSettings(newSettings: Record<string, any>): Promise<boolean> {
    this.settings = { ...this.settings, ...newSettings }
    await this.saveSettings()
    return true
  }
}
