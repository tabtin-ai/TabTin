import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, Check, ChevronDown, Circle, Clock, Copy, Crown, Download, Edit, Eye, Link2, LoaderCircle, Mail, Pencil, Save, Search, Shield, UserPlus, Users, X } from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  StatusNotice,
  Switch,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { Organization, OrganizationRole, AssignableRole, MemberSearchParams } from '@tabtin/app-shell'
import { UI_ASSIGNABLE_ROLES, ROLE_LEVELS } from '@tabtin/app-shell'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import {
  InvitationApiService,
  resolvePendingInvitationSummary,
  type InvitationInfo,
} from '@/services/invitationApi'
import { formatDate } from '@/utils/i18n/format'
import { cn } from '@utils/cn'
import { canManageOrganization as canManageOrganizationFn } from '@/hooks/useCanManageOrganization'
import { useMembersQuery, memberKeys } from '@/hooks/queries/members'
import {
  useMemberBudgetPolicies,
  useMemberUsageSummary,
  useMutateMemberBudgetPolicy,
  useDeleteMemberBudgetPolicy,
} from '@/hooks/queries/memberBudget'
import { MemberBudgetApiService } from '@/services/memberBudgetApi'
import type {
  MemberBudgetPolicy,
  MemberBudgetPolicyUpsertInput,
  MemberUsageSummaryItem,
} from '@/types/billing'
import { useNewUserOrganizationOnboardingStore } from '@stores/useNewUserOrganizationOnboardingStore'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsRow, SettingsRowGroup } from '../SettingsRow'
import { SettingsLink } from '../SettingsLink'
import { SettingsBadge } from '../SettingsBadge'
import { SettingsSection } from '../SettingsSection'
import { SETTINGS_CONTROL, SETTINGS_FIELD_TITLE, SETTINGS_HINT, SETTINGS_HOVER_ACTION, SETTINGS_LABEL, SETTINGS_ROW_HOVER, SETTINGS_SECTION_TITLE, SETTINGS_SOFT_SURFACE, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { InviteDialog } from './InviteDialog'
import { buildPublicInviteUrl } from '@/config/api'

interface OrganizationMembersPanelProps {
  organization: Organization
  currentUserRole?: OrganizationRole | null
  /** 嵌入模式：作为「成员与额度」页的一个分区渲染，不套自己的整页布局与页眉。 */
  embedded?: boolean
}

function findDefaultPolicy(policies: MemberBudgetPolicy[] | undefined) {
  return policies?.find((p) => p.user_id === null && p.target_role === null) ?? null
}

// 额度字段后端为 DecimalField(max_digits=12, decimal_places=4)，最大可存 99,999,999.9999，
// 达到 1 亿会溢出。这里在前端拦在 1 亿以内，超出直接提示、不发请求。
const MAX_CREDITS_LIMIT = 100_000_000

/** 成员用量「导出」入口：保留 downloadExport / Popover 实现，仅从 UI 收起；需要时改回 true。 */
const SHOW_MEMBER_USAGE_EXPORT = false

/** 把后端返回的规范 Decimal 字符串（如 "1000.0000"）归一化为输入框展示值（"1000"），去掉多余的小数零。 */
function toCreditsInputValue(raw?: string | null): string {
  if (raw == null || raw === '') return ''
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : raw
}

/** 是否有任一额度输入达到/超过上限；空值与非法值不拦（交给原生 number input）。 */
function exceedsCreditsLimit(...values: string[]): boolean {
  return values.some((v) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= MAX_CREDITS_LIMIT)
}

export const OrganizationMembersPanel: React.FC<OrganizationMembersPanelProps> = ({ organization, currentUserRole, embedded = false }) => {
  const { t } = useTranslation(['organization', 'common'])
  // 预算相关文案在 settings 命名空间，与「成员额度」页保持同一份 key。
  const { t: tb } = useTranslation('settings')
  const user = useAuthStore((s) => s.user)
  const { updateMemberRole: storeUpdateMemberRole, removeMember: storeRemoveMember } = useOrganizationStore(
    useShallow((s) => ({ updateMemberRole: s.updateMemberRole, removeMember: s.removeMember }))
  )
  const queryClient = useQueryClient()

  // ── 角色 / 权限（预算查询按此 gate，需在调用预算 hooks 前算出） ──
  const isOwner = user?.id === organization.owner_id
  const myRole = currentUserRole ?? (isOwner ? 'owner' : null)
  const myRoleLevel = myRole ? ROLE_LEVELS[myRole] : 0
  const canManage = canManageOrganizationFn(myRole)
  const canManageTarget = (targetRole: OrganizationRole) => myRoleLevel > (ROLE_LEVELS[targetRole] ?? 0)
  const canAssignRole = (role: AssignableRole) => myRoleLevel > (ROLE_LEVELS[role] ?? 0)
  // 额度是管理员能力：非团队 / 非管理员不拉预算数据，成员列表退化为纯名册。
  const budgetEnabled = organization.type !== 'personal' && canManage

  const [localError, setLocalError] = useState('')
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState('')
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [mutatingUserId, setMutatingUserId] = useState<string | null>(null)

  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<OrganizationRole | 'all'>('all')

  const [invitations, setInvitations] = useState<InvitationInfo[]>([])
  const [isLoadingInvitations, setIsLoadingInvitations] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [selectedLinkInvitation, setSelectedLinkInvitation] = useState<InvitationInfo | null>(null)
  const [copiedInvitationId, setCopiedInvitationId] = useState<string | null>(null)
  /** 防止 mount 拉取与 invitations-changed 重拉乱序写回陈旧 pending（ review） */
  const invitationsLoadRequestRef = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput.trim()), 400)
    return () => clearTimeout(timer)
  }, [searchInput])

  const searchParams: MemberSearchParams | undefined = (debouncedSearch || roleFilter !== 'all')
    ? {
        search: debouncedSearch || undefined,
        role: roleFilter !== 'all' ? roleFilter : undefined,
      }
    : undefined

  const linkInvitations = useMemo(
    () => invitations.filter((inv) => inv.invite_type === 'link'),
    [invitations],
  )
  const pendingTargetedInvitations = useMemo(
    () => invitations.filter((inv) => inv.invite_type !== 'link'),
    [invitations],
  )

  const { data: membersData, isLoading: membersLoading } = useMembersQuery(organization.id, searchParams)
  const members = membersData?.members ?? []
  const membersTotal = membersData?.total ?? 0
  const isLoading = membersLoading || !!mutatingUserId

  const hasActiveFilter = roleFilter !== 'all' || debouncedSearch.length > 0

  // ── 成员额度（并入本列表，不再单独一页） ──
  const { data: policies, isLoading: policiesLoading } = useMemberBudgetPolicies(organization.id, budgetEnabled)
  const { data: usageSummary, isLoading: usageLoading } = useMemberUsageSummary(organization.id, budgetEnabled)
  const upsertMutation = useMutateMemberBudgetPolicy()
  const deleteMutation = useDeleteMemberBudgetPolicy(organization.id)

  const usageByUser = useMemo(() => {
    const map = new Map<string, MemberUsageSummaryItem>()
    for (const m of usageSummary?.members ?? []) map.set(m.user_id, m)
    return map
  }, [usageSummary?.members])

  const budgetLoading = budgetEnabled && (policiesLoading || usageLoading)

  // ── 默认预算策略表单 ──
  const defaultPolicy = findDefaultPolicy(policies)
  const [policyEditing, setPolicyEditing] = useState(false)
  const [monthlyLimit, setMonthlyLimit] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [adminExempt, setAdminExempt] = useState(true)
  const [formDirty, setFormDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [limitError, setLimitError] = useState('')

  useEffect(() => {
    if (defaultPolicy) {
      setMonthlyLimit(toCreditsInputValue(defaultPolicy.monthly_credits_limit))
      setDailyLimit(toCreditsInputValue(defaultPolicy.daily_credits_limit))
    } else {
      setMonthlyLimit('')
      setDailyLimit('')
    }
    setFormDirty(false)
    setLimitError('')
  }, [defaultPolicy])

  useEffect(() => {
    if (usageSummary?.exempt_roles) {
      setAdminExempt(
        usageSummary.exempt_roles.includes('admin') && usageSummary.exempt_roles.includes('owner'),
      )
    }
  }, [usageSummary?.exempt_roles])

  const handleCancelPolicyEdit = useCallback(() => {
    if (defaultPolicy) {
      setMonthlyLimit(toCreditsInputValue(defaultPolicy.monthly_credits_limit))
      setDailyLimit(toCreditsInputValue(defaultPolicy.daily_credits_limit))
    } else {
      setMonthlyLimit('')
      setDailyLimit('')
    }
    setFormDirty(false)
    setLimitError('')
    setPolicyEditing(false)
  }, [defaultPolicy])

  const handleSaveDefaultPolicy = useCallback(async () => {
    if (exceedsCreditsLimit(monthlyLimit, dailyLimit)) {
      setLimitError(tb('memberBudget.errors.limitTooLarge'))
      return
    }
    setLimitError('')
    const input: MemberBudgetPolicyUpsertInput = {
      organization_id: organization.id,
      user_id: null,
      target_role: null,
      monthly_credits_limit: monthlyLimit ? Number(monthlyLimit) : null,
      daily_credits_limit: dailyLimit ? Number(dailyLimit) : null,
      is_active: true,
    }
    try {
      await upsertMutation.mutateAsync(input)
      const exemptRoles = adminExempt ? ['owner', 'admin'] : []
      await MemberBudgetApiService.updateExemptRoles(organization.id, exemptRoles)
      setFormDirty(false)
      setPolicyEditing(false)
      setSaveStatus('success')
      setTimeout(() => setSaveStatus('idle'), 4000)
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [organization.id, monthlyLimit, dailyLimit, adminExempt, upsertMutation, tb])

  const handleDefaultPolicyKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!formDirty || upsertMutation.isPending) return
      void handleSaveDefaultPolicy()
    }
  }, [formDirty, upsertMutation.isPending, handleSaveDefaultPolicy])

  // ── 单个成员额度编辑 ──
  const [editingMember, setEditingMember] = useState<MemberUsageSummaryItem | null>(null)
  const [editMonthly, setEditMonthly] = useState('')
  const [editDaily, setEditDaily] = useState('')
  const [memberLimitError, setMemberLimitError] = useState('')

  const openEditMember = useCallback(
    (member: MemberUsageSummaryItem) => {
      setEditingMember(member)
      setMemberLimitError('')
      const personalPolicy = policies?.find(
        (p) => p.user_id === member.user_id && p.target_role === null,
      )
      if (personalPolicy) {
        setEditMonthly(toCreditsInputValue(personalPolicy.monthly_credits_limit))
        setEditDaily(toCreditsInputValue(personalPolicy.daily_credits_limit))
      } else {
        setEditMonthly(toCreditsInputValue(member.monthly_limit))
        setEditDaily(toCreditsInputValue(member.daily_limit))
      }
    },
    [policies],
  )

  const handleSaveMemberPolicy = useCallback(async () => {
    if (!editingMember) return
    if (exceedsCreditsLimit(editMonthly, editDaily)) {
      // 抛错以阻止 ConfirmDialog 关闭，让用户看到上限提示。
      setMemberLimitError(tb('memberBudget.errors.limitTooLarge'))
      throw new Error('member_budget_limit_exceeded')
    }
    setMemberLimitError('')
    const input: MemberBudgetPolicyUpsertInput = {
      organization_id: organization.id,
      user_id: editingMember.user_id,
      monthly_credits_limit: editMonthly ? Number(editMonthly) : null,
      daily_credits_limit: editDaily ? Number(editDaily) : null,
      is_active: true,
    }
    try {
      await upsertMutation.mutateAsync(input)
      setEditingMember(null)
    } catch {
      /* mutation error handled by React Query */
    }
  }, [editingMember, organization.id, editMonthly, editDaily, upsertMutation, tb])

  const handleMemberPolicyKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (upsertMutation.isPending) return
      void handleSaveMemberPolicy()
    }
  }, [upsertMutation.isPending, handleSaveMemberPolicy])

  const handleResetMemberPolicy = useCallback(async () => {
    if (!editingMember) return
    const personalPolicy = policies?.find(
      (p) => p.user_id === editingMember.user_id && p.target_role === null,
    )
    if (personalPolicy) {
      try {
        await deleteMutation.mutateAsync(personalPolicy.id)
        setEditingMember(null)
      } catch {
        /* handled by mutation */
      }
    } else {
      setEditingMember(null)
    }
  }, [editingMember, policies, deleteMutation])

  // ── 用量导出 ──
  const [exportStart, setExportStart] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return d.toISOString().slice(0, 10)
  })
  const [exportEnd, setExportEnd] = useState(() => new Date().toISOString().slice(0, 10))

  const handleExport = useCallback(async () => {
    try {
      await MemberBudgetApiService.downloadExport(organization.id, exportStart, exportEnd)
    } catch {
      console.error('Export download failed')
    }
  }, [organization.id, exportStart, exportEnd])

  const formatCredits = (val: string | null) => {
    if (!val) return tb('memberBudget.unlimited')
    const n = Number(val)
    return isNaN(n) ? val : n.toFixed(0)
  }

  const isOverLimit = (usage: MemberUsageSummaryItem) => {
    if (usage.is_exempt || !usage.monthly_limit) return false
    return Number(usage.monthly_used) >= Number(usage.monthly_limit)
  }

  // 角色筛选标签跟随 UI 可见角色（UI_ASSIGNABLE_ROLES）：四级简化为两级后，
  // 只露 全部 / 所有者 / 管理员，隐藏 editor、viewer 筛选入口。
  // 存量 editor/viewer 成员仍可在「全部」里看到；未来放开多级时改 UI_ASSIGNABLE_ROLES 一处即可恢复。
  const ALL_ROLE_TABS: { key: OrganizationRole | 'all'; label: string }[] = [
    { key: 'all', label: t('members.filterAll') },
    { key: 'owner', label: t('members.roles.owner') },
    { key: 'admin', label: t('members.roles.admin') },
    { key: 'editor', label: t('members.roles.editor') },
    { key: 'viewer', label: t('members.roles.viewer') },
  ]
  const ROLE_TABS = ALL_ROLE_TABS.filter(
    (tab) =>
      tab.key === 'all' ||
      tab.key === 'owner' ||
      (UI_ASSIGNABLE_ROLES as readonly string[]).includes(tab.key)
  )
  const error = localError

  const handleOpenInviteDialog = () => {
    setShowInviteDialog(true)
    const onboarding = useNewUserOrganizationOnboardingStore.getState()
    if (onboarding.step === 'invite_hint') {
      onboarding.goToStep('invite_dialog')
    }
  }

  const handleInviteDialogClose = () => {
    setShowInviteDialog(false)
    const onboarding = useNewUserOrganizationOnboardingStore.getState()
    if (onboarding.step === 'invite_hint' || onboarding.step === 'invite_dialog') {
      onboarding.goToStep('agent_chat')
    }
  }

  const loadInvitations = useCallback(async () => {
    if (!canManageOrganizationFn(currentUserRole ?? (isOwner ? 'owner' : null))) return
    const organizationId = organization.id
    const requestId = invitationsLoadRequestRef.current + 1
    invitationsLoadRequestRef.current = requestId
    setIsLoadingInvitations(true)
    try {
      const list = await InvitationApiService.listInvitations(organizationId)
      if (invitationsLoadRequestRef.current !== requestId) return
      setInvitations(list.filter((inv) => inv.status === 'pending'))
    } catch {
      if (invitationsLoadRequestRef.current !== requestId) return
      setInvitations([])
    } finally {
      if (invitationsLoadRequestRef.current === requestId) {
        setIsLoadingInvitations(false)
      }
    }
  }, [organization.id, currentUserRole, isOwner])

  const handleCancelInvitation = async (invitationId: string) => {
    setCancellingId(invitationId)
    try {
      await InvitationApiService.cancelInvitation(organization.id, invitationId)
      setInvitations((prev) => prev.filter((inv) => inv.id !== invitationId))
      if (selectedLinkInvitation?.id === invitationId) {
        setSelectedLinkInvitation(null)
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('members.errors.cancelInvitationFailed'))
    } finally {
      setCancellingId(null)
    }
  }

  const getInvitationLink = (invitation: InvitationInfo) => buildPublicInviteUrl(invitation.token)

  const handleCopyInvitationLink = async (invitation: InvitationInfo) => {
    try {
      await navigator.clipboard.writeText(getInvitationLink(invitation))
      setCopiedInvitationId(invitation.id)
      toast({ title: t('members.linkInvitationCopied') })
      setTimeout(() => setCopiedInvitationId(null), 2000)
    } catch {
      toast({ title: t('members.errors.copyInvitationLinkFailed') })
    }
  }

  useEffect(() => {
    void loadInvitations()
  }, [loadInvitations])

  // ：他端接受/拒绝邀请后，实时通知驱动重拉；勿依赖切窗或半分钟级轮询
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId?: string }>).detail
      if (detail?.organizationId && detail.organizationId !== organization.id) return
      void loadInvitations()
    }
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 设置页成员面板在 Space Activity 树外，需跨 Space 切换持续接收邀请状态推送
    window.addEventListener('tabtin:organization-invitations-changed', handler)
    return () => {
      window.removeEventListener('tabtin:organization-invitations-changed', handler)
    }
  }, [loadInvitations, organization.id])

  const handleUpdateRole = async (userId: string, newRole: AssignableRole) => {
    if (mutatingUserId) return
    setMutatingUserId(userId)
    setLocalError('')
    try {
      await storeUpdateMemberRole(organization.id, userId, newRole)
      void queryClient.invalidateQueries({ queryKey: memberKeys.lists(organization.id) })
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('members.errors.updateRoleFailed'))
    } finally {
      setMutatingUserId(null)
    }
  }

  const handleRemoveMember = async (userId: string) => {
    if (mutatingUserId) return
    setMutatingUserId(userId)
    setLocalError('')
    setRemoveError('')
    try {
      await storeRemoveMember(organization.id, userId)
      void queryClient.invalidateQueries({ queryKey: memberKeys.lists(organization.id) })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('members.errors.removeFailed')
      setLocalError(message)
      setRemoveError(message)
      // ConfirmDialog 仅在 onConfirm 成功 resolve 时关闭。继续抛出异常，
      // 让失败原因留在用户当前视线内，而不是关闭弹窗后写到列表顶部。
      throw err
    } finally {
      setMutatingUserId(null)
    }
  }

  const getRoleIcon = (role: OrganizationRole) => {
    switch (role) {
      case 'owner':
        return <Crown className="h-4 w-4 text-warning" />
      case 'admin':
        return <Shield className="h-4 w-4 text-type-cron" />
      case 'editor':
        return <Edit className="h-4 w-4 text-brand-500" />
      case 'viewer':
        return <Eye className="h-4 w-4 text-muted-foreground" />
    }
  }

  const getRoleIconSmall = (role: AssignableRole) => {
    switch (role) {
      case 'admin':
        return <Shield className="h-[1em] w-[1em] text-type-cron" />
      case 'editor':
        return <Edit className="h-[1em] w-[1em] text-brand-500" />
      case 'viewer':
        return <Eye className="h-[1em] w-[1em] text-muted-foreground" />
    }
  }

  const getRoleLabel = (role: OrganizationRole) => {
    switch (role) {
      case 'owner':
        return t('members.roles.owner')
      case 'admin':
        return t('members.roles.admin')
      case 'editor':
        return t('members.roles.editor')
      case 'viewer':
        return t('members.roles.viewer')
    }
  }

  const assignableRoles: readonly AssignableRole[] = UI_ASSIGNABLE_ROLES

  if (organization.type === 'personal') {
    const personalEmpty = (
      <EmptyState
        icon="inbox"
        title={t('members.personalHint')}
        size="sm"
        layout="card"
        className="py-6"
      />
    )
    if (embedded) return personalEmpty
    return (
      <SettingsPanelLayout>
        <SettingsPanelHeader icon={<Users className="h-4 w-4" />} title={t('members.title')} />
        {personalEmpty}
      </SettingsPanelLayout>
    )
  }

  const content = (
    <>
      {error ? <StatusNotice tone="danger" size="sm" description={error} /> : null}

      {/* 默认预算策略（仅管理员） */}
      {budgetEnabled && (
        <SettingsSectionCard
          title={tb('memberBudget.defaultPolicy.title')}
          subtitle={(
            <>
              <p>{tb('memberBudget.defaultPolicy.subtitle')}</p>
              <p className="mt-1.5">{tb('memberBudget.defaultPolicy.limitEmptyHint')}</p>
              <p className="mt-1.5">
                {tb('memberBudget.defaultPolicy.adminExempt')}
                {'：'}
                {tb('memberBudget.defaultPolicy.adminExemptHint')}
              </p>
            </>
          )}
          subtitleAsTooltip
          actions={
            !policyEditing ? (
              <SettingsLink tone="accent" onClick={() => setPolicyEditing(true)}>
                <Pencil className="h-[1em] w-[1em]" />
                {tb('memberBudget.defaultPolicy.editButton')}
              </SettingsLink>
            ) : undefined
          }
        >
          {policyEditing ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={SETTINGS_LABEL}>{tb('memberBudget.defaultPolicy.monthlyLimit')}</label>
                  <Input
                    type="number"
                    min={0}
                    placeholder={tb('memberBudget.unlimited')}
                    value={monthlyLimit}
                    onChange={(e) => {
                      setMonthlyLimit(e.target.value)
                      setFormDirty(true)
                      setLimitError('')
                    }}
                    onKeyDown={handleDefaultPolicyKeyDown}
                    className={cn(SETTINGS_CONTROL, 'mt-1')}
                    disabled={budgetLoading}
                  />
                </div>
                <div>
                  <label className={SETTINGS_LABEL}>{tb('memberBudget.defaultPolicy.dailyLimit')}</label>
                  <Input
                    type="number"
                    min={0}
                    placeholder={tb('memberBudget.unlimited')}
                    value={dailyLimit}
                    onChange={(e) => {
                      setDailyLimit(e.target.value)
                      setFormDirty(true)
                      setLimitError('')
                    }}
                    onKeyDown={handleDefaultPolicyKeyDown}
                    className={cn(SETTINGS_CONTROL, 'mt-1')}
                    disabled={budgetLoading}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className={SETTINGS_LABEL}>{tb('memberBudget.defaultPolicy.adminExempt')}</span>
                <Switch
                  checked={adminExempt}
                  onCheckedChange={(v) => {
                    setAdminExempt(v)
                    setFormDirty(true)
                  }}
                  disabled={budgetLoading}
                  aria-label={tb('memberBudget.defaultPolicy.adminExempt')}
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={handleSaveDefaultPolicy} disabled={!formDirty || upsertMutation.isPending}>
                  <Save className="h-[1em] w-[1em] mr-1" />
                  {upsertMutation.isPending ? tb('memberBudget.saving') : tb('memberBudget.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleCancelPolicyEdit} disabled={upsertMutation.isPending}>
                  {tb('memberBudget.defaultPolicy.cancel')}
                </Button>
                {saveStatus === 'success' && (
                  <span className={cn(SETTINGS_TEXT_MICRO, 'text-success')}>{tb('memberBudget.saved')}</span>
                )}
                {saveStatus === 'error' && (
                  <span className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{tb('memberBudget.errors.saveFailed')}</span>
                )}
                {limitError && (
                  <span className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{limitError}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <SettingsRowGroup>
                <SettingsRow
                  label={tb('memberBudget.defaultPolicy.monthlyLimit')}
                  control={
                    <span className="text-body font-medium text-foreground tabular-nums">
                      {formatCredits(monthlyLimit || null)}
                    </span>
                  }
                />
                <SettingsRow
                  label={tb('memberBudget.defaultPolicy.dailyLimit')}
                  control={
                    <span className="text-body font-medium text-foreground tabular-nums">
                      {formatCredits(dailyLimit || null)}
                    </span>
                  }
                />
                <SettingsRow
                  label={tb('memberBudget.defaultPolicy.adminExempt')}
                  control={
                    <span className="text-body font-medium text-foreground">
                      {adminExempt
                        ? tb('memberBudget.defaultPolicy.adminExemptOn')
                        : tb('memberBudget.defaultPolicy.adminExemptOff')}
                    </span>
                  }
                />
              </SettingsRowGroup>
              {saveStatus === 'success' && (
                <p className={cn(SETTINGS_TEXT_MICRO, 'text-success')}>{tb('memberBudget.saved')}</p>
              )}
              {saveStatus === 'error' && (
                <p className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{tb('memberBudget.errors.saveFailed')}</p>
              )}
            </div>
          )}
        </SettingsSectionCard>
      )}

      {/* 操作栏 */}
      <div className="flex items-center justify-between mb-2">
        <span className={SETTINGS_FIELD_TITLE}>
          {hasActiveFilter
            ? t('members.filteredCount', { count: members.length, total: membersTotal })
            : t('members.memberSection', { count: membersTotal })}
          {(isLoading || budgetLoading) && <span className={cn(SETTINGS_TEXT_MICRO, 'font-normal text-muted-foreground/60 ml-2')}>{t('loading', { ns: 'common' })}</span>}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {SHOW_MEMBER_USAGE_EXPORT && budgetEnabled && (
            <Popover>
              <PopoverTrigger asChild>
                <SettingsLink tone="muted" title={tb('memberBudget.export.title')}>
                  <Download className="h-[1em] w-[1em]" />
                  {tb('memberBudget.export.button')}
                </SettingsLink>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 space-y-3">
                <div>
                  <p className={SETTINGS_SECTION_TITLE}>{tb('memberBudget.export.rangeTitle')}</p>
                  <p className={cn(SETTINGS_HINT, 'mt-0.5')}>{tb('memberBudget.export.rangeHint')}</p>
                </div>
                <div className={cn(SETTINGS_TEXT_MICRO, 'flex items-center gap-2')}>
                  <div className="min-w-0 flex-1">
                    <Input
                      type="date"
                      value={exportStart}
                      onChange={(e) => setExportStart(e.target.value)}
                      className={SETTINGS_CONTROL}
                      aria-label={tb('memberBudget.export.startDate')}
                    />
                  </div>
                  <span className="text-muted-foreground/60">—</span>
                  <div className="min-w-0 flex-1">
                    <Input
                      type="date"
                      value={exportEnd}
                      onChange={(e) => setExportEnd(e.target.value)}
                      className={SETTINGS_CONTROL}
                      aria-label={tb('memberBudget.export.endDate')}
                    />
                  </div>
                </div>
                <Button size="sm" className="w-full" onClick={handleExport}>
                  <Download className="h-[1em] w-[1em] mr-1" />
                  {tb('memberBudget.export.button')}
                </Button>
              </PopoverContent>
            </Popover>
          )}
          {canManage && (
            <SettingsLink
              onClick={handleOpenInviteDialog}
              disabled={isLoading}
              data-onboarding-target="new-user-organization-invite-button"
            >
              <UserPlus className="h-[1em] w-[1em]" />
              {t('members.actions.invite')}
            </SettingsLink>
          )}
        </div>
      </div>

      {/* 搜索 + 角色筛选 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('members.searchPlaceholder')}
            className={cn(SETTINGS_CONTROL, 'pl-7')}
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {ROLE_TABS.map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setRoleFilter(tab.key)}
              className={cn(
                'px-2 py-1 rounded-interactive text-body transition-colors',
                roleFilter === tab.key
                  ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] text-foreground'
                  : 'text-muted-foreground/60 hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 邀请链接：链接本身保持可用，使用后不能按“待接受”理解。 */}
      {canManage && linkInvitations.length > 0 && (
        <SettingsSection
          title={
            <>
              {t('members.linkInvitations', { count: linkInvitations.length })}
              {isLoadingInvitations && <span className="text-muted-foreground/60 ml-2">{t('loading', { ns: 'common' })}</span>}
            </>
          }
        >
          <div className="space-y-0.5">
            {linkInvitations.map((inv) => {
              const invitationSummary = t('members.linkInvitation')
              const invitationBody = (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-body text-foreground/80 truncate underline-offset-2 group-hover:underline">
                      {invitationSummary}
                    </span>
                    <SettingsBadge tone="muted">
                      {getRoleLabel(inv.role)}
                    </SettingsBadge>
                    <SettingsBadge tone={inv.use_count > 0 ? 'success' : 'muted'}>
                      {inv.use_count > 0
                        ? t('members.linkInvitationUsed', { count: inv.use_count })
                        : t('members.linkInvitationActive')}
                    </SettingsBadge>
                  </div>
                  <div className={cn(SETTINGS_HINT, 'flex items-center gap-1')}>
                    <Clock className="h-[1em] w-[1em]" />
                    {t('members.expiresAt', { date: formatDate(inv.expires_at) })}
                  </div>
                </>
              )

              return (
                <div key={inv.id} className={cn('group flex items-center gap-3 rounded-interactive px-2 py-2', SETTINGS_ROW_HOVER)}>
                  <div className="shrink-0">
                    <Link2 className="h-4 w-4 text-muted-foreground/60" />
                  </div>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left rounded-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
                    onClick={() => setSelectedLinkInvitation(inv)}
                    aria-label={t('members.openLinkInvitation')}
                  >
                    {invitationBody}
                  </button>
                  <SettingsLink
                    tone="destructive"
                    disabled={cancellingId === inv.id}
                    onClick={() => handleCancelInvitation(inv.id)}
                    className={cn(SETTINGS_HOVER_ACTION, 'shrink-0 p-1 rounded-interactive hover:bg-destructive/5')}
                    title={t('members.actions.cancelInvitation')}
                    aria-label={t('members.actions.cancelInvitation')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </SettingsLink>
                </div>
              )
            })}
          </div>
        </SettingsSection>
      )}

      {/* 待处理邀请 */}
      {canManage && pendingTargetedInvitations.length > 0 && (
        <SettingsSection
          title={
            <>
              {t('members.pendingInvitations', { count: pendingTargetedInvitations.length })}
              {isLoadingInvitations && <span className="text-muted-foreground/60 ml-2">{t('loading', { ns: 'common' })}</span>}
            </>
          }
        >
          <div className="space-y-0.5">
            {pendingTargetedInvitations.map((inv) => {
              const invitationSummary = resolvePendingInvitationSummary(inv, t)
              return (
                <div key={inv.id} className={cn('group flex items-center gap-3 rounded-interactive px-2 py-2', SETTINGS_ROW_HOVER)}>
                  <div className="shrink-0">
                    {inv.invite_type === 'email' ? (
                      <Mail className="h-4 w-4 text-muted-foreground/60" />
                    ) : (
                      <UserPlus className="h-4 w-4 text-muted-foreground/60" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body text-foreground/80 truncate">
                        {invitationSummary.title}
                      </span>
                      <SettingsBadge tone="muted">
                        {getRoleLabel(inv.role)}
                      </SettingsBadge>
                      <SettingsBadge tone="warning">
                        {t('members.statusPending')}
                      </SettingsBadge>
                    </div>
                    <div className={cn(SETTINGS_HINT, 'flex items-center gap-1 min-w-0')}>
                      {invitationSummary.detail ? (
                        <span className="truncate">{invitationSummary.detail}</span>
                      ) : null}
                      {invitationSummary.detail ? <span aria-hidden>·</span> : null}
                      <Clock className="h-[1em] w-[1em] shrink-0" />
                      <span className="truncate">
                        {t('members.expiresAt', { date: formatDate(inv.expires_at) })}
                      </span>
                    </div>
                  </div>
                  <SettingsLink
                    tone="destructive"
                    disabled={cancellingId === inv.id}
                    onClick={() => handleCancelInvitation(inv.id)}
                    className={cn(SETTINGS_HOVER_ACTION, 'shrink-0 p-1 rounded-interactive hover:bg-destructive/5')}
                    title={t('members.actions.cancelInvitation')}
                    aria-label={t('members.actions.cancelInvitation')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </SettingsLink>
                </div>
              )
            })}
          </div>
        </SettingsSection>
      )}

      {/* 成员列表（含本月用量 / 额度） */}
      <div className="space-y-0.5">
        {members.map(member => {
          const usage = usageByUser.get(member.user_id)
          const overLimit = usage ? isOverLimit(usage) : false
          const canEditBudget = budgetEnabled && usage && !usage.is_exempt
          return (
            <div key={member.user_id} className={cn('group flex items-center gap-3 rounded-interactive px-2 py-2', SETTINGS_ROW_HOVER)}>
              <div className="shrink-0">{getRoleIcon(member.role)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-body font-medium text-foreground truncate">
                    {member.user?.nickname || member.user?.username || member.user_id}
                  </span>
                  <SettingsBadge tone="muted">
                    {getRoleLabel(member.role)}
                  </SettingsBadge>
                </div>
                <div className={cn(SETTINGS_HINT, 'truncate')}>
                  {member.user?.email || member.user?.phone || member.user_id}
                  {' · '}
                  {t('members.joinedAt', { date: formatDate(member.joined_at) })}
                </div>
              </div>

              {/* 行操作（悬停显示，置于用量左侧，用量列固定贴右对齐、跨行对齐） */}
              {(canEditBudget || (canManage && member.role !== 'owner' && canManageTarget(member.role))) && (
                <div className={cn(SETTINGS_HOVER_ACTION, 'flex items-center gap-1 shrink-0')}>
                  {canEditBudget && usage && (
                    <SettingsLink
                      tone="accent"
                      onClick={() => openEditMember(usage)}
                      className="px-2 py-1 rounded-interactive hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
                    >
                      {overLimit ? tb('memberBudget.memberList.raise') : tb('memberBudget.memberList.edit')}
                    </SettingsLink>
                  )}
                  {canManage && member.role !== 'owner' && canManageTarget(member.role) && (
                    <>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <SettingsLink
                            tone="muted"
                            disabled={!!mutatingUserId}
                            className="px-2 py-1 rounded-interactive hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
                          >
                            {t('members.actions.changeRole')}
                            <ChevronDown className="h-[1em] w-[1em]" />
                          </SettingsLink>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[140px]">
                          {assignableRoles.filter((r) => canAssignRole(r)).map((role) => (
                            <DropdownMenuItem
                              key={role}
                              disabled={member.role === role}
                              onSelect={() => handleUpdateRole(member.user_id, role)}
                              className={cn(
                                'flex items-center gap-2',
                                member.role === role && 'text-accent-text bg-foreground/[0.06] dark:bg-foreground/[0.08]'
                              )}
                            >
                              {getRoleIconSmall(role)}
                              <span>{getRoleLabel(role)}</span>
                              {member.role === role && <span className={cn(SETTINGS_TEXT_META_BASE, 'text-accent-text', 'ml-auto')}>&#10003;</span>}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <SettingsLink tone="destructive" disabled={!!mutatingUserId} onClick={() => setRemovingMemberId(member.user_id)} className="px-2 py-1 rounded-interactive hover:bg-destructive/5">
                        {t('members.actions.remove')}
                      </SettingsLink>
                    </>
                  )}
                </div>
              )}

              {/* 本月用量 / 额度（行末固定贴右，跨行对齐） */}
              {budgetEnabled && usage && (
                <div className="shrink-0 min-w-[4.5rem] text-right tabular-nums">
                  <div className={cn('whitespace-nowrap text-body', overLimit ? 'text-destructive font-medium' : 'text-foreground')}>
                    {Number(usage.monthly_used).toFixed(0)}
                    {usage.is_exempt
                      ? ` / ${tb('memberBudget.exempt')}`
                      : usage.monthly_limit
                        ? ` / ${formatCredits(usage.monthly_limit)}`
                        : ` / ${tb('memberBudget.unlimited')}`}
                    {overLimit && <AlertTriangle className="inline h-[1em] w-[1em] text-destructive ml-1 -mt-0.5" />}
                  </div>
                  <div className={cn(SETTINGS_HINT, 'truncate')}>
                    {tb('memberBudget.memberList.colUsed')}
                    {usage.policy_source === 'default' && !usage.is_exempt && usage.monthly_limit && (
                      <span className="ml-0.5">· {tb('memberBudget.policyDefault')}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {!isLoading && members.length === 0 && !hasActiveFilter ? (
          <EmptyState
            icon="inbox"
            title={t('members.empty.title')}
            size="sm"
            layout="card"
            className="py-6"
          />
        ) : null}
        {!isLoading && members.length === 0 && hasActiveFilter ? (
          <div className={cn(SETTINGS_HINT, 'text-center py-6')}>
            {t('members.emptyFiltered')}
          </div>
        ) : null}
      </div>
    </>
  )

  const dialogs = (
    <>
      <Dialog open={!!selectedLinkInvitation} onOpenChange={(open) => { if (!open) setSelectedLinkInvitation(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('members.linkInvitationDetailsTitle')}</DialogTitle>
          </DialogHeader>
          {selectedLinkInvitation ? (
            <div className="space-y-3">
              <p className="text-body text-muted-foreground">
                {t('members.linkInvitationDetailsHint')}
              </p>
              <div className="flex items-center gap-2 p-2 bg-muted rounded-[12px]">
                <code className="text-body flex-1 truncate">{getInvitationLink(selectedLinkInvitation)}</code>
                <SettingsLink
                  tone="muted"
                  onClick={() => handleCopyInvitationLink(selectedLinkInvitation)}
                  className="shrink-0"
                  aria-label={t('members.copyLinkInvitation')}
                >
                  {copiedInvitationId === selectedLinkInvitation.id ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </SettingsLink>
              </div>
              <div className={cn(SETTINGS_HINT, 'flex items-center justify-between')}>
                <span>{t('members.expiresAt', { date: formatDate(selectedLinkInvitation.expires_at) })}</span>
                <span>{getRoleLabel(selectedLinkInvitation.role)}</span>
              </div>
              <Button variant="outline" size="form" onClick={() => setSelectedLinkInvitation(null)} className="w-full">
                {t('members.closeLinkInvitationDetails')}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removingMemberId)}
        onOpenChange={(open) => {
          if (!open) {
            setRemovingMemberId(null)
            setRemoveError('')
          }
        }}
        title={t('members.actions.remove')}
        description={t('members.confirmRemove')}
        confirmText={t('members.actions.remove')}
        cancelText={t('members.actions.cancel')}
        variant="destructive"
        isLoading={isLoading}
        onConfirm={async () => { if (removingMemberId) await handleRemoveMember(removingMemberId) }}
      >
        {(isLoading || removeError) && (
          <div className="space-y-3" data-testid="member-removal-progress">
            {isLoading && (
              <Progress
                value={100}
                className="h-1.5 [&>div]:animate-pulse"
                aria-label={t('members.removeProgress.running')}
              />
            )}
            <div className="space-y-2 text-body">
              <div className="flex items-start gap-2">
                {removeError ? (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent-text" />
                )}
                <div>
                  <p className={removeError ? 'text-destructive' : 'text-foreground'}>
                    {t('members.removeProgress.revokeChats')}
                  </p>
                  <p className={SETTINGS_HINT}>
                    {removeError
                      ? t('members.removeProgress.failed')
                      : t('members.removeProgress.running')}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2 text-muted-foreground">
                <Circle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p>{t('members.removeProgress.removeAccess')}</p>
                  <p className={SETTINGS_HINT}>{t('members.removeProgress.pending')}</p>
                </div>
              </div>
            </div>
            {removeError && <StatusNotice tone="danger" size="sm" description={removeError} />}
          </div>
        )}
      </ConfirmDialog>

      {/* 成员额度编辑 */}
      <ConfirmDialog
        open={Boolean(editingMember)}
        onOpenChange={(open) => { if (!open) setEditingMember(null) }}
        title={tb('memberBudget.editDialog.title', { name: editingMember?.display_name ?? '' })}
        description={tb('memberBudget.editDialog.description')}
        confirmText={tb('memberBudget.save')}
        cancelText={t('cancel', { ns: 'common' })}
        isLoading={upsertMutation.isPending}
        onConfirm={handleSaveMemberPolicy}
      >
        {editingMember && (
          <div className={cn(SETTINGS_SOFT_SURFACE, SETTINGS_TEXT_META, 'flex items-center gap-3 px-3 py-2 tabular-nums')}>
            <span>{tb('memberBudget.editDialog.currentUsage')}</span>
            <span className="font-medium text-foreground">
              {parseFloat(editingMember.monthly_used || '0').toFixed(1)}
              {editingMember.monthly_limit != null
                ? ` / ${parseFloat(editingMember.monthly_limit).toFixed(1)}`
                : ''}
              {' '}{tb('memberBudget.myUsage.credits')}
            </span>
          </div>
        )}
        <div className="space-y-3 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={SETTINGS_LABEL}>{tb('memberBudget.defaultPolicy.monthlyLimit')}</label>
              <Input
                type="number"
                min={0}
                placeholder={tb('memberBudget.unlimited')}
                value={editMonthly}
                onChange={(e) => {
                  setEditMonthly(e.target.value)
                  setMemberLimitError('')
                }}
                onKeyDown={handleMemberPolicyKeyDown}
                className={cn(SETTINGS_CONTROL, 'mt-1')}
              />
            </div>
            <div>
              <label className={SETTINGS_LABEL}>{tb('memberBudget.defaultPolicy.dailyLimit')}</label>
              <Input
                type="number"
                min={0}
                placeholder={tb('memberBudget.unlimited')}
                value={editDaily}
                onChange={(e) => {
                  setEditDaily(e.target.value)
                  setMemberLimitError('')
                }}
                onKeyDown={handleMemberPolicyKeyDown}
                className={cn(SETTINGS_CONTROL, 'mt-1')}
              />
            </div>
          </div>
          {memberLimitError && (
            <p className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{memberLimitError}</p>
          )}
          {policies?.find((p) => p.user_id === editingMember?.user_id && p.target_role === null) && (
            <SettingsLink
              tone="destructive"
              onClick={handleResetMemberPolicy}
              disabled={deleteMutation.isPending}
            >
              {tb('memberBudget.editDialog.resetToDefault')}
            </SettingsLink>
          )}
        </div>
      </ConfirmDialog>

      {showInviteDialog && (
        <InviteDialog organizationId={organization.id} onClose={handleInviteDialogClose} onInvited={() => { void queryClient.invalidateQueries({ queryKey: memberKeys.lists(organization.id) }); void loadInvitations() }} />
      )}
    </>
  )

  if (embedded) {
    return (
      <>
        {content}
        {dialogs}
      </>
    )
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Users className="h-4 w-4" />}
        title={t('members.title')}
        subtitle={t('members.subtitle', { name: organization.name, count: membersTotal })}
      />
      {content}
      {dialogs}
    </SettingsPanelLayout>
  )
}
