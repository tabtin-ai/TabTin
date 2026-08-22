import { modelsApi } from '@/ai-admin/api/models'
import { type ProviderItem, providersApi } from '@/ai-admin/api/providers'
import { spaceAdminApi } from '@/api/space-admin'
import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import type { LlmAdminModel } from '@/types/llm-admin'
import type { OrganizationSummary } from '@/types/space-admin'
import {
  Activity,
  BarChart3,
  Copy,
  Gift,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldX,
  WalletCards,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type MembershipTier, listMembershipTiers } from '../api/billing-admin'
import {
  type ProviderCreditCampaign,
  type ProviderCreditCampaignReport,
  type ProviderCreditCampaignWrite,
  type ProviderCreditGrant,
  type ProviderCreditTransaction,
  adjustProviderCreditGrant,
  createProviderCreditCampaign,
  getProviderCreditCampaignReport,
  grantProviderCredit,
  listProviderCreditCampaigns,
  listProviderCreditGrants,
  listProviderCreditTransactions,
  revokeProviderCreditGrant,
  updateProviderCreditCampaign,
} from '../api/provider-credit-admin'

const DEFAULT_PAGE_SIZE = 20
const VIEW_PERMISSIONS = [
  ADMIN_PERMISSION.PROVIDER_CREDIT_VIEW,
  ADMIN_PERMISSION.PROVIDER_CREDIT_OPERATE,
  ADMIN_PERMISSION.PROVIDER_CREDIT_ADMIN,
]
const OPERATE_PERMISSIONS = [
  ADMIN_PERMISSION.PROVIDER_CREDIT_OPERATE,
  ADMIN_PERMISSION.PROVIDER_CREDIT_ADMIN,
]

type PageTab = 'campaigns' | 'grants' | 'transactions'

interface CampaignForm {
  code: string
  name: string
  provider_key: string
  eligible_model_ids: string
  grant_credits: string
  total_budget_credits: string
  expire_days: string
  trigger_type: string
  membership_plan_codes: string
  start_at: string
  end_at: string
  enabled: boolean
}

const EMPTY_CAMPAIGN_FORM: CampaignForm = {
  code: '',
  name: '',
  provider_key: '',
  eligible_model_ids: '',
  grant_credits: '',
  total_budget_credits: '',
  expire_days: '30',
  trigger_type: 'manual',
  membership_plan_codes: '',
  start_at: '',
  end_at: '',
  enabled: true,
}

function compactDate(value?: string | null) {
  if (!value) return '-'
  return formatDateTime(value)
}

