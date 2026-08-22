import { spaceAdminApi } from '@/api/space-admin'
import {
  type OrganizationMemberBudgetData,
  type OrganizationMemberBudgetPolicyItem,
  deleteOrganizationMemberBudgetPolicy,
  getOrganizationMemberBudget,
  patchOrganizationMemberBudgetExemptRoles,
  upsertOrganizationMemberBudget,
} from '@/billing-management/api/billing-admin'
import { EntityLink } from '@/components/admin/EntityLink'
import {
  invitationTargetLabel,
  resolveInvitationLink,
} from '@/components/spaces/invitation-link'
import { OrganizationDirectAddDialog } from '@/components/spaces/organization-direct-add-dialog'
import { OrganizationInviteDialog } from '@/components/spaces/organization-invite-dialog'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatDateTime } from '@/lib/utils'
import type {
  MemberUsageItem,
  OrganizationInvitationItem,
  OrganizationMember,
} from '@/types/space-admin'
import {
  Check,
  ChevronDown,
  Copy,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  Shield,
  UserPlus,
  Users,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ROLE_LABELS: Record<OrganizationMember['role'], string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '编辑者',
  viewer: '查看者',
}

/** 对应账号 User.is_active，不是组织内在线态 */
const USER_STATUS_LABELS: Record<'active' | 'inactive' | 'unknown', string> = {
  active: '活跃',
  inactive: '已停用',
  unknown: '未知',
}

const ASSIGNABLE_ROLES: Array<'admin' | 'editor' | 'viewer'> = ['admin', 'editor', 'viewer']
const MAX_CREDITS_LIMIT = 100_000_000

function daysIntoCurrentMonth(): number {
  return Math.max(1, new Date().getDate())
}

