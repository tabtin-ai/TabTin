import { spaceAdminApi } from '@/api/space-admin'
import { MoneyText } from '@/components/admin/MoneyText'
import { PointsText } from '@/components/admin/PointsText'
import { OrganizationSubscriptionSection } from '@/components/spaces/organization-subscription-section'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDateTime } from '@/lib/utils'
import type {
  OrganizationCashWalletInfo,
  OrganizationControlPolicy,
  OrganizationEntitlementsData,
  OrganizationMember,
  OrganizationQuotaLimit,
  OrganizationSummary,
  OrganizationWalletInfo,
} from '@/types/space-admin'
import {
  AlertTriangle,
  ArrowRightLeft,
  Info,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

/** 与 Electron OrganizationMembershipPanel 行序一致 */
const LIMIT_ORDER = [
  'max_tables',
  'max_documents',
  'max_groups',
  'max_members',
  'included_storage_bytes',
  'included_llm_credits_monthly',
] as const

const LIMIT_LABELS: Record<string, string> = {
  max_tables: '表格',
  max_documents: '文档',
  max_groups: '群组',
  max_members: '成员',
  included_storage_bytes: '存储',
  included_llm_credits_monthly: '点券',
}

const STATUS_LABELS: Record<string, string> = {
  active: '正常',
  deleting: '删除中',
}

const CREDITS_AVAILABLE_TIP = '可用点券 = 点券余额 - 预留点券'
const CREDITS_FROZEN_TIP =
  '预留点券是正在进行的 AI 对话预估占用的点券。对话结束后会自动释放或结算。可用点券 = 点券余额 - 预留点券。'
const CREDITS_RULE_HINT =
  '点券用于抵扣 AI 消耗。本月套餐点券用尽后，可开启「点券自动补充」，从组织现金钱包按元购买点券；未开启则停止使用。预留点券是进行中对话的预估占用，结束后自动释放或结算。'
const CASH_WALLET_HINT =
  '可用于补充点券。现金按人民币计价，开启自动补充后，点券用尽时会从这里扣款购买点券。'

const BYTES_PER_MB = 1024 * 1024
const BYTES_PER_GB = 1024 * 1024 * 1024

export type GeneralParityNavigateTab = 'quota' | 'ai-cost' | 'billing'

export interface OrganizationGeneralParitySectionProps {
  organizationId: string
  overview: OrganizationSummary | null
  members?: OrganizationMember[]
  controlPolicy?: OrganizationControlPolicy | null
  /** 由组织详情页预载，避免本组件重复请求 */
  wallet: OrganizationWalletInfo | null
  cashWallet: OrganizationCashWalletInfo | null
  entitlements: OrganizationEntitlementsData | null
  onOverviewUpdated?: (org: OrganizationSummary) => void
  onRefreshFinance?: () => void
  /** 套餐升级成功后回调（如整页 reloadVersion） */
  onMembershipUpgraded?: () => void
  onNavigateTab?: (tab: GeneralParityNavigateTab) => void
  onOrganizationDeleted?: () => void
}

function formatQuotaValue(value?: number | null, key?: string): string {
  if (value === -1) return '无限制'
  if (value === null || value === undefined) return '—'
  if (key === 'included_storage_bytes') {
    if (value >= BYTES_PER_GB) {
      return `${(value / BYTES_PER_GB).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`
    }
    return `${(value / BYTES_PER_MB).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`
  }
  return Number(value).toLocaleString()
}

function usagePercent(current?: number | null, effective?: number | null): number | null {
  if (current == null || effective == null || effective <= 0 || effective === -1) return null
  return Math.min(100, Math.max(0, Math.round((current / effective) * 100)))
}

function sortedLimitEntries(
  limits: Record<string, OrganizationQuotaLimit>
): Array<[string, OrganizationQuotaLimit]> {
  const keys = Object.keys(limits)
  const orderIndex = new Map(LIMIT_ORDER.map((key, index) => [key, index]))
  return keys
    .sort((a, b) => {
      const ai = orderIndex.get(a as (typeof LIMIT_ORDER)[number])
      const bi = orderIndex.get(b as (typeof LIMIT_ORDER)[number])
      if (ai != null && bi != null) return ai - bi
      if (ai != null) return -1
      if (bi != null) return 1
      return a.localeCompare(b)
    })
    .map((key) => [key, limits[key]] as [string, OrganizationQuotaLimit])
}

function isFreeTier(tier: OrganizationEntitlementsData['tier'] | null | undefined): boolean {
  if (!tier) return false
  return tier.tier_type === 'free' || tier.source === 'free'
}

function resolveStatusLabel(
  overview: OrganizationSummary | null,
  controlPolicy?: OrganizationControlPolicy | null
): string {
  const lifecycle = overview?.status || 'active'
  if (lifecycle === 'deleting') return STATUS_LABELS.deleting
  if (controlPolicy?.is_suspended) return '已暂停'
  if (controlPolicy?.is_readonly) return '只读'
  return STATUS_LABELS[lifecycle] || lifecycle || '正常'
}

function memberDisplayName(member: OrganizationMember): string {
  return (
    member.user_name ||
    member.user_username ||
    member.user_email ||
    member.user_phone ||
    member.user_id
  )
}

function MeterBar({ value }: { value: number }) {
  const tone = value >= 90 ? 'bg-destructive/70' : value >= 70 ? 'bg-warning/70' : 'bg-primary/70'
  return (
    <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${tone}`} style={{ width: `${value}%` }} />
    </div>
  )
}

function InfoTip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="说明"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs" side="bottom">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function creditsPoints(
  wallet: OrganizationWalletInfo | null | undefined,
  field: 'available_credits' | 'credits' | 'credits_frozen'
) {
  return wallet?.[field] ?? 0
}

type SensitiveAction =
  | { kind: 'save_profile'; name: string; description: string }
  | { kind: 'yolo'; nextValue: boolean }
  | { kind: 'transfer'; newOwnerUserId: string }
  | { kind: 'delete' }

export function OrganizationGeneralParitySection({
  organizationId,
  overview,
  members: membersProp,
  controlPolicy,
  wallet,
  cashWallet,
  entitlements,
  onOverviewUpdated,
  onRefreshFinance,
  onMembershipUpgraded,
  onNavigateTab,
  onOrganizationDeleted,
}: OrganizationGeneralParitySectionProps) {
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const [confirmYoloOpen, setConfirmYoloOpen] = useState(false)
  const [sensitiveAction, setSensitiveAction] = useState<SensitiveAction | null>(null)
  const [actionSaving, setActionSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [transferOpen, setTransferOpen] = useState(false)
  const [transferUserId, setTransferUserId] = useState('')
  const [membersLocal, setMembersLocal] = useState<OrganizationMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)

  const members = membersProp ?? membersLocal
  const organizationName = (overview?.name || '').trim() || '未命名组织'
  const allowMemberYolo = overview?.settings?.allow_member_yolo === true
  const isPersonal = overview?.type === 'personal' || overview?.is_default === true
  const statusLabel = resolveStatusLabel(overview, controlPolicy)

  useEffect(() => {
    if (!overview || isEditing) return
    setNameDraft(overview.name || '')
    setDescriptionDraft(overview.description || '')
  }, [overview, isEditing])

  const ensureMembers = useCallback(async () => {
    if (membersProp) return
    setMembersLoading(true)
    try {
      const response = await spaceAdminApi.listOrganizationMembers(organizationId, {
        page: 1,
        pageSize: 100,
      })
      setMembersLocal(response.members || [])
    } catch {
      setMembersLocal([])
    } finally {
      setMembersLoading(false)
    }
  }, [membersProp, organizationId])

  const transferCandidates = useMemo(() => {
    const ownerId = overview?.owner_id
    return members.filter((member) => member.user_id !== ownerId && member.role !== 'owner')
  }, [members, overview?.owner_id])

  const free = isFreeTier(entitlements?.tier)
  const limitEntries = sortedLimitEntries(entitlements?.limits ?? {})
  const tierName = entitlements?.tier.name || entitlements?.tier.tier_type || '未知套餐'

  const handleStartEdit = () => {
    setNameDraft(overview?.name || '')
    setDescriptionDraft(overview?.description || '')
    setFormError(null)
    setSaveNotice(null)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setNameDraft(overview?.name || '')
    setDescriptionDraft(overview?.description || '')
    setFormError(null)
    setIsEditing(false)
  }

  const handleRequestSaveProfile = () => {
    const trimmedName = nameDraft.trim()
    if (!trimmedName) {
      setFormError('组织名称不能为空')
      return
    }
    setFormError(null)
    setSensitiveAction({
      kind: 'save_profile',
      name: trimmedName,
      description: descriptionDraft.trim(),
    })
  }

  const handleYoloToggle = (checked: boolean) => {
    if (checked === allowMemberYolo) return
    if (checked) {
      setConfirmYoloOpen(true)
      return
    }
    setSensitiveAction({ kind: 'yolo', nextValue: false })
  }

  const runSensitiveAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!organizationId || !sensitiveAction) return
    setActionSaving(true)
    setActionError(null)
    try {
      if (sensitiveAction.kind === 'save_profile') {
        const updated = await spaceAdminApi.updateOrganization(organizationId, {
          name: sensitiveAction.name,
          description: sensitiveAction.description,
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        onOverviewUpdated?.(updated)
        onRefreshFinance?.()
        setIsEditing(false)
        setSaveNotice(
          '组织资料已保存。若 Electron 仍显示旧描述，请在客户端重新打开组织设置或刷新组织列表。'
        )
      } else if (sensitiveAction.kind === 'yolo') {
        const updated = await spaceAdminApi.updateOrganization(organizationId, {
          settings: { allow_member_yolo: sensitiveAction.nextValue },
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        onOverviewUpdated?.(updated)
      } else if (sensitiveAction.kind === 'transfer') {
        const updated = await spaceAdminApi.transferOrganizationOwnership(organizationId, {
          new_owner_user_id: sensitiveAction.newOwnerUserId,
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        onOverviewUpdated?.(updated)
        setTransferOpen(false)
        setTransferUserId('')
      } else if (sensitiveAction.kind === 'delete') {
        await spaceAdminApi.deleteOrganization(organizationId, {
          dryRun: false,
          force: true,
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        onOrganizationDeleted?.()
      }
      setSensitiveAction(null)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setActionSaving(false)
    }
  }

  const sensitiveDialogMeta = useMemo(() => {
    if (!sensitiveAction) {
      return { title: '', impact: '', confirmText: undefined as string | undefined }
    }
    if (sensitiveAction.kind === 'save_profile') {
      return {
        title: '确认保存组织资料',
        impact: `将更新组织名称与描述为：「${sensitiveAction.name}」。`,
        confirmText: undefined,
      }
    }
    if (sensitiveAction.kind === 'yolo') {
      return {
        title: sensitiveAction.nextValue ? '确认开放宽松审批' : '确认关闭宽松审批',
        impact: sensitiveAction.nextValue
          ? '开启后，具备管理权限的成员可为 Agent 授权「自动通过 / 全部允许」。这只是组织准入上限，不会替任何 Agent 自动开启。'
          : '关闭后，成员将无法再选用宽松审批档。',
        confirmText: undefined,
      }
    }
    if (sensitiveAction.kind === 'transfer') {
      const candidate = transferCandidates.find((m) => m.user_id === sensitiveAction.newOwnerUserId)
      const label = candidate ? memberDisplayName(candidate) : sensitiveAction.newOwnerUserId
      return {
        title: '确认转让 Owner',
        impact: `将把「${organizationName}」的 Owner 转让给 ${label}（${sensitiveAction.newOwnerUserId}）。原 Owner 将降为 editor。`,
        confirmText: undefined,
      }
    }
    return {
      title: '确认解散组织',
      impact: `将强制解散「${organizationName}」及其下属 Space / 资源。此操作不可恢复。`,
      confirmText: organizationName,
    }
  }, [sensitiveAction, transferCandidates, organizationName])

  return (
    <div className="space-y-3">
      {actionError ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
          {actionError}
        </div>
      ) : null}
      {saveNotice ? (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-body text-foreground">
          {saveNotice}
        </div>
      ) : null}

      {/* 1. 组织资料置顶 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-subtitle">组织资料</CardTitle>
            {!isEditing ? (
              <Button size="sm" variant="outline" onClick={handleStartEdit} disabled={!overview}>
                <Pencil className="mr-1 h-3.5 w-3.5" />
                编辑资料
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isEditing ? (
            <>
              <div className="space-y-1">
                <label className="text-body font-medium" htmlFor="org-general-name">
                  名称 <span className="text-destructive">*</span>
                </label>
                <Input
                  id="org-general-name"
                  value={nameDraft}
                  maxLength={100}
                  onChange={(event) => setNameDraft(event.target.value)}
                  placeholder="组织名称"
                />
              </div>
              <div className="space-y-1">
                <label className="text-body font-medium" htmlFor="org-general-description">
                  描述
                </label>
                <Textarea
                  id="org-general-description"
                  value={descriptionDraft}
                  maxLength={500}
                  rows={3}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  placeholder="组织描述"
                />
              </div>
              {formError ? <p className="text-caption text-destructive">{formError}</p> : null}
              <p className="text-caption text-muted-foreground">
                保存需填写运维原因（SensitiveConfirm）。保存成功后本页立即更新；Electron 需刷新组织列表才能看到新描述。
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
                  取消
                </Button>
                <Button size="sm" onClick={handleRequestSaveProfile}>
                  保存
                </Button>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="text-title font-semibold">{organizationName}</div>
                <p className="mt-1 text-body text-muted-foreground">
                  {(overview?.description || '').trim() || '暂无组织描述'}
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="rounded-md border bg-background px-3 py-2">
                  <div className="text-caption text-muted-foreground">状态</div>
                  <div className="mt-1 text-body font-medium">{statusLabel}</div>
                </div>
                <div className="rounded-md border bg-background px-3 py-2">
                  <div className="text-caption text-muted-foreground">当前套餐</div>
                  <div className="mt-1 text-body font-medium">{tierName}</div>
                </div>
                <div className="rounded-md border bg-background px-3 py-2">
                  <div className="text-caption text-muted-foreground">更新时间</div>
                  <div className="mt-1 text-body font-medium">
                    {formatDateTime(overview?.updated_at)}
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-subtitle">宽松审批（YOLO）</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-body font-medium">允许成员使用宽松审批</div>
              <p className="mt-0.5 text-caption text-muted-foreground">
                开启后，具备管理权限的成员可为 Agent
                授权「自动通过」或「全部允许」。这只是组织准入上限，不会自动替任何 Agent 开启。
              </p>
            </div>
            <Switch
              checked={allowMemberYolo}
              onCheckedChange={handleYoloToggle}
              disabled={!overview || isPersonal}
              aria-label="允许成员使用宽松审批"
            />
          </div>
        </CardContent>
      </Card>

      {/* 2. 资金与套餐合并 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-subtitle">资金与套餐</CardTitle>
              <p className="mt-1 text-caption text-muted-foreground">
                现金钱包、点券 credits、当前套餐与权益用量集中在此；升级套餐在此操作，充值 / 扩容请走「配额与权益」。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => onNavigateTab?.('ai-cost')}>
                开启自动补充
              </Button>
              <Button size="sm" variant="outline" onClick={() => onNavigateTab?.('quota')}>
                运营操作（充值/流水）
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRefreshFinance?.()}
                disabled={!overview || !onRefreshFinance}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                刷新
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border bg-background px-4 py-3">
              <div className="text-body font-medium">现金钱包</div>
              <div className="mt-2 text-title font-semibold tabular-nums tracking-tight">
                {cashWallet ? <MoneyText value={cashWallet.available_cny} /> : '¥0.00'}
              </div>
              <p className="mt-2 text-caption text-muted-foreground">{CASH_WALLET_HINT}</p>
              <button
                type="button"
                className="mt-1 text-caption text-primary hover:underline"
                onClick={() => onNavigateTab?.('ai-cost')}
              >
                开启自动补充：前往 AI 成本 → 点券用尽时自动补充
              </button>
            </div>

            <div className="rounded-md border bg-background px-4 py-3">
              <div className="text-body font-medium">可用点券</div>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="text-title font-semibold tabular-nums tracking-tight">
                  <PointsText value={creditsPoints(wallet, 'available_credits')} />
                </span>
                <InfoTip text={CREDITS_AVAILABLE_TIP} />
              </div>
              <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                <div className="flex items-center justify-between gap-3 text-body">
                  <span className="text-muted-foreground">点券余额</span>
                  <span className="tabular-nums">
                    <PointsText value={creditsPoints(wallet, 'credits')} />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-body">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    预留点券
                    <InfoTip text={CREDITS_FROZEN_TIP} />
                  </span>
                  <span className="tabular-nums">
                    <PointsText value={creditsPoints(wallet, 'credits_frozen')} />
                  </span>
                </div>
              </div>
              <p className="mt-2 text-caption text-muted-foreground">{CREDITS_RULE_HINT}</p>
            </div>
          </div>

          <div className="border-t border-border/40 pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body font-medium">当前套餐</span>
                <span className="text-title font-medium">{tierName}</span>
                <Badge variant={free ? 'secondary' : 'success'}>
                  {free ? '免费套餐' : '付费会员'}
                </Badge>
                {entitlements?.tier.source ? (
                  <Badge variant="outline">来源 {entitlements.tier.source}</Badge>
                ) : null}
              </div>
              <OrganizationSubscriptionSection
                organizationId={organizationId}
                onChanged={() => {
                  onRefreshFinance?.()
                  onMembershipUpgraded?.()
                }}
              />
            </div>
            <p className="text-caption text-muted-foreground">
              {free
                ? '免费套餐 · 无到期日。可点「升级套餐」按差价升级；账单流水见「订阅与账单 → 账单中心」。'
                : '到期日未包含在权益摘要接口中。升级请用右侧按钮；账单流水见「订阅与账单 → 账单中心」。'}
            </p>
          </div>

          <div className="border-t border-border/40 pt-4">
            <div className="mb-1 text-body font-medium">套餐权益</div>
            <p className="mb-3 text-caption text-muted-foreground">
              点券为本月套餐额度（已用 / 套餐额度）；文档、表格、存储和成员数属于权益上限，超出后需升级套餐或购买扩容包，不能用点券突破上限。
              <button
                type="button"
                className="ml-1 font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => onNavigateTab?.('quota')}
              >
                点此查看所有配额
              </button>
            </p>
            {limitEntries.length === 0 ? (
              <p className="text-body text-muted-foreground">暂无权益额度数据</p>
            ) : (
              <div className="space-y-3">
                {limitEntries.map(([key, limit]) => {
                  const percent = usagePercent(limit.current, limit.effective_limit)
                  const label = LIMIT_LABELS[key] || limit.label || key
                  return (
                    <div
                      key={key}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 pb-3 last:border-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <div className="text-body font-medium">{label}</div>
                        <div className="text-caption text-muted-foreground">
                          套餐 {formatQuotaValue(limit.plan_limit, key)}
                          {limit.addon_limit
                            ? ` + 扩容 ${formatQuotaValue(limit.addon_limit, key)}`
                            : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-body tabular-nums">
                          已用 {formatQuotaValue(limit.current, key)} /{' '}
                          {formatQuotaValue(limit.effective_limit, key)}
                        </span>
                        {percent != null ? <MeterBar value={percent} /> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {!isPersonal ? (
        <Card className="border-destructive/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-subtitle text-destructive">
              <AlertTriangle className="h-4 w-4" />
              危险操作
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <div className="text-body font-medium">转让 Owner</div>
                <p className="text-caption text-muted-foreground">
                  将所有权转给现有成员；原 Owner 降为 editor。
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setTransferUserId('')
                  setTransferOpen(true)
                  void ensureMembers()
                }}
              >
                <ArrowRightLeft className="mr-1 h-3.5 w-3.5" />
                转让 Owner
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <div className="text-body font-medium">解散组织</div>
                <p className="text-caption text-muted-foreground">
                  强制删除组织及其资源；个人身份不可解散。
                </p>
              </div>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setSensitiveAction({ kind: 'delete' })}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                解散组织
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {transferOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg">
            <h2 className="text-subtitle font-semibold">选择新 Owner</h2>
            <p className="mt-2 text-caption text-muted-foreground">
              仅可转让给当前组织内的非 Owner 成员。
            </p>
            {membersLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-body text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                加载成员…
              </div>
            ) : transferCandidates.length === 0 ? (
              <div className="mt-4 rounded-md bg-muted/30 px-3 py-4 text-center text-body text-muted-foreground">
                暂无可转让成员
              </div>
            ) : (
              <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                {transferCandidates.map((member) => {
                  const selected = transferUserId === member.user_id
                  return (
                    <button
                      key={member.user_id}
                      type="button"
                      onClick={() => setTransferUserId(member.user_id)}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-body ${
                        selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {memberDisplayName(member)}
                        </span>
                        <span className="block truncate text-caption text-muted-foreground">
                          {member.user_id} · {member.role}
                        </span>
                      </span>
                      <Badge variant="outline">{member.role}</Badge>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setTransferOpen(false)
                  setTransferUserId('')
                }}
              >
                取消
              </Button>
              <Button
                disabled={!transferUserId}
                onClick={() => {
                  if (!transferUserId) return
                  setTransferOpen(false)
                  setSensitiveAction({ kind: 'transfer', newOwnerUserId: transferUserId })
                }}
              >
                继续确认
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmYoloOpen}
        onOpenChange={setConfirmYoloOpen}
        title="开放宽松审批？"
        description="开启后，具备管理权限的成员可为 Agent 授权「自动通过」或「全部允许」。这只是组织准入上限，不会自动替任何 Agent 开启。"
        variant="destructive"
        confirmLabel="继续"
        onConfirm={() => {
          setConfirmYoloOpen(false)
          setSensitiveAction({ kind: 'yolo', nextValue: true })
        }}
      />

      <SensitiveActionConfirmDialog
        open={Boolean(sensitiveAction)}
        title={sensitiveDialogMeta.title}
        targetLabel={overview ? `${organizationName} (${organizationId})` : organizationId}
        impact={sensitiveDialogMeta.impact}
        confirmText={sensitiveDialogMeta.confirmText}
        confirmButtonLabel="确认执行"
        loading={actionSaving}
        onCancel={() => {
          if (!actionSaving) setSensitiveAction(null)
        }}
        onConfirm={(payload) => void runSensitiveAction(payload)}
      />
    </div>
  )
}
