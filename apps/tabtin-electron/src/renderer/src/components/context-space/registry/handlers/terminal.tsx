import React from 'react'
import { Terminal, Bot } from 'lucide-react'
import type { ContextTypeHandler, ContextItem } from '../types'
import { useTerminalSessionStore, killPtySession } from '@components/context-space/sources/terminal'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import { useTerminalPaneStatusStore, type PaneStatus } from '@stores/useTerminalPaneStatusStore'
import { writeTerminalInput } from '@components/terminal/terminalRuntime'
import i18n from '@/i18n'
import { cn } from '@utils/cn'

const loadTerminalPaneRenderer = () =>
  import('./renderers/TerminalPaneRenderer').then(m => ({ default: m.TerminalPaneRenderer }))
const TerminalPaneRenderer = React.lazy(loadTerminalPaneRenderer)

export const terminalHandler: ContextTypeHandler = {
  type: 'terminal',
  appId: 'terminal',
  prefetch: loadTerminalPaneRenderer,
  renderMode: 'persistent',
  appEntryMode: 'create',
  displayLabel: 'Terminal',
  displayEmoji: '💻',
  agent: {
    displayName: '终端',
    capability: '本地 PTY 终端，运行 shell 命令；Agent 用 `run_terminal_command` 工具就在等价环境中执行',
    aliases: ['shell', '命令行', '控制台'],
  },
  /**
   * 关闭 terminal tab：销毁「不影响 self.tabKey 在 tabOrder 中的存在」的资源。
   *
   * 契约（详见 `ContextTypeHandler.onClose`）：
   *   - 不得修改 activeKey / tabOrder（由 useCloseHandlers 统一 fallback + closeTab）
   *   - 不得在此删 root session（它在 sessionsBySpace 的存在会驱动 useTabSync.syncTabOrder
   *     反推 tabOrder，间接动 self.tabKey，被守卫识别为违约）。root session 删除走
   *     `onAfterClose`——那时 closeTab 已完成，syncTabOrder 看 tabOrder 与 currentTabKeys
   *     一致，不会再动 tabOrder，也不会被守卫拦下。
   *
   * 这里仍然保留的副作用：
   *   - kill PTY（外部资源，越早 kill 越好；不动 source items）
   *   - 推 closedTabsStore（独立 store，不动 source items）
   *   - 清 split sub-pane sessions（**必须在 removeLayout 之前**——removeLayout 会让
   *     useTabSync 的 splitSubPaneSessionIds 不再排除这些 session，如果它们还留在
   *     sessionsBySpace，syncTabOrder 会把它们当独立 tab 加进 tabOrder。
   *     sub-pane sessionId 不在 tabOrder 中，删它们不会触发 self.tabKey 移除）
   *   - removeLayout（不动 source items）
   *   - 清 pane status（独立 store）
   */
  onClose: (item, ctx) => {
    useClosedTabsStore.getState().push({
      type: 'terminal',
      id: item.id,
      tabKey: item.tabKey,
      title: item.title || i18n.t('label.terminal', { ns: 'context' }),
      spaceId: ctx.spaceId,
    })
    const splitLayout = useTerminalSplitStore.getState().getLayout(item.id)
    const statusStore = useTerminalPaneStatusStore.getState()
    const sessionStore = useTerminalSessionStore.getState()
    // Phase 4：标签桶 key 可能是 desktop/conversation scope（用户终端）或真实 spaceId
    // （materialize 的 agent transcript / 历史会话）。按 root sessionId 跨桶定位真实桶 key，
    // 不再假定 == ctx.spaceId（否则 scope 化后的用户终端会删错桶 → 残留）。
    const rootKey = sessionStore.getSessionEntry(item.id)?.key ?? ctx.tabScopeKey ?? ctx.spaceId
    if (splitLayout) {
      // ER-5: 获取 sessionStore 中实际存在的 session ID 集合，
      // 避免 rehydration 后对已不存在的 session 调用 kill
      const existingSessionIds = new Set(
        (sessionStore.sessionsBySpace[rootKey] ?? []).map(s => s.id),
      )
      for (const pane of Object.values(splitLayout.panes)) {
        if (pane.sessionId !== item.id) {
          if (existingSessionIds.has(pane.sessionId)) {
            void killPtySession(pane.sessionId).catch((err: unknown) => { console.warn('[terminal] killPtySession failed:', err) })
            // sub-pane session 必须在 removeLayout 前删（见上方注释）
            sessionStore.removeSpaceSession(rootKey, pane.sessionId)
          }
          statusStore.removeStatus(pane.sessionId)
        }
      }
      useTerminalSplitStore.getState().removeLayout(item.id)
    }
    void killPtySession(item.id).catch((err: unknown) => { console.warn('[terminal] killPtySession failed:', err) })
    statusStore.removeStatus(item.id)
  },
  /**
   * closeTab 后的最终清理：从 sessionsBySpace 删除 root session。
   *
   * 此时 tabOrder 已不含 self.tabKey，删 root session 让 source.items 减少 1，
   * useTabSync.syncTabOrder 看 currentTabKeys 与 tabOrder 一致（都不含），不会再动
   * tabOrder。PortalLayer 看 sessionId 离开 sessionIds → scheduleDispose 走 1s 延迟
   * 清理路径，与点击 X 按钮关闭非分屏 terminal 完全等价。
   */
  onAfterClose: (item, ctx) => {
    const store = useTerminalSessionStore.getState()
    // 跨桶定位 root session 的真实桶 key（同 onClose 注释）。
    const key = store.getSessionEntry(item.id)?.key ?? ctx.tabScopeKey ?? ctx.spaceId
    store.removeSpaceSession(key, item.id)
  },
  onRefresh: (item) => {
    void writeTerminalInput(item.id, '\x0c')
  },
  resolveTabItem: (id, ctx) => {
    // Phase 4：ResolveTabContext 不带 tabScopeKey，按 sessionId 跨桶定位
    // （用户终端在 scope 桶、materialize 的 agent transcript 在真实 space 桶）。
    const session = useTerminalSessionStore.getState().getSessionEntry(id)?.session
    if (session) {
      return {
        type: 'terminal',
        id,
        tabKey: ctx.tabKey,
        title: session.title || i18n.t('label.terminal', { ns: 'context' }),
        meta: {
          source: session.source,
          status: session.status,
          cwd: session.cwd,
          createdAt: session.createdAt,
        },
      }
    }
    const persistedSource = ctx.persistedItem?.meta?.source
    return {
      type: 'terminal',
      id,
      tabKey: ctx.tabKey,
      title: ctx.persistedItem?.title || i18n.t('label.terminal', { ns: 'context' }),
      meta: {
        status: 'closed',
        ...(persistedSource === 'agent' || persistedSource === 'user'
          ? { source: persistedSource }
          : {}),
      },
    }
  },
  appMeta: {
    idField: '',
    resolve: (item) => {
      const bySpace = useTerminalSessionStore.getState().sessionsBySpace
      for (const sessions of Object.values(bySpace)) {
        const session = sessions.find(s => s.id === item.id)
        if (session?.cwd) {
          return { current_terminal_cwd: session.cwd }
        }
      }
      return null
    },
  },
  attachToChat: {
    refType: 'terminal_session',
    buildRef: (item) => {
      if (!item.id) return null
      const bySpace = useTerminalSessionStore.getState().sessionsBySpace
      let cwd: string | undefined
      for (const sessions of Object.values(bySpace)) {
        const session = sessions.find(s => s.id === item.id)
        if (session?.cwd) {
          cwd = session.cwd
          break
        }
      }
      return {
        resourceId: item.id,
        label: item.title || i18n.t('label.terminal', { ns: 'context' }),
        meta: cwd ? { cwd } : undefined,
      }
    },
  },
  quickAction: {
    icon: <Terminal className="h-3.5 w-3.5" />,
    labelKey: 'context:home.quickActions.newTerminal',
    shortLabelKey: 'context:home.quickActions.shortTerminal',
  },
  getTabLabel: (item) => {
    const label = item.title || i18n.t('label.terminal', { ns: 'context' })
    if (item?.meta?.status === 'closed') {
      return `${label} (${i18n.t('label.closed', { ns: 'context', defaultValue: 'closed' })})`
    }
    return label
  },
  getTabIcon: (item) => <TerminalTabIcon item={item} />,
  getDragPayload: item => ({
    type: 'terminal',
    id: item.id,
    title: item.title
  }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),
  renderPane: (item, ctx) => {
    const isClosed = item?.meta?.status === 'closed'
    // Agent 终端判定双通道：meta.source 优先；持久化 meta 丢 source 时（旧
    // 数据 / GC 后 fallback）用 agent- sessionId 前缀兜底（bugbot ）——
    // agent 会话 id 由 runtime 生成，恒为 agent-<spaceId>-<ts> 形态。
    const isAgentTerminal = item?.meta?.source === 'agent' || item.id.startsWith('agent-')
    // Agent 终端 tab 从卡片打开时已存 PTY 快照；closed 仅表示 PTY 已退出，
    // 仍应挂载 TerminalPaneRenderer 走 snapshotLoad 回看。用户终端 closed 保持短路。
    if (isClosed && !isAgentTerminal) {
      return (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground text-body">
          {i18n.t('label.sessionEnded', { ns: 'context', defaultValue: 'This terminal session has ended.' })}
        </div>
      )
    }
    return (
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            {i18n.t('label.loading', { ns: 'context' })}
          </div>
        }
      >
        <TerminalPaneRenderer
          sessionId={item.id}
          onPaneInteraction={ctx?.onPaneInteraction}
        />
      </React.Suspense>
    )
  }
}

