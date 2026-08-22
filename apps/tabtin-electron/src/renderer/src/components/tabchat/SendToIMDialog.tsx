/**
 * SendToIMDialog — 统一「发送资源到 IM」弹窗。
 *
 * 首屏：联系人 / 群聊分组多选 + 资源预览 + 留言。
 * 二级：创建群组并发送（保留首屏已选与留言）。
 * 结果：部分失败可重试；全部成功才关闭。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Check,
  FileText,
  Loader2,
  Send,
  Table2,
  Users,
} from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogScrollBody,
  Input,
  Textarea,
  toast,
  useOverlayContainer,
} from '@components/ui'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { ContextPageToolbar } from '@components/context-space/ContextPageToolbar'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useCloseOnOrganizationContextReset } from '@/hooks/useCloseOnOrganizationContextReset'
import type { SpaceContextItem } from '@/services/spaceApi'
import {
  createSendToIMRequestIds,
  sendResourceToIMTarget,
} from '@/services/sendResourceToIM'
import { cn } from '@utils/cn'
import { ColorAvatar } from './ColorAvatar'
import { IMMemberTransfer } from './imMemberPicker/IMMemberTransfer'
import { useIMMemberPicker } from './imMemberPicker/useIMMemberPicker'
import type { IMMemberItem } from './imMemberPicker/types'
import { memberDisplayName } from './imMemberPicker/types'
import {
  buildSendToIMContacts,
  buildSendToIMResourcePreview,
  buildSendToIMTargets,
  buildSuggestedGroupName,
  filterSendToIMContactsByQuery,
  filterSendToIMGroupConversations,
  filterSendToIMGroupsByQuery,
  normalizeSendToIMResource,
} from './sendToIM/sendToIMHelpers'
import type {
  SendToIMDeliveryResult,
  SendToIMResource,
  SendToIMTarget,
} from './sendToIM/types'
import { isNormalizedSendToIMResource } from './sendToIM/types'

type Screen = 'main' | 'create_group' | 'results'

/** 分栏 / OverlayContainer 内最小可读宽度（px） */
export const SEND_TO_IM_DIALOG_MIN_WIDTH_PX = 480

/**
 * 弹窗尺寸：scoped 到面板时用百分比宽度 + min-width，避免任务分栏下
 * 仍按整窗 92vw/860px 铺满；未 scoped 时回退视口约束。
 */
export function resolveSendToIMDialogSizeClass(scopedToPanel: boolean): string {
  if (scopedToPanel) {
    return [
      'max-h-[min(85vh,90%)]',
      'w-[85%]',
      `min-w-[${SEND_TO_IM_DIALOG_MIN_WIDTH_PX}px]`,
      'max-w-[min(860px,calc(100%-24px))]',
    ].join(' ')
  }
  return [
    'max-h-[85vh]',
    'w-[min(860px,90vw)]',
    `min-w-[${SEND_TO_IM_DIALOG_MIN_WIDTH_PX}px]`,
    'max-w-[860px]',
  ].join(' ')
}

export interface SendToIMDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 待发送资源：ContextItem 会在弹窗内归一化 */
  resource: SpaceContextItem | SendToIMResource
  organizationId?: string
  /** 当前用户是否具备资源 owner/admin 权限，可在私信发送时授予 viewer。 */
  canGrantResourceAccess?: boolean
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return fallback
}

function deliveryStatusLabel(
  result: SendToIMDeliveryResult,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (result.status === 'success') return t('sendToIMStatusSuccess')
  if (result.status === 'partial') return t('sendToIMStatusPartial')
  if (result.status === 'sending') return t('sendToIMStatusSending')
  if (result.status === 'failed') return t('sendToIMStatusFailed')
  return t('sendToIMStatusPending')
}

function formatDeliveryError(
  error: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!error) return ''
  if (error === 'removed_from_group') return t('removedFromGroup')
  if (error === 'resource_send_failed') return t('sendToIMErrorResourceFailed')
  if (error === 'note_send_failed') return t('sendToIMErrorNoteFailed')
  if (error === 'send_failed') return t('sendToIMErrorSendFailed')
  return error
}

