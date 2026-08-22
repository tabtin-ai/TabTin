import React, { Suspense } from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from '../homeSections/metaFieldUtils'
import {
  CODE_CHANGES_TAB_TYPE,
  DEFAULT_CODE_CHANGES_VIEW,
} from '../../code-workspace/codeWorkspaceTab'
import type { CodeChangesViewId } from '../../code-workspace/codeWorkspaceTab'
import i18n from '@/i18n'

const loadCodeChangesPane = () =>
  import('../../code-workspace/CodeChangesPane').then((m) => ({
    default: m.CodeChangesPane,
  }))
const LazyCodeChangesPane = React.lazy(loadCodeChangesPane)

function resolveInitialView(raw: string | null | undefined): CodeChangesViewId {
  if (
    raw === 'agent'
    || raw === 'uncommitted'
    || raw === 'staged'
    || raw === 'unstaged'
    || raw === 'history'
  ) {
    return raw
  }
  return DEFAULT_CODE_CHANGES_VIEW
}

/**
 * Changes 变更中心 — 独立标签（非 TabCode 侧栏）。
 * tabKey: `tabchanges:{base64(path)}`，meta.path = 会话绑定代码根。
 */
export const tabchangesHandler: ContextTypeHandler = {
  type: CODE_CHANGES_TAB_TYPE,
  persistOnly: true,
  keepAlive: true,
  displayLabel: 'Changes',
  displayEmoji: '⎇',
  prefetch: loadCodeChangesPane,
  onSelect: (item, ctx) => {
    useSpaceContextTabsStore.getState().openResourceTab(
      ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId),
      {
        type: CODE_CHANGES_TAB_TYPE,
        id: item.id,
        title: item.title || 'Changes',
        meta: item.meta,
      },
    )
  },
  resolveTabItem: (id, ctx) => {
    const codePath = metaStr(ctx.persistedItem?.meta, 'path')
    return {
      type: CODE_CHANGES_TAB_TYPE,
      id,
      tabKey: ctx.tabKey,
      title: ctx.persistedItem?.title || 'Changes',
      meta: {
        path: codePath,
        spaceId: ctx.spaceId,
        sessionId: metaStr(ctx.persistedItem?.meta, 'sessionId'),
        initialView: metaStr(ctx.persistedItem?.meta, 'initialView'),
        agentTurnEndMessageId: metaStr(ctx.persistedItem?.meta, 'agentTurnEndMessageId'),
        requestedView: metaStr(ctx.persistedItem?.meta, 'requestedView'),
        requestedRelativePath: metaStr(ctx.persistedItem?.meta, 'requestedRelativePath'),
        viewIntentId: metaStr(ctx.persistedItem?.meta, 'viewIntentId'),
      },
    }
  },
  getTabLabel: () =>
    i18n.t('codeWorkspace.changesTab', { ns: 'context', defaultValue: 'Changes' }),
  getTabIcon: () => <GitCommitHorizontal className="h-[1em] w-[1em]" />,
  getDragPayload: (item) => ({
    type: item.type,
    id: item.id,
    title: item.title,
  }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),
  renderPane: (item, ctx) => {
    const meta = item.meta || {}
    let rootPath = metaStr(meta, 'path') || null
    if (!rootPath) {
      const spaceIds = Object.keys(useSpaceContextTabsStore.getState().itemsBySpace || {})
      for (const pid of spaceIds) {
        const stored = useSpaceContextTabsStore.getState().itemsBySpace[pid]?.[item.tabKey]
        if (stored?.meta?.path) {
          rootPath = metaStr(stored.meta, 'path') ?? ''
          break
        }
      }
    }
    const spaceId = metaStr(meta, 'spaceId') ?? ctx?.spaceId ?? null
    const sessionId = metaStr(meta, 'sessionId')
    const initialView = resolveInitialView(metaStr(meta, 'initialView'))
    const agentTurnEndMessageId = metaStr(meta, 'agentTurnEndMessageId')
    const requestedView = resolveInitialView(metaStr(meta, 'requestedView'))
    const requestedRelativePath = metaStr(meta, 'requestedRelativePath')
    const viewIntentId = metaStr(meta, 'viewIntentId')

    return (
      <Suspense fallback={<PaneLoadingSkeleton />}>
        <LazyCodeChangesPane
          rootPath={rootPath || ''}
          spaceId={spaceId}
          sessionId={sessionId}
          tabScopeKey={ctx?.tabScopeKey ?? undefined}
          initialView={initialView}
          agentTurnEndMessageId={agentTurnEndMessageId}
          requestedView={requestedView}
          requestedRelativePath={requestedRelativePath}
          viewIntentId={viewIntentId}
        />
      </Suspense>
    )
  },
}
