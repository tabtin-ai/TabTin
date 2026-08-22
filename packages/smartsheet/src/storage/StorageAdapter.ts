// 存储适配器接口

import { Cell, View, Filter } from '../types'

export interface StorageAdapter {
  // 初始化
  initialize(): Promise<void>

  // 项目操作
  getProjects(): Promise<any[]>
  saveProjects(projects: any[]): Promise<void>

  // 设置操作
  getSettings(): Promise<Record<string, any>>
  saveSettings(settings: Record<string, any>): Promise<void>

  // 表格数据操作
  getTableData(projectId: string, tableId: string): Promise<any[]>
  saveTableData(projectId: string, tableId: string, data: any[]): Promise<void>

  // 单元格操作
  getCells(): Promise<Cell[]>
  saveCells(cells: Cell[]): Promise<void>

  // 视图操作
  getViews(tableId: string): Promise<View[]>
  saveViews(tableId: string, views: View[]): Promise<void>

  // 筛选器操作
  getFilters(viewId: string): Promise<Filter[]>
  saveFilters(viewId: string, filters: Filter[]): Promise<void>
}

export interface StorageConfig {
  dataDir: string
}
