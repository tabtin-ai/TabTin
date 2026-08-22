// 核心数据类型定义

export interface Project {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt?: string
  tables: Table[]
  settings: ProjectSettings
}

export interface ProjectSettings {
  autoSave: boolean
  exportFormat: 'csv' | 'json' | 'xlsx'
  maxRows: number
}

export interface Table {
  id: string
  name: string
  projectId: string
  columns: TableColumn[]
  rowCount: number
  createdAt: string
  lastModified: string
}

export interface TableColumn {
  id: string
  name: string
  type: ColumnType
  required: boolean
  defaultValue?: any
  description?: string
}

export type ColumnType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'url'
  | 'email'
  | 'json'

export interface TableRow {
  id: string
  data: Record<string, any>
  createdAt: string
  updatedAt?: string
}

export interface TableData {
  columns: TableColumn[]
  rows: TableRow[]
  totalRows?: number
}

// 单元格类型
export interface Cell {
  id: string
  tableId: string
  rowId: string
  columnId: string
  value: any
  formattedValue?: string
  style?: CellStyle
  validation?: CellValidation
  comment?: string
  createdAt: string
  updatedAt?: string
}

export interface CellStyle {
  backgroundColor?: string
  textColor?: string
  fontSize?: number
  fontWeight?: 'normal' | 'bold'
  fontStyle?: 'normal' | 'italic'
  textAlign?: 'left' | 'center' | 'right'
  border?: BorderStyle
}

export interface BorderStyle {
  top?: string
  right?: string
  bottom?: string
  left?: string
}

export interface CellValidation {
  type: 'required' | 'range' | 'list' | 'regex' | 'custom'
  rule: any
  message?: string
}

// 视图类型
export type ViewType = 'grid' | 'kanban' | 'calendar' | 'gallery' | 'pivot'

export interface GridViewConfig {
  visibleFields?: string[]
  fieldOrder?: string[]
  columnWidths?: Record<string, number>
  rowHeight?: number
  showRowNumbers?: boolean
  freezeColumns?: number
  freezeRows?: number
}

export interface KanbanViewConfig {
  groupByField: string
  cardTitleField: string
  cardCoverField?: string
  visibleFields?: string[]
}

export interface CalendarViewConfig {
  dateField: string
  titleField: string
  endDateField?: string
  defaultViewMode?: 'month' | 'week' | 'day' | 'agenda'
  showWeekends?: boolean
  firstDayOfWeek?: 0 | 1
  timeFormat?: '12h' | '24h'
  showTime?: boolean
  colorByField?: string
}

export interface GalleryViewConfig {
  titleField: string
  coverField?: string
  descriptionField?: string
  visibleFields?: string[]
  cardSize?: 'small' | 'medium' | 'large'
  cardAspectRatio?: '1:1' | '4:3' | '16:9' | 'custom'
  cardsPerRow?: 'auto' | number
  coverFit?: 'cover' | 'contain' | 'fill'
}

export type ViewConfig =
  | GridViewConfig
  | KanbanViewConfig
  | CalendarViewConfig
  | GalleryViewConfig
  | Record<string, any>

export interface Filter {
  id: string
  fieldId: string
  operator: FilterOperator
  value: any
  enabled: boolean
}

export type FilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in'

export interface Sort {
  fieldId: string
  direction: 'asc' | 'desc'
  priority?: number
}

export interface GroupBy {
  fieldId: string
  direction: 'asc' | 'desc'
}

export interface View {
  id: string
  name: string
  tableId: string
  type: ViewType
  description?: string
  createdById?: string
  filters: Filter[]
  sorts: Sort[]
  groups: GroupBy[]
  visibleFields: string[]
  fieldOrder: string[]
  config: ViewConfig
  isShared: boolean
  isLocked: boolean
  isDefault?: boolean
  order: number
  createdAt: string
  updatedAt?: string
}

// API 相关类型
export interface CreateProjectResult {
  id: string
  name: string
  createdAt: string
}

export interface CreateTableResult {
  id: string
  name: string
  columns: string[]
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: string
  tables: string[]
}

export interface TableSummary {
  id: string
  name: string
  columns: string[]
  rowCount: number
}

// 配置类型
export interface SmartSheetConfig {
  dataDir?: string
  autoSave?: boolean
  maxRows?: number
}

// 导入导出类型
export interface ImportOptions {
  format: 'csv' | 'json' | 'xlsx'
  encoding?: string
  delimiter?: string
  hasHeaders?: boolean
  sheetName?: string
  maxRows?: number
  projectId?: string
  tableId?: string
  saveToStorage?: boolean
}

export interface ExportOptions {
  format: 'csv' | 'json' | 'xlsx'
  filePath?: string
  filename?: string
  encoding?: string
  delimiter?: string
  includeHeaders?: boolean
  sheetName?: string
  dateFormat?: string
  pretty?: boolean
  jsonStructure?: 'array' | 'table' | 'keyValue'
  useColumnIds?: boolean
  includeMetadata?: boolean
  autoWidth?: boolean
  styling?: boolean
}

export interface ImportResult {
  success: boolean
  data?: TableData
  rowsImported?: number
  error?: string
  metadata?: any
}

export interface ExportResult {
  success: boolean
  filePath?: string
  rowsExported?: number
  fileSize?: number
  error?: string
  metadata?: any
}

export interface Importer {
  readonly format: string
  import(filePath: string, options: ImportOptions): Promise<ImportResult>
  preview(filePath: string, options: ImportOptions): Promise<TableData | null>
  validateOptions(options: ImportOptions): boolean
}

export interface Exporter {
  readonly format: string
  export(data: TableData, options: ExportOptions): Promise<ExportResult>
  validateOptions(options: ExportOptions): boolean
}
