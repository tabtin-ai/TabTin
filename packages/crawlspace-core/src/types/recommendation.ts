/**
 * 推荐相关类型定义
 *
 * 这些类型用于推荐对话框和推荐选择逻辑
 */

/**
 * 推荐案例类型
 */
export type RecommendationCaseType =
  | 'direct_extract'    // 可直接抽取
  | 'auth_required'     // 需要登录
  | 'captcha'           // 触发验证码
  | 'action_required'   // 需要操作
  | 'empty_content'     // 页面内容为空
  | 'unsupported'       // 暂不支持

/**
 * 目标区域
 */
export interface TargetRegion {
  /** 容器选择器 */
  container_selector?: string

  /** 项目选择器 */
  item_selector?: string

  /** 描述 */
  description?: string

  /** Skeleton 路径 */
  skeleton_path?: string | null

  /** 通用选择器（兼容） */
  selector?: string
}

/**
 * 推荐选项
 */
export interface RecommendationOption {
  /** 推荐 ID */
  id: string

  /** 标题 */
  title: string

  /** 置信度 (0-1) */
  confidence: number

  /** 目标区域 */
  target_region?: TargetRegion

  /** 区域类型 */
  region_type?: 'list' | 'table' | 'detail' | 'form'
}

/**
 * 推荐统计信息
 */
export interface RecommendationStats {
  /** 请求时间戳 */
  requestTime: number

  /** 响应时间戳 */
  responseTime: number

  /** 总耗时（毫秒） */
  totalDuration: number

  /** 是否来自缓存 */
  fromCache: boolean

  /** HTTP 状态码 */
  statusCode: number

  /** 重试次数 */
  retryCount?: number
}

/**
 * 推荐元数据
 */
export interface RecommendationMetadata {
  /** 生成时间 */
  generatedAt?: number

  /** 推荐列表 */
  recommendations?: RecommendationOption[]

  /** 统计信息 */
  stats?: RecommendationStats

  /** 案例类型 */
  caseType?: RecommendationCaseType

  /** 页面信息 */
  pageInfo?: Record<string, any>

  /** 阻止原因 */
  blockedReason?: string

  /** 诊断提示 */
  diagnosisHint?: string

  /** 选中的 ID */
  selectedId?: string

  /** 选中的指令 */
  selectedInstruction?: string

  /** 选择类型 */
  selectionType?: string

  /** 选择来源 */
  selectionSource?: string

  /** 其他元数据 */
  metadata?: Record<string, any>
}

/**
 * 推荐选择上下文
 */
export interface RecommendationSelectionContext {
  /** 选择类型 */
  type?: string

  /** 选择来源 */
  source?: string

  /** Schema */
  schema?: any

  /** Skeleton HTML */
  skeletonHtml?: string

  /** Cleaned HTML */
  cleanedHtml?: string

  /** 预处理统计 */
  preprocessingStats?: Record<string, any>

  /** Schema 统计 */
  schemaStats?: Record<string, any>

  /** Schema 生成时间 */
  schemaGeneratedAt?: number

  /** 应用时间 */
  appliedAt?: number

  /** 元数据 */
  metadata?: Record<string, any>

  /** 滚动探测结果 */
  scrollProbe?: any

  /** 翻页策略 */
  paginationStrategy?: any
}







