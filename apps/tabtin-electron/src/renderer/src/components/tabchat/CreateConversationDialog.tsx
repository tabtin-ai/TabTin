/**
 * CreateConversationDialog — 创建会话弹窗（DM/群聊切换）
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, User, Users } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  Button,
  Input,
} from '@components/ui'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useCloseOnOrganizationContextReset } from '@/hooks/useCloseOnOrganizationContextReset'
import { cn } from '@utils/cn'
import { ColorAvatar } from './ColorAvatar'
import { IMMemberTransfer } from './imMemberPicker/IMMemberTransfer'
import { useIMMemberPicker } from './imMemberPicker/useIMMemberPicker'
import { suggestedGroupNameFromMembers } from './imMemberPicker/suggestedGroupName'
import * as tabchatApi from '@/services/tabchatApi'
import type { ExternalContact } from '@/services/tabchatApi'

type TabType = 'dm' | 'group'

interface Props {
  isOpen: boolean
  /** 外部入口可直接落在群组创建，避免用户再理解「新建会话」里的二级切换。 */
  initialTab?: TabType
  /** 从消息侧栏发起时只提供群聊；私聊统一由通讯录成员入口发起。 */
  groupOnly?: boolean
  onClose: () => void
}

function formatCreateConversationError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return fallback
}