export const SendToIMDialog: React.FC<SendToIMDialogProps> = ({
  open,
  onOpenChange,
  resource: resourceInput,
  organizationId: organizationIdProp,
  canGrantResourceAccess = false,
}) => {
  const { t } = useTranslation('tabchat')
  const overlayContainer = useOverlayContainer()
  const isScopedToPanel = Boolean(overlayContainer)
  const dialogSizeClass = resolveSendToIMDialogSizeClass(isScopedToPanel)
  const storeOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id)
  const organizationId = organizationIdProp ?? storeOrganizationId
  const members = useOrganizationStore((s) => s.members) as IMMemberItem[]
  const isLoadingMembers = useOrganizationStore((s) => s.isLoadingMembers)
  const loadMembers = useOrganizationStore((s) => s.loadMembers)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const conversations = useIMStore((s) => s.conversations)
  const loadConversations = useIMStore((s) => s.loadConversations)
  const createConversationAndActivate = useIMStore((s) => s.createConversationAndActivate)

  const [screen, setScreen] = useState<Screen>('main')
  const [search, setSearch] = useState('')
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [groupName, setGroupName] = useState('')
  const [createGroupMemberIds, setCreateGroupMemberIds] = useState<Set<string>>(new Set())
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [results, setResults] = useState<SendToIMDeliveryResult[]>([])

  const normalizedResource = useMemo((): SendToIMResource | null => {
    if (isNormalizedSendToIMResource(resourceInput)) return resourceInput
    return normalizeSendToIMResource(resourceInput)
  }, [resourceInput])

  const resourcePreview = useMemo(
    () => (normalizedResource ? buildSendToIMResourcePreview(normalizedResource) : null),
    [normalizedResource],
  )

  const contacts = useMemo(
    () => buildSendToIMContacts(members, currentUserId),
    [members, currentUserId],
  )

  const groups = useMemo(
    () => (organizationId ? filterSendToIMGroupConversations(conversations, organizationId) : []),
    [conversations, organizationId],
  )

  const filteredContacts = useMemo(
    () => filterSendToIMContactsByQuery(contacts, search),
    [contacts, search],
  )

  const filteredGroups = useMemo(
    () => filterSendToIMGroupsByQuery(groups, search),
    [groups, search],
  )

  const {
    search: createGroupSearch,
    setSearch: setCreateGroupSearch,
    resetSearch: resetCreateGroupSearch,
    otherMembers: createGroupDirectory,
    filteredMembers: createGroupFilteredMembers,
    isSearching: isCreateGroupSearching,
  } = useIMMemberPicker({
    organizationId,
    members: contacts,
    currentUserId,
    enabled: open && screen === 'create_group',
  })

  const suggestedGroupName = useMemo(
    () => buildSuggestedGroupName(contacts, createGroupMemberIds, t('group')),
    [contacts, createGroupMemberIds, t],
  )

  const groupPreviewName = groupName.trim() || suggestedGroupName || t('group')

  const resetState = useCallback(() => {
    setScreen('main')
    setSearch('')
    setSelectedContactIds(new Set())
    setSelectedGroupIds(new Set())
    setNote('')
    setGroupName('')
    setCreateGroupMemberIds(new Set())
    resetCreateGroupSearch()
    setIsSubmitting(false)
    setLoadError('')
    setSubmitError('')
    setResults([])
  }, [resetCreateGroupSearch])

  const closeDialog = useCallback(() => {
    resetState()
    onOpenChange(false)
  }, [onOpenChange, resetState])

  const notifySendSuccess = useCallback((count: number) => {
    toast({
      title: t('sendToIMSuccessToast', {
        count,
        defaultValue: '已成功发送到 {{count}} 个目标',
      }),
    })
  }, [t])

  useCloseOnOrganizationContextReset(closeDialog)

  useEffect(() => {
    if (!open) return
    resetState()
    if (organizationId) {
      void loadMembers(organizationId)
      void loadConversations(organizationId).catch((error) => {
        setLoadError(formatErrorMessage(error, t('loadConversationsFailed')))
      })
    }
  }, [open, organizationId, loadMembers, loadConversations, resetState, t])

  const toggleContact = useCallback((userId: string) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }, [])

  const toggleGroup = useCallback((conversationId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(conversationId)) next.delete(conversationId)
      else next.add(conversationId)
      return next
    })
  }, [])

  const resolveConversationId = useCallback(async (target: SendToIMTarget): Promise<string> => {
    if (!organizationId) {
      throw new Error(t('sendToIMMissingOrganization'))
    }
    if (target.kind === 'group' && target.conversationId) {
      return target.conversationId
    }
    if (!target.userId) {
      throw new Error(t('sendToIMInvalidTarget'))
    }
    return createConversationAndActivate({
      organizationId,
      kind: 'dm',
      memberIds: [target.userId],
      activate: false,
    })
  }, [createConversationAndActivate, organizationId, t])

  const deliverToTargets = useCallback(async (
    targets: SendToIMTarget[],
    previousResults: SendToIMDeliveryResult[] = [],
  ): Promise<SendToIMDeliveryResult[]> => {
    if (!normalizedResource) {
      throw new Error(t('sendToIMUnsupportedResource'))
    }

    const previousByKey = new Map(previousResults.map((result) => [result.target.key, result]))
    const nextResults: SendToIMDeliveryResult[] = targets.map((target) => {
      const previous = previousByKey.get(target.key)
      if (previous?.status === 'success') return previous
      return {
        target,
        status: 'pending',
      }
    })

    setResults(() => {
      const merged = new Map(previousResults.map((result) => [result.target.key, result]))
      for (const target of targets) {
        if (merged.get(target.key)?.status !== 'success') {
          merged.set(target.key, { target, status: 'sending' })
        }
      }
      return Array.from(merged.values())
    })

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]
      const previous = previousByKey.get(target.key)
      if (previous?.status === 'success') continue
      const requestIds = previous?.requestIds ?? createSendToIMRequestIds()

      try {
        const convId = await resolveConversationId(target)
        const skipResource = previous?.resourceSent === true || previous?.status === 'partial'
        const delivery = await sendResourceToIMTarget({
          convId,
          resource: normalizedResource,
          note,
          requestIds,
          skipResource,
        })

        nextResults[index] = {
          target,
          status: delivery.resourceOk
            ? (delivery.noteOk ? 'success' : 'partial')
            : 'failed',
          resourceSent: delivery.resourceOk,
          noteSent: delivery.noteOk,
          error: delivery.error,
          requestIds,
        }
      } catch (error) {
        nextResults[index] = {
          target,
          status: 'failed',
          resourceSent: false,
          noteSent: false,
          error: formatErrorMessage(error, t('sendFailed')),
          requestIds,
        }
      }

      setResults((current) => {
        const merged = new Map(current.map((result) => [result.target.key, result]))
        merged.set(target.key, nextResults[index]!)
        return Array.from(merged.values())
      })
    }

    const merged = new Map(previousResults.map((result) => [result.target.key, result]))
    for (const result of nextResults) {
      merged.set(result.target.key, result)
    }
    return Array.from(merged.values())
  }, [normalizedResource, note, resolveConversationId, t])

  const handleSend = useCallback(async () => {
    if (!organizationId || isSubmitting || !normalizedResource) return
    const targets = buildSendToIMTargets({
      selectedContactIds,
      selectedGroupIds,
      contacts,
      groups,
    })
    if (targets.length === 0) return

    setIsSubmitting(true)
    setSubmitError('')
    try {
      const mergedResults = await deliverToTargets(targets)
      setScreen('results')
      const allSuccess = mergedResults.every((result) => result.status === 'success')
      if (allSuccess) {
        notifySendSuccess(mergedResults.length)
        closeDialog()
      }
    } catch (error) {
      setSubmitError(formatErrorMessage(error, t('sendFailed')))
    } finally {
      setIsSubmitting(false)
    }
  }, [
    closeDialog,
    contacts,
    deliverToTargets,
    groups,
    isSubmitting,
    normalizedResource,
    notifySendSuccess,
    organizationId,
    selectedContactIds,
    selectedGroupIds,
    t,
  ])

  const handleCreateGroupAndSend = useCallback(async () => {
    if (!organizationId || isSubmitting || !normalizedResource || createGroupMemberIds.size === 0) return

    setIsSubmitting(true)
    setSubmitError('')
    try {
      const convId = await createConversationAndActivate({
        organizationId,
        kind: 'group',
        memberIds: Array.from(createGroupMemberIds),
        groupName: groupPreviewName,
        activate: false,
      })
      const target: SendToIMTarget = {
        key: `group:${convId}`,
        kind: 'group',
        conversationId: convId,
        label: groupPreviewName,
      }
      const nextResults = await deliverToTargets([target])
      setScreen('results')
      if (nextResults.every((result) => result.status === 'success')) {
        notifySendSuccess(nextResults.length)
        closeDialog()
      }
    } catch (error) {
      setSubmitError(formatErrorMessage(error, t('createFailed')))
    } finally {
      setIsSubmitting(false)
    }
  }, [
    closeDialog,
    createConversationAndActivate,
    createGroupMemberIds,
    deliverToTargets,
    groupPreviewName,
    isSubmitting,
    normalizedResource,
    notifySendSuccess,
    organizationId,
    t,
  ])

  const handleRetryFailed = useCallback(async () => {
    const retryTargets = results
      .filter((result) => result.status === 'failed' || result.status === 'partial')
      .map((result) => result.target)
    if (retryTargets.length === 0) return

    setIsSubmitting(true)
    setSubmitError('')
    try {
      const mergedResults = await deliverToTargets(retryTargets, results)
      if (mergedResults.every((result) => result.status === 'success')) {
        notifySendSuccess(mergedResults.length)
        closeDialog()
      }
    } catch (error) {
      setSubmitError(formatErrorMessage(error, t('sendFailed')))
    } finally {
      setIsSubmitting(false)
    }
  }, [closeDialog, deliverToTargets, notifySendSuccess, results, t])

  const selectedCount = selectedContactIds.size + selectedGroupIds.size
  const hasOrganization = Boolean(organizationId)
  const canSendMain =
    hasOrganization && selectedCount > 0 && Boolean(normalizedResource) && !isSubmitting
  const canCreateGroupSend =
    hasOrganization
    && createGroupMemberIds.size >= 2
    && Boolean(normalizedResource)
    && !isSubmitting
  const failedCount = results.filter((result) => result.status === 'failed' || result.status === 'partial').length

  const renderResourcePreview = () => {
    if (!resourcePreview) {
      return (
        <div className="rounded-[12px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {t('sendToIMUnsupportedResource')}
        </div>
      )
    }

    const Icon = resourcePreview.kind === 'resource_card'
      ? (resourcePreview.subtitle === 'resourceCardTable' ? Table2 : FileText)
      : FileText

    return (
      <div className="rounded-[12px] border border-foreground/[0.08] bg-foreground/[0.02] px-4 py-3 dark:border-foreground/[0.12]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-foreground/[0.05] text-muted-foreground">
            <Icon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="truncate text-body font-medium text-foreground">{resourcePreview.title}</div>
            <div className={cn('truncate', CANVAS_TEXT_META)}>
              {t(resourcePreview.subtitle)}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderTargetRow = (
    key: string,
    label: string,
    subtitle: string,
    selected: boolean,
    onToggle: () => void,
    avatar?: React.ReactNode,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-3 rounded-interactive px-2.5 py-2 text-left transition-colors',
        selected
          ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08]'
          : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
      )}
    >
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate text-body text-foreground">{label}</div>
        <div className={cn('truncate', CANVAS_TEXT_META)}>{subtitle}</div>
      </div>
      {selected ? <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : null}
    </button>
  )

  const renderMainScreen = () => (
    <>
      <ContextDialogHeader
        className="shrink-0 border-b border-foreground/[0.06] px-5 pb-4 pt-5 dark:border-foreground/[0.08]"
        icon={<Send className="h-7 w-7" strokeWidth={1.5} aria-hidden />}
        title={t('sendToIMTitle')}
        description={t('sendToIMDescription')}
      />

      <DialogScrollBody className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
        {renderResourcePreview()}

        {normalizedResource?.kind === 'resource_card' ? (
          <p className={cn('rounded-lg bg-muted/40 px-3 py-2', CANVAS_TEXT_META)}>
            {canGrantResourceAccess
              ? t('sendToIMViewerGrantHint', {
                  defaultValue: '发送给联系人后，对方将获得查看权限；发送到群聊不会自动授权。',
                })
              : t('sendToIMCardOnlyHint', {
                  defaultValue: '将仅发送资源卡；没有权限的联系人需要申请访问。',
                })}
          </p>
        ) : null}

        <div className="space-y-2">
          <label htmlFor="send-to-im-note" className="text-body font-medium text-foreground">
            {t('sendToIMNoteLabel')}
          </label>
          <Textarea
            id="send-to-im-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('sendToIMNotePlaceholder')}
            className="min-h-[72px] resize-none"
          />
        </div>

        <ContextPageToolbar
          withHeaderGap={false}
          searchPlaceholder={t('sendToIMSearchPlaceholder')}
          searchValue={search}
          onSearchChange={setSearch}
          searchAriaLabel={t('sendToIMSearchPlaceholder')}
        />

        {loadError ? (
          <p className="text-body text-destructive" role="alert">{loadError}</p>
        ) : null}
        {!hasOrganization ? (
          <p className="text-body text-destructive" role="alert">{t('sendToIMMissingOrganization')}</p>
        ) : null}

        <div className="min-h-[280px] flex-1 overflow-y-auto rounded-[12px] border border-foreground/[0.08] p-1.5 scrollbar-hover dark:border-foreground/[0.12]">
          {isLoadingMembers && contacts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-body">{t('loadingMembers')}</span>
            </div>
          ) : (
            <>
              {/* 分组标题用普通 section：cmdk Group 依赖外层 Command context，孤立使用会渲染崩溃 */}
              <section className="px-1" aria-label={t('sendToIMContactsHeading')}>
                <div className="px-2 py-1.5 text-body font-medium text-muted-foreground">
                  {t('sendToIMContactsHeading')}
                </div>
                {filteredContacts.length === 0 ? (
                  <p className={cn('px-2 py-4 text-center', CANVAS_TEXT_META)}>
                    {contacts.length === 0 ? t('noOtherMembers') : t('sendToIMNoMatches')}
                  </p>
                ) : (
                  filteredContacts.map((member) => {
                    const name = memberDisplayName(member)
                    return renderTargetRow(
                      member.user_id,
                      name,
                      t('sendToIMContactSubtitle'),
                      selectedContactIds.has(member.user_id),
                      () => toggleContact(member.user_id),
                      (
                        <ColorAvatar
                          name={name}
                          seed={member.user_id}
                          imageUrl={member.user?.avatar}
                          className="h-8 w-8"
                          fallbackClassName="text-caption"
                        />
                      ),
                    )
                  })
                )}
              </section>

              <section className="mt-2 px-1" aria-label={t('sendToIMGroupsHeading')}>
                <div className="px-2 py-1.5 text-body font-medium text-muted-foreground">
                  {t('sendToIMGroupsHeading')}
                </div>
                {filteredGroups.length === 0 ? (
                  <p className={cn('px-2 py-4 text-center', CANVAS_TEXT_META)}>
                    {groups.length === 0 ? t('noConversations') : t('sendToIMNoMatches')}
                  </p>
                ) : (
                  filteredGroups.map((group) => {
                    const groupLabel = group.name?.trim() || group.id
                    return renderTargetRow(
                      group.id,
                      groupLabel,
                      t('sendToIMGroupSubtitle', { count: group.member_count }),
                      selectedGroupIds.has(group.id),
                      () => toggleGroup(group.id),
                      (
                        <ColorAvatar
                          name={groupLabel}
                          seed={group.id}
                          imageUrl={group.avatar_url}
                          className="h-8 w-8"
                          fallbackClassName="text-caption"
                        />
                      ),
                    )
                  })
                )}
              </section>
            </>
          )}
        </div>

        {submitError ? (
          <p className="text-body text-destructive" role="alert">{submitError}</p>
        ) : null}
      </DialogScrollBody>

      <DialogFooter className="shrink-0 flex-col gap-2 border-t border-foreground/[0.06] px-5 py-4 dark:border-foreground/[0.08] sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          className="justify-start px-0 text-accent hover:text-accent"
          onClick={() => setScreen('create_group')}
        >
          {t('sendToIMCreateGroupAndSend')}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={closeDialog}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSend()} disabled={!canSendMain}>
            {isSubmitting ? '...' : t('sendToIMSend', { count: selectedCount })}
          </Button>
        </div>
      </DialogFooter>
    </>
  )

  const renderCreateGroupScreen = () => (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-foreground/[0.06] px-5 pb-4 pt-5 dark:border-foreground/[0.08]">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => setScreen('main')}
          aria-label={t('sendToIMBack')}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-title font-semibold text-foreground">{t('sendToIMCreateGroupTitle')}</div>
          <div className={cn('mt-0.5', CANVAS_TEXT_META)}>{t('sendToIMCreateGroupDescription')}</div>
        </div>
        <Users className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden />
      </div>

      <DialogScrollBody className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
        {renderResourcePreview()}

        <div className="space-y-2">
          <label htmlFor="send-to-im-group-name" className="text-body font-medium text-foreground">
            {t('groupNameLabel')}
          </label>
          <Input
            id="send-to-im-group-name"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder={t('groupNamePlaceholder')}
          />
        </div>

        <IMMemberTransfer
          members={createGroupFilteredMembers}
          memberDirectory={createGroupDirectory}
          selectedIds={createGroupMemberIds}
          onSelectionChange={setCreateGroupMemberIds}
          search={createGroupSearch}
          onSearchChange={setCreateGroupSearch}
          isLoadingMembers={isLoadingMembers}
          isSearching={isCreateGroupSearching}
          mode="multi"
        />

        {submitError ? (
          <p className="text-body text-destructive" role="alert">{submitError}</p>
        ) : null}
      </DialogScrollBody>

      <DialogFooter className="shrink-0 gap-2 border-t border-foreground/[0.06] px-5 py-4 dark:border-foreground/[0.08]">
        <Button type="button" variant="outline" onClick={() => setScreen('main')}>
          {t('cancel')}
        </Button>
        <Button type="button" onClick={() => void handleCreateGroupAndSend()} disabled={!canCreateGroupSend}>
          {isSubmitting ? '...' : t('sendToIMCreateGroupConfirm')}
        </Button>
      </DialogFooter>
    </>
  )

  const renderResultsScreen = () => (
    <>
      <ContextDialogHeader
        className="shrink-0 border-b border-foreground/[0.06] px-5 pb-4 pt-5 dark:border-foreground/[0.08]"
        icon={<Send className="h-7 w-7" strokeWidth={1.5} aria-hidden />}
        title={t('sendToIMResultsTitle')}
        description={failedCount > 0 ? t('sendToIMResultsDescriptionFailed', { count: failedCount }) : t('sendToIMResultsDescriptionSuccess')}
      />

      <DialogScrollBody className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
        {results.map((result) => (
          <div
            key={result.target.key}
            className="flex items-center justify-between gap-3 rounded-[12px] border border-foreground/[0.08] px-3 py-2.5 dark:border-foreground/[0.12]"
          >
            <div className="min-w-0">
              <div className="truncate text-body text-foreground">{result.target.label}</div>
              <div className={cn('truncate', CANVAS_TEXT_META)}>
                {deliveryStatusLabel(result, t)}
                {result.error ? ` · ${formatDeliveryError(result.error, t)}` : ''}
              </div>
            </div>
            {result.status === 'success' ? (
              <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
            ) : result.status === 'sending' ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : null}
          </div>
        ))}

        {submitError ? (
          <p className="text-body text-destructive" role="alert">{submitError}</p>
        ) : null}
      </DialogScrollBody>

      <DialogFooter className="shrink-0 gap-2 border-t border-foreground/[0.06] px-5 py-4 dark:border-foreground/[0.08]">
        <Button type="button" variant="outline" onClick={closeDialog}>
          {t('cancel')}
        </Button>
        {failedCount > 0 ? (
          <Button type="button" onClick={() => void handleRetryFailed()} disabled={isSubmitting}>
            {isSubmitting ? '...' : t('sendToIMRetryFailed', { count: failedCount })}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  )

  return (
    <Dialog
      open={open}
      modal={!isScopedToPanel}
      onOpenChange={(nextOpen) => { if (!nextOpen) closeDialog() }}
    >
      <DialogContent
        data-shell-overlay-allows-resize={isScopedToPanel ? '' : undefined}
        className={cn(
          'pointer-events-auto flex flex-col overflow-hidden p-0 gap-0',
          dialogSizeClass,
        )}
        overlayClassName={isScopedToPanel ? '!pointer-events-none' : undefined}
        onPointerDownOutside={(event) => {
          if (isScopedToPanel) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (isScopedToPanel) event.preventDefault()
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {screen === 'main' ? renderMainScreen() : null}
          {screen === 'create_group' ? renderCreateGroupScreen() : null}
          {screen === 'results' ? renderResultsScreen() : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
