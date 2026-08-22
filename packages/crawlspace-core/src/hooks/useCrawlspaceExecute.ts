/**
 * useCrawlspaceExecute - 核心执行控制 Hook
 *
 * 封装 TaskAPI 调用，管理任务执行状态、暂停、恢复、取消
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type {
  CrawlspaceExecuteReturn
} from '../types'
import type { TaskState, TaskPauseInfo, FullTaskConfig } from '../types/task'
import type { PaginationIntervalConfig } from '../types/pagination'
import { t } from '../i18n'

import {
  normalizePauseInfo,
  normalizeRecommendationMetadata,
  normalizePaginationExecution
} from '../utils/task-normalization'

export interface UseCrawlspaceExecuteOptions {
  runId: string | null
  onTaskCreated?: (taskId: string) => void
  onTaskCompleted?: (taskId: string) => void
  onTaskPaused?: (taskId: string, pauseInfo: TaskPauseInfo) => void
  onTaskResumed?: (taskId: string) => void
  onTaskCancelled?: (taskId: string) => void
  onTaskFailed?: (taskId: string, error: string) => void
  adapter?: {
    create?: (config: any) => Promise<{ success: boolean; task?: any; error?: string }>
    enqueue?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    get?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    cancel?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    resume?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    onStateChange?: (callback: (event: any) => void) => () => void
    resumeWithPagination?: (params: {
      taskId: string
      pages: number
      method: 'click' | 'scroll' | 'both'
      interval?: any
    }) => Promise<{ success: boolean; task?: any; error?: string }>
    selectRecommendation?: (params: {
      taskId: string
      recommendationId: string
      instruction: string
      selectionType?: 'history' | 'recommendation'
      selectionSource?: string
      schema?: any
      metadata?: Record<string, any>
      skeletonHtml?: string
    }) => Promise<{ success: boolean; task?: any; error?: string }>
  }
  analytics?: {
    onPaginationEvent?: (callback: (payload: any) => void) => () => void
  }
}

/**
 * useCrawlspaceExecute
 *
 * 提供统一的任务执行接口，包括：
 * - execute: 创建并执行任务
 * - cancel: 取消任务
 * - resume: 恢复任务
 * - resumeWithPagination: 带翻页参数恢复
 * - selectRecommendation: 选择推荐项
 */
