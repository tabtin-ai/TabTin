/**
 * subagent_session handler —— 子 Agent 详情工作台标签注册器（PRD §4.1.1）
 *
 * 设计基线：
 *   - 运行时型 tab：无独立 appId / Quick Action / @ 提及
 *   - `tabKey = subagent_session:${subagentRunId}`
 *   - persistOnly：tab 在 tabOrder 持久化，跨重启自动还原；resolveTabItem 从 persist 重建
 *   - keepAlive：切走不卸载（与多 tab 并行查看体验一致）
 *   - isVisibleInContext：实现"按当前 chat session 过滤"语义（PRD §4.3 三集合分离）
 *   - beforeClose：running / queued 态弹"关闭不停止子 Agent"确认对话框
 *
 * 红线遵守：
 *   - 不声明 appId / backendAliases / quickAction / mention / appEntryMode（红线 #7）
 *   - 钩子名 beforeClose（红线 #1）
 *   - 不写 validateRestore（restore 决策在 policies.ts；红线 #2）
 */

import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Bot } from 'lucide-react'
import i18n from '@/i18n'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useSpeakerRegistryStore } from '@stores/useSpeakerRegistryStore'
import type {
  ContextTypeHandler,
  TabKeyResolutionContext,
} from '../types'
import type { ContextItem } from '../types'
import type { SubagentSessionMeta } from '@stores/contextTabs/types'
import { SubagentDetailPane } from '../../../chat/subagent/SubagentDetailPane'
import { requestSubagentTabCloseConfirm } from '../../../chat/subagent/subagentTabCloseConfirm'

const SUBAGENT_SESSION_TYPE = 'subagent_session'

function isSubagentMeta(meta: unknown): meta is SubagentSessionMeta {
  if (!meta || typeof meta !== 'object') return false
  const m = meta as Record<string, unknown>
  return m.kind === 'subagent_session' || typeof m.parentSessionId === 'string'
}

function getSubagentMeta(item: ContextItem): SubagentSessionMeta | undefined {
  return isSubagentMeta(item.meta) ? (item.meta as SubagentSessionMeta) : undefined
}

function buildDisplayLabel(item: ContextItem): string {
  const meta = getSubagentMeta(item)
  const fallback = i18n.t('chat:subagent.tab.fallbackTitle', { defaultValue: '子 Agent' })
  // 优先「Agent 身份名」（与 SubagentDetailPane header 同口径，用户拍板顺序）：实时
  // run.role → run.label → speaker.display_name；再回落打开 tab 时存进 meta 的
  // displayName / label。**不用 task**——那是主 Agent 的指令 prompt，长且不是名字。
  if (meta?.parentSessionId) {
    const run = useChatRuntimeStore.getState().subagentRunsBySessionId[meta.parentSessionId]?.find(r => r.subagentRunId === item.id)
    if (run?.role?.trim()) return run.role.trim()
    if (run?.label?.trim()) return run.label.trim()
    const speaker = useSpeakerRegistryStore.getState().speakersBySessionId[meta.parentSessionId]?.[item.id]
    if (speaker?.display_name?.trim()) return speaker.display_name.trim()
  }
  if (meta?.displayName && meta.displayName.trim().length > 0) return meta.displayName.trim()
  if (meta?.label && meta.label.trim().length > 0) return meta.label.trim()
  if (item.title && item.title.trim().length > 0) return item.title.trim()
  return fallback
}

/**
 * 上下文可见性钩子（PRD §4.3）：
 *   - 没有 parentSessionId（数据坏 / 老格式）→ 隐藏，避免出现 orphan tab
 *   - currentSessionId 是 null（首页 / 草稿）→ 全部隐藏
 *   - parentSessionId !== currentSessionId → 隐藏（切走后藏起来，不删）
 */
function isVisibleInContext(item: ContextItem, ctx: TabKeyResolutionContext): boolean {
  if (item.type !== SUBAGENT_SESSION_TYPE) return true
  const meta = getSubagentMeta(item)
  if (!meta?.parentSessionId) return false
  if (!ctx.currentSessionId) return false
  return meta.parentSessionId === ctx.currentSessionId
}

/**
 * 关闭前拦截（PRD §4.10）：
 *   - completed / failed / cancelled / unknown → 直接放行（直接关）
 *   - running / queued / pending → 弹 imperative dialog 确认
 *
 * 用户在 dialog 选「保留标签」→ 返回 false 阻止关闭；选「仅关闭标签」→ 返回 true 放行
 * （子 Agent 继续在后台跑——这是有意为之的"标签生命周期 ≠ 子 Agent 生命周期"决策）。
 */
async function beforeClose(item: ContextItem): Promise<boolean> {
  const meta = getSubagentMeta(item)
  if (!meta?.parentSessionId) return true

  const runs = useChatRuntimeStore.getState().subagentRunsBySessionId[meta.parentSessionId] ?? []
  const run = runs.find(r => r.subagentRunId === item.id)
  const status = run?.status

  // 终态 / 未知态直接关——非 running/queued/pending 的都不弹窗
  // （unknown 也不弹：已经"看不到状态了"，保留确认没价值）
  if (status !== 'running' && status !== 'queued' && status !== 'pending') return true

  const displayName = buildDisplayLabel(item)
  const choice = await requestSubagentTabCloseConfirm(displayName)
  return choice === 'close'
}

export const subagentSessionHandler: ContextTypeHandler = {
  type: SUBAGENT_SESSION_TYPE,
  // 红线 #7：不声明 appId / backendAliases / quickAction / mention / appEntryMode
  renderMode: 'pane',
  keepAlive: true,
  persistOnly: true,
  closable: true,
  requireResourceMembership: false,
  isVisibleInContext,
  getTabLabel: buildDisplayLabel,
  getTabIcon: () => <TabTypeEmoji appIdOrType="subagent-session" />,
  resolveTabItem: (id, ctx) => {
    const persisted = ctx.persistedItem ?? null
    const persistedMeta = isSubagentMeta(persisted?.meta) ? (persisted!.meta as SubagentSessionMeta) : undefined
    return {
      type: SUBAGENT_SESSION_TYPE,
      id,
      tabKey: ctx.tabKey,
      title: persisted?.title,
      meta: persistedMeta ?? (persisted?.meta as SubagentSessionMeta | undefined),
    }
  },
  renderPane: (item, ctx) => {
    const meta = getSubagentMeta(item)
    if (!meta?.parentSessionId) {
      return (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-body text-muted-foreground/60">
          {i18n.t('chat:subagent.tab.paneError', { defaultValue: '子 Agent 数据加载失败' })}
        </div>
      )
    }
    return (
      <SubagentDetailPane
        subagentRunId={item.id}
        parentSessionId={meta.parentSessionId}
        parentToolCallId={meta.parentToolCallId}
        isPaneActive={ctx?.isPaneActive ?? false}
        fallbackName={meta.displayName || meta.label}
      />
    )
  },
  beforeClose,
  buildCanvasContent: item => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: tabKey => ({ tabKey }),
}
