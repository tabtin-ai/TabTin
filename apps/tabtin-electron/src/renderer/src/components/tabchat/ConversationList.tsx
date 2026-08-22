/**
 * ConversationList — 左栏会话列表
 *
 * 跟 organization 切换器联动（PRD 2026-05-21 私信 tab 改造）：
 * - useIMStore.conversations 是**跨 organization 累加**的（loadConversations 替换当前
 *   organization 部分，保留其他 organization 的旧缓存做切换性能优化）
 * - 本组件按 useOrganizationStore.selectedOrganization.id 强过滤，只展示当前 organization 的
 *   会话——跟顶部 SidebarTopOrganizationSwitcher 的"workspace 切换"语义对齐
 * - 切换 organization 时（顶部切换器 → useOrganizationStore.selectOrganization），
 *   useTabChatPanelLifecycle 自动拉新 organization 的 conversations，本组件 re-render
 *   过滤出新 organization 的部分
 *
 * 搜索：跟通讯录一致用常驻搜索框（MessageSearch），不再点放大镜切换全屏搜索。
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { UsersRound } from 'lucide-react'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { ConversationItem } from './ConversationItem'
import { CreateConversationDialog } from './CreateConversationDialog'
import { MessageSearch } from './MessageSearch'
import { LabelFilterBar } from './LabelFilterBar'
import { NavigationListSkeleton } from '@components/common/ListSkeletons'
import { SIDEBAR_EMPTY_TEXT, SIDEBAR_ICON_BUTTON, SIDEBAR_ICON_SM, SIDEBAR_GROUPS, SIDEBAR_META, SIDEBAR_ROW_LIST } from '@components/layout/sidebarUi'
import { groupConversationsForInbox } from '@/lib/groupConversationsForInbox'
import { cn } from '@utils/cn'

interface ConversationListProps {
  /** 内嵌在 SidebarIMPanel 的「私信/通讯录」切换下时隐藏自带标题，避免与 tab 重复 */
  embedded?: boolean
  /**
   * 隐藏自带搜索 / 新建工具栏，只渲染纯会话列表。
   * 供外层（如独立 IM 窗口侧栏）自行提供常驻搜索框时使用。
   */
  hideHeader?: boolean
  /**
   * 是否渲染内置「发起群聊」按钮（搜索框右侧）。
   * 私聊统一从通讯录点选成员发起；当外层已承载群聊入口时传 false 避免重复。
   */
  showCreate?: boolean
}

export const ConversationList: React.FC<ConversationListProps> = ({
  embedded = false,
  hideHeader = false,
  showCreate = true,
}) => {
  const { t } = useTranslation('tabchat')
  const {
    conversations,
    currentConversationId,
    isLoading,
  } = useIMStore(useShallow((s) => ({
    conversations: s.conversations,
    currentConversationId: s.currentConversationId,
    isLoading: s.isLoadingConversations,
  })))
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? '')
  const spaces = useSpaceStore((s) => s.spaces)
  const [isCreateOpen, setIsCreateOpen] = useState(false)


  // 强过滤：只展示当前 organization 的会话。空 organizationId（用户尚未选定团队）时
  // 也返回空列表——避免误显示其他 organization 的缓存。
  const visibleConversations = useMemo(() => {
    if (!organizationId) return []
    return conversations.filter((c) => (
      c.organization_id === organizationId
      && !c.is_team_space_channel
    ))
  }, [conversations, organizationId])

  const spaceNameById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const space of spaces) {
      if (space.type === 'team_space' && space.organization_id === organizationId) {
        map[space.id] = space.name
      }
    }
    return map
  }, [spaces, organizationId])

  const groupedConversations = useMemo(
    () => groupConversationsForInbox(visibleConversations, spaceNameById),
    [spaceNameById, visibleConversations],
  )

  const list = (
    <div className={cn(
      'flex-1 min-h-0 overflow-y-auto scrollbar-hover py-1',
      !embedded && 'px-2',
    )}>
      {isLoading && visibleConversations.length === 0 ? (
        <NavigationListSkeleton count={6} />
      ) : visibleConversations.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <p className={cn(
            'text-center leading-5',
            embedded ? cn(SIDEBAR_EMPTY_TEXT, 'text-muted-foreground/80') : 'text-body text-muted-foreground',
          )}>
            {t('noConversations')}
          </p>
        </div>
      ) : (
        <div className={embedded ? SIDEBAR_ROW_LIST : SIDEBAR_GROUPS}>
          {embedded ? (
            groupedConversations.directConversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === currentConversationId}
                embedded
              />
            ))
          ) : (
            <section className="min-w-0">
              <div className="space-y-0.5">
                {groupedConversations.directConversations.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === currentConversationId}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )

  // hideHeader：外层自带主操作和导航，本组件只渲染会话列表。
  if (hideHeader) {
    return <div className="flex h-full min-h-0 flex-col">{list}</div>
  }

  const createButton = showCreate ? (
    <button
      type="button"
      onClick={() => setIsCreateOpen(true)}
      className={cn(SIDEBAR_ICON_BUTTON, embedded ? 'h-7 w-7' : 'h-9 w-9')}
      title={t('createGroup')}
      aria-label={t('createGroup')}
    >
      <UsersRound className={embedded ? SIDEBAR_ICON_SM : 'h-4 w-4'} />
    </button>
  ) : undefined

  return (
    <div className="flex flex-col h-full min-h-0">
      <MessageSearch organizationId={organizationId} embedded={embedded} trailing={createButton}>
        {/* TC-37：label 筛选条（query 为空随会话列表展示） */}
        <div className="flex h-full min-h-0 flex-col">
          <LabelFilterBar />
          {list}
        </div>
      </MessageSearch>

      {showCreate && (
        <CreateConversationDialog
          isOpen={isCreateOpen}
          initialTab="group"
          groupOnly
          onClose={() => setIsCreateOpen(false)}
        />
      )}
    </div>
  )
}
