/**
 * IMWelcomePanel —— 「消息」主画布欢迎页。
 *
 * 触发条件：workbenchMode === 'im'（未选会话），或 im-chat 但尚无默认工作空间。
 * 列表与 ChatView 固定在 shell IM rail（SidebarIMPanel + TabChatPanel）；本组件只做
 * 主画布引导，默认可随画布折叠隐藏，避免与 rail 再挂一套完整消息页。
 */

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircle, Plus } from 'lucide-react'
import { Button as UIButton } from '@tabtin/smartsheet-ui'
import { CreateConversationDialog } from '@components/tabchat/CreateConversationDialog'

export const IMWelcomePanel: React.FC = React.memo(() => {
  const { t } = useTranslation(['tabchat'])
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  return (
    <div className="tabchat-skin h-full flex items-center justify-center px-6 bg-[hsl(var(--accent)/0.025)]">
      <div className="text-center space-y-5 max-w-sm">
        <div className="w-14 h-14 mx-auto rounded-full bg-muted/30 border border-border/40 flex items-center justify-center">
          <MessageCircle className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-subtitle font-semibold text-foreground">
            {t('welcome.title', { defaultValue: '私信' })}
          </h2>
          <p className="text-body text-muted-foreground leading-relaxed">
            {t('welcome.hint', {
              defaultValue: '从左侧选择一个会话继续；私聊请在通讯录中选择成员，或发起群聊开始协作。如果组织目前只有你，先邀请成员加入即可开始。',
            })}
          </p>
        </div>
        <UIButton
          type="button"
          onClick={() => setIsCreateOpen(true)}
          className="bg-accent hover:bg-accent/90 mt-2"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          {t('createGroup', { defaultValue: '发起群聊' })}
        </UIButton>
      </div>
      <CreateConversationDialog
        isOpen={isCreateOpen}
        initialTab="group"
        groupOnly
        onClose={() => setIsCreateOpen(false)}
      />
    </div>
  )
})

IMWelcomePanel.displayName = 'IMWelcomePanel'