export function useCrawlspaceExecute(options: UseCrawlspaceExecuteOptions): CrawlspaceExecuteReturn {
  const {
    runId,
    onTaskCreated,
    onTaskCompleted,
    onTaskPaused,
    onTaskResumed,
    onTaskCancelled,
    onTaskFailed,
    adapter,
    analytics
  } = options

  const [taskState, setTaskState] = useState<TaskState>({
    taskId: null,
    status: 'idle',
    stage: 'config',
    progress: 0,
    error: undefined,
    pauseInfo: undefined,
    // ✅ 初始化数据字段，避免 UI 空值报错
    extractedData: [],
    schema: undefined,
    paginationExecution: undefined
  })

  const [currentStage, setCurrentStage] = useState<'config' | 'executing' | 'mapping' | 'completed'>('config')
  const startTimeRef = useRef<number | null>(null)
  const lastEventAtRef = useRef<number>(0)

  // CC-016: 用于将 updater 内的副作用延迟到 useEffect 中触发
  const [pendingSideEffect, setPendingSideEffect] = useState<{
    type: 'resumed' | 'completed' | 'paused' | 'failed'
    taskId: string
    pauseInfo?: any
    error?: string
  } | null>(null)

  const isExecuting = taskState.status === 'running' || taskState.status === 'pending' || taskState.status === 'paused'
  const isPaused = taskState.status === 'paused'

  /**
   * 兜底从 metadata 派生 pauseInfo，防止后端 pauseInfo 被后续 metadata 覆盖时前端拿不到信息
   */
  const derivePauseInfo = useCallback((task: any): TaskPauseInfo | undefined => {
    const rawPauseInfo = task?.metadata?.pauseInfo
    if (rawPauseInfo) return rawPauseInfo

    const paginationStrategy = task?.metadata?.recommendation?.selectionContext?.paginationStrategy
    const paginationInfo =
      task?.metadata?.pagination?.detectionResult ||
      task?.metadata?.paginationInfo

    // 只有在任务状态为 paused 且存在翻页信息时才兜底生成
    if (task?.status === 'paused' && (paginationStrategy || paginationInfo)) {
      return {
        reason: paginationStrategy ? 'pagination_configuration' : 'pagination_detected',
        message: paginationStrategy ? t('execute.pause.paginationDetected') : t('execute.pause.firstPageDone'),
        paginationStrategy,
        paginationInfo,
        allowRetry: true,
        pausedAt: task.updatedAt ?? Date.now()
      }
    }
    return undefined
  }, [])

  // CC-016 补修: 用 ref 从 updater 内部传递副作用到外部，避免 StrictMode 双次调用
  const pendingEffectRef = useRef<{
    type: 'resumed' | 'completed' | 'paused' | 'failed'
    taskId: string
    pauseInfo?: any
    error?: string
  } | null>(null)

  const subscribedTaskIdRef = useRef<string | null>(null)
  const lastNotifiedRef = useRef<{ taskId?: string; status?: string; pauseReason?: string }>({})
  const adapterRef = useRef(adapter)
  const derivePauseInfoRef = useRef(derivePauseInfo)
  const onTaskResumedRef = useRef(onTaskResumed)
  const onTaskPausedRef = useRef(onTaskPaused)
  const onTaskCompletedRef = useRef(onTaskCompleted)
  const onTaskFailedRef = useRef(onTaskFailed)

  useEffect(() => {
    adapterRef.current = adapter
  }, [adapter])

  useEffect(() => {
    derivePauseInfoRef.current = derivePauseInfo
  }, [derivePauseInfo])

  useEffect(() => {
    onTaskResumedRef.current = onTaskResumed
  }, [onTaskResumed])

  useEffect(() => {
    onTaskPausedRef.current = onTaskPaused
  }, [onTaskPaused])

  useEffect(() => {
    onTaskCompletedRef.current = onTaskCompleted
  }, [onTaskCompleted])

  useEffect(() => {
    onTaskFailedRef.current = onTaskFailed
  }, [onTaskFailed])

  // CC-016: 副作用在 useEffect 中触发，避免在 setTaskState updater 内调用回调
  useEffect(() => {
    if (!pendingSideEffect) return
    const { type, taskId, pauseInfo, error } = pendingSideEffect
    setPendingSideEffect(null)

    switch (type) {
      case 'resumed':
        onTaskResumedRef.current?.(taskId)
        break
      case 'completed':
        onTaskCompletedRef.current?.(taskId)
        break
      case 'paused':
        onTaskPausedRef.current?.(taskId, pauseInfo)
        break
      case 'failed':
        console.error('[useCrawlspaceExecute] task failed:', error)
        onTaskFailedRef.current?.(taskId, error || 'Unknown error')
        break
    }
  }, [pendingSideEffect])

  // ✅ 执行任务
  const execute = useCallback(async (config: FullTaskConfig): Promise<{ success: boolean; error?: string }> => {
    if (!runId) {
      console.error('[useCrawlspaceExecute] runId is empty')
      return { success: false, error: t('execute.error.runIdMissing') }
    }

    try {
      setTaskState((prev) => ({ ...prev, stage: 'executing', status: 'pending', error: undefined }))
      setCurrentStage('executing') // ✅ 同步更新 currentStage
      startTimeRef.current = Date.now() // ✅ 记录开始时间

      if (!adapter?.create) {
        console.error('[useCrawlspaceExecute] taskApi adapter.create not available')
        return { success: false, error: t('execute.error.taskApiUnavailable') }
      }

      const result = await adapter.create(config)

      if (!result.success || !result.task) {
        console.error('[useCrawlspaceExecute] task creation failed:', result.error)
        setTaskState((prev) => ({ ...prev, status: 'failed', error: result.error }))
        return { success: false, error: result.error }
      }

      const taskId = result.task.id

      // ✅ 关键修复：立即将任务入队，让 ExecutionManager 开始执行
      if (adapter?.enqueue) {
        const enqueueResult = await adapter.enqueue(taskId)
        if (!enqueueResult.success) {
          console.error('[useCrawlspaceExecute] task enqueue failed:', enqueueResult.error)
        }
      } else {
        console.warn('[useCrawlspaceExecute] taskApi.enqueue not provided, task may need manual start')
      }

      setTaskState((prev) => ({ ...prev, taskId, status: result.task.status }))
      onTaskCreated?.(taskId)

      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : t('common.unknownError')
      console.error('[useCrawlspaceExecute] Execute failed:', error)
      setTaskState((prev) => ({ ...prev, status: 'failed', error: errorMsg }))
      return { success: false, error: errorMsg }
    }
  }, [runId, onTaskCreated, adapter])

  /**
   * ✅ P0：订阅任务状态变化（事件驱动），减少轮询延迟与漏状态风险
   *
   * 事件来源：ElectronTaskStore 广播的 `task:state:change`
   * 载荷结构通常为：{ type: 'updated'|'created'|..., task, changes }
   */
  useEffect(() => {
    const taskId = taskState.taskId
    if (!taskId) {
      subscribedTaskIdRef.current = null
      return
    }
    if (subscribedTaskIdRef.current === taskId) {
      return
    }

    const currentAdapter = adapterRef.current
    if (typeof currentAdapter?.onStateChange !== 'function') {
      return
    }

    subscribedTaskIdRef.current = taskId

    const handleEvent = (event: any) => {
      const task = event?.task
      const eventTaskId = task?.id || event?.taskId
      if (!eventTaskId || eventTaskId !== taskId) {
        return
      }

      lastEventAtRef.current = Date.now()

      const derivedPauseInfo = derivePauseInfoRef.current(task)

      // CC-016 补修: 先清空 ref，updater 内写入 ref，updater 外读取并触发 setPendingSideEffect
      pendingEffectRef.current = null
      let nextLastNotified: { taskId?: string; status?: string; pauseReason?: string } | null = null

      setTaskState((prev) => {
        const statusChanged = prev.status !== task.status
        const pauseReason = derivedPauseInfo?.reason
        const pauseReasonChanged = prev.pauseInfo?.reason !== pauseReason
        const resumed = prev.status === 'paused' && task.status === 'running'
        const shouldNotifyPause =
          task.status === 'paused' &&
          derivedPauseInfo &&
          (statusChanged ||
            pauseReasonChanged ||
            lastNotifiedRef.current.taskId !== taskId ||
            lastNotifiedRef.current.pauseReason !== pauseReason)

        // CC-016 补修: 写入 ref 而非直接调用 setPendingSideEffect，避免 StrictMode 双次触发
        if (resumed) {
          pendingEffectRef.current = { type: 'resumed', taskId }
        } else if (task.status === 'completed' && statusChanged) {
          pendingEffectRef.current = { type: 'completed', taskId }
        } else if (shouldNotifyPause) {
          pendingEffectRef.current = { type: 'paused', taskId, pauseInfo: derivedPauseInfo }
        } else if (task.status === 'failed' && statusChanged) {
          pendingEffectRef.current = { type: 'failed', taskId, error: task.error || 'Unknown error' }
        }

        if (statusChanged || pauseReasonChanged) {
          nextLastNotified = { taskId, status: task.status, pauseReason }
        }

        const nextState = {
          ...prev,
          status: task.status,
          progress: task.progress || 0,
          pauseInfo: derivedPauseInfo,
          schema: task.result?.extract?.schema || prev.schema,
          extractedData: task.result?.extract?.data || prev.extractedData,
          paginationExecution:
            normalizePaginationExecution(task.metadata?.pagination?.execution) ||
            prev.paginationExecution,
          error: task.error
        }

        const noStateChange =
          prev.status === nextState.status &&
          prev.progress === nextState.progress &&
          prev.error === nextState.error &&
          prev.pauseInfo?.reason === nextState.pauseInfo?.reason &&
          prev.schema === nextState.schema &&
          prev.extractedData === nextState.extractedData &&
          prev.paginationExecution === nextState.paginationExecution

        return noStateChange ? prev : nextState
      })

      if (nextLastNotified) {
        lastNotifiedRef.current = nextLastNotified
      }
      // CC-016 补修: updater 执行完毕后，在外部安全地触发 setPendingSideEffect
      if (pendingEffectRef.current) {
        setPendingSideEffect(pendingEffectRef.current)
      }
    }

    const unsubscribe = currentAdapter.onStateChange(handleEvent)

    // ✅ 订阅后立即拉取一次快照，避免“订阅建立前错过关键状态”
    const getTask = currentAdapter?.get
    if (typeof getTask === 'function') {
      void (async () => {
        try {
          const result = await getTask(taskId)
          if (result?.success && result.task) {
            handleEvent({ type: 'snapshot', task: result.task })
          }
        } catch (error) {
          console.warn('[useCrawlspaceExecute] snapshot get failed (ignored):', error)
        }
      })()
    }

    return () => {
      if (subscribedTaskIdRef.current === taskId) {
        subscribedTaskIdRef.current = null
        unsubscribe?.()
      }
    }
  }, [taskState.taskId])

  // ✅ 轮询任务状态
  useEffect(() => {
    const shouldPoll =
      !!taskState.taskId &&
      taskState.stage === 'executing' &&
      taskState.status !== 'idle' &&
      taskState.status !== 'completed' &&
      taskState.status !== 'failed' &&
      taskState.status !== 'cancelled'

    if (!shouldPoll) {
      return
    }

    const getTask = adapterRef.current?.get
    if (!getTask) {
      console.error('[useCrawlspaceExecute] taskApi adapter.get not available')
      return
    }
    const interval = setInterval(async () => {
      try {
        // ✅ 如果已经有事件驱动更新，且近期刚收到事件，则降低轮询频率（兜底即可）
        if (typeof adapterRef.current?.onStateChange === 'function') {
          const since = Date.now() - lastEventAtRef.current
          if (since >= 0 && since < 3000) {
            return
          }
        }

        // CC-014: 使用 taskIdSnapshot 而非闭包中的 taskState.taskId
        const taskIdSnapshot = taskState.taskId
        if (!taskIdSnapshot) return
        const result = await getTask(taskIdSnapshot)
        if (!result.success || !result.task) return

        const task = result.task

        const derivedPauseInfo = derivePauseInfoRef.current(task)

        // CC-016 补修: 先清空 ref，updater 内写入 ref，updater 外读取并触发 setPendingSideEffect
        pendingEffectRef.current = null
        let nextLastNotified: { taskId?: string; status?: string; pauseReason?: string } | null = null

        setTaskState((prev) => {
          // CC-014: 在 updater 内使用 prev.taskId 而非闭包捕获的 taskState.taskId
          const currentTaskId = prev.taskId
          if (!currentTaskId || currentTaskId !== taskIdSnapshot) {
            return prev // taskId 已变更，丢弃过时轮询结果
          }

          const statusChanged = prev.status !== task.status
          const pauseReason = derivedPauseInfo?.reason
          const pauseReasonChanged = prev.pauseInfo?.reason !== pauseReason
          const resumed = prev.status === 'paused' && task.status === 'running'
          const shouldNotifyPause =
            task.status === 'paused' &&
            derivedPauseInfo &&
            (statusChanged ||
              pauseReasonChanged ||
              lastNotifiedRef.current.taskId !== currentTaskId ||
              lastNotifiedRef.current.pauseReason !== pauseReason)

          // CC-016 补修: 写入 ref 而非直接调用 setPendingSideEffect，避免 StrictMode 双次触发
          if (resumed) {
            pendingEffectRef.current = { type: 'resumed', taskId: currentTaskId }
          } else if (task.status === 'completed' && statusChanged) {
            pendingEffectRef.current = { type: 'completed', taskId: currentTaskId }
          } else if (shouldNotifyPause) {
            pendingEffectRef.current = { type: 'paused', taskId: currentTaskId, pauseInfo: derivedPauseInfo }
          } else if (task.status === 'failed' && statusChanged) {
            pendingEffectRef.current = { type: 'failed', taskId: currentTaskId, error: task.error || 'Unknown error' }
          }

          if (statusChanged || pauseReasonChanged) {
            nextLastNotified = { taskId: currentTaskId, status: task.status, pauseReason }
          }

          const nextState = {
            ...prev,
            status: task.status,
            progress: task.progress || 0,
            pauseInfo: derivedPauseInfo,
            schema: task.result?.extract?.schema || prev.schema,
            extractedData: task.result?.extract?.data || prev.extractedData,
            paginationExecution:
              normalizePaginationExecution(task.metadata?.pagination?.execution) ||
              prev.paginationExecution,
            error: task.error
          }

          const noStateChange =
            prev.status === nextState.status &&
            prev.progress === nextState.progress &&
            prev.error === nextState.error &&
            prev.pauseInfo?.reason === nextState.pauseInfo?.reason &&
            prev.schema === nextState.schema &&
            prev.extractedData === nextState.extractedData &&
            prev.paginationExecution === nextState.paginationExecution

          return noStateChange ? prev : nextState
        })

        if (nextLastNotified) {
          lastNotifiedRef.current = nextLastNotified
        }
        // CC-016 补修: updater 执行完毕后，在外部安全地触发 setPendingSideEffect
        if (pendingEffectRef.current) {
          setPendingSideEffect(pendingEffectRef.current)
        }
      } catch (error) {
        console.error('[useCrawlspaceExecute] poll failed:', error)
      }
    }, typeof adapterRef.current?.onStateChange === 'function' ? 5000 : 2000)  // ✅ 事件优先，轮询兜底

    return () => clearInterval(interval)
  }, [taskState.taskId, taskState.status, taskState.stage])

  /**
   * 订阅分页分析事件（实时翻页日志/指标）
   */
  useEffect(() => {
    if (!taskState.taskId || !analytics?.onPaginationEvent) {
      return
    }

    const handleAnalyticsEvent = (payload: any) => {
      if (!payload || payload.taskId !== taskState.taskId || !payload.event) {
        return
      }

      const analyticsEvent = payload.event as { type: 'log' | 'telemetry'; [key: string]: any }

      setTaskState((prev) => {
        if (!prev.taskId || prev.taskId !== payload.taskId) {
          return prev
        }

        const baseExecution = prev.paginationExecution ?? {
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

          const logEntry = {
            timestamp: Date.now(),
            level,
            message: typeof analyticsEvent.message === 'string'
              ? analyticsEvent.message
              : String(analyticsEvent.message ?? ''),
            params: Array.isArray(analyticsEvent.params) ? analyticsEvent.params : undefined
          }

          const logs = [...(baseExecution.logs ?? []), logEntry]
          if (logs.length > 50) {
            logs.splice(0, logs.length - 50)
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
          const telemetry = analyticsEvent.telemetry as any
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

    const unsubscribe = analytics.onPaginationEvent(handleAnalyticsEvent)
    return () => {
      unsubscribe?.()
    }
  }, [taskState.taskId, analytics])

  // ✅ 取消任务
  const cancel = useCallback(async () => {
    if (!taskState.taskId) return

    if (!adapter?.cancel) return
    await adapter.cancel(taskState.taskId)
    setTaskState((prev) => ({
      ...prev,
      status: 'cancelled',
      pauseInfo: undefined
    }))
    onTaskCancelled?.(taskState.taskId)
  }, [taskState.taskId, onTaskCancelled, adapter])

  // ✅ 恢复任务
  const resume = useCallback(async () => {
    if (!taskState.taskId) return

    if (!adapter?.resume) return
    await adapter.resume(taskState.taskId)
  }, [taskState.taskId, adapter])

  // ✅ 带翻页参数恢复
  const resumeWithPagination = useCallback(async (
    pages: number,
    method: 'click' | 'scroll' | 'both',
    interval?: PaginationIntervalConfig
  ) => {
    if (!taskState.taskId) return

    if (!adapter?.resumeWithPagination) return

    // ✅ 调用 task:resume-with-pagination IPC，会触发 EngineControlService.resumeWithPagination
    // 该服务会异步调用 PaginationService 执行翻页循环
    await adapter.resumeWithPagination({
      taskId: taskState.taskId,
      pages,
      method,
      interval
    })
  }, [taskState.taskId, adapter])

  // ✅ 使用推荐恢复
  const resumeWithRecommendation = useCallback(async (id: string, instruction: string) => {
    if (!taskState.taskId) return

    if (!adapter?.selectRecommendation) return
    await adapter.selectRecommendation({
      taskId: taskState.taskId,
      recommendationId: id,
      instruction,
      selectionType: 'recommendation'
    })
  }, [taskState.taskId, adapter])

  const selectRecommendation = resumeWithRecommendation

  // ✅ 阶段切换
  const goToNextStage = useCallback((targetStage?: 'config' | 'executing' | 'mapping' | 'completed') => {
    const stageOrder: Array<'config' | 'executing' | 'mapping' | 'completed'> = ['config', 'executing', 'mapping', 'completed']

    if (targetStage) {
      setCurrentStage(targetStage)
      return
    }

    const currentIndex = stageOrder.indexOf(currentStage)
    if (currentIndex < stageOrder.length - 1) {
      setCurrentStage(stageOrder[currentIndex + 1])
    }
  }, [currentStage])

  // ✅ 获取运行时长（毫秒）
  const getElapsedTime = useCallback(() => {
    if (!startTimeRef.current) return 0
    return Date.now() - startTimeRef.current
  }, [])

  // ✅ 导出执行追踪
  const exportExecutionTrace = useCallback(() => {
    return {
      taskId: taskState.taskId,
      status: taskState.status,
      stage: currentStage,
      progress: taskState.progress,
      elapsedTime: getElapsedTime(),
      startTime: startTimeRef.current,
      pauseInfo: taskState.pauseInfo,
      error: taskState.error
    }
  }, [taskState, currentStage, getElapsedTime])

  // ✅ 用 useMemo 包装返回值，避免不必要的引用变化
  return useMemo(() => ({
    taskState,
    currentStage,
    isExecuting,
    isPaused,
    execute,
    cancel,
    resume,
    resumeWithPagination,
    resumeWithRecommendation,
    selectRecommendation,
    goToNextStage,
    getElapsedTime,
    exportExecutionTrace
  }), [
    taskState,
    currentStage,
    isExecuting,
    isPaused,
    execute,
    cancel,
    resume,
    resumeWithPagination,
    resumeWithRecommendation,
    selectRecommendation,
    goToNextStage,
    getElapsedTime,
    exportExecutionTrace
  ])
}
