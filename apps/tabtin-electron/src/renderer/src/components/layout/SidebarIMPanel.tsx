/**
 * SidebarIMPanel —— 侧栏「消息」模块。
 *
 * 顶部「通讯录」是消息域内 select：点开后右侧主聊天区展示通讯录（IMContactsPanel），
 * 左侧始终保留最近消息列表；再点一次取消选中回到聊天。
 * 新私信统一从通讯录点选成员发起，不再保留重复的“新建私信”入口。
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConversationList } from '@components/tabchat/ConversationList'
import { CreateConversationDialog } from '@components/tabchat/CreateConversationDialog'
import { MessageSearch } from '@components/tabchat/MessageSearch'
import { useTabChatPanelLifecycle } from '@components/tabchat/useTabChatPanelLifecycle'
import { useCloseOnOrganizationContextReset } from '@/hooks/useCloseOnOrganizationContextReset'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { cn } from '@utils/cn'
import { SidebarIMPrimaryNav } from './SidebarIMPrimaryNav'
import {
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from './sidebarUi'

export const SidebarIMPanel: React.FC = React.memo(() => {
  useTabChatPanelLifecycle()
  const { t } = useTranslation('tabchat')
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? '')
  const imSidebarView = useIMStore((s) => s.imSidebarView)
  const setImSidebarView = useIMStore((s) => s.setImSidebarView)
  const isContactsActive = imSidebarView === 'contacts'
  const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false)
  const closeCreateGroup = useCallback(() => {
    setIsCreateGroupOpen(false)
  }, [])
  // 侧栏在 ContentArea remount 范围外；不关会把 A 组织已选成员提交到 B。
  useCloseOnOrganizationContextReset(closeCreateGroup)

  const handleToggleContacts = useCallback(() => {
    // 通讯录是「消息」内的 select 视图；进入时由 store 统一退出当前会话上下文，
    // 避免最近消息继续选中并把该会话的资产栏带到通讯录。
    setImSidebarView(isContactsActive ? 'inbox' : 'contacts')
  }, [isContactsActive, setImSidebarView])

  const inboxLabel = t('recentConversations', { defaultValue: '最近消息' })

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <SidebarIMPrimaryNav
        isContactsActive={isContactsActive}
        createGroupDisabled={!organizationId}
        onToggleContacts={handleToggleContacts}
        onCreateGroup={() => setIsCreateGroupOpen(true)}
      />
      <MessageSearch organizationId={organizationId} embedded>
        <div className="flex h-full min-h-0 flex-col">
          <div className={cn(SIDEBAR_SECTION_HEADER, 'flex items-center pb-1 pt-0')}>
            <span className={SIDEBAR_SECTION_LABEL}>{inboxLabel}</span>
          </div>
          <div className="min-h-0 flex-1">
            <ConversationList embedded hideHeader showCreate={false} />
          </div>
        </div>
      </MessageSearch>
      <CreateConversationDialog
        isOpen={isCreateGroupOpen}
        initialTab="group"
        groupOnly
        onClose={closeCreateGroup}
      />
    </div>
  )
})

SidebarIMPanel.displayName = 'SidebarIMPanel'
