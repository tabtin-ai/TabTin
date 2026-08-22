/**
 * ConversationPickerDialog — 通用「选一个私信会话」弹窗（TC-5 入口②等复用）。
 *
 * 列当前 organization 的 DM / 群聊（与 ConversationList / ForwardDialog 同口径强过滤），
 * 搜索 + 单选 → onSelect(convId)。不绑定具体消息，纯选会话；调用方决定选中后干什么
 * （如发资源卡）。
 */

import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Send, Check } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { Dialog, DialogContent, DialogTitle } from '@components/ui'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import { ColorAvatar } from './ColorAvatar'
import { useConversationPickerOptions } from './useConversationPickerOptions'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSelect: (convId: string) => void | Promise<void>
  organizationId?: string | null
  title?: string
  failureTitle?: string
}

export const ConversationPickerDialog: React.FC<Props> = ({
  isOpen,
  onClose,
  onSelect,
  organizationId,
  title,
  failureTitle,
}) => {
  const { t } = useTranslation('tabchat')
  const conversations = useIMStore((s) => s.conversations)
  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const effectiveOrganizationId = organizationId ?? selectedOrganizationId
  const [query, setQuery] = useState('')
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const filtered = useConversationPickerOptions(
    conversations,
    effectiveOrganizationId,
    query,
    false,
  )

  const handleSelect = async (convId: string) => {
    if (sending) return
    setSending(true)
    try {
      await onSelect(convId)
      setSentTo(convId)
      closeTimerRef.current = setTimeout(() => {
        onClose()
        setSentTo(null)
        setQuery('')
      }, 600)
    } catch (err) {
      console.error('[TabChat] ConversationPicker select failed:', err)
      toast({
        title: failureTitle || t('resourceShareFailed', { defaultValue: '分享资源失败' }),
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[360px] max-w-[360px] max-h-[480px] p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Send className="h-4 w-4 text-muted-foreground" />
          <DialogTitle className="text-body font-medium">{title || t('shareToConversation', { defaultValue: '分享到私信' })}</DialogTitle>
        </div>

        <div className="px-3 py-2 border-b border-border/30">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('forwardSearch', { defaultValue: '搜索会话' })}
              className="w-full h-8 pl-8 pr-3 text-body bg-muted/30 border border-border/40 rounded-lg outline-none focus:border-accent/60 placeholder:text-muted-foreground/60 transition-colors"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-body text-muted-foreground">
              {t('noConversations', { defaultValue: '没有会话' })}
            </div>
          ) : (
            filtered.map(({ conversation: conv, displayName, avatarUrl }) => {
              const isSent = sentTo === conv.id
              const visibleName = displayName || t(conv.type === CONVERSATION_TYPE_DM ? 'dm' : 'group')
              return (
                <button
                  key={conv.id}
                  type="button"
                  disabled={sending || isSent}
                  onClick={() => handleSelect(conv.id)}
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
                      {conv.type === CONVERSATION_TYPE_DM ? t('dm') : `${t('group')} · ${conv.member_count}`}
                    </div>
                  </div>
                  {isSent && <Check className="h-4 w-4 text-success flex-shrink-0" />}
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