export const CreateConversationDialog: React.FC<Props> = ({
  isOpen,
  initialTab = 'dm',
  groupOnly = false,
  onClose,
}) => {
  const { t } = useTranslation('tabchat')
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id)
  const members = useOrganizationStore((s) => s.members)
  const isLoadingMembers = useOrganizationStore((s) => s.isLoadingMembers)
  const loadMembers = useOrganizationStore((s) => s.loadMembers)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const createConversationAndActivate = useIMStore(
    (s) => s.createConversationAndActivate,
  )

  const [tab, setTab] = useState<TabType>('dm')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedExternalIds, setSelectedExternalIds] = useState<Set<string>>(new Set())
  const [externalContacts, setExternalContacts] = useState<ExternalContact[]>([])
  const [groupName, setGroupName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')
  const creationAttemptRef = useRef<{ fingerprint: string; requestId: string } | null>(null)

  const {
    search,
    setSearch,
    resetSearch,
    otherMembers,
    filteredMembers,
    isSearching,
  } = useIMMemberPicker({
    organizationId,
    members,
    currentUserId,
    enabled: isOpen,
  })

  useEffect(() => {
    if (!isOpen) return
    setTab(groupOnly ? 'group' : initialTab)
    setSelectedIds(new Set())
    setSelectedExternalIds(new Set())
    resetSearch()
    setGroupName('')
    setError('')
    if (organizationId) void loadMembers(organizationId)
  }, [isOpen, initialTab, groupOnly, organizationId, loadMembers, resetSearch])

  const loadExternalContacts = useCallback(async () => {
    if (!organizationId) return
    const contacts = await tabchatApi.listExternalContacts(organizationId)
    setExternalContacts(contacts.items.filter((contact) => contact.relationship === 'friend'))
  }, [organizationId])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    void loadExternalContacts().catch(() => {
      // 联系人关系服务暂不可用时不展示候选人；服务端建群仍会再次校验。
      if (!cancelled) setExternalContacts([])
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, loadExternalContacts])

  const suggestedGroupName = useMemo(
    () => suggestedGroupNameFromMembers(
      [
        ...otherMembers,
        ...externalContacts.map((contact) => ({
          user_id: contact.contact_id,
          user: { nickname: contact.display_name || contact.peer_user_id },
        })),
      ],
      new Set([...selectedIds, ...selectedExternalIds]),
    ),
    [externalContacts, otherMembers, selectedExternalIds, selectedIds],
  )

  const groupPreviewName = groupName.trim() || suggestedGroupName || t('group')

  const resetState = useCallback(() => {
    resetSearch()
    setSelectedIds(new Set())
    setSelectedExternalIds(new Set())
    setGroupName('')
    setTab(groupOnly ? 'group' : 'dm')
    setError('')
    creationAttemptRef.current = null
  }, [groupOnly, resetSearch])

  const closeAndReset = useCallback(() => {
    resetState()
    onClose()
  }, [onClose, resetState])

  useCloseOnOrganizationContextReset(closeAndReset)

  const handleCreate = useCallback(async () => {
    if (!organizationId || isCreating) return

    const memberIds = Array.from(selectedIds).sort()
    const externalContactIds = Array.from(selectedExternalIds).sort()
    const normalizedGroupName = groupName.trim() || undefined
    const fingerprint = JSON.stringify({
      organizationId,
      tab,
      memberIds,
      externalContactIds,
      groupName: normalizedGroupName,
    })
    const creationAttempt = creationAttemptRef.current?.fingerprint === fingerprint
      ? creationAttemptRef.current
      : {
        fingerprint,
        requestId: globalThis.crypto.randomUUID(),
      }
    creationAttemptRef.current = creationAttempt

    setIsCreating(true)
    try {
      await createConversationAndActivate({
        organizationId,
        kind: tab,
        memberIds,
        externalContactIds,
        groupName: normalizedGroupName,
        clientRequestId: creationAttempt.requestId,
      })
      onClose()
      resetState()
    } catch (err) {
      console.error('[TabChat] Failed to create conversation:', err)
      setError(formatCreateConversationError(err, t('createFailed')))
    } finally {
      setIsCreating(false)
    }
  }, [organizationId, isCreating, tab, selectedIds, selectedExternalIds, groupName, t, createConversationAndActivate, onClose, resetState])

  const selectedCount = selectedIds.size + selectedExternalIds.size
  const canCreate = tab === 'dm' ? selectedCount === 1 : selectedCount >= 2
  const isGroupTab = tab === 'group'

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) { resetState(); onClose() } }}>
      <DialogContent
        className={cn(
          'flex max-h-[85vh] flex-col overflow-hidden p-0 gap-0',
          isGroupTab ? 'w-[min(860px,92vw)] max-w-[860px]' : 'sm:max-w-md',
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <ContextDialogHeader
            className="shrink-0 border-b border-foreground/[0.06] px-5 pb-4 pt-5 dark:border-foreground/[0.08]"
            icon={isGroupTab ? (
              <ColorAvatar
                name={groupPreviewName}
                seed={groupPreviewName}
                className="h-10 w-10"
                fallbackClassName="text-caption"
              />
            ) : (
              <User className="h-7 w-7" strokeWidth={1.5} aria-hidden />
            )}
            title={isGroupTab ? t('createGroup') : t('newConversation')}
            description={isGroupTab ? t('groupNameHint') : t('createConversationDescription')}
          />

          {!groupOnly && (
            <div className="flex shrink-0 border-b border-foreground/[0.06] px-5 dark:border-foreground/[0.08]">
              <button
                type="button"
                onClick={() => { setTab('dm'); setSelectedIds(new Set()); setSelectedExternalIds(new Set()) }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-body font-medium transition-colors',
                  tab === 'dm'
                    ? 'border-b-2 border-accent text-accent'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
              >
                <User className="h-3.5 w-3.5" aria-hidden />
                {t('newDM')}
              </button>
              <button
                type="button"
                onClick={() => { setTab('group'); setSelectedIds(new Set()); setSelectedExternalIds(new Set()) }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-body font-medium transition-colors',
                  tab === 'group'
                    ? 'border-b-2 border-accent text-accent'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
              >
                <Users className="h-3.5 w-3.5" aria-hidden />
                {t('newGroup')}
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-5 py-4">
            {isGroupTab ? (
              <div className="shrink-0 space-y-2">
                <label htmlFor="create-group-name" className="text-body font-medium text-foreground">
                  {t('groupNameLabel')}
                </label>
                <Input
                  id="create-group-name"
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder={t('groupNamePlaceholder')}
                />
              </div>
            ) : null}

            <IMMemberTransfer
              members={filteredMembers}
              memberDirectory={otherMembers}
              selectedIds={selectedIds}
              onSelectionChange={(ids) => {
                setSelectedIds(ids)
                if (tab === 'dm' && ids.size > 0) setSelectedExternalIds(new Set())
              }}
              search={search}
              onSearchChange={setSearch}
              isLoadingMembers={isLoadingMembers && otherMembers.length === 0}
              isSearching={isSearching}
              mode={tab === 'dm' ? 'single' : 'multi'}
              fitAvailableHeight
              className="flex-1"
            />

            <div className="shrink-0 space-y-2 border-t border-foreground/[0.06] pt-3">
              <p className="text-body font-medium">{t('externalContacts.tabs.external')}</p>
              {externalContacts.length > 0 ? (
                <div className="max-h-36 space-y-0.5 overflow-y-auto">
                  {externalContacts.map((contact) => {
                    const selected = selectedExternalIds.has(contact.contact_id)
                    return (
                      <button
                        key={contact.contact_id}
                        type="button"
                        aria-pressed={selected}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-interactive px-2 py-2 text-left text-body transition-colors',
                          selected ? 'bg-accent/10 text-accent' : 'hover:bg-foreground/[0.03]',
                        )}
                        onClick={() => {
                          const next = new Set(tab === 'dm' ? [] : selectedExternalIds)
                          if (selected) next.delete(contact.contact_id)
                          else next.add(contact.contact_id)
                          setSelectedExternalIds(next)
                          if (tab === 'dm' && next.size > 0) setSelectedIds(new Set())
                        }}
                      >
                        <ColorAvatar name={contact.display_name} seed={contact.peer_user_id} imageUrl={contact.avatar_url} className="h-8 w-8" />
                        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{contact.display_name}</span><span className="block truncate text-caption text-muted-foreground">{contact.peer_organization_name}</span></span>
                        <span className="rounded bg-warning/10 px-1.5 py-0.5 text-caption text-warning">{t('externalContacts.external')}</span>
                        {selected ? <Check className="h-4 w-4" /> : null}
                      </button>
                    )
                  })}
                </div>
              ) : <p className="text-caption text-muted-foreground">{t('externalContacts.noAddedContacts')}</p>}
              {isGroupTab && selectedExternalIds.size > 0 ? (
                <div className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-caption text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('externalContacts.externalGroupWarning')}</span>
                </div>
              ) : null}
            </div>

            {error ? (
              <p className="text-body text-destructive" role="alert">{error}</p>
            ) : null}
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t border-foreground/[0.06] px-5 py-4 dark:border-foreground/[0.08]">
            <Button
              type="button"
              variant="outline"
              onClick={() => { resetState(); onClose() }}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!canCreate || isCreating}
            >
              {isCreating ? '...' : isGroupTab ? t('createGroup') : t('create')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
