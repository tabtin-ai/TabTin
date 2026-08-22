// 视图管理器 - 处理表格视图的创建、更新和管理

import {
  View,
  ViewType,
  ViewConfig,
  Filter,
  Sort,
  GroupBy,
  GridViewConfig,
  KanbanViewConfig,
  CalendarViewConfig,
  GalleryViewConfig
} from './types'
import { StorageAdapter } from './storage/StorageAdapter'
import { t } from './i18n'

export interface CreateViewOptions {
  name: string
  type?: ViewType
  description?: string
  createdById?: string
  filters?: Filter[]
  sorts?: Sort[]
  groups?: GroupBy[]
  visibleFields?: string[]
  fieldOrder?: string[]
  config?: ViewConfig
  isShared?: boolean
  isLocked?: boolean
  isDefault?: boolean
  order?: number
}

export interface UpdateViewOptions {
  name?: string
  description?: string
  filters?: Filter[]
  sorts?: Sort[]
  groups?: GroupBy[]
  visibleFields?: string[]
  fieldOrder?: string[]
  config?: Partial<ViewConfig>
  isShared?: boolean
  isLocked?: boolean
}

export interface ViewConfigValidationOptions {
  tableId: string
  viewType: ViewType
  config: ViewConfig
  visibleFields?: string[]
}

export interface ViewConfigValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
  suggestions: Record<string, unknown>
}

export interface ViewRecordQueryOptions {
  page?: number
  pageSize?: number
  dateRange?: { start: string; end: string }
}

export interface ViewRecordResult<T = any> {
  view: Pick<View, 'id' | 'name' | 'type' | 'config'>
  records: T[]
  total: number
  page: number
  pageSize: number
  metadata: Record<string, unknown>
}

type LegacyFilter = Filter & { columnId?: string }
type LegacySort = Sort & { columnId?: string }
type LegacyGroup = GroupBy & { columnId?: string }

export class ViewManager {
  private storage: StorageAdapter
  private views: Map<string, View[]> = new Map() // tableId -> views

  constructor(storage: StorageAdapter) {
    this.storage = storage
  }

  /**
   * 初始化视图管理器
   */
  async initialize(): Promise<void> {
    // 视图数据按表格分别加载，这里不需要预加载
  }

  /**
   * 加载指定表格的视图
   */
  private async loadTableViews(tableId: string): Promise<void> {
    try {
      const views = await this.storage.getViews(tableId)
      const normalized = views.map(view => this.normalizeView(view, tableId))
      normalized.sort((a, b) => a.order - b.order)

      // 如果没有默认视图，则将第一个视图设为默认
      if (normalized.length > 0 && !normalized.some(v => v.isDefault)) {
        normalized[0].isDefault = true
      }

      this.views.set(tableId, normalized)
    } catch (error) {
      console.log(`No existing views for table ${tableId}`)
      this.views.set(tableId, [])
    }
  }

  /**
   * 保存表格视图
   */
  private async saveTableViews(tableId: string): Promise<void> {
    const views = this.views.get(tableId) || []
    const ordered = [...views].sort((a, b) => a.order - b.order)
    await this.storage.saveViews(tableId, ordered)
  }

  /**
   * 创建新视图
   */
  async createView(tableId: string, options: CreateViewOptions): Promise<View> {
    if (!options.name?.trim()) {
      throw new Error(t('errors.viewNameRequired'))
    }

    if (!this.views.has(tableId)) {
      await this.loadTableViews(tableId)
    }

    const tableViews = this.views.get(tableId) || []
    const now = new Date().toISOString()
    const order = options.order ?? this.getNextOrder(tableViews)

    const view: View = {
      id: `view_${Date.now()}`,
      tableId,
      name: options.name,
      type: options.type ?? 'grid',
      description: options.description,
      createdById: options.createdById,
      filters: (options.filters ?? []).map(f => this.normalizeFilter(f)),
      sorts: (options.sorts ?? []).map(s => this.normalizeSort(s)),
      groups: (options.groups ?? []).map(g => this.normalizeGroup(g)),
      visibleFields: options.visibleFields ?? [],
      fieldOrder: options.fieldOrder ?? [],
      config: options.config ?? this.getDefaultConfig(options.type),
      isShared: options.isShared ?? false,
      isLocked: options.isLocked ?? false,
      isDefault: options.isDefault ?? tableViews.length === 0,
      order,
      createdAt: now,
      updatedAt: now
    }

    if (view.isDefault) {
      tableViews.forEach(v => (v.isDefault = false))
    }

    tableViews.push(view)
    tableViews.sort((a, b) => a.order - b.order)
    this.views.set(tableId, tableViews)

    await this.saveTableViews(tableId)
    return view
  }

