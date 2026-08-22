/**
 * PendingTasksNotice —— 「异步任务感知」B：有异步任务在跑时，在对话底部
 * （ChatInput 上方）显示的预告条。
 *
 * 用户视角断层：Agent 派了子 Agent / 后台命令后先回正文，任务还在后台跑，
 * 用户以为「对话结束了」，其实任务完成后会 push 唤起 Agent 新一轮继续。本预告条明确告诉
 * 用户「下列任务完成后，Agent 会继续回复你」+ 任务清单，消除断层。
 *
 * 数据源 + 时机（见 pendingTasks.ts）：
 *   - 子 Agent active：实时读 `subagentRunsBySessionId`；
 *   - 后台终端 running：IPC pull + 短轮询（短 sleep 常在 turn 结束前跑完，
 *     不能只在 phase===done 拉一次）；
 *   - pending 非空即显示（不限 phase）。
 *
 * 样式沿用 subagentMarkerStatus 字形 + chatDesignTokens 中性色，克制不抢主叙事。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ChevronUp, Hourglass, Square } from 'lucide-react'
import { cn } from '@utils/cn'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import type { SubagentRun } from '../../../stores/chat/shared/types'
import { TEXT, TEXT_COLOR, BG, BORDER, CARD_RADIUS, ICON_SIZE } from '../registry/chatDesignTokens'
import { MARKER_STATUS_GLYPH, MARKER_STATUS_FALLBACK } from '../subagent/subagentMarkerStatus'
import {
  aggregatePendingTasks,
  shouldShowPendingNotice,
  type PendingTaskItem,
} from './pendingTasks'
import { countSurvivingBackgroundSubagents } from '../../../stores/chat/subagent/survivingBackgroundSubagents'

/** 共享空数组引用——避免 selector 在「无 run」路径每次返回新 [] 触发 re-render。 */
const EMPTY_RUNS: SubagentRun[] = []
type BackgroundTask = { sessionId: string; command: string; startedAt: number }
type BackgroundTaskState = { ownerSessionId: string | null; tasks: BackgroundTask[] }
const EMPTY_BG_TASKS: BackgroundTask[] = []
/** 后台任务列表轮询间隔——覆盖短任务窗口，又不过度打 IPC。 */
const BACKGROUND_TASK_POLL_MS = 2_000

/** pending 状态中文兜底（i18n key 缺省时用）。 */
const STATUS_FALLBACK_ZH: Record<string, string> = {
  pending: '启动中',
  queued: '排队中',
  running: '运行中',
}

/** 截断标题（命令/标题只占一行，过长省略号收尾）。 */
function compactTitle(value: string, limit = 56): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

interface PendingTasksNoticeProps {
  sessionId: string | null
  spaceId: string | null
}

