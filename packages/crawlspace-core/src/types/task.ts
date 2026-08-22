/**
 * 任务相关类型定义
 */

import type { RecommendationOption } from './recommendation'
import type { PaginationExecutionState } from './pagination'

/**
 * 任务阶段类型
 */
export type TaskStage = 'config' | 'executing' | 'mapping' | 'completed'

/**
 * 任务状态
 */
export type TaskStatus =
  | 'idle'        // 空闲
  | 'pending'     // 等待中
  | 'running'     // 运行中
  | 'paused'      // 已暂停
  | 'completed'   // 已完成
  | 'failed'      // 失败
  | 'cancelled'   // 已取消

/**
 * 任务暂停信息
 */
export interface TaskPauseInfo {
  /** 暂停原因 */
  reason: string

  /** 暂停消息 */
  message: string

  /** 暂停时间 */
  pausedAt: number

  /** 是否允许重试 */
  allowRetry: boolean

  /** 翻页信息 */
  paginationInfo?: Record<string, unknown>

  /** 翻页策略 */
  paginationStrategy?: Record<string, unknown>

  /** 推荐选项 */
  recommendations?: RecommendationOption[]

  /** 上下文 */
  context?: Record<string, unknown>
}

/**
 * 任务状态信息
 */
export interface TaskState {
  /** 任务 ID */
  taskId: string | null

  /** 任务状态 */
  status: TaskStatus

  /** 当前阶段 */
  stage?: TaskStage

  /** 当前步骤 */
  currentStep?: string

  /** 进度 (0-100) */
  progress?: number

  /** 错误信息 */
  error?: string

  /** 暂停信息 */
  pauseInfo?: TaskPauseInfo

  /** 已提取的数据 */
  extractedData?: Record<string, unknown>[]

  /** 提取结果中的 Schema（由 task.result.extract.schema 填充） */
  schema?: unknown

  /** 翻页执行状态 */
  paginationExecution?: PaginationExecutionState

  /** 元数据 */
  metadata?: Record<string, unknown>
}

/**
 * 完整的任务配置（传入 execute / adapter.create）
 */
export type FullTaskConfig = Record<string, unknown>