  /**
   * 获取表格的所有视图
   */
  async getTableViews(tableId: string): Promise<View[]> {
    if (!this.views.has(tableId)) {
      await this.loadTableViews(tableId)
    }
    return this.views.get(tableId) || []
  }

  /**
   * 获取指定视图
   */
  async getView(tableId: string, viewId: string): Promise<View | null> {
    const tableViews = await this.getTableViews(tableId)
    return tableViews.find(view => view.id === viewId) || null
  }

  /**
   * 更新视图基础信息
   */
  async updateView(tableId: string, viewId: string, updates: UpdateViewOptions): Promise<View | null> {
    const tableViews = await this.getTableViews(tableId)
    const view = tableViews.find(v => v.id === viewId)

    if (!view) return null
    if (view.isLocked && updates.isLocked === undefined && (updates.name || updates.description || updates.filters || updates.sorts || updates.groups || updates.visibleFields || updates.fieldOrder || updates.config)) {
      throw new Error(t('errors.viewLocked'))
    }

    if (updates.name !== undefined) {
      view.name = updates.name
    }
    if (updates.description !== undefined) {
      view.description = updates.description
    }
    if (updates.filters !== undefined) {
      view.filters = updates.filters.map(f => this.normalizeFilter(f))
    }
    if (updates.sorts !== undefined) {
      view.sorts = updates.sorts.map(s => this.normalizeSort(s))
    }
    if (updates.groups !== undefined) {
      view.groups = updates.groups.map(g => this.normalizeGroup(g))
    }
    if (updates.visibleFields !== undefined) {
      view.visibleFields = updates.visibleFields
    }
    if (updates.fieldOrder !== undefined) {
      view.fieldOrder = updates.fieldOrder
    }
    if (updates.config !== undefined) {
      view.config = { ...(view.config || {}), ...updates.config }
    }
    if (updates.isShared !== undefined) {
      view.isShared = updates.isShared
    }
    if (updates.isLocked !== undefined) {
      view.isLocked = updates.isLocked
    }

    view.updatedAt = new Date().toISOString()

    await this.saveTableViews(tableId)
    return view
  }

  /**
   * 更新视图配置
   */
  async updateViewConfig(tableId: string, viewId: string, config: Partial<ViewConfig>): Promise<boolean> {
    const result = await this.updateView(tableId, viewId, { config })
    return result !== null
  }

  /**
   * 添加筛选器到视图
   */
  async addFilter(tableId: string, viewId: string, filter: Filter): Promise<boolean> {
    const tableViews = await this.getTableViews(tableId)
    const view = tableViews.find(v => v.id === viewId)

    if (!view) return false

    view.filters.push(this.normalizeFilter(filter))
    view.updatedAt = new Date().toISOString()

    await this.saveTableViews(tableId)
    return true
  }

  /**
   * 移除筛选器
   */
  async removeFilter(tableId: string, viewId: string, filterId: string): Promise<boolean> {
    const tableViews = await this.getTableViews(tableId)
    const view = tableViews.find(v => v.id === viewId)

    if (!view) return false

    const filterIndex = view.filters.findIndex(f => f.id === filterId)
    if (filterIndex === -1) return false

    view.filters.splice(filterIndex, 1)
    view.updatedAt = new Date().toISOString()

    await this.saveTableViews(tableId)
    return true
  }

  /**
   * 更新筛选器
   */
  async updateFilter(tableId: string, viewId: string, filterId: string, updates: Partial<Filter>): Promise<boolean> {
    const tableViews = await this.getTableViews(tableId)
    const view = tableViews.find(v => v.id === viewId)

    if (!view) return false

    const filter = view.filters.find(f => f.id === filterId)
    if (!filter) return false

    Object.assign(filter, this.normalizeFilter({ ...filter, ...updates }))
    view.updatedAt = new Date().toISOString()

    await this.saveTableViews(tableId)
    return true
  }

