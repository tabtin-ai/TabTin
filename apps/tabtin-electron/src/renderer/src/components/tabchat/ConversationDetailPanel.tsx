/**
 * ConversationDetailPanel — 会话详情面板（右侧抽屉）
 *
 * 群聊：群头像/名 + 成员管理 + 设置（免打扰/置顶/清空记录/退出群聊）。
 * 私聊：对方资料 + 设置（免打扰/置顶/清空记录）。
 */

import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X, UserPlus, UserMinus, Crown, Shield, Loader2, Bot, Users,
  Bell, BellOff, Pin, Trash2, LogOut, Pencil, Check, Ban, Replace,
} from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { ChatIconTooltip } from '@components/chat/panel/ChatIconTooltip'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import * as tabchatApi from '@/services/tabchatApi'
import type { ConversationAgentBinding, ConversationMember } from '@/services/tabchatApi'
import type { ExternalContact } from '@/services/tabchatApi'
import { AvatarCropUploader } from '@components/shared/AvatarCropUploader'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useUserProfile, useUserProfileCache } from '@stores/useUserProfileCache'
import { AgentMemberBadges } from './AgentMemberBadges'
import { ColorAvatar } from './ColorAvatar'
import {
  MEMBER_ROLE_ADMIN,
  MEMBER_ROLE_OWNER,
  CONVERSATION_TYPE_GROUP,
} from '@/constants/tabchat'
import {
  agentOwnerDisplayName,
  countMemberBreakdown,
  isAgentExecutionOffline,
  isAgentMember,
  partitionConversationMembers,
} from './conversationMembers'
import { IM_AGENT_OFFLINE_IDENTITY_CLASS } from './tabchatUi'
import {
  planGroupMemberDirectChat,
  resolveGroupMemberDirectChat,
} from './resolveGroupMemberDirectChat'
import { AgentWorkspacePickerDialog } from './AgentWorkspacePickerDialog'

interface AddCandidate {
  user_id: string
  user?: { nickname?: string; username?: string; email?: string; avatar?: string }
}

interface AgentCandidate {
  agent_id: string
  name: string
  avatar?: string
}

interface Props {
  conversationId: string
  isOpen: boolean
  onClose: () => void
  onHistoryCleared?: () => void
}

type ConfirmAction = 'clear' | 'leave' | 'remove-contact' | null

