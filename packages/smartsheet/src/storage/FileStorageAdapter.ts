// 文件系统存储适配器（Node.js 环境）

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { StorageAdapter, StorageConfig } from './StorageAdapter'
import { Cell, View, Filter } from '../types'

export class FileStorageAdapter implements StorageAdapter {
  private dataDir: string
  private projectsFile: string
  private settingsFile: string
  private cellsFile: string
  private tablesDir: string

  constructor(config: StorageConfig) {
    this.dataDir = config.dataDir
    this.projectsFile = join(this.dataDir, 'projects.json')
    this.settingsFile = join(this.dataDir, 'settings.json')
    this.cellsFile = join(this.dataDir, 'cells.json')
    this.tablesDir = join(this.dataDir, 'tables')
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true })
      await fs.mkdir(this.tablesDir, { recursive: true })
    } catch (error) {
      console.error('Failed to create data directory:', error)
      throw error
    }
  }

  async getProjects(): Promise<any[]> {
    try {
      const data = await fs.readFile(this.projectsFile, 'utf-8')
      return JSON.parse(data)
    } catch (error) {
      // 文件不存在时返回空数组
      return []
    }
  }

  async saveProjects(projects: any[]): Promise<void> {
    try {
      await fs.writeFile(this.projectsFile, JSON.stringify(projects, null, 2))
    } catch (error) {
      console.error('Failed to save projects:', error)
      throw error
    }
  }

  async getSettings(): Promise<Record<string, any>> {
    try {
      const data = await fs.readFile(this.settingsFile, 'utf-8')
      return JSON.parse(data)
    } catch (error) {
      // 文件不存在时返回空对象
      return {}
    }
  }

  async saveSettings(settings: Record<string, any>): Promise<void> {
    try {
      await fs.writeFile(this.settingsFile, JSON.stringify(settings, null, 2))
    } catch (error) {
      console.error('Failed to save settings:', error)
      throw error
    }
  }

  async getTableData(projectId: string, tableId: string): Promise<any[]> {
    try {
      const tableFile = this.getTableFilePath(projectId, tableId)
      const data = await fs.readFile(tableFile, 'utf-8')
      const parsed = JSON.parse(data)

      if (Array.isArray(parsed)) {
        // 兼容旧版本仅存数组的情况
        return parsed
      }

      if (Array.isArray(parsed.rows)) {
        return parsed.rows
      }

      return []
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return []
      }

      console.error(`Failed to read table data for ${projectId}/${tableId}:`, error)
      throw error
    }
  }

  async saveTableData(projectId: string, tableId: string, data: any[]): Promise<void> {
    const tableFile = this.getTableFilePath(projectId, tableId)
    try {
      await fs.mkdir(dirname(tableFile), { recursive: true })
      const payload = {
        rows: data,
        updatedAt: new Date().toISOString()
      }
      await fs.writeFile(tableFile, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (error) {
      console.error(`Failed to save table data for ${projectId}/${tableId}:`, error)
      throw error
    }
  }

  // 单元格操作
  async getCells(): Promise<Cell[]> {
    try {
      const data = await fs.readFile(this.cellsFile, 'utf-8')
      return JSON.parse(data)
    } catch (error) {
      return []
    }
  }

  async saveCells(cells: Cell[]): Promise<void> {
    try {
      await fs.writeFile(this.cellsFile, JSON.stringify(cells, null, 2))
    } catch (error) {
      console.error('Failed to save cells:', error)
      throw error
    }
  }

  // 视图操作
  async getViews(tableId: string): Promise<View[]> {
    try {
      const viewsFile = join(this.dataDir, `views_${tableId}.json`)
      const data = await fs.readFile(viewsFile, 'utf-8')
      return JSON.parse(data)
    } catch (error) {
      return []
    }
  }

  async saveViews(tableId: string, views: View[]): Promise<void> {
    try {
      const viewsFile = join(this.dataDir, `views_${tableId}.json`)
      await fs.writeFile(viewsFile, JSON.stringify(views, null, 2))
    } catch (error) {
      console.error('Failed to save views:', error)
      throw error
    }
  }

  // 筛选器操作
  async getFilters(viewId: string): Promise<Filter[]> {
    try {
      const filtersFile = join(this.dataDir, `filters_${viewId}.json`)
      const data = await fs.readFile(filtersFile, 'utf-8')
      return JSON.parse(data)
    } catch (error) {
      return []
    }
  }

  async saveFilters(viewId: string, filters: Filter[]): Promise<void> {
    try {
      const filtersFile = join(this.dataDir, `filters_${viewId}.json`)
      await fs.writeFile(filtersFile, JSON.stringify(filters, null, 2))
    } catch (error) {
      console.error('Failed to save filters:', error)
      throw error
    }
  }
  private getTableFilePath(projectId: string, tableId: string): string {
    return join(this.tablesDir, projectId, `${tableId}.json`)
  }
}