  /**
   * 设置排序规则
   */
  async setSorts(tableId: string, viewId: string, sorts: Sort[]): Promise<boolean> {
    const tableViews = await this.getTableViews(tableId)
    const view = tableViews.find(v => v.id === viewId)

    if (!view) return false

    view.sorts = sorts.map(s => this.normalizeSort(s))
    view.updatedAt = new Date().toISOString()

    await this.saveTableViews(tableId)
    return true
  }

  /**
   * 设置分组规则（兼容旧名称）
   */
  async setGroupBy(tableId: string, viewId: string, groupBy: GroupBy[]): Promise<boolean> {
    return this.setGroups(tableId, viewId, groupBy)
  }

  /**
   * 设置视图分组
   */
  async setGroups(tableId: string, viewId: string, groups: GroupBy[]): Promise<boolean> {
    const tableViews = await this.getTableViews(tableId)
    const view = tableViews.find(v => v.id === viewId)

    if (!view) return false

    view.groups = groups.map(g => this.normalizeGroup(g))
    view.updatedAt = new Date().toISOString()

    await this.saveTableViews(tableId)
    return true
  }

  /**
   * 设置默认视图
   */
  async setDefaultView(tableId: string, viewId: string): Promise<boolean> {
    const tableViews = await this.getTableViews(tableId)
    const target = tableViews.find(v => v.id === viewId)
    if (!target) return false

    tableViews.forEach(v => {
      v.isDefault = v.id === viewId
    })
    await this.saveTableViews(tableId)
    return true
  }

  /**
   * 调整视图顺序
   */
  async reorderViews(tableId: string, viewOrders: Array<{ viewId: string; order: number }>): Promise<void> {
    const tableViews = await this.getTableViews(tableId)
    const orderMap = new Map(viewOrders.map(item => [item.viewId, item.order]))

    tableViews.forEach(view => {
      const newOrder = orderMap.get(view.id)
      if (typeof newOrder === 'number') {
        view.order = newOrder
      }
    })

    tableViews.sort((a, b) => a.order - b.order)
    await this.saveTableViews(tableId)
  }

  /**
   * 删除视图
   */
  async deleteView(tableId: string, viewId: string): Promise<boolean> {
    const tableViews = await this.getTableViews(tableId)
    const viewIndex = tableViews.findIndex(v => v.id === viewId)

    if (viewIndex === -1) return false
    if (tableViews[viewIndex].isDefault) {
      throw new Error(t('errors.defaultViewDelete'))
    }

    tableViews.splice(viewIndex, 1)

    // 确保仍然有默认视图
    if (tableViews.length > 0 && !tableViews.some(v => v.isDefault)) {
      tableViews[0].isDefault = true
    }

    await this.saveTableViews(tableId)
    return true
  }

  /**
   * 复制视图
   */
  async duplicateView(tableId: string, viewId: string, newName: string): Promise<View | null> {
    const originalView = await this.getView(tableId, viewId)
    if (!originalView) return null

    const tableViews = await this.getTableViews(tableId)
    const now = new Date().toISOString()
    const duplicatedView: View = {
      ...originalView,
      id: `view_${Date.now()}`,
      name: newName,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      order: this.getNextOrder(tableViews)
    }

    tableViews.push(duplicatedView)
    tableViews.sort((a, b) => a.order - b.order)
    await this.saveTableViews(tableId)

    return duplicatedView
  }

  /**
   * 验证视图配置
   */
  validateViewConfig(options: ViewConfigValidationOptions): ViewConfigValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    const suggestions: Record<string, unknown> = {}

