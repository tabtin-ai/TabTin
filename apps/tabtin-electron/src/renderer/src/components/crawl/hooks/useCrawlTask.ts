/**
 * 抓取任务管理 Hook
 *
 * 职责：
 * - 创建和管理任务
 * - 监听任务状态变化
 * - 控制任务生命周期（暂停、恢复、取消）
 * - 处理任务结果
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  SimpleTaskConfig,
  TaskState,
  TaskStage,
  PaginationExecutionState,
  PaginationExecutionLog,
  ExtractionSelectionType,
  PaginationIntervalConfig,
  FieldConfig
} from '../types'
import { convertToFullTaskConfig } from '../utils/taskHelpers'
import { taskApiClient } from '@/crawlspace/electron/task-api-client'
import i18n from '@/i18n'
import {
  MAX_PAGINATION_LOG_ENTRIES,
  normalizeRecommendationMetadata,
  normalizePaginationExecution,
  normalizePauseInfo,
  normalizeStrategyMetadata,
} from './crawl-task/result-parser'
import type { PaginationTelemetry } from './crawl-task/result-parser'
import { createLogger } from '@/utils/logger'

const log = createLogger('CrawlTask')

export function useCrawlTask() {
  // 任务状态
  const [taskState, setTaskState] = useState<TaskState>({
    taskId: null,
    status: 'pending',
    progress: 0,
    extractedData: [],
    schema: null,
    accessResult: null,
    strategy: undefined,
    startedAt: null,
    completedAt: null,
    recommendationMetadata: null,
    paginationExecution: undefined,
  })

  // 当前阶段
  const [currentStage, setCurrentStage] = useState<TaskStage>('config')

  // ✅ TaskAPI 已由 taskApiClient 统一封装（避免散落 window.tabtin/electronAPI）
  // 为了最小化改动，保留原来的 ref 形态，但默认指向 taskApiClient。
  const taskAPI = useRef<any>(taskApiClient)

  /**
   * 创建任务
   * @param config 任务配置
   * @param existingTabId 可选的已存在标签ID（用于复用预览标签）
   * @param runId 可选的 runId（用于事件追踪和资源管理）
   */
  const createTask = useCallback(async (
    config: SimpleTaskConfig,
    existingTabId?: string,
    runId?: string
  ): Promise<boolean> => {
    if (!taskAPI.current) {
      log.error(i18n.t('crawl:task.logs.apiUnavailable'))
      return false
    }

    try {
      // 转换配置
      const { config: fullConfig, metadata: initialMetadata } = convertToFullTaskConfig(config)

      // ✨ 如果有预设 Schema，添加到配置中（跳过 AI 生成）
      if (config.presetSchema && fullConfig.extract) {
        // ✅ 统一格式：同时提供驼峰和下划线格式（兼容新旧数据）
        // 🔥 Schema 格式转换：后端格式 → 前端格式
        // 后端格式：{ extraction: { list_selector, fields } }
        // 前端格式：{ listSelector, fields }
        const extraction = config.presetSchema.extraction || config.presetSchema;
        const normalizedSchema = {
          ...config.presetSchema,
          // 🔑 从 extraction 中提取字段
          listSelector: config.presetSchema.listSelector ||
                       config.presetSchema.list_selector ||
                       extraction.list_selector ||
                       extraction.listSelector,
          list_selector: config.presetSchema.list_selector ||
                        config.presetSchema.listSelector ||
                        extraction.list_selector ||
                        extraction.listSelector,
          fields: config.presetSchema.fields || extraction.fields || [],
        }

        // ✅ 验证必需字段
        if (!normalizedSchema.listSelector) {
          log.error(i18n.t('crawl:task.logs.schemaMissingListSelector'));
          log.error('原始 Schema:', config.presetSchema);
          log.error('extraction:', extraction);
          setTaskState((prev) => ({
            ...prev,
            status: 'failed',
            error: i18n.t('crawl:task.errors.schemaMissingListSelector'),
          }))
          return false
        }

        if (!Array.isArray(normalizedSchema.fields) || normalizedSchema.fields.length === 0) {
          log.error(i18n.t('crawl:task.logs.schemaMissingFields'))
          log.error('原始 Schema:', config.presetSchema)
          setTaskState((prev) => ({
            ...prev,
            status: 'failed',
            error: i18n.t('crawl:task.errors.schemaMissingFields'),
          }))
          return false
        }

        fullConfig.extract.presetSchema = normalizedSchema
        if (config.presetSchema.pagination_info) {
          fullConfig.extract.paginationInfo = config.presetSchema.pagination_info
        }
      }

      // 如果有 existingTabId，添加到配置中
      if (existingTabId) {
        fullConfig.crawl = fullConfig.crawl || {}
        fullConfig.crawl.webcontents = fullConfig.crawl.webcontents || {}
        fullConfig.crawl.webcontents.existingTabId = existingTabId
        fullConfig.viewId = existingTabId
      }

      // 🆕 如果有 runId，添加到配置中（用于事件追踪）
      if (runId) {
        fullConfig.runId = runId
        fullConfig.crawl = fullConfig.crawl || {}
        fullConfig.crawl.webcontents = fullConfig.crawl.webcontents || {}
        fullConfig.crawl.webcontents.runId = runId
      }

      // 创建任务
      const createResult = await taskAPI.current.create(fullConfig)
      if (!createResult.success) {
        log.error(i18n.t('crawl:task.logs.createTaskFailed'), createResult.error)
        setTaskState((prev) => ({
          ...prev,
          status: 'failed',
          error: createResult.error,
        }))
        return false
      }

      let task = createResult.task

      if (initialMetadata && taskAPI.current.updateMetadata) {
        const metadataResult = await taskAPI.current.updateMetadata(task.id, initialMetadata)
        if (metadataResult.success && metadataResult.task) {
          task = metadataResult.task
        } else if (!metadataResult.success) {
          log.warn(i18n.t('crawl:task.logs.updateMetadataFailed'), metadataResult.error)
        }
      }

      // 更新任务状态
      const recommendationMetadata = normalizeRecommendationMetadata(task.metadata?.recommendation)

      setTaskState({
        taskId: task.id,
        status: task.status,
        progress: task.progress || 0,
        currentStep: task.currentStep,
        extractedData: [],
        schema: null,
        accessResult: task.result?.accessResult || null,
        resourceRecords: task.result?.resourceRecords || [],
        strategy: undefined,
        startedAt: task.startedAt ?? null,
        completedAt: task.completedAt ?? null,
        recommendationMetadata: recommendationMetadata ?? null,
        paginationExecution: normalizePaginationExecution(task.metadata?.pagination?.execution),
      })

      // 入队任务
      const enqueueResult = await taskAPI.current.enqueue(task.id)
      if (!enqueueResult.success) {
        log.error(i18n.t('crawl:task.logs.enqueueFailed'), enqueueResult.error)
        return false
      }

      setCurrentStage('executing')

      return true
    } catch (error) {
      log.error(i18n.t('crawl:task.logs.createTaskException'), error)
      setTaskState((prev) => ({
        ...prev,
        status: 'failed',
        error: error instanceof Error ? error.message : i18n.t('crawl:task.errors.unknown'),
      }))
      return false
    }
  }, [])

  /**
   * 取消任务
   */
  const cancelTask = useCallback(async (): Promise<void> => {
    if (!taskAPI.current || !taskState.taskId) return

    try {
      const result = await taskAPI.current.cancel(taskState.taskId)

      if (result.success) {
        setTaskState((prev) => ({
          ...prev,
          status: 'cancelled',
        }))
      }
    } catch (error) {
      log.error(i18n.t('crawl:task.logs.cancelTaskFailed'), error)
    }
  }, [taskState.taskId])

  useEffect(() => {
    const ipcRenderer = window.electron?.ipcRenderer
    if (!ipcRenderer || !taskState.taskId) {
      return
    }

    const handleAnalyticsEvent = (_event: any, payload: any) => {
      if (!payload || payload.taskId !== taskState.taskId || !payload.event) {
        return
      }

      const analyticsEvent = payload.event as { type: 'log' | 'telemetry'; [key: string]: any }

      setTaskState(prev => {
        if (!prev.taskId || prev.taskId !== payload.taskId) {
          return prev
        }

        const baseExecution: PaginationExecutionState = prev.paginationExecution ?? {
          status: 'running',
          logs: [],
          metrics: undefined,
          startedAt: undefined,
          lastUpdatedAt: undefined,
          requestedPages: undefined,
          successPages: undefined,
          errorMessage: undefined
        }

        if (analyticsEvent.type === 'log') {
          const level = analyticsEvent.level
          if (level !== 'info' && level !== 'warn' && level !== 'error') {
            return prev
          }

          const logEntry: PaginationExecutionLog = {
            timestamp: Date.now(),
            level,
            message: typeof analyticsEvent.message === 'string'
              ? analyticsEvent.message
              : String(analyticsEvent.message ?? ''),
            params: Array.isArray(analyticsEvent.params) ? analyticsEvent.params : undefined
          }

          const logs = [...(baseExecution.logs ?? []), logEntry]
          if (logs.length > MAX_PAGINATION_LOG_ENTRIES) {
            logs.splice(0, logs.length - MAX_PAGINATION_LOG_ENTRIES)
          }

          return {
            ...prev,
            paginationExecution: {
              ...baseExecution,
              status: baseExecution.status === 'completed' || baseExecution.status === 'failed'
                ? baseExecution.status
                : 'running',
              logs
            }
          }
        }

        if (analyticsEvent.type === 'telemetry' && analyticsEvent.telemetry) {
          const telemetry = analyticsEvent.telemetry as PaginationTelemetry
          return {
            ...prev,
            paginationExecution: {
              ...baseExecution,
              status: telemetry.lastError ? 'failed' : 'completed',
              startedAt: telemetry.startedAt,
              lastUpdatedAt: telemetry.finishedAt,
              requestedPages: telemetry.requestedPages,
              successPages: telemetry.successPages,
              errorMessage: telemetry.lastError,
              metrics: telemetry,
              logs: baseExecution.logs
            }
          }
        }

        return prev
      })
    }

    const unsub = ipcRenderer.on('analytics:pagination:event', handleAnalyticsEvent)
    return () => {
      unsub?.()
    }
  }, [taskState.taskId])

  /**
   * 恢复暂停的任务
   */
  const resumeTask = useCallback(async (): Promise<boolean> => {
    if (!taskAPI.current || !taskState.taskId) return false

    try {
      // 检查 TaskAPI 是否支持 resume
      if (typeof taskAPI.current.resume !== 'function') {
        log.error(i18n.t('crawl:task.logs.resumeUnsupported'))
        return false
      }

      const result = await taskAPI.current.resume(taskState.taskId)

      if (result.success) {
        setTaskState((prev) => ({
          ...prev,
          status: 'running',
          pauseInfo: undefined,
        }))
        return true
      } else {
        log.error(i18n.t('crawl:task.logs.resumeFailed'), result.error)
        return false
      }
    } catch (error) {
      log.error(i18n.t('crawl:task.logs.resumeException'), error)
      return false
    }
  }, [taskState.taskId])

  /**
   * 恢复任务并执行翻页
   */
  const resumeWithPagination = useCallback(async (
    pages: number,
    method: 'click' | 'scroll' | 'both',
    interval?: PaginationIntervalConfig,
    fieldConfigs?: FieldConfig[]
  ): Promise<boolean> => {
    if (!taskAPI.current || !taskState.taskId) return false

    try {
      // 检查 TaskAPI 是否支持 resumeWithPagination
      if (typeof taskAPI.current.resumeWithPagination !== 'function') {
        log.error(i18n.t('crawl:task.logs.resumeWithPaginationUnsupported'))
        return false
      }

      const result = await taskAPI.current.resumeWithPagination({
        taskId: taskState.taskId,
        pages,
        method,
        interval,
        fieldConfigs,
      })

      if (result.success) {
        setTaskState((prev) => ({
          ...prev,
          status: 'running',
          pauseInfo: undefined,
        }))
        return true
      } else {
        log.error(i18n.t('crawl:task.logs.startPaginationFailed'), result.error)
        return false
      }
    } catch (error) {
      log.error(i18n.t('crawl:task.logs.paginationException'), error)
      return false
    }
  }, [taskState.taskId])

  /**
   * 恢复任务并应用推荐方案
   */
  const resumeWithRecommendation = useCallback(async (
    params: { id: string; instruction: string }
  ): Promise<boolean> => {
    if (!taskAPI.current || !taskState.taskId) return false

    try {
      if (typeof taskAPI.current.selectRecommendation !== 'function') {
        log.error(i18n.t('crawl:task.logs.selectRecommendationUnsupported'))
        return false
      }

      const selectionContext = taskState.recommendationMetadata?.selectionContext
      const fallbackType: ExtractionSelectionType = selectionContext?.type === 'history' ? 'history' : 'recommendation'
      const selectionType: ExtractionSelectionType =
        taskState.pauseInfo?.selection?.type ??
        selectionContext?.type ??
        taskState.recommendationMetadata?.selectionType ??
        fallbackType

      const selectionSource =
        taskState.pauseInfo?.selection?.source ??
        selectionContext?.source ??
        taskState.recommendationMetadata?.selectionSource ??
        'recommendation'

      const result = await taskAPI.current.selectRecommendation({
        taskId: taskState.taskId,
        recommendationId: params.id,
        instruction: params.instruction,
        selectionType,
        selectionSource,
        schema: selectionContext?.schema,
        metadata: selectionContext?.metadata,
        skeletonHtml: selectionContext?.skeletonHtml
      })

      if (result?.success) {
        const updatedTask = result.task
        setTaskState((prev) => {
          const pauseInfo = normalizePauseInfo(updatedTask?.metadata?.pauseInfo)
          const recommendationMetadata = normalizeRecommendationMetadata(updatedTask?.metadata?.recommendation)
          return {
            ...prev,
            status: updatedTask?.status ?? 'queued',
            pauseInfo,
            recommendationMetadata: recommendationMetadata ?? prev.recommendationMetadata ?? null,
          }
        })
        return true
      }

      log.error(i18n.t('crawl:task.logs.selectRecommendationFailed'), result?.error)
      return false
    } catch (error) {
      log.error(i18n.t('crawl:task.logs.selectRecommendationException'), error)
      return false
    }
  }, [taskState.taskId])

  /**
   * 监听任务更新
   */
  useEffect(() => {
    if (!taskAPI.current) {
      log.warn(i18n.t('crawl:task.logs.apiUnavailableEffect'))
      return
    }

    if (!taskState.taskId) {
      return
    }

    const handleTaskStateChange = (event: any) => {
      if (event.type !== 'updated') {
        return
      }

      const task = event.task
      if (task.id !== taskState.taskId) {
        return
      }

      const nextStrategy = normalizeStrategyMetadata(task.metadata?.strategy)
      const extractedData = task.result?.extract?.data || []
      const schema = task.result?.extract?.schema || null
      const pauseInfo = normalizePauseInfo(task.metadata?.pauseInfo)
      const recommendationMetadata = normalizeRecommendationMetadata(task.metadata?.recommendation)
      const paginationExecution = normalizePaginationExecution(task.metadata?.pagination?.execution)

      setTaskState((prev) => {
        const accessResult = task.result?.accessResult ?? prev.accessResult

        // ✅ 提取网络响应缓存（包含图片的 base64）
        // 注意：networkResponses 和 resourceRecords 在 task.result 顶层，
        // 不在 accessResult 上（ContractAccessResult 没有这些字段）
        const networkResponses = task.result?.networkResponses ?? prev.networkResponses
        const resourceRecords = task.result?.resourceRecords ?? prev.resourceRecords

        const next: TaskState = {
          ...prev,
          status: task.status,
          progress: task.progress ?? prev.progress,
          currentStep: task.currentStep ?? prev.currentStep,
          accessResult,
          strategy: nextStrategy ?? prev.strategy,
          pauseInfo: pauseInfo,
          paginationInfo:
            pauseInfo?.paginationInfo ??
            task.metadata?.pagination?.detectionResult ??
            task.metadata?.paginationInfo ??
            prev.paginationInfo,
          paginationExecution: paginationExecution ?? prev.paginationExecution,
          startedAt: typeof task.startedAt === 'number' ? task.startedAt : prev.startedAt ?? null,
          completedAt: typeof task.completedAt === 'number' ? task.completedAt : prev.completedAt ?? null,
          recommendationMetadata: recommendationMetadata ?? prev.recommendationMetadata ?? null,
          networkResponses, // ✅ 添加网络响应缓存
          resourceRecords,
        }

        switch (task.status) {
          case 'completed':
            next.extractedData = extractedData
            next.schema = schema
            next.error = undefined
            if (!networkResponses || networkResponses.length === 0) {
              log.warn('没有网络响应缓存数据！')
            }
            break
          case 'failed':
            next.error = task.error?.message || i18n.t('crawl:task.errors.executionFailed')
            break
          case 'paused':
            next.extractedData = extractedData
            next.schema = schema
            break
          default:
            if (task.status === 'running' || task.status === 'queued') {
              next.error = undefined
            }
            break
        }

        return next
      })

      switch (task.status) {
        case 'completed':
          log.debug('任务完成', { extractedCount: extractedData.length })
          // 设置为 mapping 作为默认行为（向后兼容）
          setCurrentStage('mapping')
          break
        case 'failed':
          log.error('任务失败:', {
            errorObject: task.error,
            errorMessage: task.error?.message || (typeof task.error === 'string' ? task.error : JSON.stringify(task.error)),
            errorStack: task.error?.stack,
            taskId: task.id,
            taskStatus: task.status,
            taskMetadata: task.metadata,
            fullError: task.error
          })
          break
        case 'paused':
          setCurrentStage('executing')
          break
        case 'running':
        case 'queued':
          setCurrentStage('executing')
          break
        default:
          break
      }
    }

    // 注册事件监听 - 使用 taskAPI.onStateChange
    const unsubscribe = taskAPI.current.onStateChange(handleTaskStateChange)

    // 清理
    return () => {
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, [taskState.taskId])

  /**
   * 获取任务耗时
   */
  const getElapsedTime = useCallback((): number => {
    const startedAt = taskState.startedAt
    if (!startedAt) {
      return 0
    }

    if (taskState.status === 'completed' || taskState.status === 'failed') {
      const end = taskState.completedAt ?? Date.now()
      return end - startedAt
    }

    return Date.now() - startedAt
  }, [taskState.startedAt, taskState.completedAt, taskState.status])

  /**
   * 进入下一阶段
   */
  const goToNextStage = useCallback((stage: TaskStage) => {
    setCurrentStage(stage)
  }, [])

  /**
   * 导出流转记录到剪贴板
   */
  const exportExecutionTrace = useCallback(async (): Promise<boolean> => {
    if (!taskAPI.current || !taskState.taskId) {
      log.warn(i18n.t('crawl:task.logs.exportTraceUnavailable'))
      return false
    }

    if (typeof taskAPI.current.get !== 'function') {
      log.error(i18n.t('crawl:task.logs.exportTraceGetUnsupported'))
      return false
    }

    const writeTextToClipboard = async (text: string): Promise<boolean> => {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }

      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', 'true')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        const successful = document.execCommand('copy')
        document.body.removeChild(textarea)
        if (!successful) {
          throw new Error('document.execCommand("copy") returned false')
        }
        return true
      } catch (error) {
        log.error(i18n.t('crawl:task.logs.clipboardCopyFailed'), error)
        return false
      }
    }

    try {
      const response = await taskAPI.current.get(taskState.taskId)
      const task = response?.task ?? response

      if (!task) {
        log.error(i18n.t('crawl:task.logs.exportTraceMissingTask'))
        return false
      }

      const payload = {
        taskId: task.id ?? taskState.taskId,
        status: task.status,
        timestamps: {
          createdAt: task.createdAt ?? null,
          startedAt: task.startedAt ?? null,
          completedAt: task.completedAt ?? null,
        },
        strategyTrace: task.metadata?.strategy ?? null,
        paginationTrace: task.metadata?.pagination?.execution ?? null,
        pauseInfo: task.metadata?.pauseInfo ?? null,
      }

      const serialized = JSON.stringify(payload, null, 2)
      const copied = await writeTextToClipboard(serialized)

      if (copied) {
        return true
      }

      return false
    } catch (error) {
      log.error(i18n.t('crawl:task.logs.exportTraceException'), error)
      return false
    }
  }, [taskState.taskId])

  return {
    // 状态
    taskState,
    currentStage,

    // 操作
    createTask,
    cancelTask,
    resumeTask,           // 🆕 恢复任务
    resumeWithPagination, // 🆕 翻页恢复
    resumeWithRecommendation,
    goToNextStage,

    // 辅助
    getElapsedTime,
    exportExecutionTrace,
    isTaskRunning: taskState.status === 'running' || taskState.status === 'queued',
    isTaskPaused: taskState.status === 'paused', // 🆕 是否暂停
    hasError: !!taskState.error,
  }
}
