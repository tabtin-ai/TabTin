import React, { Suspense } from 'react'
import { FileText } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import type { ContextTypeHandler } from '../types'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { openResourceTabGuarded } from '../../restore/openResourceMembershipGuard'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaBool, metaIcon, metaStr } from '../homeSections/metaFieldUtils'
import {
  getTabDocDirtySnapshot,
  saveTabDoc,
  shouldConfirmTabDocClose,
} from '../../tabdoc/tabdocDirtyRegistry'
import { requestTabDocCloseConfirm } from '../../tabdoc/tabdocCloseConfirm'

const loadTabdocPanelApp = () => import('../../tabdoc/TabdocPanelApp')
const LazyTabdocPanelApp = React.lazy(loadTabdocPanelApp)

/**
 * TabDoc handler — 每个文档一个独立标签
 *
 * tabKey 格式: `tabdoc:{documentId}`
 * item.id 即为 documentId
 */
export const tabdocHandler: ContextTypeHandler = {
  type: 'tabdoc',
  appId: 'tabdoc',
  persistOnly: true,
  /**
   * keepAlive=true：避免切换 tab 时卸载文档面板，保留滚动位置 / 编辑器选区 / 协作 Yjs 连接。
   * 默认（不声明）的话，SpaceContextArea 对 inactive 非 keepAlive tab 直接 return null，
   * 用户在长文档里滚到一半切走 → 切回归零，体验割裂。
   * keepAlive 池子由 paneOverlays 用 LRU 管理（默认 MAX_KEEP_ALIVE_TABS=10），不会无限增长。
   */
  keepAlive: true,
  /**
   * ：Activity hidden 会 cleanup useCollabProvider → disconnect 销毁 Y.Doc，
   * 切回新建空 Y.Doc 可能在 hydrate 前播种空段。改用 visibility 保活。
   */
  keepAliveSuspendMode: 'visibility',
  /** 文档 tab 的 id 即 documentId，资源被删后 tab 应自动清理 */
  requireResourceMembership: true,
  appEntryMode: 'resources',
  aggregateAppId: 'cloud-resources',
  displayLabel: 'Docs',
  displayEmoji: '📄',
  agent: {
    displayName: '文档',
    capability: '叙事性长文档与协作内容（标题 / 段落 / 列表 / 引用 / 代码块 / 评论），适合报告、设计文档、需求 spec、会议纪要。',
    aliases: ['doc', '文章', '长文'],
    // backendAliases[0]='document' 是后端 item_type 别名，真实 CLI 是 `tabtin doc`。
    cliKey: 'doc',
  },
  // `doc` 是 present_to_user / agent-runtime 常用别名；与 parseResourcePointer
  // 的 SELF_FORMAT_TYPE_ALIASES 对齐，避免手造 pointer 路径再踩 。
  backendAliases: ['document', 'doc'],
  searchable: true,
  searchLabelKey: 'organization:search.documents',
  quickAction: {
    icon: <FileText className="h-3.5 w-3.5" />,
    labelKey: 'context:home.quickActions.newDocument',
    shortLabelKey: 'context:home.quickActions.shortDocument',
  },
  appMeta: { idField: 'current_doc_id', titleField: 'current_doc_title' },
  mention: { icon: FileText, color: 'text-info bg-info/10', mentionType: 'document' },
  attachToChat: {
    refType: 'document',
    buildRef: (item) => {
      if (!item.id) return null
      return {
        resourceId: item.id,
        label: item.title || 'TabDoc',
      }
    },
  },
  onSelect: (item, ctx) => {
    // ：打开已有文档也要打 membership pending，避免 restore 在索引滞后时打回其它 App
    openResourceTabGuarded(
      ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId),
      {
        type: 'tabdoc',
        id: item.id,
        title: item.title,
        meta: item.meta,
      },
      ctx.spaceId,
    )
  },
  // CC-001 / W2 T5: 关闭前检查未保存改动，弹三选确认对话框
  // - 编辑器面板未挂载（snapshot=null）→ 直接放行
  // - 'idle' / 'saved' 且 controller 干净 → 直接放行
  // - 'dirty' / 'saving' / 'error' 或 isDirty → 弹窗
  beforeClose: async (item) => {
    const snapshot = getTabDocDirtySnapshot(item.id)
    if (!shouldConfirmTabDocClose(snapshot)) return true

    const displayName = snapshot?.title || item.title || ''
    const choice = await requestTabDocCloseConfirm(displayName)
    if (choice === 'cancel') return false
    if (choice === 'discard') return true

    // 'save' —— 触发 manualSave，成功才放行；失败 toast 提示并阻止关闭
    const ok = await saveTabDoc(item.id)
    if (ok) return true

    toast({
      title: i18n.t('tabdoc:closeConfirm.saveFailedTitle', { defaultValue: '保存失败' }),
      description: i18n.t('tabdoc:closeConfirm.saveFailedDesc', {
        defaultValue: '文档未能保存到服务器，标签已保留。请检查网络后重试，或选择"放弃修改"关闭。',
      }),
      variant: 'destructive',
    })
    return false
  },
  onClose: (item, ctx) => {
    useClosedTabsStore.getState().push({
      type: 'tabdoc',
      id: item.id,
      tabKey: item.tabKey,
      title: item.title || 'TabDoc',
      spaceId: ctx.spaceId,
    })
  },
  getTabLabel: (item) => item.title || 'TabDoc',
  getTabIcon: (item) => {
    const icon = metaIcon(item.meta)
    if (icon) {
      return (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-body leading-none" aria-hidden>
          {icon}
        </span>
      )
    }
    return <TabTypeEmoji appIdOrType="tabdoc" />
  },
  getDragPayload: item => ({
    type: item.type,
    id: item.id,
    title: item.title,
  }),
  buildCanvasContent: item => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: tabKey => ({ tabKey }),
  prefetch: loadTabdocPanelApp,
  renderPane: (item, ctx) => {
    const spaceId = metaStr(item.meta, 'spaceId')
      ?? ctx?.spaceId
    const documentId = item.id
    // 「分享给我」独立 tab：资源不在当前 Space，需按资源真实 organization 挂载，
    // 否则编辑器运行时上下文（organization 派生）错配。普通 tab 不带该 meta，沿用默认。
    const organizationIdOverride = metaStr(item.meta, 'organizationId') ?? null
    const focusTitle = metaBool(item.meta, 'focusTitle') ?? false
    return (
      <Suspense
        fallback={<PaneLoadingSkeleton />}
      >
        <LazyTabdocPanelApp
          appId="tabdoc"
          spaceId={spaceId ?? null}
          documentId={documentId}
          organizationIdOverride={organizationIdOverride}
          focusTitle={focusTitle}
          isPaneActive={ctx?.isPaneActive ?? false}
          isVisible={ctx?.isVisible ?? true}
        />
      </Suspense>
    )
  },
}