    switch (options.viewType) {
      case 'kanban': {
        const config = options.config as KanbanViewConfig
        if (!config.groupByField) {
          errors.push('Kanban view requires groupByField')
        }
        if (!config.cardTitleField) {
          errors.push('Kanban view requires cardTitleField')
        }
        if (!config.cardCoverField) {
          warnings.push('cardCoverField is not set, cards will have no cover')
        }
        break
      }
      case 'calendar': {
        const config = options.config as CalendarViewConfig
        if (!config.dateField) {
          errors.push('Calendar view requires dateField')
        }
        if (!config.titleField) {
          errors.push('Calendar view requires titleField')
        }
        if (!config.defaultViewMode) {
          suggestions.defaultViewMode = 'month'
        }
        break
      }
      case 'gallery': {
        const config = options.config as GalleryViewConfig
        if (!config.titleField) {
          errors.push('Gallery view requires titleField')
        }
        if (!config.coverField) {
          warnings.push('coverField is not set, cards will display placeholder cover')
        }
        break
      }
      default: {
        const config = options.config as GridViewConfig
        if (!config.visibleFields || config.visibleFields.length === 0) {
          suggestions.visibleFields = options.visibleFields ?? []
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions
    }
  }

  /**
   * 获取应用视图后的数据结果
   */
  applyView<T = any>(
    data: T[],
    view: View,
    options?: ViewRecordQueryOptions
  ): ViewRecordResult<T> {
    const filtered = this.applyFilters(data, view.filters)
    const sorted = this.applySorts(filtered, view.sorts)

    let processed = sorted
    let metadata: Record<string, unknown> = {
      viewType: view.type
    }

    if (view.type === 'kanban') {
      metadata = {
        ...metadata,
        groupByField: (view.config as KanbanViewConfig)?.groupByField,
        groups: this.groupRecordsByField(sorted, (view.config as KanbanViewConfig)?.groupByField)
      }
    }

    if (view.type === 'calendar' && options?.dateRange) {
      const { start, end } = options.dateRange
      processed = sorted.filter(record => {
        const dateField = (view.config as CalendarViewConfig)?.dateField
        if (!dateField) return true
        const value = (record as Record<string, any>)[dateField]
        if (!value) return false
        return value >= start && value <= end
      })

      metadata = {
        ...metadata,
        dateRange: options.dateRange
      }
    }

    if (view.type === 'gallery') {
      metadata = {
        ...metadata,
        gridLayout: {
          cardsPerRow: (view.config as GalleryViewConfig)?.cardsPerRow ?? 'auto',
          cardSize: (view.config as GalleryViewConfig)?.cardSize ?? 'medium'
        }
      }
    }

    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? (processed.length || 1)
    const startIndex = (page - 1) * pageSize
    const paginated = processed.slice(startIndex, startIndex + pageSize)

    return {
      view: {
        id: view.id,
        name: view.name,
        type: view.type,
        config: view.config
      },
      records: paginated,
      total: processed.length,
      page,
      pageSize,
      metadata
    }
  }

  /**
   * 应用筛选器到数据
   */
  applyFilters<T = any>(data: T[], filters: Filter[]): T[] {
    if (!filters.length) return data

    return data.filter(row => {
      return filters.every(filter => {
        if (!filter.enabled) return true

        const key = filter.fieldId || (filter as LegacyFilter).columnId
        const cellValue = key ? (row as Record<string, any>)[key] : undefined
        return this.evaluateFilter(cellValue, filter)
      })
    })
  }

  /**
   * 评估单个筛选器条件
   */
  private evaluateFilter(value: any, filter: Filter): boolean {
    const { operator, value: filterValue } = filter

    switch (operator) {
      case 'equals':
        return value === filterValue
      case 'not_equals':
        return value !== filterValue
      case 'contains':
        return String(value ?? '').toLowerCase().includes(String(filterValue ?? '').toLowerCase())
      case 'not_contains':
        return !String(value ?? '').toLowerCase().includes(String(filterValue ?? '').toLowerCase())
      case 'starts_with':
        return String(value ?? '').toLowerCase().startsWith(String(filterValue ?? '').toLowerCase())
      case 'ends_with':
        return String(value ?? '').toLowerCase().endsWith(String(filterValue ?? '').toLowerCase())
      case 'greater_than':
        return Number(value) > Number(filterValue)
      case 'greater_than_or_equal':
        return Number(value) >= Number(filterValue)
      case 'less_than':
        return Number(value) < Number(filterValue)
      case 'less_than_or_equal':
        return Number(value) <= Number(filterValue)
      case 'is_empty':
        return value === null || value === undefined || value === ''
      case 'is_not_empty':
        return value !== null && value !== undefined && value !== ''
      case 'in':
        return Array.isArray(filterValue) && filterValue.includes(value)
      case 'not_in':
        return Array.isArray(filterValue) && !filterValue.includes(value)
      default:
        return true
    }
  }

  /**
   * 应用排序到数据
   */
  applySorts<T = any>(data: T[], sorts: Sort[]): T[] {
    if (!sorts.length) return data

    const prioritized = [...sorts].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))