const STATUS_DOT_COLORS: Record<PaneStatus, string> = {
  idle: '',
  running: 'bg-warning',
  exited: 'bg-destructive/60',
}

const TerminalTabIcon: React.FC<{ item: ContextItem }> = ({ item }) => {
  const isAgent = item?.meta?.source === 'agent'
  const isClosed = item?.meta?.status === 'closed'

  const layout = useTerminalSplitStore(state => state.layouts[item.id])
  const aggregatedStatus = useTerminalPaneStatusStore(state => {
    if (!layout) {
      return state.statuses[item.id]?.status ?? 'idle'
    }
    const sessionIds = Object.values(layout.panes).map(p => p.sessionId)
    return state.getAggregatedStatus(sessionIds)
  })

  const showDot = aggregatedStatus === 'running' || aggregatedStatus === 'exited'

  const icon = isAgent ? (
    <span className={cn('relative shrink-0 h-4 w-4', isClosed && 'opacity-50')}>
      <Terminal className="h-4 w-4" />
      <Bot className="absolute -top-1 -right-1.5 h-2.5 w-2.5 text-primary" />
    </span>
  ) : (
    <Terminal className={cn('h-4 w-4 shrink-0', isClosed && 'opacity-50')} />
  )

  if (!showDot) return icon

  return (
    <span className="relative shrink-0 inline-flex">
      {icon}
      <span
        className={cn(
          'absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border border-background',
          STATUS_DOT_COLORS[aggregatedStatus],
          aggregatedStatus === 'running' && 'motion-safe:animate-[pane-pulse_1.4s_ease-in-out_infinite]',
        )}
      />
    </span>
  )
}
