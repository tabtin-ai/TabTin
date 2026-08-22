/**
 * TrackerRunBreadcrumb — 跳回自动化任务详情的入口。
 *
 * 主任务顶栏标题旁 / 分屏 pane 标题旁渲染「查看自动化任务」。
 * tracker_run_breadcrumb_marker: TrackerRunBreadcrumb / tracker.*breadcrumb
 */

import React from 'react'
import { ListChecks } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { cn } from '@utils/cn'
import type { TrackerRunMeta } from '@tabtin/chat-client'
import { resolveForegroundTabScopeKey } from '../subagent/openSubagentTab'

interface TrackerRunBreadcrumbProps {
  trackerRun: TrackerRunMeta
  className?: string
}

/** 执行记录会话标题：自动化任务 "name" 的第 x 次记录 */
export function resolveTrackerRunSessionTitle(
  trackerRun: TrackerRunMeta,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const name =
    (trackerRun.tracker_name || '').trim()
    || t('trackerRun.untitled', { defaultValue: '未命名' })
  const idx = trackerRun.run_index || '?'
  return t('trackerRun.sessionTitle', {
    defaultValue: '自动化任务 "{{name}}" 的第 {{idx}} 次记录',
    name,
    idx,
  })
}

/**
 * Wave 5 (charter v1.8 §6.7 表达点 #1): 可点击跳回自动化任务详情。
 * tracker_run_breadcrumb_marker for grep validation.
 */
export const TrackerRunBreadcrumb: React.FC<TrackerRunBreadcrumbProps> = ({
  trackerRun,
  className,
}) => {
  const { t } = useTranslation('chat')
  const openResourceTab = useSpaceContextTabsStore(s => s.openResourceTab)
  const selectedSpace = useSpaceStore(s => s.selectedSpace)

  const handleJumpToTracker = () => {
    if (!selectedSpace?.id) {
      toast.error(
        t('trackerRun.jumpFailedNoSpace', {
          defaultValue: '无法跳转,工作空间上下文丢失',
        }),
      )
      return
    }
    openResourceTab(resolveForegroundTabScopeKey(selectedSpace.id), {
      type: 'tabtracker',
      id: trackerRun.tracker_id,
      title: trackerRun.tracker_name || undefined,
      meta: { spaceId: selectedSpace.id, taskId: trackerRun.tracker_id },
    })
  }

  return (
    <button
      type="button"
      onClick={handleJumpToTracker}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border border-border/40 bg-muted/20',
        'px-2 py-0.5 text-caption text-muted-foreground transition-colors',
        'hover:border-border/60 hover:bg-muted/40 hover:text-foreground',
        className,
      )}
      data-testid="tracker-run-breadcrumb"
      title={t('trackerRun.viewTracker', { defaultValue: '查看自动化任务' })}
      aria-label={t('trackerRun.viewTracker', { defaultValue: '查看自动化任务' })}
    >
      <ListChecks className="h-3 w-3 shrink-0" aria-hidden />
      <span>
        {t('trackerRun.viewTracker', { defaultValue: '查看自动化任务' })}
      </span>
    </button>
  )
}
