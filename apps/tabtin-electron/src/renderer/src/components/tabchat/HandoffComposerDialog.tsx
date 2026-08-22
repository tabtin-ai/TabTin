/**
 * HandoffComposerDialog — 发起 IM 上下文交接的编辑对话框。
 *
 * 补充信息 + 接收者多选 + 材料披露。材料 = 发起来源消息（可跳回）；
 * 资源卡额外引用资源本体。提交走 createHandoff。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Check, Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Textarea,
} from '@components/ui'
import { toast } from '@tabtin/smartsheet-ui'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useUserProfileCache, useDisplayName } from '@stores/useUserProfileCache'
import {
  createHandoff,
  type ConversationMember,
  type HandoffReferenceSpec,
  type IMMessage,
} from '@/services/tabchatApi'
import { ColorAvatar } from './ColorAvatar'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'

const log = createLogger('HandoffComposer')
const EMPTY_CONVERSATION_MEMBERS: ConversationMember[] = []

function eligibleHandoffMembers(
  members: readonly ConversationMember[],
  currentUserId: string | undefined,
): ConversationMember[] {
  return members.filter((member) => (
    (member.member_type ?? 'user') === 'user'
    && Boolean(member.user_id)
    && member.user_id !== currentUserId
  ))
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: string
  sourceMessage: IMMessage | null
}

const NOTE_MAX_LEN = 2000
const DEFAULT_GOAL = '上下文交接'

const MemberOption: React.FC<{
  member: ConversationMember
  selected: boolean
  onToggle: () => void
}> = ({ member, selected, onToggle }) => {
  const userId = member.user_id ?? ''
  const cachedName = useDisplayName(userId)
  const name = cachedName || member.nickname || member.username || userId.slice(0, 8)
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center gap-2 rounded-full border px-2.5 py-1 text-caption transition-colors',
        selected
          ? 'border-violet-500/50 bg-violet-500/10 text-violet-700 dark:text-violet-300'
          : 'border-border/50 text-muted-foreground hover:bg-muted/50',
      )}
    >
      <ColorAvatar name={name} seed={userId} imageUrl={member.avatar} className="h-4 w-4" />
      <span className="max-w-[120px] truncate">{name}</span>
      {selected && <Check className="h-3 w-3 shrink-0" />}
    </button>
  )
}

export const HandoffComposerDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  conversationId,
  sourceMessage,
}) => {
  const { t } = useTranslation('tabchat')
  const currentUserId = useAuthStore((s) => s.user?.id)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  const memberSnapshot = useIMStore((state) => state.conversationMembers[conversationId])
  const membersLoading = useIMStore(
    (state) => state.conversationMembersLoading[conversationId] ?? false,
  )
  const refreshConversationMembers = useIMStore((state) => state.refreshConversationMembers)

  const [note, setNote] = useState('')
  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const members = useMemo(
    () => eligibleHandoffMembers(
      membersLoading
        ? EMPTY_CONVERSATION_MEMBERS
        : memberSnapshot ?? EMPTY_CONVERSATION_MEMBERS,
      currentUserId,
    ),
    [currentUserId, memberSnapshot, membersLoading],
  )
  const selectedRecipientIds = useMemo(
    () => members
      .map((member) => member.user_id)
      .filter((userId): userId is string => Boolean(userId && selectedRecipients.has(userId))),
    [members, selectedRecipients],
  )

  useLayoutEffect(() => {
    if (!open) return
    let cancelled = false
    setNote('')
    setSelectedRecipients(new Set())
    void refreshConversationMembers(conversationId, {
      supersede: true,
      invalidateSnapshot: true,
    })
      .then(() => {
        if (cancelled) return
        const refreshedMembers = useIMStore.getState().conversationMembers[conversationId] ?? []
        const eligibleIds = eligibleHandoffMembers(refreshedMembers, currentUserId)
          .map((member) => member.user_id)
          .filter((userId): userId is string => Boolean(userId))
        if (eligibleIds.length === 1) {
          setSelectedRecipients(new Set(eligibleIds))
        }
      })
      .catch((err) => {
        log.warn('load conversation members failed', { conversationId, err })
      })
    return () => { cancelled = true }
  }, [conversationId, currentUserId, open, refreshConversationMembers])

  useEffect(() => {
    if (!open || members.length === 0) return
    ensureProfiles(
      members
        .map((member) => member.user_id)
        .filter((userId): userId is string => Boolean(userId)),
    )
  }, [ensureProfiles, members, open])

  useEffect(() => {
    if (!open || membersLoading || memberSnapshot === undefined) return
    const eligibleIds = new Set(
      members
        .map((member) => member.user_id)
        .filter((userId): userId is string => Boolean(userId)),
    )
    setSelectedRecipients((previous) => {
      const next = new Set([...previous].filter((userId) => eligibleIds.has(userId)))
      if (
        next.size === previous.size
        && [...next].every((userId) => previous.has(userId))
      ) {
        return previous
      }
      return next
    })
  }, [memberSnapshot, members, membersLoading, open])

  const toggleRecipient = useCallback((userId: string) => {
    setSelectedRecipients((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }, [])

  const references = useMemo<HandoffReferenceSpec[]>(() => {
    if (!sourceMessage) return []
    const messageRef = typeof sourceMessage.metadata.message_ref === 'string'
      ? sourceMessage.metadata.message_ref.trim()
      : ''
    const refs: HandoffReferenceSpec[] = [
      {
        ref_type: 'im_message',
        resource_id: messageRef,
        summary_snapshot: sourceMessage.content.slice(0, 500),
        source_link: {
          conversation_id: conversationId,
          message_ref: messageRef,
          seq: sourceMessage.seq ?? sourceMessage.id,
        },
      },
    ]
    const card = sourceMessage.metadata?.card
    if (card?.resource_id && (card.type === 'document' || card.type === 'table')) {
      refs.push({ ref_type: card.type, resource_id: card.resource_id })
    }
    return refs
  }, [conversationId, sourceMessage])

  const sourcePreview = sourceMessage
    ? sourceMessage.metadata?.card?.name || sourceMessage.content || ''
    : ''

  const canSubmit = selectedRecipientIds.length > 0 && !submitting

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await createHandoff({
        conversationId,
        goal: note.trim() || t('handoffDefaultGoal', { defaultValue: DEFAULT_GOAL }),
        recipients: selectedRecipientIds,
        references,
      })
      toast({
        title: t('handoffSent', { defaultValue: '交接已发送' }),
      })
      onOpenChange(false)
    } catch (err) {
      log.warn('create handoff failed', { conversationId, err })
      toast({
        title: t('handoffSendFailed', { defaultValue: '交接发送失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, conversationId, note, selectedRecipientIds, references, onOpenChange, t])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent className="w-[420px] max-w-[calc(100vw-32px)] p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <ArrowRightLeft className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <DialogTitle className="text-body font-medium">
            {t('handoffComposerTitle', { defaultValue: '整理为交接' })}
          </DialogTitle>
        </div>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-4">
          {sourcePreview && (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <div className="text-caption font-medium text-muted-foreground">
                {t('handoffSourceLabel', { defaultValue: '相关材料' })}
              </div>
              <p className="mt-1 line-clamp-2 text-caption text-foreground/90">{sourcePreview}</p>
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="text-caption font-medium text-muted-foreground">
              {t('handoffNoteLabel', { defaultValue: '补充信息' })}
            </span>
            <Textarea
              value={note}
              maxLength={NOTE_MAX_LEN}
              rows={3}
              disabled={submitting}
              placeholder={t('handoffNotePlaceholder', {
                defaultValue: '有什么需要对方知道的，写在这里…',
              })}
              onChange={(e) => setNote(e.target.value)}
              className="resize-none text-body"
              autoFocus
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-caption font-medium text-muted-foreground">
              {t('handoffRecipientsLabel', { defaultValue: '交接给' })}
              <span className="ml-1 text-red-500/80">*</span>
            </span>
            {membersLoading ? (
              <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('loadingMembers', { defaultValue: '正在更新成员…' })}
              </div>
            ) : members.length === 0 ? (
              <div className="text-caption text-muted-foreground">
                {t('handoffNoCandidates', { defaultValue: '会话里没有其他成员可以交接' })}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {members.map((m) => (
                  <MemberOption
                    key={m.user_id}
                    member={m}
                    selected={selectedRecipients.has(m.user_id!)}
                    onToggle={() => toggleRecipient(m.user_id!)}
                  />
                ))}
              </div>
            )}
            <p className="text-caption text-muted-foreground/80">
              {t('handoffMaterialDisclosure', {
                defaultValue: '材料按接收者自身权限展示；对方无权访问的内容会显示「无法访问」。',
              })}
            </p>
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('cancel', { defaultValue: '取消' })}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('handoffSubmit', { defaultValue: '发送交接' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
