import React, { Suspense } from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Activity } from 'lucide-react'
import i18n from '@/i18n'
import type { ContextTypeHandler } from '../types'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from '../homeSections/metaFieldUtils'

const LazyTrackerPanel = React.lazy(() =>
  import('../../../tabtracker/TrackerPanel').then(m => ({ default: m.TrackerPanel })),
)

const LazyTrackerDetail = React.lazy(() =>
  import('../../../tabtracker/TrackerDetail').then(m => ({ default: m.TrackerDetail })),
)

export const tabtrackerHandler: ContextTypeHandler = {
  type: 'tabtracker',
  appId: 'tabtracker',
  persistOnly: true,
  appEntryMode: 'panel',
  sidebarPanel: LazyTrackerPanel,
  displayLabel: '自动化',
  displayEmoji: '🎯',
  // ContextRefType / tabtin://resource/<type>/… 用 'tracker'；前端 ContextItemType 是 'tabtracker'。
  // 缺这一项时 ResourceRouter 会以 type=tracker 建 tab，getHandler 失败 → 空壳。
  backendAliases: ['tracker'],
  agent: {
    displayName: '自动化',
    capability: '按时间或事件触发的 Agent 自动化任务，适合定时运行流程、周期检查、查看运行历史。',
    // 「定时任务」保留为旧称别名，方便用户口头仍用旧名时被识别。
    aliases: ['tracker', '自动化', '自动化任务', '定时任务', '触发器'],
  },
  appMeta: {
    idField: 'current_tracker_id',
    titleField: 'current_tracker_title',
    resolve: (item) => {
      // charter v1.8 §3.1：对外字段统一用 tracker_id（不再用 task_id 避免与未来
      // 广义 Task 概念冲突）。组件内 taskId 局部变量名暂保留（属于实现细节，
      // 未来如改 trackerId 是单独的前端命名 PR）。
      const taskId = metaStr(item.meta, 'taskId') || metaStr(item.meta, 'eventId')
      return {
        current_tracker_id: taskId || '',
        current_tracker_title: item.title || '',
      }
    },
  },
  attachToChat: {
    refType: 'tracker',
    buildRef: (item) => {
      // 与 appMeta.resolve 对齐：taskId 优先、eventId 兜底
      const taskId = metaStr(item.meta, 'taskId') || metaStr(item.meta, 'eventId')
      if (!taskId) return null
      return {
        resourceId: taskId,
        label: item.title || i18n.t('tabtracker:appName', { defaultValue: '自动化' }),
      }
    },
  },
  getTabLabel: (item) => {
    if (metaStr(item.meta, 'taskId') || metaStr(item.meta, 'eventId')) return item.title || i18n.t('tabtracker:appName')
    return i18n.t('tabtracker:panel.header')
  },
  getTabIcon: () => <TabTypeEmoji appIdOrType="tabtracker" />,
  getDragPayload: item => ({
    type: item.type,
    id: item.id,
    title: item.title,
  }),
  buildCanvasContent: item => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: tabKey => ({ tabKey }),
  renderPane: (item, ctx) => {
    const spaceId = metaStr(item.meta, 'spaceId') ?? item.id
    const tabScopeKey = ctx?.tabScopeKey ?? ctx?.spaceId ?? spaceId
    const taskId = metaStr(item.meta, 'taskId') || metaStr(item.meta, 'eventId')

    if (taskId) {
      return (
        <Suspense fallback={<PaneLoadingSkeleton />}>
          <LazyTrackerDetail spaceId={spaceId} tabScopeKey={tabScopeKey} taskId={taskId} />
        </Suspense>
      )
    }

    return (
      <Suspense fallback={<PaneLoadingSkeleton />}>
        <LazyTrackerPanel
          spaceId={spaceId}
          tabScopeKey={tabScopeKey}
          detailNavigation="tab"
        />
      </Suspense>
    )
  },
}