export const PendingTasksNotice: React.FC<PendingTasksNoticeProps> = ({ sessionId, spaceId }) => {
  const { t } = useTranslation('chat')

  // 子 Agent active runs（实时 store）。整组 run 引用稳定时 useShallow 跳过 re-render。
  const subagentRuns = useChatRuntimeStore(
    useShallow((s) => (sessionId ? s.subagentRunsBySessionId[sessionId] ?? EMPTY_RUNS : EMPTY_RUNS)),
  )

  const phase = useChatRuntimeStore((s) => (sessionId ? s.runStateBySessionId[sessionId]?.phase : undefined))
  const cancelSubagentRun = useChatRuntimeStore((s) => s.cancelSubagentRun)
  const subagentCancellingByRunId = useChatRuntimeStore((s) => s.subagentCancellingByRunId)
  const composerStopBackgroundHint = useChatRuntimeStore((s) =>
    sessionId ? s.composerStopBackgroundHintBySessionId[sessionId] ?? 0 : 0,
  )
  const clearComposerStopBackgroundHint = useChatRuntimeStore((s) => s.clearComposerStopBackgroundHint)

  const [backgroundTaskState, setBackgroundTaskState] =
    useState<BackgroundTaskState>({ ownerSessionId: null, tasks: EMPTY_BG_TASKS })
  const [isExpanded, setIsExpanded] = useState(false)
  const [stoppingShellTaskIds, setStoppingShellTaskIds] = useState<Record<string, boolean>>({})
  const [stoppedShellTaskIds, setStoppedShellTaskIds] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!sessionId) {
      setBackgroundTaskState({ ownerSessionId: null, tasks: EMPTY_BG_TASKS })
      return
    }
    const api = window.tabtin?.agentEngine?.listRunningBackgroundTasks
    if (!api) {
      setBackgroundTaskState({ ownerSessionId: sessionId, tasks: EMPTY_BG_TASKS })
      return
    }
    let cancelled = false
    setBackgroundTaskState({ ownerSessionId: sessionId, tasks: EMPTY_BG_TASKS })
    const pull = () => {
      void api({ sessionId, spaceId: spaceId ?? undefined })
        .then((tasks) => {
          if (!cancelled) {
            setBackgroundTaskState({
              ownerSessionId: sessionId,
              tasks: Array.isArray(tasks) && tasks.length > 0 ? tasks : EMPTY_BG_TASKS,
            })
          }
        })
        .catch(() => {
          if (!cancelled) setBackgroundTaskState({ ownerSessionId: sessionId, tasks: EMPTY_BG_TASKS })
        })
    }
    pull()
    // 短后台任务竞态：turn 结束前就可能已退出；轮询直到列表清空。
    const timer = window.setInterval(pull, BACKGROUND_TASK_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId, spaceId])

  const backgroundTasks =
    backgroundTaskState.ownerSessionId === sessionId ? backgroundTaskState.tasks : EMPTY_BG_TASKS
  const visibleBackgroundTasks = useMemo(
    () => backgroundTasks.filter(task => !stoppedShellTaskIds[task.sessionId]),
    [backgroundTasks, stoppedShellTaskIds],
  )

  const items = useMemo<PendingTaskItem[]>(
    () => aggregatePendingTasks({ subagentRuns, backgroundTasks: visibleBackgroundTasks }),
    [subagentRuns, visibleBackgroundTasks],
  )

  const survivingBackgroundCount = useMemo(
    () => countSurvivingBackgroundSubagents(subagentRuns),
    [subagentRuns],
  )

  useEffect(() => {
    if (items.length === 0) setIsExpanded(false)
  }, [items.length])

  // ：主 Stop 后仍有后台子 → 自动展开清单，避免用户以为「全停了」。
  useEffect(() => {
    if (composerStopBackgroundHint > 0 && survivingBackgroundCount > 0) {
      setIsExpanded(true)
    }
  }, [composerStopBackgroundHint, survivingBackgroundCount])

  useEffect(() => {
    if (!sessionId) return
    if (survivingBackgroundCount === 0 && composerStopBackgroundHint > 0) {
      clearComposerStopBackgroundHint(sessionId)
    }
  }, [sessionId, survivingBackgroundCount, composerStopBackgroundHint, clearComposerStopBackgroundHint])

  useEffect(() => {
    setStoppingShellTaskIds({})
    setStoppedShellTaskIds({})
  }, [sessionId])

  useEffect(() => {
    if (backgroundTasks.length === 0) {
      setStoppingShellTaskIds({})
      return
    }
    const liveIds = new Set(backgroundTasks.map(task => task.sessionId))
    setStoppingShellTaskIds((current) => {
      let changed = false
      const next: Record<string, boolean> = {}
      for (const [id, stopping] of Object.entries(current)) {
        if (!liveIds.has(id)) {
          changed = true
          continue
        }
        next[id] = stopping
      }
      return changed ? next : current
    })
  }, [backgroundTasks])

  if (!shouldShowPendingNotice(phase, items.length)) return null

  const toggleLabel = isExpanded
    ? t('pendingNotice.collapse', { defaultValue: '折叠后台任务' })
    : t('pendingNotice.expand', { defaultValue: '展开后台任务' })
  const stopLabel = t('pendingNotice.stop', { defaultValue: '停止后台任务' })

  const handleStopTask = (item: PendingTaskItem) => {
    if (item.kind === 'subagent') {
      if (subagentCancellingByRunId[item.id]) return
      void cancelSubagentRun(item.id)
      return
    }
    if (stoppingShellTaskIds[item.id]) return
    setStoppingShellTaskIds(current => ({ ...current, [item.id]: true }))
    void window.tabtin?.pty?.agentKill?.(item.id)
      .then((result) => {
        if (result?.success === true) {
          setStoppedShellTaskIds(current => ({ ...current, [item.id]: true }))
          setBackgroundTaskState(current => (
            current.ownerSessionId === sessionId
              ? { ...current, tasks: current.tasks.filter(task => task.sessionId !== item.id) }
              : current
          ))
          setStoppingShellTaskIds((current) => {
            const next = { ...current }
            delete next[item.id]
            return next
          })
          return
        }
        setStoppingShellTaskIds((current) => {
          const next = { ...current }
          delete next[item.id]
          return next
        })
      })
      .catch(() => {
        setStoppingShellTaskIds((current) => {
          const next = { ...current }
          delete next[item.id]
          return next
        })
      })
  }

  return (
    <div
      className={cn(CARD_RADIUS, BORDER.subtle, BG.card, 'border px-3 py-2')}
      data-testid="pending-tasks-notice"
    >
      {isExpanded && (
        <div className="mb-1.5 space-y-1" data-testid="pending-tasks-list">
          {items.map((item) => {
            const glyph = MARKER_STATUS_GLYPH[item.status] ?? MARKER_STATUS_FALLBACK
            const kindLabel =
              item.kind === 'subagent'
                ? t('pendingNotice.kindSubagent', { defaultValue: '子 Agent' })
                : t('pendingNotice.kindShell', { defaultValue: '后台命令' })
            const fallbackTitle =
              item.kind === 'subagent'
                ? t('pendingNotice.subagentFallback', { defaultValue: '子 Agent' })
                : t('pendingNotice.shellFallback', { defaultValue: '后台命令' })
            const title = compactTitle(item.title) || fallbackTitle
            const statusLabel = t(`pendingNotice.status.${item.status}`, {
              defaultValue: STATUS_FALLBACK_ZH[item.status] ?? item.status,
            })
            const isStopping = item.kind === 'subagent'
              ? !!subagentCancellingByRunId[item.id]
              : !!stoppingShellTaskIds[item.id]
            return (
              <div
                key={`${item.kind}-${item.id}`}
                className="flex min-w-0 items-center gap-2"
                data-testid="pending-task-row"
                data-pending-kind={item.kind}
              >
                <glyph.Icon className={cn(ICON_SIZE.status, glyph.tone, 'shrink-0')} aria-hidden />
                <span className={cn('shrink-0', TEXT.meta, TEXT_COLOR.muted)}>{kindLabel}</span>
                <span className={cn('min-w-0 flex-1 truncate', TEXT.meta, 'text-foreground/80')}>{title}</span>
                <span className={cn('shrink-0', TEXT.meta, TEXT_COLOR.muted)}>{statusLabel}</span>
                <button
                  type="button"
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted/40',
                    isStopping ? 'cursor-default text-muted-foreground/40' : 'text-muted-foreground/60 hover:text-destructive',
                  )}
                  aria-label={stopLabel}
                  disabled={isStopping}
                  onClick={(event) => {
                    event.stopPropagation()
                    handleStopTask(item)
                  }}
                >
                  <Square className={cn('h-2.5 w-2.5', !isStopping && 'fill-current')} aria-hidden />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button
        type="button"
        className={cn('group flex w-full min-w-0 items-center gap-1.5 text-left', TEXT.meta, 'text-foreground/80')}
        aria-expanded={isExpanded}
        aria-label={toggleLabel}
        data-testid="pending-tasks-toggle"
        onClick={() => setIsExpanded(value => !value)}
      >
        <Hourglass className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'shrink-0')} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {composerStopBackgroundHint > 0 && survivingBackgroundCount > 0
            ? t('pendingNotice.titleAfterMainStop', {
                defaultValue: '主回答已停止；下列后台子任务仍在运行，完成后 Agent 会继续',
              })
            : t('pendingNotice.title', { defaultValue: '下列任务完成后，Agent 会继续回复你' })}
        </span>
        <span className={cn('shrink-0', TEXT.meta, TEXT_COLOR.muted)}>
          {t('pendingNotice.count', { count: items.length, defaultValue: '{{count}} 个任务' })}
        </span>
        {isExpanded
          ? <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'shrink-0 transition-colors group-hover:text-foreground')} aria-hidden />
          : <ChevronUp className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'shrink-0 transition-colors group-hover:text-foreground')} aria-hidden />}
      </button>
    </div>
  )
}

PendingTasksNotice.displayName = 'PendingTasksNotice'