function formatCredits(value?: string | number | null): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return String(value ?? '—')
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatLimitOrUnlimited(value?: string | number | null): string {
  if (value == null || value === '') return '不限'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function toCreditsInputValue(raw?: string | null): string {
  if (raw == null || raw === '') return ''
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : raw
}

function exceedsCreditsLimit(...values: string[]): boolean {
  return values.some(
    (v) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= MAX_CREDITS_LIMIT
  )
}

type SensitiveAction =
  | { type: 'save_default_policy' }
  | { type: 'change_role'; member: OrganizationMember; role: 'admin' | 'editor' | 'viewer' }
  | { type: 'remove_member'; member: OrganizationMember }
  | { type: 'save_member_budget'; member: OrganizationMember }
  | { type: 'reset_member_budget'; member: OrganizationMember; policyId: string }
  | { type: 'cancel_invitation'; invitation: OrganizationInvitationItem }

export interface OrganizationMembersParitySectionProps {
  organizationId: string
  /** 传入则不再请求 listOrganizationMembers */
  members?: OrganizationMember[]
  /** 与组织详情页「重新加载」联动；变化时重拉成员/邀请/用量/预算 */
  refreshKey?: number
}

/**
 * AdminDash「成员与额度」对齐 Electron OrganizationMembersPanel + InviteDialog。
 */
export function OrganizationMembersParitySection({
  organizationId,
  members: membersProp,
  refreshKey = 0,
}: OrganizationMembersParitySectionProps) {
  const [membersLocal, setMembersLocal] = useState<OrganizationMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)

  const [memberBudget, setMemberBudget] = useState<OrganizationMemberBudgetData | null>(null)
  const [budgetLoading, setBudgetLoading] = useState(false)
  const [budgetError, setBudgetError] = useState<string | null>(null)

  const [usageByUserId, setUsageByUserId] = useState<Map<string, MemberUsageItem>>(new Map())
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [usagePeriodDays, setUsagePeriodDays] = useState(daysIntoCurrentMonth())
  const [usageTotalCredits, setUsageTotalCredits] = useState<string | null>(null)

  const [invitations, setInvitations] = useState<OrganizationInvitationItem[]>([])
  const [invitationsLoading, setInvitationsLoading] = useState(false)
  const [invitationsError, setInvitationsError] = useState<string | null>(null)
  const [copiedInvitationId, setCopiedInvitationId] = useState<string | null>(null)

  const [searchInput, setSearchInput] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | OrganizationMember['role']>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'unknown'>('all')

  const [policyEditing, setPolicyEditing] = useState(false)
  const [monthlyLimit, setMonthlyLimit] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [adminExempt, setAdminExempt] = useState(true)
  const [limitError, setLimitError] = useState('')

  const [inviteOpen, setInviteOpen] = useState(false)
  const [directAddOpen, setDirectAddOpen] = useState(false)
  const [memberBudgetDialog, setMemberBudgetDialog] = useState<OrganizationMember | null>(null)
  const [editMonthly, setEditMonthly] = useState('')
  const [editDaily, setEditDaily] = useState('')
  const [memberLimitError, setMemberLimitError] = useState('')

  const [pendingAction, setPendingAction] = useState<SensitiveAction | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const members = membersProp ?? membersLocal

  const loadMembers = useCallback(async () => {
    if (membersProp) return
    setMembersLoading(true)
    setMembersError(null)
    try {
      const response = await spaceAdminApi.listOrganizationMembers(organizationId, {
        page: 1,
        pageSize: 100,
      })
      setMembersLocal(response.members || [])
    } catch (e) {
      setMembersError(e instanceof Error ? e.message : '加载成员列表失败')
      setMembersLocal([])
    } finally {
      setMembersLoading(false)
    }
  }, [organizationId, membersProp])

  const loadMemberBudget = useCallback(async () => {
    setBudgetLoading(true)
    setBudgetError(null)
    try {
      const data = await getOrganizationMemberBudget(organizationId)
      setMemberBudget(data)
      const defaultPolicy = data.default_policy
      setMonthlyLimit(toCreditsInputValue(defaultPolicy?.monthly_credits_limit))
      setDailyLimit(toCreditsInputValue(defaultPolicy?.daily_credits_limit))
      setAdminExempt(Boolean(data.admin_exempt))
    } catch (e) {
      setBudgetError(e instanceof Error ? e.message : '加载默认预算策略失败')
      setMemberBudget(null)
    } finally {
      setBudgetLoading(false)
    }
  }, [organizationId])

  const loadMemberUsage = useCallback(async () => {
    setUsageLoading(true)
    setUsageError(null)
    try {
      const days = daysIntoCurrentMonth()
      const response = await spaceAdminApi.getOrganizationMemberUsage(organizationId, days)
      const map = new Map<string, MemberUsageItem>()
      for (const item of response.members || []) {
        map.set(item.user_id, item)
      }
      setUsageByUserId(map)
      setUsagePeriodDays(response.period_days ?? days)
      setUsageTotalCredits(response.total_credits ?? null)
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : '加载成员本月用量失败')
      setUsageByUserId(new Map())
      setUsageTotalCredits(null)
    } finally {
      setUsageLoading(false)
    }
  }, [organizationId])

  const loadInvitations = useCallback(async () => {
    setInvitationsLoading(true)
    setInvitationsError(null)
    try {
      const response = await spaceAdminApi.listOrganizationInvitations(organizationId)
      setInvitations(response.invitations || [])
    } catch (e) {
      setInvitationsError(e instanceof Error ? e.message : '加载待处理邀请失败')
      setInvitations([])
    } finally {
      setInvitationsLoading(false)
    }
  }, [organizationId])

  const reloadAll = useCallback(() => {
    void loadMembers()
    void loadMemberBudget()
    void loadMemberUsage()
    void loadInvitations()
  }, [loadMembers, loadMemberBudget, loadMemberUsage, loadInvitations])

  useEffect(() => {
    void loadMembers()
  }, [loadMembers])

  useEffect(() => {
    void loadMemberBudget()
  }, [loadMemberBudget])

  useEffect(() => {
    void loadMemberUsage()
  }, [loadMemberUsage])

  useEffect(() => {
    void loadInvitations()
  }, [loadInvitations])

  // Electron 里接受邀请后切回后台：不重拉会一直停在进页快照（不重拉预算，避免冲掉编辑中表单）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void loadMembers()
      void loadInvitations()
      void loadMemberUsage()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadMembers, loadInvitations, loadMemberUsage])

  // 顶栏「重新加载」会 bump refreshKey；跳过初次挂载（上面的 load* effect 已拉过）
  const refreshKeyBootstrapped = useRef(false)
  useEffect(() => {
    if (!refreshKeyBootstrapped.current) {
      refreshKeyBootstrapped.current = true
      return
    }
    reloadAll()
  }, [refreshKey, reloadAll])

  const policies = memberBudget?.policies ?? []
  const personalPolicyByUserId = useMemo(() => {
    const map = new Map<string, OrganizationMemberBudgetPolicyItem>()
    for (const policy of policies) {
      if (policy.user_id && !policy.target_role && policy.is_active) {
        map.set(policy.user_id, policy)
      }
    }
    return map
  }, [policies])

  const defaultPolicy = memberBudget?.default_policy ?? null
  const exemptRoles = memberBudget?.exempt_roles ?? []

  const filteredMembers = useMemo(() => {
    const q = searchInput.trim().toLowerCase()
    return members.filter((member) => {
      if (roleFilter !== 'all' && member.role !== roleFilter) return false
      const status = member.user_status || 'unknown'
      if (statusFilter !== 'all' && status !== statusFilter) return false
      if (!q) return true
      const haystack = [
        member.user_id,
        member.user_name,
        member.user_email,
        member.user_phone,
        member.user_username,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [members, roleFilter, statusFilter, searchInput])

  const resolveMemberQuota = (member: OrganizationMember) => {
    if (exemptRoles.includes(member.role)) {
      return {
        label: '豁免',
        monthly: null as string | null,
        daily: null as string | null,
        source: 'exempt' as const,
      }
    }
    const personal = personalPolicyByUserId.get(member.user_id)
    if (personal) {
      return {
        label: `${formatLimitOrUnlimited(personal.monthly_credits_limit)} / 日 ${formatLimitOrUnlimited(personal.daily_credits_limit)}`,
        monthly: personal.monthly_credits_limit,
        daily: personal.daily_credits_limit,
        source: 'personal' as const,
      }
    }
    return {
      label: `${formatLimitOrUnlimited(defaultPolicy?.monthly_credits_limit)} / 日 ${formatLimitOrUnlimited(defaultPolicy?.daily_credits_limit)}`,
      monthly: defaultPolicy?.monthly_credits_limit ?? null,
      daily: defaultPolicy?.daily_credits_limit ?? null,
      source: 'default' as const,
    }
  }

  const openMemberBudgetEdit = (member: OrganizationMember) => {
    const personal = personalPolicyByUserId.get(member.user_id)
    setMemberBudgetDialog(member)
    setMemberLimitError('')
    if (personal) {
      setEditMonthly(toCreditsInputValue(personal.monthly_credits_limit))
      setEditDaily(toCreditsInputValue(personal.daily_credits_limit))
    } else {
      setEditMonthly(toCreditsInputValue(defaultPolicy?.monthly_credits_limit))
      setEditDaily(toCreditsInputValue(defaultPolicy?.daily_credits_limit))
    }
  }

  const handleCancelPolicyEdit = () => {
    setMonthlyLimit(toCreditsInputValue(defaultPolicy?.monthly_credits_limit))
    setDailyLimit(toCreditsInputValue(defaultPolicy?.daily_credits_limit))
    setAdminExempt(Boolean(memberBudget?.admin_exempt))
    setLimitError('')
    setPolicyEditing(false)
  }

  const handleConfirmSensitive = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingAction) return
    setActionLoading(true)
    setActionMessage(null)
    try {
      if (pendingAction.type === 'save_default_policy') {
        if (exceedsCreditsLimit(monthlyLimit, dailyLimit)) {
          setLimitError('额度过大，请控制在 1 亿以内')
          setPendingAction(null)
          return
        }
        await upsertOrganizationMemberBudget(organizationId, {
          user_id: null,
          target_role: null,
          monthly_credits_limit: monthlyLimit ? Number(monthlyLimit) : null,
          daily_credits_limit: dailyLimit ? Number(dailyLimit) : null,
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        await patchOrganizationMemberBudgetExemptRoles(organizationId, {
          exempt_roles: adminExempt ? ['owner', 'admin'] : [],
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setPolicyEditing(false)
        setActionMessage('默认预算策略已保存')
        await loadMemberBudget()
      } else if (pendingAction.type === 'change_role') {
        await spaceAdminApi.updateOrganizationMemberRole(
          organizationId,
          pendingAction.member.user_id,
          {
            role: pendingAction.role,
            reason: payload.reason,
            ticket_id: payload.ticket_id,
          }
        )
        setActionMessage(`已将角色改为 ${ROLE_LABELS[pendingAction.role]}`)
        await loadMembers()
      } else if (pendingAction.type === 'remove_member') {
        await spaceAdminApi.removeOrganizationMember(organizationId, pendingAction.member.user_id, {
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setActionMessage('成员已移除')
        await loadMembers()
        await loadMemberUsage()
      } else if (pendingAction.type === 'save_member_budget') {
        if (exceedsCreditsLimit(editMonthly, editDaily)) {
          setMemberLimitError('额度过大，请控制在 1 亿以内')
          setPendingAction(null)
          return
        }
        await upsertOrganizationMemberBudget(organizationId, {
          user_id: pendingAction.member.user_id,
          monthly_credits_limit: editMonthly ? Number(editMonthly) : null,
          daily_credits_limit: editDaily ? Number(editDaily) : null,
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setMemberBudgetDialog(null)
        setActionMessage('个人 AI 额度已保存')
        await loadMemberBudget()
      } else if (pendingAction.type === 'reset_member_budget') {
        await deleteOrganizationMemberBudgetPolicy(organizationId, pendingAction.policyId, {
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setMemberBudgetDialog(null)
        setActionMessage('已重置为默认额度')
        await loadMemberBudget()
      } else if (pendingAction.type === 'cancel_invitation') {
        await spaceAdminApi.cancelOrganizationInvitation(
          organizationId,
          pendingAction.invitation.id,
          {
            reason: payload.reason,
            ticket_id: payload.ticket_id,
          }
        )
        setActionMessage('邀请已取消')
        await loadInvitations()
      }
      setPendingAction(null)
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : '操作失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleCopyInvitation = async (invitation: OrganizationInvitationItem) => {
    const link = resolveInvitationLink(invitation)
    if (!link) {
      setActionMessage('该邀请没有可复制链接')
      return
    }
    try {
      await navigator.clipboard.writeText(link)
      setCopiedInvitationId(invitation.id)
      setActionMessage('邀请链接已复制')
      setTimeout(() => setCopiedInvitationId(null), 2000)
    } catch {
      setActionMessage('复制失败，请手动复制列表中的链接')
    }
  }

  const tableLoading = (membersProp ? false : membersLoading) || usageLoading
  const sensitiveMeta = (() => {
    if (!pendingAction) return null
    if (pendingAction.type === 'save_default_policy') {
      return {
        title: '保存默认预算策略',
        targetLabel: `组织 ${organizationId}`,
        impact: `月额度 ${formatLimitOrUnlimited(monthlyLimit || null)}，日额度 ${formatLimitOrUnlimited(dailyLimit || null)}，管理员豁免 ${adminExempt ? '开启' : '关闭'}`,
        confirmButtonLabel: '确认保存',
      }
    }
    if (pendingAction.type === 'change_role') {
      return {
        title: '更改成员角色',
        targetLabel: `${pendingAction.member.user_name || pendingAction.member.user_id}（${ROLE_LABELS[pendingAction.member.role]} → ${ROLE_LABELS[pendingAction.role]}）`,
        impact: '角色变更会影响权限与预算豁免判定。',
        confirmButtonLabel: '确认更改',
      }
    }
    if (pendingAction.type === 'remove_member') {
      return {
        title: '移除组织成员',
        targetLabel: pendingAction.member.user_name || pendingAction.member.user_id,
        impact: '移除后该用户将失去组织访问权，相关连接会被撤销。',
        confirmText: 'REMOVE',
        confirmButtonLabel: '确认移除',
      }
    }
    if (pendingAction.type === 'save_member_budget') {
      return {
        title: '保存个人 AI 额度',
        targetLabel: pendingAction.member.user_name || pendingAction.member.user_id,
        impact: `月 ${formatLimitOrUnlimited(editMonthly || null)} / 日 ${formatLimitOrUnlimited(editDaily || null)}`,
        confirmButtonLabel: '确认保存',
      }
    }
    if (pendingAction.type === 'reset_member_budget') {
      return {
        title: '重置为默认额度',
        targetLabel: pendingAction.member.user_name || pendingAction.member.user_id,
        impact: '将删除该成员的个人额度策略，回退到组织默认策略。',
        confirmButtonLabel: '确认重置',
      }
    }
    return {
      title: '取消邀请',
      targetLabel: pendingAction.invitation.id,
      impact: '取消后邀请链接将立即失效。',
      confirmButtonLabel: '确认取消',
    }
  })()

  return (
    <div className="space-y-3">
      {actionMessage ? (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-body">{actionMessage}</div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-subtitle">
                <Shield className="h-4 w-4" />
                默认预算策略
              </CardTitle>
              <CardDescription className="mt-1">
                为所有成员设置默认的月度/日度上限；可编辑保存。
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {!policyEditing ? (
                <Button size="sm" variant="outline" onClick={() => setPolicyEditing(true)}>
                  <Pencil className="mr-1 h-3 w-3" />
                  编辑
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadMemberBudget()}
                disabled={budgetLoading}
              >
                {budgetLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {budgetError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {budgetError}
            </div>
          ) : budgetLoading && !memberBudget ? (
            <div className="flex h-16 items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载预算策略…
            </div>
          ) : policyEditing ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label
                    className="mb-1 block text-body font-medium"
                    htmlFor="org-default-monthly-limit"
                  >
                    月度上限（credits）
                  </label>
                  <Input
                    id="org-default-monthly-limit"
                    type="number"
                    min={0}
                    placeholder="留空表示不限"
                    value={monthlyLimit}
                    onChange={(e) => {
                      setMonthlyLimit(e.target.value)
                      setLimitError('')
                    }}
                  />
                </div>
                <div>
                  <label
                    className="mb-1 block text-body font-medium"
                    htmlFor="org-default-daily-limit"
                  >
                    日上限（credits）
                  </label>
                  <Input
                    id="org-default-daily-limit"
                    type="number"
                    min={0}
                    placeholder="留空表示不限"
                    value={dailyLimit}
                    onChange={(e) => {
                      setDailyLimit(e.target.value)
                      setLimitError('')
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-body font-medium">管理员豁免</div>
                  <div className="text-caption text-muted-foreground">
                    Owner 角色不受额度限制
                  </div>
                </div>
                <Switch checked={adminExempt} onCheckedChange={setAdminExempt} />
              </div>
              {limitError ? <div className="text-body text-destructive">{limitError}</div> : null}
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setPendingAction({ type: 'save_default_policy' })}>
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={handleCancelPolicyEdit}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="divide-y rounded-md border bg-background">
              <PolicyRow
                label="月度上限（credits）"
                hint="留空表示不限制月度用量"
                value={formatLimitOrUnlimited(defaultPolicy?.monthly_credits_limit)}
              />
              <PolicyRow
                label="日上限（credits）"
                hint="留空表示不限制日用量"
                value={formatLimitOrUnlimited(defaultPolicy?.daily_credits_limit)}
              />
              <PolicyRow
                label="管理员豁免"
                hint="Owner 角色不受额度限制"
                value={
                  memberBudget?.admin_exempt ? (
                    <Badge variant="success">已开启</Badge>
                  ) : (
                    <Badge variant="secondary">已关闭</Badge>
                  )
                }
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-subtitle">
                <UserPlus className="h-4 w-4" />
                邀请
              </CardTitle>
              <CardDescription className="mt-1">
                手机号 / 链接 / 用户 ID 邀请需对方接受；「直接添加」可跳过同意立刻入组。下方为待处理邀请。
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setDirectAddOpen(true)}>
                <UserPlus className="mr-1 h-3.5 w-3.5" />
                直接添加成员
              </Button>
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <Link2 className="mr-1 h-3.5 w-3.5" />
                邀请成员
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {invitationsError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {invitationsError}
            </div>
          ) : null}
          {invitationsLoading ? (
            <div className="flex h-16 items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载邀请…
            </div>
          ) : invitations.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
              暂无待处理邀请
            </div>
          ) : (
            <div className="overflow-auto rounded-md border bg-background">
              <table className="min-w-full text-body">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">类型</th>
                    <th className="px-3 py-2 text-left font-medium">目标 / 邀请链接</th>
                    <th className="px-3 py-2 text-left font-medium">角色</th>
                    <th className="px-3 py-2 text-left font-medium">过期</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => {
                    const inviteLink = resolveInvitationLink(invitation)
                    const targetLabel = invitationTargetLabel(invitation)
                    return (
                      <tr key={invitation.id} className="border-t">
                        <td className="px-3 py-2">{invitation.invite_type}</td>
                        <td className="max-w-[420px] px-3 py-2 font-mono text-caption">
                          <div className="inline-flex max-w-full items-center gap-1">
                            <span className="min-w-0 truncate" title={targetLabel}>
                              {targetLabel}
                            </span>
                            {inviteLink ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 shrink-0 px-0"
                                title="复制链接"
                                onClick={() => void handleCopyInvitation(invitation)}
                              >
                                {copiedInvitationId === invitation.id ? (
                                  <Check className="h-3.5 w-3.5 text-success" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {ROLE_LABELS[invitation.role as OrganizationMember['role']] ||
                            invitation.role}
                        </td>
                        <td className="px-3 py-2">{formatDateTime(invitation.expires_at)}</td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() =>
                              setPendingAction({ type: 'cancel_invitation', invitation })
                            }
                          >
                            取消
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-subtitle">
                <Users className="h-4 w-4" />
                成员与本月用量
              </CardTitle>
              <CardDescription className="mt-1">
                近 {usagePeriodDays} 天（本月至今）credits
                {usageTotalCredits != null ? ` · 合计 ${formatCredits(usageTotalCredits)}` : ''}
                。用量来自 member-usage，额度取个人策略 / 默认策略。
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={reloadAll} disabled={tableLoading}>
              {tableLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div className="grid gap-2 md:grid-cols-3">
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索昵称 / 邮箱 / 手机 / 用户 ID"
            />
            <Select
              value={roleFilter}
              onValueChange={(value) => setRoleFilter(value as typeof roleFilter)}
            >
              <SelectTrigger>
                <SelectValue placeholder="角色筛选" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部角色</SelectItem>
                <SelectItem value="owner">所有者</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
                <SelectItem value="editor">编辑者</SelectItem>
                <SelectItem value="viewer">查看者</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}
            >
              <SelectTrigger>
                <SelectValue placeholder="账号状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部账号状态</SelectItem>
                <SelectItem value="active">活跃</SelectItem>
                <SelectItem value="inactive">已停用</SelectItem>
                <SelectItem value="unknown">未知</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {membersError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {membersError}
            </div>
          ) : null}
          {usageError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {usageError}
            </div>
          ) : null}

          {tableLoading && members.length === 0 ? (
            <div className="flex h-20 items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载成员与用量…
            </div>
          ) : filteredMembers.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
              暂无成员数据
            </div>
          ) : (
            <div className="overflow-auto rounded-md border bg-background">
              <table className="min-w-full text-body">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">用户</th>
                    <th className="px-3 py-2 text-left font-medium">角色</th>
                    <th className="px-3 py-2 text-left font-medium">账号状态</th>
                    <th className="px-3 py-2 text-left font-medium">加入时间</th>
                    <th className="px-3 py-2 text-right font-medium">本月 credits</th>
                    <th className="px-3 py-2 text-right font-medium">个人额度</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.map((member) => {
                    const usage = usageByUserId.get(member.user_id)
                    const quota = resolveMemberQuota(member)
                    const userStatus = member.user_status || 'unknown'
                    return (
                      <tr key={member.id} className="border-t">
                        <td className="px-3 py-2">
                          <div className="font-medium">
                            {member.user_name || usage?.display_name || '未知'}
                          </div>
                          <div className="text-caption text-muted-foreground">
                            <EntityLink type="user" id={member.user_id} label={member.user_id} />
                          </div>
                          <div className="text-caption text-muted-foreground">
                            {member.user_email || member.user_phone || member.user_username || null}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline">{ROLE_LABELS[member.role] ?? member.role}</Badge>
                          {member.role === 'owner' ? (
                            <Badge className="ml-1" variant="success">
                              Owner
                            </Badge>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            variant={
                              userStatus === 'active'
                                ? 'success'
                                : userStatus === 'inactive'
                                  ? 'destructive'
                                  : 'outline'
                            }
                          >
                            {USER_STATUS_LABELS[userStatus]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">{formatDateTime(member.joined_at)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {usage ? formatCredits(usage.total_credits) : usageLoading ? '…' : '0'}
                          {usage ? (
                            <div className="font-sans text-caption text-muted-foreground">
                              {usage.event_count} 次
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="tabular-nums">{quota.label}</div>
                          <div className="text-caption text-muted-foreground">
                            {quota.source === 'personal'
                              ? '个人策略'
                              : quota.source === 'exempt'
                                ? '角色豁免'
                                : '默认策略'}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            {member.role !== 'owner' ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button size="sm" variant="outline">
                                    更改角色
                                    <ChevronDown className="ml-1 h-3 w-3" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {ASSIGNABLE_ROLES.filter((role) => role !== member.role).map(
                                    (role) => (
                                      <DropdownMenuItem
                                        key={role}
                                        onClick={() =>
                                          setPendingAction({
                                            type: 'change_role',
                                            member,
                                            role,
                                          })
                                        }
                                      >
                                        {ROLE_LABELS[role]}
                                      </DropdownMenuItem>
                                    )
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openMemberBudgetEdit(member)}
                              disabled={quota.source === 'exempt'}
                            >
                              编辑额度
                            </Button>
                            {member.role !== 'owner' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                onClick={() => setPendingAction({ type: 'remove_member', member })}
                              >
                                移除
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <OrganizationDirectAddDialog
        open={directAddOpen}
        organizationId={organizationId}
        onOpenChange={setDirectAddOpen}
        onAdded={() => {
          setActionMessage('成员已直接添加')
          void loadMembers()
          void loadMemberUsage()
        }}
      />

      <OrganizationInviteDialog
        open={inviteOpen}
        organizationId={organizationId}
        onOpenChange={setInviteOpen}
        onInvited={() => {
          void loadInvitations()
          void loadMembers()
        }}
      />

      <Dialog
        open={Boolean(memberBudgetDialog)}
        onOpenChange={(open) => {
          if (!open) setMemberBudgetDialog(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑个人 AI 额度</DialogTitle>
            <DialogDescription>
              {memberBudgetDialog?.user_name || memberBudgetDialog?.user_id}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <label
                className="mb-1 block text-body font-medium"
                htmlFor="org-member-monthly-limit"
              >
                月度上限
              </label>
              <Input
                id="org-member-monthly-limit"
                type="number"
                min={0}
                placeholder="留空表示不限"
                value={editMonthly}
                onChange={(e) => {
                  setEditMonthly(e.target.value)
                  setMemberLimitError('')
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-body font-medium" htmlFor="org-member-daily-limit">
                日上限
              </label>
              <Input
                id="org-member-daily-limit"
                type="number"
                min={0}
                placeholder="留空表示不限"
                value={editDaily}
                onChange={(e) => {
                  setEditDaily(e.target.value)
                  setMemberLimitError('')
                }}
              />
            </div>
            {memberLimitError ? (
              <div className="text-body text-destructive">{memberLimitError}</div>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="ghost"
              disabled={
                !memberBudgetDialog || !personalPolicyByUserId.get(memberBudgetDialog.user_id)
              }
              onClick={() => {
                if (!memberBudgetDialog) return
                const personal = personalPolicyByUserId.get(memberBudgetDialog.user_id)
                if (!personal) return
                // 先关编辑 Dialog，避免 Radix 焦点锁挡住二次确认输入
                setPendingAction({
                  type: 'reset_member_budget',
                  member: memberBudgetDialog,
                  policyId: personal.id,
                })
                setMemberBudgetDialog(null)
              }}
            >
              重置为默认
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setMemberBudgetDialog(null)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  if (!memberBudgetDialog) return
                  setPendingAction({ type: 'save_member_budget', member: memberBudgetDialog })
                  setMemberBudgetDialog(null)
                }}
              >
                保存
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sensitiveMeta ? (
        <SensitiveActionConfirmDialog
          open={Boolean(pendingAction)}
          title={sensitiveMeta.title}
          targetLabel={sensitiveMeta.targetLabel}
          impact={sensitiveMeta.impact}
          confirmText={'confirmText' in sensitiveMeta ? sensitiveMeta.confirmText : undefined}
          confirmButtonLabel={sensitiveMeta.confirmButtonLabel}
          loading={actionLoading}
          onCancel={() => {
            if (
              pendingAction?.type === 'save_member_budget' ||
              pendingAction?.type === 'reset_member_budget'
            ) {
              setMemberBudgetDialog(pendingAction.member)
            }
            setPendingAction(null)
          }}
          onConfirm={(payload) => void handleConfirmSensitive(payload)}
        />
      ) : null}
    </div>
  )
}

function PolicyRow({
  label,
  hint,
  value,
}: {
  label: string
  hint: string
  value: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-body font-medium">{label}</div>
        <div className="mt-0.5 text-caption text-muted-foreground">{hint}</div>
      </div>
      <div className="shrink-0 text-body font-medium tabular-nums">{value}</div>
    </div>
  )
}
