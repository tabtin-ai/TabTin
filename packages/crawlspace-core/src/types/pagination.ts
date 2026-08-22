/**
 * 翻页相关类型定义
 */

/**
 * 翻页间隔配置
 */
export interface PaginationIntervalConfig {
  /** 类型：固定 | 随机 */
  type: 'fixed' | 'random'

  /** 固定间隔（毫秒） */
  fixedMillis?: number

  /** 最小间隔（毫秒） */
  minMillis?: number

  /** 最大间隔（毫秒） */
  maxMillis?: number
}

/**
 * 翻页执行状态
 */
export interface PaginationExecutionState {
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed'

  /** 开始时间 */
  startedAt?: number

  /** 最后更新时间 */
  lastUpdatedAt?: number

  /** 请求的页数 */
  requestedPages?: number

  /** 成功的页数 */
  successPages?: number

  /** 错误消息 */
  errorMessage?: string

  /** 日志 */
  logs?: PaginationExecutionLog[]

  /** 遥测指标数据（来自 analytics telemetry 事件） */
  metrics?: Record<string, unknown>
}

/**
 * 翻页执行日志
 */
export interface PaginationExecutionLog {
  /** 页码（标准翻页日志必填，analytics 日志可省略） */
  page?: number

  /** 时间戳 */
  timestamp: number

  /** 翻页结果状态（标准翻页日志） */
  status?: 'success' | 'error'

  /** 日志级别（analytics 实时日志） */
  level?: 'info' | 'warn' | 'error'

  /** 消息 */
  message?: string

  /** 提取的记录数 */
  recordCount?: number

  /** 附加参数（analytics 实时日志） */
  params?: unknown[]
}