    return [...data].sort((a, b) => {
      for (const sort of prioritized) {
        const key = sort.fieldId || (sort as LegacySort).columnId
        const aValue = key ? (a as Record<string, any>)[key] : undefined
        const bValue = key ? (b as Record<string, any>)[key] : undefined

        if (aValue === bValue) continue

        let comparison = 0
        if (aValue === undefined || aValue === null) comparison = -1
        else if (bValue === undefined || bValue === null) comparison = 1
        else if (aValue < bValue) comparison = -1
        else if (aValue > bValue) comparison = 1

        if (comparison !== 0) {
          return sort.direction === 'desc' ? -comparison : comparison
        }
      }
      return 0
    })
  }

  private groupRecordsByField<T = any>(data: T[], field?: string) {
    if (!field) {
      return []
    }

    const map = new Map<string, { groupValue: string; records: T[] }>()

    data.forEach(record => {
      const value = String((record as Record<string, any>)[field] ?? t('view.unsetValue'))
      if (!map.has(value)) {
        map.set(value, { groupValue: value, records: [] })
      }
      map.get(value)!.records.push(record)
    })

    return Array.from(map.values()).map(group => ({
      groupValue: group.groupValue,
      groupLabel: group.groupValue,
      count: group.records.length,
      records: group.records
    }))
  }

  private normalizeView(view: Partial<View>, tableId: string): View {
    const now = new Date().toISOString()
    return {
      id: view.id || `view_${Date.now()}`,
      tableId: view.tableId || tableId,
      name: view.name || t('view.unnamed'),
      type: view.type || 'grid',
      description: view.description,
      createdById: view.createdById,
      filters: (view.filters || []).map(f => this.normalizeFilter(f)),
      sorts: (view.sorts || []).map(s => this.normalizeSort(s)),
      groups: (view.groups || (view as any).groupBy || []).map((g: any) => this.normalizeGroup(g)),
      visibleFields: view.visibleFields || [],
      fieldOrder: view.fieldOrder || [],
      config: view.config || this.getDefaultConfig(view.type),
      isShared: view.isShared ?? false,
      isLocked: view.isLocked ?? false,
      isDefault: view.isDefault ?? false,
      order: typeof view.order === 'number' ? view.order : 0,
      createdAt: view.createdAt || now,
      updatedAt: view.updatedAt
    }
  }

  private normalizeFilter(filter: Partial<Filter>): Filter {
    const fieldId = filter.fieldId || (filter as LegacyFilter).columnId
    if (!fieldId) {
      throw new Error(t('errors.filterRequiresFieldId'))
    }

    return {
      id: filter.id || `filter_${Date.now()}`,
      fieldId,
      operator: filter.operator || 'equals',
      value: filter.value,
      enabled: filter.enabled ?? true
    }
  }

  private normalizeSort(sort: Partial<Sort>): Sort {
    const fieldId = sort.fieldId || (sort as LegacySort).columnId
    if (!fieldId) {
      throw new Error(t('errors.sortRequiresFieldId'))
    }

    return {
      fieldId,
      direction: sort.direction || 'asc',
      priority: sort.priority
    }
  }

  private normalizeGroup(group: Partial<GroupBy>): GroupBy {
    const fieldId = group.fieldId || (group as LegacyGroup).columnId
    if (!fieldId) {
      throw new Error(t('errors.groupRequiresFieldId'))
    }

    return {
      fieldId,
      direction: group.direction || 'asc'
    }
  }

  private getNextOrder(views: View[]): number {
    if (!views.length) return 0
    return Math.max(...views.map(v => v.order ?? 0)) + 1
  }

  private getDefaultConfig(viewType?: ViewType): ViewConfig {
    switch (viewType) {
      case 'kanban':
        return {
          groupByField: '',
          cardTitleField: ''
        } as KanbanViewConfig
      case 'calendar':
        return {
          dateField: '',
          titleField: '',
          defaultViewMode: 'month',
          showWeekends: true,
          showTime: true,
          timeFormat: '24h'
        } as CalendarViewConfig
      case 'gallery':
        return {
          titleField: '',
          cardSize: 'medium',
          cardsPerRow: 'auto',
          coverFit: 'cover'
        } as GalleryViewConfig
      default:
        return {
          visibleFields: [],
          fieldOrder: [],
          columnWidths: {}
        } as GridViewConfig
    }
  }
}