export const ConversationDetailPanel: React.FC<Props> = ({
  conversationId,
  isOpen,
  onClose,
  onHistoryCleared,
}) => {
  const { t } = useTranslation('tabchat')
  const currentUserId = useAuthStore((s) => s.user?.id)
  const conversation = useIMStore((s) => s.conversations.find((c) => c.id === conversationId))
  const isGroup = conversation?.type === CONVERSATION_TYPE_GROUP
  const isMuted = conversation?.is_muted ?? false
  const isPinned = conversation?.pinned ?? false
  const conversationOrganizationId = conversation?.organization_id
  const peerId = !isGroup ? conversation?.dm_peer_user_id : undefined
  const peerProfile = useUserProfile(peerId)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  const members = useIMStore((s) => s.conversationMembers[conversationId])
  const membersLoading = useIMStore(
    (s) => s.conversationMembersLoading[conversationId] ?? false,
  )
  const refreshConversationMembers = useIMStore((s) => s.refreshConversationMembers)

  useEffect(() => {
    if (isOpen && peerId) ensureProfiles([peerId])
  }, [ensureProfiles, isOpen, peerId])

  const [showAddPanel, setShowAddPanel] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [isLeaving, setIsLeaving] = useState(false)
  const leaveInFlightRef = useRef(false)
  const [isMutating, setIsMutating] = useState(false)
  const [isEditingGroupName, setIsEditingGroupName] = useState(false)
  const [groupNameDraft, setGroupNameDraft] = useState('')
  const [isSavingGroupName, setIsSavingGroupName] = useState(false)
  // 移除成员二次确认：记录正在确认移除的成员 key（agent_id 或 user_id）
  const [confirmRemoveMemberId, setConfirmRemoveMemberId] = useState<string | null>(null)
  const organizationMembers = useOrganizationStore((s) => s.members)
  const loadMembers = useOrganizationStore((s) => s.loadMembers)
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id)
  const [apiSearchResults, setApiSearchResults] = useState<AddCandidate[]>([])
  const [agentResults, setAgentResults] = useState<AgentCandidate[]>([])
  const [externalContacts, setExternalContacts] = useState<ExternalContact[]>([])
  const [isSearchingApi, setIsSearchingApi] = useState(false)
  const [pendingAgent, setPendingAgent] = useState<AgentCandidate | null>(null)
  const [rebindAgentId, setRebindAgentId] = useState<string | null>(null)
  const [agentBindings, setAgentBindings] = useState<ConversationAgentBinding[]>([])
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const myRole = members?.find((m) => m.user_id === currentUserId)?.role ?? 0
  const isAdminOrOwner = myRole >= MEMBER_ROLE_ADMIN
  const canAddAgents = Boolean(
    isGroup && !conversation?.is_external && !conversation?.is_team_space_channel,
  )

  const resetAddPanel = useCallback(() => {
    setShowAddPanel(false)
    setAddQuery('')
    setApiSearchResults([])
    setAgentResults([])
    setIsSearchingApi(false)
    setPendingAgent(null)
    setRebindAgentId(null)
  }, [])

  const handleClose = useCallback((e?: React.MouseEvent<HTMLButtonElement>) => {
    e?.stopPropagation()
    resetAddPanel()
    setConfirmAction(null)
    onClose()
  }, [onClose, resetAddPanel])

  useEffect(() => {
    if (!isOpen) {
      resetAddPanel()
      setConfirmAction(null)
    }
  }, [isOpen, resetAddPanel])

  useEffect(() => {
    if (showAddPanel && organizationId && organizationMembers.length === 0) {
      void loadMembers(organizationId)
    }
  }, [showAddPanel, organizationId, organizationMembers.length, loadMembers])

  // TC-8：打开添加面板时拉取本团队可加入的 AI Agent（普通群成员可加自己的 bot）
  useEffect(() => {
    if (!showAddPanel || !organizationId || !canAddAgents) {
      setAgentResults([])
      return
    }
    let cancelled = false
    tabchatApi
      .searchOrganizationAgents(organizationId, addQuery.trim())
      .then((results) => {
        if (cancelled) return
        setAgentResults(results.map((r) => ({ agent_id: r.id, name: r.name, avatar: r.avatar })))
      })
      .catch(() => {
        if (!cancelled) setAgentResults([])
      })
    return () => { cancelled = true }
  }, [canAddAgents, showAddPanel, organizationId, addQuery])

  useEffect(() => {
    // 已有群聊不可再引入外部联系人；外部联系人只在新建群聊（含私聊转群）时选择。
    const needsExternalContacts = !isGroup && (showAddPanel || conversation?.is_external)
    if (!needsExternalContacts || !organizationId) {
      setExternalContacts([])
      return
    }
    let cancelled = false
    void tabchatApi.listExternalContacts(organizationId)
      .then(({ items }) => {
        if (!cancelled) setExternalContacts(items.filter((item) => item.relationship === 'friend'))
      })
      .catch(() => { if (!cancelled) setExternalContacts([]) })
    return () => { cancelled = true }
  }, [conversation?.is_external, isGroup, showAddPanel, organizationId])

  const dmExternalContact = !isGroup && peerId
    ? externalContacts.find((contact) => (
      contact.peer_user_id === peerId
      && contact.peer_organization_id === conversation?.dm_peer_organization_id
    ))
    : undefined

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const query = addQuery.trim()
    if (!query || !organizationId) {
      setApiSearchResults([])
      setIsSearchingApi(false)
      return
    }
    let cancelled = false
    setIsSearchingApi(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await tabchatApi.searchOrganizationMembers(organizationId, query)
        if (cancelled) return
        setApiSearchResults(results.map((r) => ({
          user_id: r.id,
          user: { nickname: r.nickname, username: r.username, email: r.email, avatar: r.avatar },
        })))
      } catch {
        if (!cancelled) setApiSearchResults([])
      } finally {
        if (!cancelled) setIsSearchingApi(false)
      }
    }, 300)
    return () => {
      cancelled = true
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [addQuery, organizationId])

  const addableCandidates = useMemo((): AddCandidate[] => {
    if (!members) return []
    const existingIds = new Set(members.map((m) => m.user_id))
    const localCandidates: AddCandidate[] = (organizationMembers || [])
      .filter((m) => !existingIds.has(m.user_id))
      .map((m) => ({ user_id: m.user_id, user: m.user }))

    const q = addQuery.trim().toLowerCase()
    const filtered = q
      ? localCandidates.filter(
          (m) =>
            (m.user?.nickname || '').toLowerCase().includes(q) ||
            (m.user?.username || '').toLowerCase().includes(q) ||
            (m.user?.email || '').toLowerCase().includes(q),
        )
      : localCandidates

    if (apiSearchResults.length === 0) return filtered

    const seen = new Set(filtered.map((m) => m.user_id))
    const merged = [...filtered]
    for (const r of apiSearchResults) {
      if (!seen.has(r.user_id) && !existingIds.has(r.user_id)) {
        merged.push(r)
        seen.add(r.user_id)
      }
    }
    return merged
  }, [members, organizationMembers, addQuery, apiSearchResults])

  const addableAgents = useMemo((): AgentCandidate[] => {
    if (!canAddAgents || !members) return []
    const existingAgentIds = new Set(
      members.filter((m) => m.agent_id).map((m) => m.agent_id as string),
    )
    return agentResults.filter((a) => !existingAgentIds.has(a.agent_id))
  }, [canAddAgents, members, agentResults])

  const addableExternalContacts = useMemo(() => {
    if (isGroup) return []
    const existingIds = new Set(members?.map((member) => member.user_id) ?? [])
    return externalContacts.filter((contact) => !existingIds.has(contact.peer_user_id))
  }, [externalContacts, isGroup, members])

  const memberBreakdown = useMemo(
    () => (members ? countMemberBreakdown(members) : null),
    [members],
  )

  const { humans: humanMembers, agents: agentMembers } = useMemo(
    () => (members ? partitionConversationMembers(members) : { humans: [], agents: [] }),
    [members],
  )

  // 私聊身份只认资料缓存：会话快照可能滞后于用户改名或头像更新。
  const peerName = peerProfile?.nickname || peerProfile?.username || (peerProfile ? peerId?.slice(0, 8) || '' : '')
  const peerAvatar = peerProfile?.avatar || ''

  const [isAdding, setIsAdding] = useState(false)
  const [openingMemberUserId, setOpeningMemberUserId] = useState<string | null>(null)
  const openingMemberUserIdRef = useRef<string | null>(null)

  const createGroupFromDM = useCallback(async (
    addedUserIds: string[] = [],
    addedExternalContactIds: string[] = [],
  ) => {
    if (!conversationOrganizationId || !currentUserId || !members) {
      throw new Error('DM members are unavailable')
    }
    const memberIds: string[] = []
    const externalContactIds: string[] = []
    for (const member of members) {
      if (!member.user_id || member.user_id === currentUserId) continue
      if (!member.is_external) {
        memberIds.push(member.user_id)
        continue
      }
      const contact = externalContacts.find((item) => (
        item.peer_user_id === member.user_id
        && item.peer_organization_id === member.participant_organization_id
      ))
      if (!contact) throw new Error('External DM peer is not an active contact')
      externalContactIds.push(contact.contact_id)
    }
    await useIMStore.getState().createConversationAndActivate({
      organizationId: conversationOrganizationId,
      kind: 'group',
      memberIds: Array.from(new Set([...memberIds, ...addedUserIds])),
      externalContactIds: Array.from(new Set([
        ...externalContactIds,
        ...addedExternalContactIds,
      ])),
    })
    onClose()
  }, [conversationOrganizationId, currentUserId, externalContacts, members, onClose])

  const handleOpenMemberDM = useCallback(
    async (userId: string) => {
      if (!isGroup || !conversationOrganizationId || userId === currentUserId || openingMemberUserIdRef.current) return
      openingMemberUserIdRef.current = userId
      setOpeningMemberUserId(userId)
      try {
        const member = members?.find((item) => item.user_id === userId)
        const plan = planGroupMemberDirectChat(
          conversationOrganizationId,
          userId,
          await resolveGroupMemberDirectChat({
            organizationId: conversationOrganizationId,
            userId,
            participantOrganizationId: member?.participant_organization_id,
            memberIsExternal: Boolean(member?.is_external),
            conversationIsExternal: Boolean(conversation?.is_external),
          }),
        )
        if (plan.type === 'reject') {
          toast({ title: t(plan.messageKey), variant: 'destructive' })
          return
        }
        await useIMStore.getState().createConversationAndActivate(plan.input)
        onClose()
      } catch (err) {
        console.error('[TabChat] Failed to open DM from group member:', err)
        toast({ title: t('createFailed'), variant: 'destructive' })
      } finally {
        openingMemberUserIdRef.current = null
        setOpeningMemberUserId(null)
      }
    },
    [conversation?.is_external, conversationOrganizationId, currentUserId, isGroup, members, onClose, t],
  )

  const handleAddMember = useCallback(
    async (userId: string) => {
      if (!conversationId || isAdding) return
      setIsAdding(true)
      try {
        if (isGroup) {
          await tabchatApi.addMembers(conversationId, [userId])
          await refreshConversationMembers(conversationId, {
            supersede: true,
            invalidateSnapshot: true,
          })
        } else {
          await createGroupFromDM([userId])
        }
        setShowAddPanel(false)
        setAddQuery('')
        toast({ title: t('memberAdded') })
      } catch (err) {
        console.error('[TabChat] Failed to add member:', err)
        toast({ title: t('addMemberFailed'), variant: 'destructive' })
      } finally {
        setIsAdding(false)
      }
    },
    [conversationId, createGroupFromDM, isAdding, isGroup, refreshConversationMembers, t],
  )

  const refreshAgentBindings = useCallback(async () => {
    if (!conversationId || !isGroup) {
      setAgentBindings([])
      return
    }
    try {
      const items = await tabchatApi.listConversationAgentBindings(conversationId)
      setAgentBindings(items)
    } catch (err) {
      console.error('[TabChat] Failed to load agent bindings:', err)
      setAgentBindings([])
    }
  }, [conversationId, isGroup])

  const handleAddAgent = useCallback((agent: AgentCandidate) => {
    if (!conversationId || isAdding) return
    setPendingAgent(agent)
  }, [conversationId, isAdding])

  const handleConfirmAddAgentWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!conversationId || !pendingAgent || isAdding) return
      setIsAdding(true)
      try {
        await tabchatApi.createConversationAgentBinding(
          conversationId,
          pendingAgent.agent_id,
          workspaceId,
        )
        await refreshConversationMembers(conversationId, {
          supersede: true,
          invalidateSnapshot: true,
        })
        await refreshAgentBindings()
        setPendingAgent(null)
        setShowAddPanel(false)
        setAddQuery('')
        toast({ title: t('memberAdded') })
      } catch (err) {
        console.error('[TabChat] Failed to add agent:', err)
        throw err
      } finally {
        setIsAdding(false)
      }
    },
    [conversationId, isAdding, pendingAgent, refreshAgentBindings, refreshConversationMembers, t],
  )

  const handleConfirmRebindWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!conversationId || !rebindAgentId) return
      await tabchatApi.updateConversationAgentBinding(conversationId, rebindAgentId, workspaceId)
      await refreshAgentBindings()
      setRebindAgentId(null)
      toast({ title: t('workspaceUpdated') })
    },
    [conversationId, rebindAgentId, refreshAgentBindings, t],
  )

  const handleAddExternalContact = useCallback(async (contactId: string) => {
    if (!conversationId || isGroup || isAdding) return
    setIsAdding(true)
    try {
      await createGroupFromDM([], [contactId])
      resetAddPanel()
      toast({ title: t('memberAdded') })
    } catch (err) {
      console.error('[TabChat] Failed to add external contact:', err)
      toast({ title: t('addMemberFailed'), variant: 'destructive' })
    } finally {
      setIsAdding(false)
    }
  }, [conversationId, createGroupFromDM, isAdding, isGroup, resetAddPanel, t])

  useLayoutEffect(() => {
    if (!isOpen || !conversationId) return
    let cancelled = false
    refreshConversationMembers(conversationId, {
      supersede: true,
      invalidateSnapshot: true,
    })
      .then(() => {
        if (!cancelled) return refreshAgentBindings()
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[TabChat] Failed to load conversation detail:', err)
        toast({ title: t('loadDetailFailed'), variant: 'destructive' })
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, conversationId, refreshAgentBindings, refreshConversationMembers, t])

  const handleRemoveMember = useCallback(
    async (member: { user_id: string | null; agent_id?: string | null }) => {
      if (!conversationId) return
      setConfirmRemoveMemberId(null)
      try {
        if (member.agent_id) {
          await tabchatApi.removeAgent(conversationId, member.agent_id)
        } else if (member.user_id) {
          await tabchatApi.removeMember(conversationId, member.user_id)
        } else {
          return
        }
        await refreshConversationMembers(conversationId, {
          supersede: true,
          invalidateSnapshot: true,
        })
      } catch (err) {
        console.error('[TabChat] Failed to remove member:', err)
        toast({ title: t('removeMemberFailed'), variant: 'destructive' })
      }
    },
    [conversationId, refreshConversationMembers, t],
  )

  const handleToggleMute = useCallback(async () => {
    if (isMutating) return
    const prev = isMuted
    setIsMutating(true)
    useIMStore.getState().updateConversation(conversationId, { is_muted: !prev })
    try {
      const result = await tabchatApi.toggleMute(conversationId, !prev)
      if (result.muted !== !prev) {
        useIMStore.getState().updateConversation(conversationId, { is_muted: result.muted })
      }
    } catch (err) {
      console.error('[TabChat] Failed to toggle mute:', err)
      useIMStore.getState().updateConversation(conversationId, { is_muted: prev })
      toast({
        title: t(conversation?.last_message_at ? 'muteFailed' : 'muteBeforeFirstMessage'),
        variant: 'destructive',
      })
    } finally {
      setIsMutating(false)
    }
  }, [conversation?.last_message_at, conversationId, isMuted, isMutating, t])

  const handleTogglePin = useCallback(async () => {
    if (isMutating) return
    setIsMutating(true)
    try {
      const result = await tabchatApi.togglePin(conversationId, !isPinned)
      useIMStore.getState().updateConversation(conversationId, result)
    } catch (err) {
      console.error('[TabChat] Failed to toggle pin:', err)
      toast({ title: t('pinFailed'), variant: 'destructive' })
    } finally {
      setIsMutating(false)
    }
  }, [conversationId, isPinned, isMutating, t])

  const handleStartGroupNameEdit = useCallback(() => {
    if (!isGroup || !isAdminOrOwner) return
    setGroupNameDraft(conversation?.name || '')
    setIsEditingGroupName(true)
  }, [conversation?.name, isAdminOrOwner, isGroup])

  const handleCancelGroupNameEdit = useCallback(() => {
    setIsEditingGroupName(false)
    setGroupNameDraft('')
  }, [])

  const handleSaveGroupName = useCallback(async () => {
    const name = groupNameDraft.trim()
    if (!name || name === conversation?.name) {
      handleCancelGroupNameEdit()
      return
    }

    setIsSavingGroupName(true)
    try {
      await tabchatApi.updateConversation(conversationId, { name })
      useIMStore.getState().updateConversation(conversationId, { name })
      handleCancelGroupNameEdit()
    } catch (err) {
      console.error('[TabChat] Failed to update group name:', err)
      toast({ title: t('updateNameFailed'), variant: 'destructive' })
    } finally {
      setIsSavingGroupName(false)
    }
  }, [conversation?.name, conversationId, groupNameDraft, handleCancelGroupNameEdit, t])

  const handleClearHistory = useCallback(async () => {
    try {
      await tabchatApi.clearHistory(conversationId)
      useIMStore.getState().clearConversationMessages(conversationId)
      onHistoryCleared?.()
      setConfirmAction(null)
      toast({ title: t('clearHistoryDone') })
    } catch (err) {
      console.error('[TabChat] Failed to clear history:', err)
      toast({ title: t('clearHistoryFailed'), variant: 'destructive' })
    }
  }, [conversationId, onHistoryCleared, t])

  const handleLeaveGroup = useCallback(async () => {
    if (!currentUserId || leaveInFlightRef.current) return
    leaveInFlightRef.current = true
    setIsLeaving(true)
    try {
      await tabchatApi.leaveConversation(conversationId, currentUserId)
      setConfirmAction(null)
      useIMStore.getState().removeConversation(conversationId)
      toast({ title: t('leaveGroupDone') })
      onClose()
    } catch (err) {
      console.error('[TabChat] Failed to leave group:', err)
      toast({ title: t('leaveGroupFailed'), variant: 'destructive' })
    } finally {
      leaveInFlightRef.current = false
      setIsLeaving(false)
    }
  }, [conversationId, currentUserId, onClose, t])

  const handleExternalContactAction = useCallback(async (
    action: 'block' | 'unblock' | 'remove',
  ) => {
    if (!organizationId || !dmExternalContact || isMutating) return
    setIsMutating(true)
    try {
      const updated = await tabchatApi.updateExternalContact(
        organizationId,
        dmExternalContact.contact_id,
        action,
      )
      setExternalContacts((contacts) => contacts.map((contact) => (
        contact.contact_id === updated.contact_id ? updated : contact
      )))
      if (action === 'block' || action === 'remove') {
        useIMStore.getState().updateConversation(conversationId, {
          external_contact_relationship: action === 'block' ? 'blocked' : 'removed',
        })
        setConfirmAction(null)
      } else if (action === 'unblock') {
        useIMStore.getState().updateConversation(conversationId, {
          external_contact_relationship: 'friend',
        })
      }
    } catch (err) {
      console.error('[TabChat] Failed to update external contact:', err)
      toast({ title: t('externalContacts.errors.updateFailed'), variant: 'destructive' })
    } finally {
      setIsMutating(false)
    }
  }, [conversationId, dmExternalContact, isMutating, organizationId, t])

  // 群头像裁剪上传完成（AvatarCropUploader 已完成裁剪 + OSS 上传）→ 持久化 + 同步。
  const handleAvatarUploaded = useCallback(
    async (url: string) => {
      try {
        await tabchatApi.updateConversation(conversationId, { avatar_url: url })
        useIMStore.getState().updateConversation(conversationId, { avatar_url: url })
        toast({ title: t('avatarUpdated') })
      } catch (err) {
        console.error('[TabChat] Failed to persist group avatar:', err)
        toast({ title: t('avatarUpdateFailed'), variant: 'destructive' })
        throw new Error('persist failed')
      }
    },
    [conversationId, t],
  )

  const handleAvatarRemoved = useCallback(async () => {
    try {
      await tabchatApi.updateConversation(conversationId, { avatar_url: '' })
      useIMStore.getState().updateConversation(conversationId, { avatar_url: '' })
      toast({ title: t('avatarRemoved') })
    } catch (err) {
      console.error('[TabChat] Failed to remove group avatar:', err)
      toast({ title: t('avatarUpdateFailed'), variant: 'destructive' })
    }
  }, [conversationId, t])

  // 不再 early-return：保持挂载以支持淡入淡出动画；内容数据按 isOpen 懒加载（见上方 effect）。
  const roleIcon = (role: number) => {
    if (role === MEMBER_ROLE_OWNER) return <Crown className="h-3 w-3 text-warning" />
    if (role === MEMBER_ROLE_ADMIN) return <Shield className="h-3 w-3 text-info" />
    return null
  }

  const headerTitle = isGroup
    ? memberBreakdown
      ? memberBreakdown.agent > 0
        ? t('memberBreakdown', {
            human: memberBreakdown.human,
            agent: memberBreakdown.agent,
          })
        : t('memberBreakdownHumanOnly', { human: memberBreakdown.human })
      : t('members')
    : t('chatInfo')

  const renderMemberRow = (member: ConversationMember) => {
    const isAgent = isAgentMember(member)
    const identity = member.agent_id || member.user_id || ''
    const isSelf = !isAgent && member.user_id === currentUserId
    const displayName = isSelf
      ? t('you')
      : member.nickname || member.username || identity.slice(0, 8)
    const avatarName = member.nickname || member.username || identity
    const canRemove =
      isAdminOrOwner && !isSelf && (isAgent || member.role < myRole)
    const binding = isAgent
      ? agentBindings.find((item) => item.agent_id === member.agent_id)
      : undefined
    const offline = isAgentExecutionOffline(member)

    const isConfirming = confirmRemoveMemberId === identity
    const canOpenDirectChat =
      isGroup && !isAgent && !!member.user_id && !isSelf && !!conversationOrganizationId
    const memberIdentity = (
      <>
        <div className="relative">
          <ColorAvatar
            name={avatarName}
            seed={identity}
            imageUrl={member.avatar || undefined}
            isAgent={isAgent}
            fallbackIcon={isAgent ? <Bot className="h-3.5 w-3.5 text-white" /> : undefined}
            className="h-7 w-7"
            fallbackClassName="text-caption"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate text-body text-foreground">
              {displayName}
            </span>
            {isAgent ? (
              <AgentMemberBadges ownerName={agentOwnerDisplayName(member)} offline={offline} />
            ) : (
              roleIcon(member.role)
            )}
          </div>
          {isAgent ? (
            <span className="block truncate text-caption text-muted-foreground">
              {binding?.is_executable === false
                ? t('workspaceStale', { name: binding.workspace_name })
                : (binding?.workspace_name || t('workspaceUnbound'))}
            </span>
          ) : null}
        </div>
      </>
    )
    const canChangeWorkspace = Boolean(isAgent && binding?.can_rebind)

    return (
      <div key={identity}>
        <div className="group relative flex items-center gap-2.5 mx-1.5 px-2 py-1.5 rounded-lg hover:bg-muted/40">
          {canOpenDirectChat ? (
            <button
              type="button"
              onClick={() => void handleOpenMemberDM(member.user_id!)}
              disabled={openingMemberUserId !== null}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-50"
              aria-label={t('messageMember', { name: displayName, defaultValue: `向 ${displayName} 发消息` })}
              title={t('contactCardSendMessage', { defaultValue: '发消息' })}
            >
              {memberIdentity}
            </button>
          ) : (
            <div
              data-offline={offline || undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2.5',
                offline && IM_AGENT_OFFLINE_IDENTITY_CLASS,
              )}
            >
              {memberIdentity}
            </div>
          )}
          <MemberRowActionBar
            changeWorkspaceLabel={t('changeAgentWorkspace')}
            onChangeWorkspace={canChangeWorkspace ? () => setRebindAgentId(member.agent_id!) : undefined}
            removeLabel={t('removeMember')}
            onRemove={canRemove ? () => setConfirmRemoveMemberId(isConfirming ? null : identity) : undefined}
          />
        </div>
        {canRemove && isConfirming && (
          <ConfirmRow
            message={t('removeMemberConfirm', { name: displayName })}
            confirmLabel={t('confirm')}
            cancelLabel={t('cancel')}
            destructive
            onConfirm={() => handleRemoveMember(member)}
            onCancel={() => setConfirmRemoveMemberId(null)}
          />
        )}
      </div>
    )
  }

  return (
    <>
      {/* 透明点击关闭层：不模糊、不压暗聊天区，仅用于点击空白处收起抽屉 */}
      <div
        className={`absolute inset-0 z-overlay ${isOpen ? '' : 'pointer-events-none'}`}
        onClick={() => handleClose()}
        aria-hidden="true"
      />
      {/* 右侧浮层抽屉：固定在最终位置淡入，避免横向滑入时被聊天容器裁剪成残缺窄栏 */}
      <div
        className={`absolute top-0 right-0 z-overlay h-full w-72 rounded-[12px] border-l border-border/40 bg-background/80 backdrop-blur-xl flex flex-col transition-[opacity,box-shadow] duration-200 ease-out ${
          isOpen ? 'opacity-100 shadow-xl' : 'opacity-0 pointer-events-none shadow-none'
        }`}
        data-testid="conversation-detail-panel"
        role="dialog"
        aria-label={headerTitle}
        aria-hidden={!isOpen}
      >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20 flex-shrink-0">
        <span className="text-body font-semibold text-foreground">{isGroup ? t('groupInfo') : t('chatInfo')}</span>
        <div className="flex items-center gap-1">
          {conversation && (
            <button
              type="button"
              onClick={() => setShowAddPanel((v) => !v)}
              className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
              title={t('addMember')}
              aria-label={t('addMember')}
            >
              <UserPlus className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={handleClose}
            className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            title={t('cancel')}
            aria-label={t('cancel')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 英雄区：大头像 + 名称 + 状态 + 快捷操作磁贴 */}
        {conversation && (
          <div className="px-4 pt-5 pb-4 border-b border-border/20">
            <div className="flex flex-col items-center gap-2.5">
              <div className="relative">
                {isGroup && isAdminOrOwner ? (
                  <AvatarCropUploader
                    compact
                    currentAvatar={conversation.avatar_url || undefined}
                    previewSize="h-20 w-20"
                    previewRounded="rounded-full"
                    uploadOptions={{
                      module: 'tabchat',
                      folder: 'im/avatars',
                      contextType: 'conversation',
                      contextId: conversationId,
                      fileNamePrefix: `group-${conversationId}`,
                      isPublic: true,
                    }}
                    onUploadComplete={handleAvatarUploaded}
                    onRemove={handleAvatarRemoved}
                    cropTitle={t('changeGroupAvatar')}
                  />
                ) : (
                  isGroup ? (
                    <div className="h-20 w-20 rounded-full bg-muted/60 border border-border/30 flex items-center justify-center overflow-hidden shadow-sm">
                      {conversation.avatar_url ? (
                        <img src={conversation.avatar_url} alt="" className="h-20 w-20 rounded-full object-cover" />
                      ) : (
                        <Users className="h-8 w-8 text-muted-foreground" />
                      )}
                    </div>
                  ) : (
                    <ColorAvatar
                      name={peerName || t('dm')}
                      seed={peerId || undefined}
                      imageUrl={peerAvatar || undefined}
                      className="h-20 w-20"
                      fallbackClassName="text-heading"
                    />
                  )
                )}
              </div>
              <div className="text-center min-w-0 max-w-full">
                {isGroup && isAdminOrOwner && isEditingGroupName ? (
                  <div className="flex items-center gap-1">
                    <input
                      autoFocus
                      value={groupNameDraft}
                      onChange={(event) => setGroupNameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleSaveGroupName()
                        if (event.key === 'Escape') handleCancelGroupNameEdit()
                      }}
                      aria-label={t('groupNameLabel')}
                      maxLength={100}
                      disabled={isSavingGroupName}
                      className="h-8 min-w-0 w-52 rounded-md border border-accent/60 bg-muted/20 px-2 text-body font-semibold text-foreground outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveGroupName()}
                      disabled={isSavingGroupName}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-success hover:bg-success/10 disabled:opacity-50"
                      aria-label={t('confirm')}
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelGroupNameEdit}
                      disabled={isSavingGroupName}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/30 disabled:opacity-50"
                      aria-label={t('cancel')}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-1">
                    <div className="text-title font-semibold text-foreground truncate">
                      {isGroup ? conversation.name || t('group') : peerName || t('dm')}
                    </div>
                    {isGroup && isAdminOrOwner && (
                      <button
                        type="button"
                        onClick={handleStartGroupNameEdit}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                        title={t('editGroupName')}
                        aria-label={t('editGroupName')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <div className="text-caption text-muted-foreground mt-0.5">
                  {isGroup
                    ? memberBreakdown
                      ? memberBreakdown.agent > 0
                        ? t('memberBreakdown', { human: memberBreakdown.human, agent: memberBreakdown.agent })
                        : t('memberBreakdownHumanOnly', { human: memberBreakdown.human })
                      : ''
                    : t('dm')}
                </div>
              </div>
            </div>

            {/* 快捷操作磁贴：静音 / 置顶 */}
            <div className="flex items-center gap-2 mt-4">
              <button
                type="button"
                onClick={handleToggleMute}
                disabled={isMutating}
                className={`flex-1 flex flex-col items-center gap-1 py-2.5 rounded-xl border transition-colors disabled:opacity-50 ${
                  isMuted
                    ? 'bg-accent/10 border-accent/30 text-accent'
                    : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
                }`}
              >
                {isMuted ? <BellOff className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
                <span className="text-caption font-medium">{t('mute')}</span>
              </button>
              <button
                type="button"
                onClick={handleTogglePin}
                disabled={isMutating}
                className={`flex-1 flex flex-col items-center gap-1 py-2.5 rounded-xl border transition-colors disabled:opacity-50 ${
                  isPinned
                    ? 'bg-accent/10 border-accent/30 text-accent'
                    : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
                }`}
              >
                <Pin className="h-5 w-5" />
                <span className="text-caption font-medium">{t('pin')}</span>
              </button>
            </div>
          </div>
        )}

        {/* 群聊直接加成员；私聊选择成员后创建一个新群，原私聊保留。 */}
        {showAddPanel && (
          <div className="border-b border-border/20 px-2 py-2 space-y-1.5">
            <input
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
              placeholder={t('searchMember')}
              className="w-full h-7 px-2 text-body bg-muted/30 border border-border/40 rounded-md outline-none focus:border-accent/60 placeholder:text-muted-foreground/60"
              autoFocus
            />
            <div className="max-h-32 overflow-y-auto">
              {isSearchingApi && addableCandidates.length === 0 && addableAgents.length === 0 && addableExternalContacts.length === 0 ? (
                <div className="flex justify-center py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : addableCandidates.length === 0 && addableAgents.length === 0 && addableExternalContacts.length === 0 ? (
                <div className="text-caption text-muted-foreground text-center py-2">
                  {t('noMembersToAdd')}
                </div>
              ) : (
                <>
                  {addableCandidates.slice(0, 10).map((member) => (
                    <button
                      key={member.user_id}
                      type="button"
                      onClick={() => handleAddMember(member.user_id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/30 rounded-md text-left"
                    >
                      <div className="h-5 w-5 rounded-full bg-muted/60 border border-border/30 flex items-center justify-center">
                        <span className="text-caption font-medium text-muted-foreground">
                          {(member.user?.nickname || member.user?.username || '?').slice(0, 1).toUpperCase()}
                        </span>
                      </div>
                      <span className="text-body truncate">
                        {member.user?.nickname || member.user?.username || member.user_id.slice(0, 8)}
                      </span>
                    </button>
                  ))}
                  {!isGroup && addableExternalContacts.slice(0, 10).map((contact) => (
                    <button
                      key={contact.contact_id}
                      type="button"
                      onClick={() => void handleAddExternalContact(contact.contact_id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/30 rounded-md text-left"
                    >
                      <UserPlus className="h-4 w-4 text-muted-foreground" />
                      <span className="text-body truncate">{contact.display_name}</span>
                      <span className="ml-auto text-caption text-muted-foreground">外部 · {contact.peer_organization_name}</span>
                    </button>
                  ))}
                  {addableAgents.slice(0, 10).map((agent) => (
                    <button
                      key={agent.agent_id}
                      type="button"
                      onClick={() => handleAddAgent(agent)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/30 rounded-md text-left"
                    >
                      <div className="h-5 w-5 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center overflow-hidden">
                        {agent.avatar ? (
                          <img src={agent.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
                        ) : (
                          <Bot className="h-3 w-3 text-accent" />
                        )}
                      </div>
                      <span className="text-body truncate">{agent.name || agent.agent_id.slice(0, 8)}</span>
                      <span className="ml-auto flex-shrink-0 rounded px-1 py-0.5 text-caption font-medium text-accent bg-accent/10">
                        AI
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {/* 成员列表（群聊）：人类 / AI 分开展示 */}
        {isGroup && (
          <div className="py-1 border-b border-border/20">
            {members === undefined && membersLoading ? (
              <div className="py-1">
                <DetailedRowListSkeleton count={6} leadingShape="avatar" compact showPreview={false} />
              </div>
            ) : (
              <>
                {humanMembers.length > 0 && (
                  <div>
                    <div className="px-3 py-1 text-caption font-medium text-muted-foreground/60">
                      {t('humanMembers')} ({humanMembers.length})
                    </div>
                    {humanMembers.map(renderMemberRow)}
                  </div>
                )}
                {agentMembers.length > 0 && (
                  <div>
                    <div className="px-3 py-1 text-caption font-medium text-muted-foreground/80">
                      {t('agentMembers')} ({agentMembers.length})
                    </div>
                    {agentMembers.map(renderMemberRow)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 设置卡：清空记录 / 退出群聊（静音、置顶已上移为快捷磁贴） */}
        <div className="px-3 py-3">
          <div className="rounded-xl border border-border/30 bg-muted/20 overflow-hidden">
            {/* 清空聊天记录 */}
            {confirmAction === 'clear' ? (
              <ConfirmRow
                message={t('clearHistoryConfirm')}
                confirmLabel={t('confirm')}
                cancelLabel={t('cancel')}
                destructive
                onConfirm={handleClearHistory}
                onCancel={() => setConfirmAction(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setConfirmAction('clear')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/40 text-left transition-colors"
              >
                <Trash2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="flex-1 text-body text-foreground">{t('clearHistory')}</span>
              </button>
            )}

            {/* 退出群聊（群聊） */}
            {isGroup && (
              <div className="border-t border-border/20">
                {confirmAction === 'leave' ? (
                  <ConfirmRow
                    message={t('leaveGroupConfirm')}
                    confirmLabel={t('confirm')}
                    cancelLabel={t('cancel')}
                    destructive
                    pending={isLeaving}
                    onConfirm={handleLeaveGroup}
                    onCancel={() => setConfirmAction(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmAction('leave')}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-destructive/10 text-left transition-colors"
                  >
                    <LogOut className="h-4 w-4 text-destructive flex-shrink-0" />
                    <span className="flex-1 text-body text-destructive">{t('leaveGroup')}</span>
                  </button>
                )}
              </div>
            )}

            {!isGroup && dmExternalContact && dmExternalContact.relationship !== 'removed' ? (
              <>
                <div className="border-t border-border/20">
                  <button
                    type="button"
                    disabled={isMutating}
                    onClick={() => void handleExternalContactAction(
                      dmExternalContact.relationship === 'blocked' ? 'unblock' : 'block',
                    )}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/40 text-left transition-colors disabled:opacity-50"
                  >
                    <Ban className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 text-body text-foreground">
                      {t(dmExternalContact.relationship === 'blocked'
                        ? 'externalContacts.unblock'
                        : 'externalContacts.block')}
                    </span>
                  </button>
                </div>
                <div className="border-t border-border/20">
                  {confirmAction === 'remove-contact' ? (
                    <ConfirmRow
                      message={t('externalContacts.removeConfirm', { name: dmExternalContact.display_name })}
                      confirmLabel={t('confirm')}
                      cancelLabel={t('cancel')}
                      destructive
                      pending={isMutating}
                      onConfirm={() => void handleExternalContactAction('remove')}
                      onCancel={() => setConfirmAction(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={isMutating}
                      onClick={() => setConfirmAction('remove-contact')}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-destructive/10 text-left transition-colors disabled:opacity-50"
                    >
                      <UserMinus className="h-4 w-4 text-destructive flex-shrink-0" />
                      <span className="flex-1 text-body text-destructive">{t('externalContacts.remove')}</span>
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
      </div>
      <AgentWorkspacePickerDialog
        open={pendingAgent !== null}
        onOpenChange={(open) => { if (!open) setPendingAgent(null) }}
        title={t('pickAgentWorkspace')}
        onConfirm={handleConfirmAddAgentWorkspace}
      />
      <AgentWorkspacePickerDialog
        open={rebindAgentId !== null}
        onOpenChange={(open) => { if (!open) setRebindAgentId(null) }}
        title={t('changeAgentWorkspace')}
        initialWorkspaceId={
          rebindAgentId
            ? agentBindings.find((item) => item.agent_id === rebindAgentId)?.workspace_id ?? null
            : null
        }
        onConfirm={handleConfirmRebindWorkspace}
      />
    </>
  )
}

const SESSION_ROW_ACTION_TOOLTIP_DELAY_MS = 300
const SESSION_ROW_ACTION_BUTTON =
  'h-5 w-5 inline-flex items-center justify-center rounded-interactive text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground transition-colors'
const SESSION_ROW_ACTION_ICON = 'h-3 w-3'
const SESSION_ROW_ACTION_BAR =
  'absolute right-1.5 top-1/2 z-floating flex -translate-y-1/2 items-center rounded-interactive bg-background/40 py-0.5 pl-1 pr-0 backdrop-blur-md dark:bg-background/40 transition-opacity opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:pointer-events-auto'

function MemberRowActionButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <ChatIconTooltip content={label} delayDuration={SESSION_ROW_ACTION_TOOLTIP_DELAY_MS}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        className={SESSION_ROW_ACTION_BUTTON}
      >
        {children}
      </button>
    </ChatIconTooltip>
  )
}

function MemberRowActionBar({
  changeWorkspaceLabel,
  onChangeWorkspace,
  removeLabel,
  onRemove,
}: {
  changeWorkspaceLabel: string
  onChangeWorkspace?: () => void
  removeLabel: string
  onRemove?: () => void
}) {
  if (!onChangeWorkspace && !onRemove) return null
  return (
    <div className={SESSION_ROW_ACTION_BAR}>
      <div className="inline-flex items-center gap-0.5">
        {onChangeWorkspace ? (
          <MemberRowActionButton label={changeWorkspaceLabel} onClick={onChangeWorkspace}>
            <Replace className={SESSION_ROW_ACTION_ICON} />
          </MemberRowActionButton>
        ) : null}
        {onRemove ? (
          <MemberRowActionButton label={removeLabel} onClick={onRemove}>
            <UserMinus className={SESSION_ROW_ACTION_ICON} />
          </MemberRowActionButton>
        ) : null}
      </div>
    </div>
  )
}

const ConfirmRow: React.FC<{
  message: string
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}> = ({ message, confirmLabel, cancelLabel, destructive, pending, onConfirm, onCancel }) => (
  <div className="px-3 py-2 space-y-2 bg-muted/10">
    <p className="text-caption text-muted-foreground">{message}</p>
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onConfirm}
        disabled={pending}
        className={`flex-1 h-7 rounded-md text-caption font-medium ${
          destructive
            ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
            : 'bg-accent text-accent-foreground hover:bg-accent/90'
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className="flex-1 h-7 rounded-md text-caption font-medium bg-muted/40 text-foreground hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {cancelLabel}
      </button>
    </div>
  </div>
)
