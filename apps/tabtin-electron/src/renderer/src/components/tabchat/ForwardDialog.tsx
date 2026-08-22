/**
 * ForwardDialog — 消息转发弹窗，选择目标会话后转发消息
 */

import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Share2, Check } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { Dialog, DialogContent, DialogTitle } from '@components/ui'
import {
  listExternalContacts,
  type ExternalContact,
  type ForwardedFrom,
  type IMMessage,
  type IMMessageMetadata,
} from '@/services/tabchatApi'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import { canSendToExternalConversation } from '@/services/im/externalConversationPolicy'
import { ColorAvatar } from './ColorAvatar'
import { useConversationPickerOptions } from './useConversationPickerOptions'

interface ForwardDialogProps {
  isOpen: boolean
  onClose: () => void
  message: IMMessage
}

function forwardableContentMetadata(metadata: IMMessageMetadata): IMMessageMetadata {
  return {
    ...(typeof metadata.file_id === 'string' ? { file_id: metadata.file_id } : {}),
    ...(typeof metadata.access_url === 'string' ? { access_url: metadata.access_url } : {}),
    ...(typeof metadata.file_name === 'string' ? { file_name: metadata.file_name } : {}),
    ...(typeof metadata.file_size === 'number' ? { file_size: metadata.file_size } : {}),
    ...(typeof metadata.file_type === 'string' ? { file_type: metadata.file_type } : {}),
    ...(metadata.card ? { card: metadata.card } : {}),
    ...(metadata.sticker ? { sticker: metadata.sticker } : {}),
  }
}

export const ForwardDialog: React.FC<ForwardDialogProps> = ({ isOpen, onClose, message }) => {
  const { t } = useTranslation('tabchat')
  const conversations = useIMStore((s) => s.conversations)
  // useIMStore.conversations 是跨 organization 累加缓存——本对话框只允许转发到
  // 当前 organization 的会话，跟 ConversationList 强过滤一致，避免误转发到错误团队。
  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const [query, setQuery] = useState('')
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [externalContacts, setExternalContacts] = useState<ExternalContact[]>([])
  const includeExternal = canSendToExternalConversation(message.message_type, message.metadata)

  useEffect(() => {
    if (!isOpen || !selectedOrganizationId || !includeExternal) {
      setExternalContacts([])
      return
    }
    let cancelled = false
    void listExternalContacts(selectedOrganizationId)
      .then(({ items }) => {
        if (!cancelled) setExternalContacts(items)
      })
      .catch(() => {
        if (!cancelled) setExternalContacts([])
      })
    return () => {
      cancelled = true
    }
  }, [includeExternal, isOpen, selectedOrganizationId])

  const filtered = useConversationPickerOptions(
    conversations,
    selectedOrganizationId,
    query,
    includeExternal,
    externalContacts,
  )

  const handleForward = async (targetConvId: string) => {
    if (sending) return
    setSending(true)
    try {
      const sourceConv = conversations.find((c) => c.id === message.conversation_id)
      const forwarded: ForwardedFrom = {
        original_message_id: message.id,
        original_conversation_id: message.conversation_id,
        original_conversation_name: sourceConv?.name || '',
        original_sender_id: message.sender_id,
        original_sender_name: message.sender_name || '',
      }

      // 转发是当前用户创建的内容快照。只继承渲染正文所需 metadata；消息身份、
      // Agent 运行态、TabTin 引用和 mention 都属于源消息，不能进入目标会话。
      const contentMetadata = forwardableContentMetadata(message.metadata || {})

      const sent = await useIMStore.getState().sendMessage({
        convId: targetConvId,
        content: message.content,
        messageType: message.message_type,
        metadata: {
          ...contentMetadata,
          forwarded_from: forwarded,
        },
      })
      if (!sent) {
        toast({ title: t('forwardFailed'), variant: 'destructive' })
        return
      }

      setSentTo(targetConvId)
      closeTimerRef.current = setTimeout(() => {
        onClose()
        setSentTo(null)
        setQuery('')
      }, 600)
    } catch (err) {
      console.error('[TabChat] Forward failed:', err)
      toast({ title: t('forwardFailed'), variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    }
  }, [])

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[360px] max-w-[360px] max-h-[480px] p-0 gap-0 overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Share2 className="h-4 w-4 text-muted-foreground" />
          <DialogTitle className="text-body font-medium">{t('forwardTo')}</DialogTitle>
        </div>

        {/* 搜索框 */}
        <div className="px-3 py-2 border-b border-border/30">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('forwardSearch')}
              className="w-full h-8 pl-8 pr-3 text-body bg-muted/30 border border-border/40 rounded-lg outline-none focus:border-accent/60 placeholder:text-muted-foreground/60 transition-colors"
              autoFocus
            />
          </div>
        </div>

        {/* 会话列表 */}
        <div className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-body text-muted-foreground">
              {t('noConversations')}
            </div>
          ) : (
            filtered.map(({ conversation: conv, displayName, avatarUrl, peerOrganizationName }) => {
              const isSent = sentTo === conv.id
              const visibleName = displayName || t(conv.type === CONVERSATION_TYPE_DM ? 'dm' : 'group')
              return (
                <button
                  key={conv.id}
                  type="button"
                  disabled={sending || isSent}
                  onClick={() => handleForward(conv.id)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors text-left disabled:opacity-50"
                >
                  <ColorAvatar
                    name={visibleName}
                    seed={conv.type === CONVERSATION_TYPE_DM
                      ? conv.dm_peer_user_id || conv.id
                      : conv.name || conv.id}
                    imageUrl={avatarUrl || undefined}
                    className="h-8 w-8"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">{visibleName}</div>
                    <div className="text-caption text-muted-foreground truncate">
                      {conv.type === CONVERSATION_TYPE_DM
                        ? conv.is_external
                          ? `${t('dm')} · ${peerOrganizationName || t('externalContacts.external')}`
                          : t('dm')
                        : `${t('group')} · ${conv.member_count}`}
                    </div>
                  </div>
                  {isSent && (
                    <Check className="h-4 w-4 text-success flex-shrink-0" />
                  )}
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
