/**
 * useCrawlspace - 核心 Hook
 *
 * 整合 RunManager, ViewManager 和 ExecuteManager
 * 提供统一的 Crawlspace 上下文
 */

import { useCallback, useMemo } from 'react'
import { useRunManager, type UseRunManagerOptions } from './useRunManager'
import { useViewManager, type UseViewManagerOptions } from './useViewManager'
import { useCrawlspaceExecute, type UseCrawlspaceExecuteOptions } from './useCrawlspaceExecute'
import type { RunManagerReturn, ViewManagerReturn, CrawlspaceExecuteReturn } from '../types'

export interface UseCrawlspaceOptions {
  crawlspaceId: string
  isActive?: boolean

  runOptions?: Omit<UseRunManagerOptions, 'crawlspaceId' | 'isActive'>
  viewOptions?: Omit<UseViewManagerOptions, 'crawlspaceId' | 'isActive'>
  executeOptions?: UseCrawlspaceExecuteOptions
}

export interface CrawlspaceReturn {
  crawlspaceId: string
  run: RunManagerReturn
  view: ViewManagerReturn
  exec: CrawlspaceExecuteReturn
}

export function useCrawlspace(options: UseCrawlspaceOptions): CrawlspaceReturn {
  const { crawlspaceId, isActive = true } = options

  // 1. Run 管理
  const run = useRunManager({
    isActive,
    ...options.runOptions
  } as UseRunManagerOptions)

  // 🔧 CC-013：用 useCallback 包装回调，避免每次渲染重建导致下游 hook 重跑
  const handleAllViewsClosed = useCallback(async () => {
    try {
      await run.cleanupRun?.()
    } catch (error) {
      console.warn('[useCrawlspace] onAllViewsClosed: cleanupRun failed (ignored):', error)
    }
  }, [run.cleanupRun])

  const getRunId = useCallback(() => run.runId, [run.runId])

  // 2. View 管理
  const view = useViewManager({
    crawlspaceId,
    isActive,
    runId: run.runId, // 关联当前 runId
    getRunId, // 🔧 CC-013：稳定引用
    onAllViewsClosed: handleAllViewsClosed, // 🔧 CC-013：稳定引用
    ...options.viewOptions
  })

  // 3. 执行管理 - ✅ 使用动态的 run.runId
  const exec = useCrawlspaceExecute({
    ...options.executeOptions,
    runId: run.runId // 使用动态 runId 而不是初始值
  })

  return useMemo(() => ({
    crawlspaceId,
    run,
    view,
    exec
  }), [crawlspaceId, run, view, exec])
}