function formatCredits(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '-'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return numeric.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

function shortId(value: string) {
  if (!value) return '-'
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function splitList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function toLocalDateTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function toIsoDateTime(value: string) {
  return value ? new Date(value).toISOString() : undefined
}

function campaignToForm(campaign: ProviderCreditCampaign): CampaignForm {
  return {
    code: campaign.code,
    name: campaign.name,
    provider_key: campaign.provider_key,
    eligible_model_ids: campaign.eligible_model_ids.join('\n'),
    grant_credits: campaign.grant_credits,
    total_budget_credits: campaign.total_budget_credits,
    expire_days: String(campaign.expire_days),
    trigger_type: campaign.trigger_type,
    membership_plan_codes: campaign.membership_plan_codes.join('\n'),
    start_at: toLocalDateTime(campaign.start_at),
    end_at: toLocalDateTime(campaign.end_at),
    enabled: campaign.enabled,
  }
}

function campaignFormToPayload(form: CampaignForm): ProviderCreditCampaignWrite {
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    provider_key: form.provider_key.trim().toLowerCase(),
    eligible_model_ids: splitList(form.eligible_model_ids),
    grant_credits: form.grant_credits.trim(),
    total_budget_credits: form.total_budget_credits.trim(),
    expire_days: Number(form.expire_days),
    trigger_type: form.trigger_type,
    membership_plan_codes: splitList(form.membership_plan_codes),
    start_at: toIsoDateTime(form.start_at),
    end_at: toIsoDateTime(form.end_at),
    enabled: form.enabled,
  }
}

function statusBadge(status: string) {
  if (status === 'active') return <Badge variant="success">有效</Badge>
  if (status === 'exhausted') return <Badge variant="outline">已用尽</Badge>
  if (status === 'revoked' || status === 'ended') {
    return <Badge variant="destructive">{status === 'revoked' ? '已撤销' : '已结束'}</Badge>
  }
  if (status === 'paused' || status === 'expired') {
    return <Badge variant="warning">{status === 'paused' ? '暂停' : '已过期'}</Badge>
  }
  return <Badge variant="outline">{status || '-'}</Badge>
}

function transactionTypeLabel(type: string) {
  return (
    {
      grant: '发放',
      consume: '消费',
      refund: '退款',
      expire: '过期',
      adjust: '调整',
    }[type] ||
    type ||
    '-'
  )
}

function referenceTypeLabel(type: string) {
  return (
    {
      provider_credit_campaign: '活动发放',
      provider_credit_grant: '额度批次',
      provider_credit_admin_adjustment: '管理员调整',
      provider_credit_admin_revoke: '管理员撤销',
      billing_usage_event: '模型用量扣减',
    }[type] ||
    type ||
    '-'
  )
}

function EmptyTable({ loading, text }: { loading: boolean; text: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-body text-muted-foreground">
      {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : text}
    </div>
  )
}

function CampaignDialog({
  open,
  campaign,
  saving,
  onOpenChange,
  onSave,
  providers,
  models,
  membershipTiers,
}: {
  open: boolean
  campaign: ProviderCreditCampaign | null
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (form: CampaignForm) => void
  providers: ProviderItem[]
  models: LlmAdminModel[]
  membershipTiers: MembershipTier[]
}) {
  const [form, setForm] = useState<CampaignForm>(EMPTY_CAMPAIGN_FORM)

  useEffect(() => {
    if (open) setForm(campaign ? campaignToForm(campaign) : EMPTY_CAMPAIGN_FORM)
  }, [campaign, open])

  const invalid =
    !form.code.trim() ||
    !form.name.trim() ||
    !form.provider_key.trim() ||
    Number(form.grant_credits) <= 0 ||
    Number(form.total_budget_credits) <= 0 ||
    Number(form.expire_days) <= 0 ||
    Boolean(form.start_at && form.end_at && new Date(form.start_at) >= new Date(form.end_at))
  const providerModels = models.filter((model) => model.provider_key === form.provider_key)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{campaign ? '编辑赠送活动' : '创建赠送活动'}</DialogTitle>
          <DialogDescription>
            模型范围使用稳定的 model UUID；留空表示该供应商的全部模型。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-code">
              活动编码
            </label>
            <Input
              id="provider-credit-code"
              className="mt-1"
              value={form.code}
              disabled={Boolean(campaign)}
              placeholder="DOUBAO_NEW_USER"
              onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
            />
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-name">
              活动名称
            </label>
            <Input
              id="provider-credit-name"
              className="mt-1"
              value={form.name}
              placeholder="豆包推广赠送额度"
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-provider">
              供应商标识（provider_key）
            </label>
            <select
              id="provider-credit-provider"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-body"
              value={form.provider_key}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  provider_key: event.target.value,
                  eligible_model_ids: '',
                }))
              }
            >
              <option value="">请选择供应商</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.provider_key}>
                  {provider.display_name || provider.provider_key}（{provider.provider_key}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-trigger">
              发放触发
            </label>
            <select
              id="provider-credit-trigger"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-body"
              value={form.trigger_type}
              onChange={(event) =>
                setForm((current) => ({ ...current, trigger_type: event.target.value }))
              }
            >
              <option value="manual">仅手动发放</option>
              <option value="new_org">用户首个团队组织自动发放（每活动一次）</option>
              <option value="membership">会员升级发放</option>
            </select>
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-grant-amount">
              单次发放额度
            </label>
            <Input
              id="provider-credit-grant-amount"
              className="mt-1"
              type="number"
              min="0"
              value={form.grant_credits}
              onChange={(event) =>
                setForm((current) => ({ ...current, grant_credits: event.target.value }))
              }
            />
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-total-budget">
              活动总预算
            </label>
            <Input
              id="provider-credit-total-budget"
              className="mt-1"
              type="number"
              min="0"
              value={form.total_budget_credits}
              onChange={(event) =>
                setForm((current) => ({ ...current, total_budget_credits: event.target.value }))
              }
            />
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-expire-days">
              额度有效天数
            </label>
            <Input
              id="provider-credit-expire-days"
              className="mt-1"
              type="number"
              min="1"
              value={form.expire_days}
              onChange={(event) =>
                setForm((current) => ({ ...current, expire_days: event.target.value }))
              }
            />
          </div>
          <div className="flex items-end gap-3 pb-2">
            <Switch
              id="provider-credit-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, enabled: checked }))
              }
            />
            <label className="text-body font-medium" htmlFor="provider-credit-enabled">
              启用活动
            </label>
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-start-at">
              开始时间
            </label>
            <Input
              id="provider-credit-start-at"
              className="mt-1"
              type="datetime-local"
              value={form.start_at}
              onChange={(event) =>
                setForm((current) => ({ ...current, start_at: event.target.value }))
              }
            />
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-end-at">
              结束时间
            </label>
            <Input
              id="provider-credit-end-at"
              className="mt-1"
              type="datetime-local"
              value={form.end_at}
              onChange={(event) =>
                setForm((current) => ({ ...current, end_at: event.target.value }))
              }
            />
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-models">
              可用模型 UUID
            </label>
            <select
              id="provider-credit-models"
              multiple
              className="mt-1 min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-body"
              value={splitList(form.eligible_model_ids)}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  eligible_model_ids: Array.from(event.target.selectedOptions)
                    .map((option) => option.value)
                    .join('\n'),
                }))
              }
            >
              {providerModels.length === 0 ? (
                <option value="" disabled>
                  {form.provider_key ? '该供应商暂无可用模型' : '请先选择供应商'}
                </option>
              ) : (
                providerModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.display_name || model.model_name}（{model.model_name}）
                  </option>
                ))
              )}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">不选择表示该供应商的全部模型。</p>
          </div>
          <div>
            <label className="text-body font-medium" htmlFor="provider-credit-membership">
              会员计划编码
            </label>
            <select
              id="provider-credit-membership"
              multiple
              className="mt-1 min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-body"
              value={splitList(form.membership_plan_codes)}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  membership_plan_codes: Array.from(event.target.selectedOptions)
                    .map((option) => option.value)
                    .join('\n'),
                }))
              }
            >
              {membershipTiers.length === 0 ? (
                <option value="" disabled>
                  暂无会员套餐
                </option>
              ) : (
                membershipTiers.map((tier) => (
                  <option key={tier.id} value={tier.tier_type}>
                    {tier.name}（{tier.tier_type}）
                  </option>
                ))
              )}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">仅会员触发活动需要选择套餐。</p>
          </div>
        </div>

        {form.start_at && form.end_at && new Date(form.start_at) >= new Date(form.end_at) ? (
          <p className="text-body text-destructive">结束时间必须晚于开始时间。</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => onSave(form)} disabled={saving || invalid}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            保存活动
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SimpleOperationDialog({
  open,
  title,
  description,
  saving,
  children,
  submitDisabled,
  submitLabel,
  onOpenChange,
  onSubmit,
  className,
}: {
  open: boolean
  title: string
  description: string
  saving: boolean
  children: React.ReactNode
  submitDisabled?: boolean
  submitLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: () => void
  className?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={saving || submitDisabled}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ProviderCreditManagement() {
  const { show: showToast, element: toastElement } = useSimpleToast()
  const [activeTab, setActiveTab] = useState<PageTab>('campaigns')
  const [campaigns, setCampaigns] = useState<ProviderCreditCampaign[]>([])
  const [campaignTotal, setCampaignTotal] = useState(0)
  const [campaignPage, setCampaignPage] = useState(1)
  const [campaignPageSize, setCampaignPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [campaignFilters, setCampaignFilters] = useState({ code: '', provider_key: '', status: '' })
  const [campaignLoading, setCampaignLoading] = useState(false)
  const [campaignDialogOpen, setCampaignDialogOpen] = useState(false)
  const [editCampaign, setEditCampaign] = useState<ProviderCreditCampaign | null>(null)
  const [campaignSaving, setCampaignSaving] = useState(false)
  const [report, setReport] = useState<ProviderCreditCampaignReport | null>(null)
  const [reportCampaign, setReportCampaign] = useState<ProviderCreditCampaign | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [providerOptions, setProviderOptions] = useState<ProviderItem[]>([])
  const [modelOptions, setModelOptions] = useState<LlmAdminModel[]>([])
  const [membershipTierOptions, setMembershipTierOptions] = useState<MembershipTier[]>([])
  const [organizationOptions, setOrganizationOptions] = useState<OrganizationSummary[]>([])

  const [grants, setGrants] = useState<ProviderCreditGrant[]>([])
  const [grantTotal, setGrantTotal] = useState(0)
  const [grantPage, setGrantPage] = useState(1)
  const [grantPageSize, setGrantPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [grantFilters, setGrantFilters] = useState({
    organization_id: '',
    provider_key: '',
    campaign_code: '',
    status: '',
  })
  const [grantLoading, setGrantLoading] = useState(false)
  const [grantDialogOpen, setGrantDialogOpen] = useState(false)
  const [grantForm, setGrantForm] = useState({
    organization_ids: [] as string[],
    campaign_code: '',
    reason: '',
  })
  const [organizationSearch, setOrganizationSearch] = useState('')
  const [adjustTarget, setAdjustTarget] = useState<ProviderCreditGrant | null>(null)
  const [adjustForm, setAdjustForm] = useState({ amount: '', reason: '' })
  const [revokeTarget, setRevokeTarget] = useState<ProviderCreditGrant | null>(null)
  const [operationSaving, setOperationSaving] = useState(false)

  const [transactions, setTransactions] = useState<ProviderCreditTransaction[]>([])
  const [transactionTotal, setTransactionTotal] = useState(0)
  const [transactionPage, setTransactionPage] = useState(1)
  const [transactionPageSize, setTransactionPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [transactionFilters, setTransactionFilters] = useState({
    organization_id: '',
    grant_id: '',
    transaction_type: '',
    start_time: '',
    end_time: '',
  })
  const [transactionLoading, setTransactionLoading] = useState(false)

  const loadSequence = useRef({ campaigns: 0, grants: 0, transactions: 0 })

  useEffect(() => {
    void Promise.all([
      providersApi.list({ scope: 'global', includeInactive: false }),
      modelsApi.listModels({
        domain: 'chat',
        providerScope: 'global',
        includeInactive: false,
        limit: 500,
      }),
      listMembershipTiers(),
    ])
      .then(([providers, models, tiers]) => {
        setProviderOptions(providers.providers || [])
        setModelOptions(models.models || [])
        setMembershipTierOptions((tiers.tiers || []).filter((tier) => tier.is_active))
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '选项加载失败', 'error')
      })
  }, [showToast])

  useEffect(() => {
    void (async () => {
      try {
        const firstPage = await spaceAdminApi.listOrganizations({
          page: 1,
          pageSize: 100,
          sort: 'name',
        })
        const totalPages = firstPage.pagination?.total_pages ?? Math.ceil(firstPage.total / 100)
        const pages = await Promise.all(
          Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) =>
            spaceAdminApi.listOrganizations({ page: index + 2, pageSize: 100, sort: 'name' })
          )
        )
        setOrganizationOptions(
          [firstPage, ...pages]
            .flatMap((page) => page.organizations || [])
            .filter((org) => org.status !== 'deleting')
        )
      } catch (error) {
        showToast(error instanceof Error ? error.message : '组织列表加载失败', 'error')
      }
    })()
  }, [showToast])

  const loadCampaigns = useCallback(async () => {
    const sequence = ++loadSequence.current.campaigns
    setCampaignLoading(true)
    try {
      const response = await listProviderCreditCampaigns({
        ...campaignFilters,
        page: campaignPage,
        page_size: campaignPageSize,
      })
      if (sequence !== loadSequence.current.campaigns) return
      setCampaigns(response.items)
      setCampaignTotal(response.total)
    } catch (error) {
      if (sequence !== loadSequence.current.campaigns) return
      setCampaigns([])
      setCampaignTotal(0)
      showToast(error instanceof Error ? error.message : '活动列表加载失败', 'error')
    } finally {
      if (sequence === loadSequence.current.campaigns) setCampaignLoading(false)
    }
  }, [campaignFilters, campaignPage, campaignPageSize, showToast])

  const loadGrants = useCallback(async () => {
    const sequence = ++loadSequence.current.grants
    setGrantLoading(true)
    try {
      const response = await listProviderCreditGrants({
        ...grantFilters,
        page: grantPage,
        page_size: grantPageSize,
      })
      if (sequence !== loadSequence.current.grants) return
      setGrants(response.items)
      setGrantTotal(response.total)
    } catch (error) {
      if (sequence !== loadSequence.current.grants) return
      setGrants([])
      setGrantTotal(0)
      showToast(error instanceof Error ? error.message : 'Grant 列表加载失败', 'error')
    } finally {
      if (sequence === loadSequence.current.grants) setGrantLoading(false)
    }
  }, [grantFilters, grantPage, grantPageSize, showToast])

  const loadTransactions = useCallback(async () => {
    const sequence = ++loadSequence.current.transactions
    setTransactionLoading(true)
    try {
      const response = await listProviderCreditTransactions({
        ...transactionFilters,
        start_time: toIsoDateTime(transactionFilters.start_time),
        end_time: toIsoDateTime(transactionFilters.end_time),
        page: transactionPage,
        page_size: transactionPageSize,
      })
      if (sequence !== loadSequence.current.transactions) return
      setTransactions(response.items)
      setTransactionTotal(response.total)
    } catch (error) {
      if (sequence !== loadSequence.current.transactions) return
      setTransactions([])
      setTransactionTotal(0)
      showToast(error instanceof Error ? error.message : '流水列表加载失败', 'error')
    } finally {
      if (sequence === loadSequence.current.transactions) setTransactionLoading(false)
    }
  }, [showToast, transactionFilters, transactionPage, transactionPageSize])

  useEffect(() => {
    if (activeTab === 'campaigns') void loadCampaigns()
  }, [activeTab, loadCampaigns])

  useEffect(() => {
    if (activeTab === 'grants') void loadGrants()
  }, [activeTab, loadGrants])

  useEffect(() => {
    if (activeTab === 'transactions') void loadTransactions()
  }, [activeTab, loadTransactions])

  const activeCampaigns = useMemo(
    () => campaigns.filter((campaign) => campaign.enabled && campaign.status === 'active').length,
    [campaigns]
  )
  const currentRemaining = useMemo(
    () => grants.reduce((sum, grant) => sum + Number(grant.remaining_credits || 0), 0),
    [grants]
  )
  const currentConsumed = useMemo(
    () => grants.reduce((sum, grant) => sum + Number(grant.consumed_credits || 0), 0),
    [grants]
  )
  const issuedOrganizationIds = useMemo(
    () =>
      new Set(
        grants
          .filter((grant) => grant.campaign_code === grantForm.campaign_code)
          .map((grant) => grant.organization_id)
      ),
    [grants, grantForm.campaign_code]
  )
  const selectableOrganizationIds = useMemo(
    () =>
      organizationOptions
        .filter((organization) => !issuedOrganizationIds.has(organization.id))
        .map((organization) => organization.id),
    [issuedOrganizationIds, organizationOptions]
  )
  const visibleOrganizations = useMemo(() => {
    const keyword = organizationSearch.trim().toLowerCase()
    if (!keyword) return organizationOptions
    return organizationOptions.filter(
      (organization) =>
        organization.name.toLowerCase().includes(keyword) ||
        organization.id.toLowerCase().includes(keyword)
    )
  }, [organizationOptions, organizationSearch])

  const refreshActiveTab = () => {
    if (activeTab === 'campaigns') void loadCampaigns()
    if (activeTab === 'grants') void loadGrants()
    if (activeTab === 'transactions') void loadTransactions()
  }

  const copyId = async (value: string, label = 'ID') => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      showToast(`已复制${label}`, 'success')
    } catch {
      showToast(`复制${label}失败`, 'error')
    }
  }

  const resolveOrganizationName = (organizationId: string, fallbackName?: string) => {
    const fromApi = fallbackName?.trim()
    if (fromApi) return fromApi
    return (
      organizationOptions.find((organization) => organization.id === organizationId)?.name ||
      '未命名组织'
    )
  }

  const saveCampaign = async (form: CampaignForm) => {
    setCampaignSaving(true)
    try {
      const payload = campaignFormToPayload(form)
      if (editCampaign) {
        await updateProviderCreditCampaign(editCampaign.code, payload)
      } else {
        await createProviderCreditCampaign(payload)
      }
      setCampaignDialogOpen(false)
      setEditCampaign(null)
      showToast(editCampaign ? '活动已更新' : '活动已创建')
      await loadCampaigns()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '活动保存失败', 'error')
    } finally {
      setCampaignSaving(false)
    }
  }

  const toggleCampaign = async (campaign: ProviderCreditCampaign, enabled: boolean) => {
    try {
      await updateProviderCreditCampaign(campaign.code, { enabled })
      showToast(enabled ? '活动已启用' : '活动已停用')
      await loadCampaigns()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '活动状态更新失败', 'error')
    }
  }

  const openReport = async (campaign: ProviderCreditCampaign) => {
    setReportCampaign(campaign)
    setReport(null)
    setReportLoading(true)
    try {
      setReport(await getProviderCreditCampaignReport(campaign.code))
    } catch (error) {
      showToast(error instanceof Error ? error.message : '活动报表加载失败', 'error')
    } finally {
      setReportLoading(false)
    }
  }

  const submitGrant = async () => {
    setOperationSaving(true)
    try {
      const results = await Promise.allSettled(
        grantForm.organization_ids.map((organization_id) =>
          grantProviderCredit({
            organization_id,
            campaign_code: grantForm.campaign_code.trim(),
            reason: grantForm.reason.trim(),
          })
        )
      )
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length === results.length) throw new Error('所有组织发放均失败')
      setGrantDialogOpen(false)
      setGrantForm({ organization_ids: [], campaign_code: '', reason: '' })
      showToast(
        failed.length
          ? `已发放 ${results.length - failed.length} 个组织，${failed.length} 个失败`
          : `已向 ${results.length} 个组织发放额度`
      )
      await loadGrants()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '额度发放失败', 'error')
    } finally {
      setOperationSaving(false)
    }
  }

  const submitAdjustment = async () => {
    if (!adjustTarget) return
    setOperationSaving(true)
    try {
      await adjustProviderCreditGrant(adjustTarget.id, {
        amount: adjustForm.amount.trim(),
        reason: adjustForm.reason.trim(),
      })
      setAdjustTarget(null)
      setAdjustForm({ amount: '', reason: '' })
      showToast('Grant 余额已调整，并已生成流水')
      await loadGrants()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '余额调整失败', 'error')
    } finally {
      setOperationSaving(false)
    }
  }

  const submitRevoke = async ({ reason, ticket_id }: { reason: string; ticket_id: string }) => {
    if (!revokeTarget) return
    setOperationSaving(true)
    try {
      const auditReason = ticket_id.trim()
        ? `${reason.trim()}（工单：${ticket_id.trim()}）`
        : reason
      await revokeProviderCreditGrant(revokeTarget.id, { reason: auditReason })
      setRevokeTarget(null)
      showToast('Grant 已撤销，剩余额度已通过流水冲销')
      await loadGrants()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Grant 撤销失败', 'error')
    } finally {
      setOperationSaving(false)
    }
  }

  return (
    <AdminPage>
      {toastElement}
      <AdminPageHeader
        title="供应商赠送额度"
        description="管理供应商活动、组织额度和流水。"
        icon={Gift}
        badges={
          <>
            <Badge variant="outline">按供应商和模型 UUID 匹配</Badge>
            <Badge variant="success">额度不进入钱包</Badge>
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={refreshActiveTab}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="活动总数"
          value={campaignTotal.toLocaleString()}
          hint="当前筛选条件下的活动数量。"
          icon={Gift}
        />
        <AdminMetricCard
          title="当前页有效活动"
          value={activeCampaigns.toLocaleString()}
          hint="启用且处于有效状态的活动。"
          tone={activeCampaigns > 0 ? 'success' : 'default'}
          icon={Activity}
        />
        <AdminMetricCard
          title="当前页额度余额"
          value={formatCredits(currentRemaining)}
          hint="当前结果的剩余额度合计。"
          icon={WalletCards}
        />
        <AdminMetricCard
          title="当前页已消费"
          value={formatCredits(currentConsumed)}
          hint="当前结果的累计消费额度。"
          icon={BarChart3}
        />
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PageTab)}>
        <TabsList>
          <TabsTrigger value="campaigns">活动管理</TabsTrigger>
          <TabsTrigger value="grants">组织额度</TabsTrigger>
          <TabsTrigger value="transactions">额度流水</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="space-y-4">
          <AdminListCard
            title="供应商活动"
            description="定义供应商、模型范围、额度和活动周期。"
            actions={
              <PermissionGate permissions={OPERATE_PERMISSIONS}>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditCampaign(null)
                    setCampaignDialogOpen(true)
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  创建活动
                </Button>
              </PermissionGate>
            }
            contentClassName="space-y-4 px-0"
          >
            <div className="grid gap-3 px-6 md:grid-cols-3">
              <Input
                aria-label="活动名称或编码筛选"
                placeholder="活动名称 / 活动编码"
                value={campaignFilters.code}
                onChange={(event) => {
                  setCampaignPage(1)
                  setCampaignFilters((current) => ({ ...current, code: event.target.value }))
                }}
              />
              <Input
                aria-label="供应商标识筛选"
                placeholder="供应商标识"
                value={campaignFilters.provider_key}
                onChange={(event) => {
                  setCampaignPage(1)
                  setCampaignFilters((current) => ({
                    ...current,
                    provider_key: event.target.value,
                  }))
                }}
              />
              <select
                aria-label="活动状态筛选"
                className="h-9 rounded-md border border-input bg-background px-3 text-body"
                value={campaignFilters.status}
                onChange={(event) => {
                  setCampaignPage(1)
                  setCampaignFilters((current) => ({ ...current, status: event.target.value }))
                }}
              >
                <option value="">全部状态</option>
                <option value="draft">草稿</option>
                <option value="active">有效</option>
                <option value="paused">暂停</option>
                <option value="ended">结束</option>
              </select>
            </div>

            {campaigns.length === 0 ? (
              <EmptyTable loading={campaignLoading} text="暂无供应商赠送活动" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body" aria-label="供应商赠送活动列表">
                  <thead className="border-y bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">活动</th>
                      <th className="px-4 py-3 text-left font-medium">供应商 / 模型</th>
                      <th className="px-4 py-3 text-right font-medium">单次 / 总预算</th>
                      <th className="px-4 py-3 text-left font-medium">周期</th>
                      <th className="px-4 py-3 text-center font-medium">状态</th>
                      <th className="px-4 py-3 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {campaigns.map((campaign) => (
                      <tr key={campaign.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <div className="font-medium">{campaign.name}</div>
                          <div className="mt-1 font-mono text-xs text-muted-foreground">
                            {campaign.code}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-mono">{campaign.provider_key}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {campaign.eligible_model_ids.length
                              ? `${campaign.eligible_model_ids.length} 个模型 UUID`
                              : '供应商全部模型'}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <div>{formatCredits(campaign.grant_credits)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            / {formatCredits(campaign.total_budget_credits)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div>{campaign.expire_days} 天有效</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {compactDate(campaign.start_at)} — {compactDate(campaign.end_at)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <div className="flex flex-col items-center gap-2">
                            {statusBadge(campaign.status)}
                            <Badge variant={campaign.enabled ? 'success' : 'outline'}>
                              {campaign.enabled ? '已启用' : '已停用'}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void openReport(campaign)}
                            >
                              <BarChart3 className="mr-1.5 h-4 w-4" />
                              报表
                            </Button>
                            <PermissionGate permission={ADMIN_PERMISSION.PROVIDER_CREDIT_ADMIN}>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setEditCampaign(campaign)
                                  setCampaignDialogOpen(true)
                                }}
                              >
                                <Pencil className="mr-1.5 h-4 w-4" />
                                编辑
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void toggleCampaign(campaign, !campaign.enabled)}
                              >
                                {campaign.enabled ? '停用' : '启用'}
                              </Button>
                            </PermissionGate>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="px-6">
              <Pagination
                page={campaignPage}
                total={campaignTotal}
                pageSize={campaignPageSize}
                onChange={setCampaignPage}
                onPageSizeChange={(value) => {
                  setCampaignPage(1)
                  setCampaignPageSize(value)
                }}
              />
            </div>
          </AdminListCard>
        </TabsContent>

        <TabsContent value="grants" className="space-y-4">
          <AdminListCard
            title="组织额度"
            description="查询组织额度，执行补发、扣减或撤销。"
            actions={
              <PermissionGate permissions={OPERATE_PERMISSIONS}>
                <Button size="sm" onClick={() => setGrantDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  手动发放
                </Button>
              </PermissionGate>
            }
            contentClassName="space-y-4 px-0"
          >
            <div className="grid gap-3 px-6 md:grid-cols-5">
              <Input
                aria-label="组织 ID 筛选"
                placeholder="组织 UUID"
                value={grantFilters.organization_id}
                onChange={(event) => {
                  setGrantPage(1)
                  setGrantFilters((current) => ({
                    ...current,
                    organization_id: event.target.value,
                  }))
                }}
              />
              <Input
                aria-label="额度供应商筛选"
                placeholder="供应商标识"
                value={grantFilters.provider_key}
                onChange={(event) => {
                  setGrantPage(1)
                  setGrantFilters((current) => ({
                    ...current,
                    provider_key: event.target.value,
                  }))
                }}
              />
              <Input
                aria-label="额度活动编码筛选"
                placeholder="活动编码"
                value={grantFilters.campaign_code}
                onChange={(event) => {
                  setGrantPage(1)
                  setGrantFilters((current) => ({
                    ...current,
                    campaign_code: event.target.value,
                  }))
                }}
              />
              <select
                aria-label="额度状态筛选"
                className="h-9 rounded-md border border-input bg-background px-3 text-body"
                value={grantFilters.status}
                onChange={(event) => {
                  setGrantPage(1)
                  setGrantFilters((current) => ({ ...current, status: event.target.value }))
                }}
              >
                <option value="">全部状态</option>
                <option value="active">有效</option>
                <option value="exhausted">已用尽</option>
                <option value="expired">已过期</option>
                <option value="revoked">已撤销</option>
              </select>
              <Button variant="outline" onClick={() => void loadGrants()}>
                <Search className="mr-2 h-4 w-4" />
                查询
              </Button>
            </div>

            {grants.length === 0 ? (
              <EmptyTable loading={grantLoading} text="暂无组织额度" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body" aria-label="供应商赠送额度列表">
                  <thead className="border-y bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">组织</th>
                      <th className="px-4 py-3 text-left font-medium">活动 / 供应商</th>
                      <th className="px-4 py-3 text-right font-medium">总额</th>
                      <th className="px-4 py-3 text-right font-medium">已用 / 剩余</th>
                      <th className="px-4 py-3 text-left font-medium">到期</th>
                      <th className="px-4 py-3 text-center font-medium">状态</th>
                      <th className="px-4 py-3 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {grants.map((grant) => (
                      <tr key={grant.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {grant.organization.name || '未命名组织'}
                          </div>
                          <div
                            className="mt-1 font-mono text-xs text-muted-foreground"
                            title={grant.organization_id}
                          >
                            {shortId(grant.organization_id)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{grant.campaign.name}</div>
                          <div className="mt-1 font-mono text-xs text-muted-foreground">
                            {grant.campaign_code} · {grant.provider_key}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCredits(grant.total_credits)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <div>{formatCredits(grant.consumed_credits)}</div>
                          <div className="mt-1 font-medium text-primary">
                            {formatCredits(grant.remaining_credits)}
                          </div>
                        </td>
                        <td className="px-4 py-3">{compactDate(grant.expire_at)}</td>
                        <td className="px-4 py-3 text-center">{statusBadge(grant.status)}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <PermissionGate permissions={OPERATE_PERMISSIONS}>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={grant.status !== 'active'}
                                onClick={() => {
                                  setAdjustTarget(grant)
                                  setAdjustForm({ amount: '', reason: '' })
                                }}
                              >
                                <RotateCcw className="mr-1.5 h-4 w-4" />
                                调整
                              </Button>
                            </PermissionGate>
                            <PermissionGate permission={ADMIN_PERMISSION.PROVIDER_CREDIT_ADMIN}>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={grant.status !== 'active'}
                                onClick={() => setRevokeTarget(grant)}
                              >
                                <ShieldX className="mr-1.5 h-4 w-4" />
                                撤销
                              </Button>
                            </PermissionGate>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="px-6">
              <Pagination
                page={grantPage}
                total={grantTotal}
                pageSize={grantPageSize}
                onChange={setGrantPage}
                onPageSizeChange={(value) => {
                  setGrantPage(1)
                  setGrantPageSize(value)
                }}
              />
            </div>
          </AdminListCard>
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <AdminListCard
            title="额度流水"
            description="记录发放、消费、退款、到期和人工调整。"
            contentClassName="space-y-4 px-0"
          >
            <div className="grid gap-3 px-6 md:grid-cols-3 xl:grid-cols-6">
              <Input
                aria-label="流水组织 ID"
                placeholder="组织 UUID"
                value={transactionFilters.organization_id}
                onChange={(event) => {
                  setTransactionPage(1)
                  setTransactionFilters((current) => ({
                    ...current,
                    organization_id: event.target.value,
                  }))
                }}
              />
              <Input
                aria-label="流水额度 ID"
                placeholder="额度 UUID"
                value={transactionFilters.grant_id}
                onChange={(event) => {
                  setTransactionPage(1)
                  setTransactionFilters((current) => ({ ...current, grant_id: event.target.value }))
                }}
              />
              <select
                aria-label="流水类型"
                className="h-9 rounded-md border border-input bg-background px-3 text-body"
                value={transactionFilters.transaction_type}
                onChange={(event) => {
                  setTransactionPage(1)
                  setTransactionFilters((current) => ({
                    ...current,
                    transaction_type: event.target.value,
                  }))
                }}
              >
                <option value="">全部类型</option>
                <option value="grant">发放</option>
                <option value="consume">消费</option>
                <option value="refund">退款</option>
                <option value="expire">过期</option>
                <option value="adjust">调整</option>
              </select>
              <Input
                aria-label="流水开始时间"
                type="datetime-local"
                value={transactionFilters.start_time}
                onChange={(event) => {
                  setTransactionPage(1)
                  setTransactionFilters((current) => ({
                    ...current,
                    start_time: event.target.value,
                  }))
                }}
              />
              <Input
                aria-label="流水结束时间"
                type="datetime-local"
                value={transactionFilters.end_time}
                onChange={(event) => {
                  setTransactionPage(1)
                  setTransactionFilters((current) => ({
                    ...current,
                    end_time: event.target.value,
                  }))
                }}
              />
              <Button variant="outline" onClick={() => void loadTransactions()}>
                <Search className="mr-2 h-4 w-4" />
                查询
              </Button>
            </div>

            {transactions.length === 0 ? (
              <EmptyTable loading={transactionLoading} text="暂无额度流水" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body" aria-label="供应商赠送额度流水列表">
                  <thead className="border-y bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">时间</th>
                      <th className="px-4 py-3 text-left font-medium">活动 / 供应商</th>
                      <th className="px-4 py-3 text-left font-medium">组织 / 额度批次</th>
                      <th className="px-4 py-3 text-center font-medium">类型</th>
                      <th className="px-4 py-3 text-right font-medium">变化</th>
                      <th className="px-4 py-3 text-right font-medium">变化后余额</th>
                      <th className="px-4 py-3 text-left font-medium">业务引用</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {transactions.map((transaction) => {
                      const organizationName = resolveOrganizationName(
                        transaction.organization_id,
                        transaction.organization?.name
                      )
                      const campaignName =
                        transaction.grant.campaign_name?.trim() ||
                        transaction.grant.campaign_code ||
                        '额度批次'
                      return (
                      <tr key={transaction.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 whitespace-nowrap">
                          {compactDate(transaction.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {transaction.grant.campaign_name?.trim() ||
                              transaction.grant.campaign_code}
                          </div>
                          <div className="mt-1 font-mono text-xs text-muted-foreground">
                            {transaction.grant.campaign_code} · {transaction.grant.provider_key}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{organizationName}</div>
                          <button
                            type="button"
                            className="mt-1 inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-muted-foreground hover:text-primary"
                            title={`点击复制组织 ID：${transaction.organization_id}`}
                            onClick={() => void copyId(transaction.organization_id, '组织 ID')}
                          >
                            <span>{transaction.organization_id}</span>
                            <Copy className="h-3 w-3 shrink-0" />
                          </button>
                          <div className="mt-2 text-caption text-muted-foreground">
                            额度批次 · {campaignName}
                          </div>
                          <button
                            type="button"
                            className="mt-1 inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-muted-foreground hover:text-primary"
                            title={`点击复制额度批次 ID：${transaction.grant_id}`}
                            onClick={() => void copyId(transaction.grant_id, '额度批次 ID')}
                          >
                            <span>{transaction.grant_id}</span>
                            <Copy className="h-3 w-3 shrink-0" />
                          </button>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Badge
                            variant={
                              transaction.transaction_type === 'consume' ? 'warning' : 'outline'
                            }
                          >
                            {transactionTypeLabel(transaction.transaction_type)}
                          </Badge>
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-medium tabular-nums ${
                            Number(transaction.amount) < 0 ? 'text-destructive' : 'text-success'
                          }`}
                        >
                          {Number(transaction.amount) > 0 ? '+' : ''}
                          {formatCredits(transaction.amount)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCredits(transaction.balance_after)}
                        </td>
                        <td className="px-4 py-3">
                          <div>{referenceTypeLabel(transaction.reference_type)}</div>
                          {transaction.reference_id ? (
                            <button
                              type="button"
                              className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary"
                              title={`点击复制引用 ID：${transaction.reference_id}`}
                              onClick={() => void copyId(transaction.reference_id, '引用 ID')}
                            >
                              <span className="truncate">{transaction.reference_id}</span>
                              <Copy className="h-3 w-3 shrink-0" />
                            </button>
                          ) : (
                            <div className="mt-1 text-xs text-muted-foreground">-</div>
                          )}
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="px-6">
              <Pagination
                page={transactionPage}
                total={transactionTotal}
                pageSize={transactionPageSize}
                onChange={setTransactionPage}
                onPageSizeChange={(value) => {
                  setTransactionPage(1)
                  setTransactionPageSize(value)
                }}
              />
            </div>
          </AdminListCard>
        </TabsContent>
      </Tabs>

      <CampaignDialog
        open={campaignDialogOpen}
        campaign={editCampaign}
        saving={campaignSaving}
        providers={providerOptions}
        models={modelOptions}
        membershipTiers={membershipTierOptions}
        onOpenChange={(open) => {
          setCampaignDialogOpen(open)
          if (!open) setEditCampaign(null)
        }}
        onSave={(form) => void saveCampaign(form)}
      />

      <SimpleOperationDialog
        open={grantDialogOpen}
        title="手动发放供应商赠送额度"
        description="按活动规则生成独立额度，不会充值到组织钱包。"
        className="max-w-3xl"
        saving={operationSaving}
        submitLabel="确认发放"
        submitDisabled={
          grantForm.organization_ids.length === 0 ||
          !grantForm.campaign_code.trim() ||
          !grantForm.reason.trim()
        }
        onOpenChange={setGrantDialogOpen}
        onSubmit={() => void submitGrant()}
      >
        <div>
          <div className="flex items-center justify-between">
            <label className="text-body font-medium" htmlFor="provider-credit-grant-org">
              选择组织
            </label>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <button
                type="button"
                className="text-primary hover:underline"
                disabled={selectableOrganizationIds.length === 0}
                onClick={() =>
                  setGrantForm((current) => ({
                    ...current,
                    organization_ids:
                      current.organization_ids.length === selectableOrganizationIds.length
                        ? []
                        : selectableOrganizationIds,
                  }))
                }
              >
                {grantForm.organization_ids.length === selectableOrganizationIds.length
                  ? '取消全选'
                  : '全选'}
              </button>
              <span>已选 {grantForm.organization_ids.length} 个</span>
            </div>
          </div>
          <div
            id="provider-credit-grant-org"
            className="mt-1 max-h-56 space-y-1 overflow-y-auto rounded-md border p-2"
          >
            <Input
              aria-label="搜索组织"
              placeholder="搜索组织名称或 UUID"
              value={organizationSearch}
              onChange={(event) => setOrganizationSearch(event.target.value)}
              className="mb-2"
            />
            {visibleOrganizations.map((organization) => {
              const issued = issuedOrganizationIds.has(organization.id)
              const selected = grantForm.organization_ids.includes(organization.id)
              return (
                <label
                  key={organization.id}
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-body ${issued ? 'cursor-not-allowed bg-muted/50 text-muted-foreground' : 'cursor-pointer hover:bg-muted/50'}`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={issued}
                    onChange={(event) =>
                      setGrantForm((current) => ({
                        ...current,
                        organization_ids: event.target.checked
                          ? [...current.organization_ids, organization.id]
                          : current.organization_ids.filter((id) => id !== organization.id),
                      }))
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {organization.name || '未命名组织'}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {shortId(organization.id)}
                    </span>
                  </span>
                  {issued ? <span className="text-xs">已发放</span> : null}
                </label>
              )
            })}
          </div>
        </div>
        <div>
          <label className="text-body font-medium" htmlFor="provider-credit-grant-campaign">
            选择活动
          </label>
          <select
            id="provider-credit-grant-campaign"
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-body"
            value={grantForm.campaign_code}
            onChange={(event) =>
              setGrantForm((current) => ({
                ...current,
                campaign_code: event.target.value,
                organization_ids: [],
              }))
            }
          >
            <option value="">请选择活动</option>
            {campaigns
              .filter((campaign) => campaign.enabled && campaign.status === 'active')
              .map((campaign) => (
                <option key={campaign.code} value={campaign.code}>
                  {campaign.name}（{campaign.code}）
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="text-body font-medium" htmlFor="provider-credit-grant-reason">
            发放原因
          </label>
          <Textarea
            id="provider-credit-grant-reason"
            className="mt-1"
            value={grantForm.reason}
            onChange={(event) =>
              setGrantForm((current) => ({ ...current, reason: event.target.value }))
            }
          />
        </div>
      </SimpleOperationDialog>

      <SimpleOperationDialog
        open={Boolean(adjustTarget)}
        title="调整额度"
        description="正数补发、负数扣减；服务端会生成调整流水。"
        saving={operationSaving}
        submitLabel="确认调整"
        submitDisabled={
          !adjustForm.reason.trim() || !adjustForm.amount.trim() || Number(adjustForm.amount) === 0
        }
        onOpenChange={(open) => {
          if (!open) setAdjustTarget(null)
        }}
        onSubmit={() => void submitAdjustment()}
      >
        {adjustTarget ? (
          <div className="rounded-md border bg-muted/30 p-3 text-body">
            <div>{adjustTarget.campaign.name}</div>
            <div className="mt-1 text-muted-foreground">
              当前剩余 {formatCredits(adjustTarget.remaining_credits)}
            </div>
          </div>
        ) : null}
        <div>
          <label className="text-body font-medium" htmlFor="provider-credit-adjust-amount">
            调整数量
          </label>
          <Input
            id="provider-credit-adjust-amount"
            className="mt-1"
            type="number"
            value={adjustForm.amount}
            placeholder="例如 5000 或 -500"
            onChange={(event) =>
              setAdjustForm((current) => ({ ...current, amount: event.target.value }))
            }
          />
        </div>
        <div>
          <label className="text-body font-medium" htmlFor="provider-credit-adjust-reason">
            调整原因
          </label>
          <Textarea
            id="provider-credit-adjust-reason"
            className="mt-1"
            value={adjustForm.reason}
            onChange={(event) =>
              setAdjustForm((current) => ({ ...current, reason: event.target.value }))
            }
          />
        </div>
      </SimpleOperationDialog>

      <SensitiveActionConfirmDialog
        open={Boolean(revokeTarget)}
        title="撤销供应商赠送额度"
        targetLabel={
          revokeTarget
            ? `${revokeTarget.organization.name || revokeTarget.organization_id} / ${revokeTarget.campaign_code}`
            : '-'
        }
        impact="额度不会被删除；剩余额度会通过负数调整流水冲销，并保留审计记录。"
        confirmText={revokeTarget?.campaign_code}
        confirmButtonLabel="确认撤销"
        loading={operationSaving}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={(payload) => void submitRevoke(payload)}
      />

      <Dialog
        open={Boolean(reportCampaign)}
        onOpenChange={(open) => {
          if (!open) {
            setReportCampaign(null)
            setReport(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{reportCampaign?.name || '活动'} · 消耗报表</DialogTitle>
            <DialogDescription>
              供应商 {reportCampaign?.provider_key} 的预算和消费表现。
            </DialogDescription>
          </DialogHeader>
          {reportLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : report ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['累计发放', report.granted],
                ['累计消费', report.consumed],
                ['当前剩余', report.remaining],
                ['已过期', report.expired],
                ['覆盖组织', report.organizations],
                ['消费次数', report.usage_count],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md border bg-muted/20 p-4">
                  <div className="text-body text-muted-foreground">{label}</div>
                  <div className="mt-2 text-xl font-semibold tabular-nums">
                    {formatCredits(value)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-10 text-center text-body text-muted-foreground">报表暂不可用</p>
          )}
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

export const PROVIDER_CREDIT_VIEW_PERMISSIONS = VIEW_PERMISSIONS
