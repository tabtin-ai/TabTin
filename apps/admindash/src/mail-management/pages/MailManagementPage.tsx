import {
  AdminListCard,
  AdminOperationFeedCard,
  AdminPage,
  AdminPageHeader,
} from '@/components/admin-page'
import { EntityLink } from '@/components/admin/EntityLink'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import {
  batchSyncAdminMailAccounts,
  batchUpdateAdminMailAccountStatus,
  getAdminMailAccountDetail,
  getAdminMailAccounts,
  getAdminMailOperations,
  syncAdminMailAccount,
  updateAdminMailAccountStatus,
} from '@/mail-management/api/mail-management'
import type {
  AdminMailBatchActionResponse,
  AdminMailDetailResponse,
  AdminMailListResponse,
  AdminMailOperationsResponse,
  MailActiveFilter,
  MailAttentionFilter,
  MailProviderFilter,
  MailSyncStatusFilter,
} from '@/mail-management/types'
import {
  Copy,
  Loader2,
  Mail,
  MessageSquareText,
  MoreHorizontal,
  Power,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

const providerOptions: Array<{ value: MailProviderFilter; label: string }> = [
  { value: 'all', label: '全部提供商' },
  { value: 'smtp', label: 'SMTP / IMAP' },
  { value: 'gmail_api', label: 'Gmail API' },
  { value: 'ses', label: 'AWS SES' },
]

const syncStatusOptions: Array<{ value: MailSyncStatusFilter; label: string }> = [
  { value: 'all', label: '全部同步状态' },
  { value: 'idle', label: '空闲' },
  { value: 'syncing', label: '同步中' },
  { value: 'synced', label: '已同步' },
  { value: 'error', label: '异常' },
]

const activeOptions: Array<{ value: MailActiveFilter; label: string }> = [
  { value: 'all', label: '全部启用状态' },
  { value: 'true', label: '仅启用' },
  { value: 'false', label: '仅停用' },
]

const attentionOptions: Array<{ value: MailAttentionFilter; label: string }> = [
  { value: 'all', label: '全部风险' },
  { value: 'error', label: '异常账户' },
  { value: 'unread', label: '有未读消息' },
  { value: 'pending_draft', label: '有待审批草稿' },
  { value: 'syncing', label: '同步中' },
]

const operationActionLabels: Record<string, string> = {
  batch_sync: '批量同步',
  batch_status_update: '批量状态更新',
  single_sync: '单账户同步',
  single_status_update: '单账户状态更新',
}

type PendingMailSensitiveAction =
  | { type: 'single_sync'; accountId: string; accountName: string }
  | { type: 'single_status'; accountId: string; accountName: string; nextActive: boolean }
  | { type: 'batch_sync'; accountIds: string[] }
  | { type: 'batch_status'; accountIds: string[]; nextActive: boolean }

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function compactId(value?: string | null, start = 8, end = 4): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function CompactMetric({
  label,
  value,
  icon: Icon,
  onClick,
}: {
  label: string
  value: number | string | undefined
  icon: ComponentType<{ className?: string }>
  onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg border bg-background px-4 py-3 text-left"
    >
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value ?? 0}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </Comp>
  )
}

function EmptyNote({ children = '暂无记录' }: { children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[320px] break-words text-right">{value || '—'}</span>
    </div>
  )
}

function getSyncStatusBadge(status: string) {
  switch (status) {
    case 'error':
      return <Badge variant="destructive">异常</Badge>
    case 'syncing':
      return <Badge variant="warning">同步中</Badge>
    case 'synced':
      return <Badge variant="secondary">已同步</Badge>
    default:
      return <Badge variant="outline">空闲</Badge>
  }
}

function parseMailProvider(value: string | null): MailProviderFilter {
  return providerOptions.some((option) => option.value === value)
    ? (value as MailProviderFilter)
    : 'all'
}

function parseMailSyncStatus(value: string | null): MailSyncStatusFilter {
  return syncStatusOptions.some((option) => option.value === value)
    ? (value as MailSyncStatusFilter)
    : 'all'
}

function parseMailActive(value: string | null): MailActiveFilter {
  return activeOptions.some((option) => option.value === value)
    ? (value as MailActiveFilter)
    : 'all'
}

function parseMailAttention(value: string | null): MailAttentionFilter {
  return attentionOptions.some((option) => option.value === value)
    ? (value as MailAttentionFilter)
    : 'all'
}

function buildMailOperationsHref(
  params: { operationId?: string; success?: 'failed' | 'success' } = {}
) {
  const search = new URLSearchParams()
  if (params.operationId) {
    search.set('operation_id', params.operationId)
  }
  if (params.success) {
    search.set('success', params.success)
  }
  const query = search.toString()
  return query ? `/mail/operations?${query}` : '/mail/operations'
}

export function MailManagementPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialKeyword = searchParams.get('keyword') || ''
  const initialOrganizationQuery =
    searchParams.get('organization_query') || searchParams.get('organization_id') || ''
  const initialSpaceQuery = searchParams.get('space_query') || searchParams.get('space_id') || ''
  const initialProvider = parseMailProvider(searchParams.get('provider'))
  const initialSyncStatus = parseMailSyncStatus(searchParams.get('sync_status'))
  const initialIsActive = parseMailActive(searchParams.get('is_active'))
  const initialAttention = parseMailAttention(searchParams.get('attention'))
  const initialPage = Math.max(1, Number(searchParams.get('page')) || 1)

  const [keywordInput, setKeywordInput] = useState(initialKeyword)
  const [organizationQueryInput, setOrganizationQueryInput] = useState(initialOrganizationQuery)
  const [spaceQueryInput, setSpaceQueryInput] = useState(initialSpaceQuery)

  const [keyword, setKeyword] = useState(initialKeyword)
  const [organizationQuery, setOrganizationQuery] = useState(initialOrganizationQuery)
  const [spaceQuery, setSpaceQuery] = useState(initialSpaceQuery)
  const [provider, setProvider] = useState<MailProviderFilter>(initialProvider)
  const [syncStatus, setSyncStatus] = useState<MailSyncStatusFilter>(initialSyncStatus)
  const [isActive, setIsActive] = useState<MailActiveFilter>(initialIsActive)
  const [attention, setAttention] = useState<MailAttentionFilter>(initialAttention)
  const [page, setPage] = useState(initialPage)
  const [pageSize, setPageSize] = useState(20)

  const [listData, setListData] = useState<AdminMailListResponse | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([])
  const [detail, setDetail] = useState<AdminMailDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [actionLoading, setActionLoading] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastBatchResult, setLastBatchResult] = useState<AdminMailBatchActionResponse | null>(null)
  const [pendingSensitiveAction, setPendingSensitiveAction] =
    useState<PendingMailSensitiveAction | null>(null)

  const [operationsData, setOperationsData] = useState<AdminMailOperationsResponse | null>(null)
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [operationsError, setOperationsError] = useState<string | null>(null)

  const loadAccounts = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const response = await getAdminMailAccounts({
        keyword: keyword || undefined,
        provider,
        sync_status: syncStatus,
        is_active: isActive,
        attention,
        organization_query: organizationQuery || undefined,
        space_query: spaceQuery || undefined,
        page,
        page_size: pageSize,
      })
      setListData(response)
    } catch (loadError: unknown) {
      setListError(getErrorMessage(loadError, '加载邮箱账户失败'))
    } finally {
      setListLoading(false)
    }
  }, [
    spaceQuery,
    attention,
    isActive,
    keyword,
    page,
    pageSize,
    provider,
    syncStatus,
    organizationQuery,
  ])

  const loadDetail = useCallback(async (accountId: string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await getAdminMailAccountDetail(accountId)
      setDetail(response)
    } catch (loadError: unknown) {
      setDetailError(getErrorMessage(loadError, '加载邮箱详情失败'))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const loadOperations = useCallback(async () => {
    setOperationsLoading(true)
    setOperationsError(null)
    try {
      const response = await getAdminMailOperations({ page: 1, page_size: 6 })
      setOperationsData(response)
    } catch (loadError: unknown) {
      setOperationsError(getErrorMessage(loadError, '加载治理日志失败'))
    } finally {
      setOperationsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    void loadOperations()
  }, [loadOperations])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (keyword) params.keyword = keyword
    if (organizationQuery) params.organization_query = organizationQuery
    if (spaceQuery) params.space_query = spaceQuery
    if (provider !== 'all') params.provider = provider
    if (syncStatus !== 'all') params.sync_status = syncStatus
    if (isActive !== 'all') params.is_active = isActive
    if (attention !== 'all') params.attention = attention
    if (page > 1) params.page = String(page)
    setSearchParams(params, { replace: true })
  }, [
    spaceQuery,
    attention,
    isActive,
    keyword,
    page,
    provider,
    setSearchParams,
    syncStatus,
    organizationQuery,
  ])

  useEffect(() => {
    const items = listData?.items ?? []
    if (!items.length) {
      setSelectedAccountId(null)
      setSelectedAccountIds([])
      setDetail(null)
      return
    }
    if (selectedAccountId && !items.some((item) => item.id === selectedAccountId)) {
      setSelectedAccountId(null)
      setDetail(null)
      setDetailDrawerOpen(false)
    }
    setSelectedAccountIds((previous) =>
      previous.filter((id) => items.some((item) => item.id === id))
    )
  }, [listData?.items, selectedAccountId])

  useEffect(() => {
    if (!selectedAccountId || !detailDrawerOpen) {
      setDetail(null)
      return
    }
    void loadDetail(selectedAccountId)
  }, [detailDrawerOpen, loadDetail, selectedAccountId])

  const selectedAccount = useMemo(
    () => listData?.items.find((item) => item.id === selectedAccountId) ?? null,
    [listData?.items, selectedAccountId]
  )

  const pagination = listData?.pagination
  const summary = listData?.summary
  const visibleAccountIds = useMemo(
    () => listData?.items.map((item) => item.id) ?? [],
    [listData?.items]
  )
  const allVisibleSelected =
    visibleAccountIds.length > 0 && visibleAccountIds.every((id) => selectedAccountIds.includes(id))
  const partiallySelected = selectedAccountIds.length > 0 && !allVisibleSelected

  const handleApplyFilters = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setOrganizationQuery(organizationQueryInput.trim())
    setSpaceQuery(spaceQueryInput.trim())
  }

  const handleReset = () => {
    setPage(1)
    setKeywordInput('')
    setOrganizationQueryInput('')
    setSpaceQueryInput('')
    setKeyword('')
    setOrganizationQuery('')
    setSpaceQuery('')
    setProvider('all')
    setSyncStatus('all')
    setIsActive('all')
    setAttention('all')
    setSelectedAccountIds([])
  }

  const handleRefresh = async (options?: { preserveFeedback?: boolean }) => {
    if (!options?.preserveFeedback) {
      setActionError(null)
      setActionMessage(null)
    }
    await Promise.all([loadAccounts(), loadOperations()])
    if (selectedAccountId && detailDrawerOpen) {
      await loadDetail(selectedAccountId)
    }
  }

  const openAccountDetail = (accountId: string) => {
    setSelectedAccountId(accountId)
    setDetailDrawerOpen(true)
  }

  const copyAccountId = async (accountId: string) => {
    try {
      await navigator.clipboard.writeText(accountId)
    } catch {
      setActionError('复制账户 ID 失败')
    }
  }

  const toggleAccountSelection = (accountId: string, checked: boolean) => {
    setSelectedAccountIds((previous) => {
      if (checked) {
        return previous.includes(accountId) ? previous : [...previous, accountId]
      }
      return previous.filter((id) => id !== accountId)
    })
  }

  const toggleAllVisible = (checked: boolean) => {
    setSelectedAccountIds((previous) => {
      if (checked) {
        return Array.from(new Set([...previous, ...visibleAccountIds]))
      }
      return previous.filter((id) => !visibleAccountIds.includes(id))
    })
  }

  const handleSync = () => {
    if (!selectedAccountId) return
    const account = detail?.account
    setPendingSensitiveAction({
      type: 'single_sync',
      accountId: selectedAccountId,
      accountName: account?.display_name || account?.email_address || selectedAccountId,
    })
  }

  const executeSingleSync = async (
    accountId: string,
    payload: { reason: string; ticket_id: string }
  ) => {
    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const result = await syncAdminMailAccount(accountId, payload)
      setActionMessage(result.message)
      await handleRefresh({ preserveFeedback: true })
    } catch (actionErr: unknown) {
      setActionError(getErrorMessage(actionErr, '触发同步失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleToggleActive = async () => {
    if (!detail) return
    const nextActive = !detail.account.is_active
    setPendingSensitiveAction({
      type: 'single_status',
      accountId: detail.account.id,
      accountName: detail.account.display_name || detail.account.email_address,
      nextActive,
    })
  }

  const executeSingleStatusUpdate = async (
    accountId: string,
    nextActive: boolean,
    payload: { reason: string; ticket_id: string }
  ) => {
    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const result = await updateAdminMailAccountStatus(accountId, nextActive, payload)
      setActionMessage(result.message)
      await handleRefresh({ preserveFeedback: true })
    } catch (actionErr: unknown) {
      setActionError(getErrorMessage(actionErr, '更新账户状态失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleBatchSync = () => {
    if (!selectedAccountIds.length) return
    setPendingSensitiveAction({
      type: 'batch_sync',
      accountIds: [...selectedAccountIds],
    })
  }

  const executeBatchSync = async (
    accountIds: string[],
    payload: { reason: string; ticket_id: string }
  ) => {
    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const result = await batchSyncAdminMailAccounts(accountIds, payload)
      setActionMessage(result.message)
      setLastBatchResult(result)
      setSelectedAccountIds([])
      await handleRefresh({ preserveFeedback: true })
    } catch (actionErr: unknown) {
      setActionError(getErrorMessage(actionErr, '批量同步失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleBatchSetActive = async (nextActive: boolean) => {
    if (!selectedAccountIds.length) return
    setPendingSensitiveAction({
      type: 'batch_status',
      accountIds: [...selectedAccountIds],
      nextActive,
    })
  }

  const executeBatchStatusUpdate = async (
    accountIds: string[],
    nextActive: boolean,
    payload: { reason: string; ticket_id: string }
  ) => {
    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const result = await batchUpdateAdminMailAccountStatus(accountIds, nextActive, payload)
      setActionMessage(result.message)
      setLastBatchResult(result)
      setSelectedAccountIds([])
      await handleRefresh({ preserveFeedback: true })
    } catch (actionErr: unknown) {
      setActionError(getErrorMessage(actionErr, '批量更新账户状态失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleConfirmSensitiveAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingSensitiveAction) return
    if (pendingSensitiveAction.type === 'single_sync') {
      await executeSingleSync(pendingSensitiveAction.accountId, payload)
    } else if (pendingSensitiveAction.type === 'single_status') {
      await executeSingleStatusUpdate(
        pendingSensitiveAction.accountId,
        pendingSensitiveAction.nextActive,
        payload
      )
    } else if (pendingSensitiveAction.type === 'batch_sync') {
      await executeBatchSync(pendingSensitiveAction.accountIds, payload)
    } else {
      await executeBatchStatusUpdate(
        pendingSensitiveAction.accountIds,
        pendingSensitiveAction.nextActive,
        payload
      )
    }
    setPendingSensitiveAction(null)
  }

  const getSensitiveDialogConfig = () => {
    if (!pendingSensitiveAction) return null
    if (pendingSensitiveAction.type === 'single_sync') {
      return {
        title: '同步邮箱账户',
        targetLabel: pendingSensitiveAction.accountName,
        impact: '该操作会触发账户邮件同步，可能产生外部邮箱访问和客户端状态更新。',
        confirmText: '同步',
      }
    }
    if (pendingSensitiveAction.type === 'single_status') {
      return {
        title: `${pendingSensitiveAction.nextActive ? '启用' : '停用'}邮箱账户`,
        targetLabel: pendingSensitiveAction.accountName,
        impact: '该操作会改变账户可用状态，不会影响客户端其他数据。',
        confirmText: pendingSensitiveAction.nextActive ? '启用' : '停用',
      }
    }
    if (pendingSensitiveAction.type === 'batch_sync') {
      return {
        title: '批量同步邮箱账户',
        targetLabel: `共 ${pendingSensitiveAction.accountIds.length} 个账户`,
        impact: `该操作会触发选中 ${pendingSensitiveAction.accountIds.length} 个账户的邮件同步。`,
        confirmText: '同步',
      }
    }
    return {
      title: `批量${pendingSensitiveAction.nextActive ? '启用' : '停用'}邮箱账户`,
      targetLabel: `共 ${pendingSensitiveAction.accountIds.length} 个账户`,
      impact: `该操作会改变选中 ${pendingSensitiveAction.accountIds.length} 个账户的可用状态，不会影响客户端其他数据。`,
      confirmText: pendingSensitiveAction.nextActive ? '启用' : '停用',
    }
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="邮件"
        icon={Mail}
        actions={
          <div className="flex items-center gap-2">
            <PermissionGate permission={ADMIN_PERMISSION.MAIL_UPDATE_STATUS}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => selectedAccountId && handleSync()}
                disabled={!selectedAccountId || actionLoading}
              >
                同步
              </Button>
            </PermissionGate>
            <Button size="sm" variant="ghost" onClick={() => navigate('/mail/operations')}>
              导出
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={listLoading || detailLoading}
            >
              {listLoading || detailLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
          </div>
        }
      />

      {listError || detailError || actionError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {[listError, detailError, actionError].filter(Boolean).join('；')}
        </div>
      ) : null}
      {actionMessage ? (
        <div className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-body text-success">
          {actionMessage}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CompactMetric
          label="邮箱账户"
          value={summary?.total_accounts}
          icon={Mail}
          onClick={() => {
            setPage(1)
            setAttention('all')
          }}
        />
        <CompactMetric
          label="未读邮件"
          value={summary?.unread_messages}
          icon={MessageSquareText}
          onClick={() => {
            setPage(1)
            setAttention('unread')
          }}
        />
        <CompactMetric
          label="同步异常"
          value={summary?.error_accounts}
          icon={Power}
          onClick={() => {
            setPage(1)
            setAttention('error')
          }}
        />
        <CompactMetric
          label="待审核"
          value={summary?.pending_drafts}
          icon={RefreshCw}
          onClick={() => {
            setPage(1)
            setAttention('pending_draft')
          }}
        />
      </div>

      <AdminListCard title="邮箱账户">
        <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(240px,2fr)_140px_140px_140px_140px_1fr_auto_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                placeholder="邮箱 / 用户 / Organization"
              />
            </div>
            <Select
              value={isActive}
              onValueChange={(value) => {
                setIsActive(value as MailActiveFilter)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                {activeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={provider}
              onValueChange={(value) => {
                setProvider(value as MailProviderFilter)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="提供商" />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={syncStatus}
              onValueChange={(value) => {
                setSyncStatus(value as MailSyncStatusFilter)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="同步状态" />
              </SelectTrigger>
              <SelectContent>
                {syncStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={attention}
              onValueChange={(value) => {
                setAttention(value as MailAttentionFilter)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="审核状态" />
              </SelectTrigger>
              <SelectContent>
                {attentionOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={organizationQueryInput}
              onChange={(event) => setOrganizationQueryInput(event.target.value)}
              placeholder="Organization"
            />
            <Button size="sm" onClick={handleApplyFilters}>
              查询
            </Button>
            <Button variant="outline" size="sm" onClick={handleReset}>
              重置
            </Button>
          </div>
          <div className="flex items-center justify-between text-body text-muted-foreground">
            <span>共 {pagination?.total ?? 0} 条结果</span>
            <Input
              className="h-8 max-w-[220px]"
              value={spaceQueryInput}
              onChange={(event) => setSpaceQueryInput(event.target.value)}
              placeholder="Space（可选）"
            />
          </div>

          {selectedAccountIds.length ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-body">
              <span className="font-medium text-warning">
                已选择 {selectedAccountIds.length} 个账户
              </span>
              <PermissionGate permission={ADMIN_PERMISSION.MAIL_UPDATE_STATUS}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBatchSync}
                  disabled={actionLoading}
                >
                  批量同步
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.MAIL_UPDATE_STATUS}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleBatchSetActive(true)}
                  disabled={actionLoading}
                >
                  批量启用
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.MAIL_UPDATE_STATUS}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleBatchSetActive(false)}
                  disabled={actionLoading}
                >
                  批量停用
                </Button>
              </PermissionGate>
              <Button variant="ghost" size="sm" onClick={() => setSelectedAccountIds([])}>
                清除
              </Button>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-md border bg-background">
            <table className="min-w-full text-body">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2 text-left">
                    <Checkbox
                      checked={
                        allVisibleSelected ? true : partiallySelected ? 'indeterminate' : false
                      }
                      onCheckedChange={(checked) => toggleAllVisible(checked === true)}
                      disabled={!visibleAccountIds.length}
                    />
                  </th>
                  <th className="px-4 py-2 text-left font-medium">邮箱账户</th>
                  <th className="px-4 py-2 text-left font-medium">Organization / 用户</th>
                  <th className="px-4 py-2 text-left font-medium">状态</th>
                  <th className="px-4 py-2 text-left font-medium">同步状态</th>
                  <th className="px-4 py-2 text-left font-medium">未读</th>
                  <th className="px-4 py-2 text-left font-medium">最近同步</th>
                  <th className="px-4 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {listLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      加载中...
                    </td>
                  </tr>
                ) : listData?.items.length ? (
                  listData.items.map((item) => (
                    <tr
                      key={item.id}
                      className="h-16 cursor-pointer hover:bg-muted/30"
                      tabIndex={0}
                      onClick={() => openAccountDetail(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') openAccountDetail(item.id)
                      }}
                    >
                      <td className="px-4 py-2">
                        <Checkbox
                          checked={selectedAccountIds.includes(item.id)}
                          onClick={(event) => event.stopPropagation()}
                          onCheckedChange={(checked) =>
                            toggleAccountSelection(item.id, checked === true)
                          }
                          aria-label={`选择 ${item.display_name || item.email_address}`}
                        />
                      </td>
                      <td className="max-w-[300px] px-4 py-2">
                        <div className="truncate font-medium">
                          {item.display_name || item.email_address}
                        </div>
                        <div className="truncate text-caption text-muted-foreground">
                          {item.email_address}
                        </div>
                        <button
                          type="button"
                          className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation()
                            void copyAccountId(item.id)
                          }}
                        >
                          {compactId(item.id)}
                          <Copy className="h-3 w-3" />
                        </button>
                      </td>
                      <td className="max-w-[220px] px-4 py-2 text-muted-foreground">
                        <div className="truncate">
                          <EntityLink
                            type="organization"
                            id={item.organization_id}
                            label={item.organization_name || item.organization_id}
                          />
                        </div>
                        <div className="mt-1 truncate text-caption">
                          {item.space_id ? (
                            <EntityLink
                              type="space"
                              id={item.space_id}
                              label={item.space_name || item.space_id}
                            />
                          ) : (
                            '未绑定'
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={item.is_active ? 'secondary' : 'outline'}>
                          {item.is_active ? '启用' : '停用'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">{getSyncStatusBadge(item.sync_status)}</td>
                      <td className="px-4 py-2">{item.unread_message_count}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatDateTime(item.last_sync_at)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation()
                              openAccountDetail(item.id)
                            }}
                          >
                            详情
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={(event) => {
                              event.stopPropagation()
                              openAccountDetail(item.id)
                            }}
                            aria-label="更多"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      暂无账户
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pagination ? (
            <div className="flex items-center justify-between text-body text-muted-foreground">
              <span>
                第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 个账户
              </span>
              <div className="flex items-center gap-2">
                <PageSizeSelect
                  value={pageSize}
                  onChange={(nextPageSize) => {
                    setPageSize(nextPageSize)
                    setPage(1)
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page >= pagination.total_pages}
                  onClick={() => setPage((prev) => prev + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </AdminListCard>

      {lastBatchResult ? (
        <div className="rounded-lg border bg-muted/20 px-4 py-3 text-body text-muted-foreground">
          最近批量：{lastBatchResult.message}
          {lastBatchResult.operation_id ? (
            <Button
              className="ml-3"
              size="sm"
              variant="ghost"
              onClick={() =>
                navigate(
                  buildMailOperationsHref({ operationId: lastBatchResult.operation_id || '' })
                )
              }
            >
              查看
            </Button>
          ) : null}
        </div>
      ) : null}

      <AdminOperationFeedCard
        title="最近活动"
        items={operationsData?.items ?? []}
        loading={operationsLoading}
        error={operationsError}
        actionLabels={operationActionLabels}
        emptyText="暂无活动"
        itemHrefBuilder={(item) => buildMailOperationsHref({ operationId: item.id })}
        itemActionLabel="查看"
        actions={
          <Button size="sm" variant="outline" onClick={() => navigate('/mail/operations')}>
            查看全部
          </Button>
        }
      />

      <Dialog
        open={detailDrawerOpen}
        onOpenChange={(open) => {
          setDetailDrawerOpen(open)
          if (!open) setSelectedAccountId(null)
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-w-[620px] translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-5 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {detail?.account.display_name ||
                    selectedAccount?.display_name ||
                    selectedAccount?.email_address ||
                    '账户详情'}
                </DialogTitle>
                <div className="mt-1 text-body text-muted-foreground">
                  {selectedAccountId ? compactId(selectedAccountId, 10, 6) : '—'}
                </div>
              </div>
              {detail ? (
                <div className="flex gap-2">
                  <PermissionGate permission={ADMIN_PERMISSION.MAIL_UPDATE_STATUS}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSync}
                      disabled={actionLoading}
                    >
                      同步
                    </Button>
                  </PermissionGate>
                  <PermissionGate permission={ADMIN_PERMISSION.MAIL_UPDATE_STATUS}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleToggleActive()}
                      disabled={actionLoading}
                    >
                      {detail.account.is_active ? '停用' : '启用'}
                    </Button>
                  </PermissionGate>
                </div>
              ) : null}
            </div>
          </DialogHeader>
          <ScrollArea className="min-h-0">
            <div className="p-5">
              {detailLoading ? (
                <div className="flex min-h-[360px] items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载中...
                </div>
              ) : detail ? (
                <Tabs defaultValue="overview">
                  <TabsList className="grid w-full grid-cols-5">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="sync">同步</TabsTrigger>
                    <TabsTrigger value="mail">邮件</TabsTrigger>
                    <TabsTrigger value="approval">审批</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="space-y-4">
                    <div className="rounded-md border p-3">
                      <InfoRow label="邮箱" value={detail.account.email_address} />
                      <InfoRow label="状态" value={detail.account.is_active ? '启用' : '停用'} />
                      <InfoRow
                        label="Organization"
                        value={
                          <EntityLink
                            type="organization"
                            id={detail.account.organization_id}
                            label={detail.account.organization_name || detail.account.organization_id}
                          />
                        }
                      />
                      <InfoRow
                        label="Space"
                        value={
                          detail.account.space_id ? (
                            <EntityLink
                              type="space"
                              id={detail.account.space_id}
                              label={detail.account.space_name || detail.account.space_id}
                            />
                          ) : (
                            '未绑定'
                          )
                        }
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="sync">
                    <div className="rounded-md border p-3">
                      <InfoRow
                        label="同步状态"
                        value={getSyncStatusBadge(detail.account.sync_status)}
                      />
                      <InfoRow
                        label="最近同步"
                        value={formatDateTime(detail.account.last_sync_at)}
                      />
                      <InfoRow label="连续失败" value={detail.account.consecutive_sync_failures} />
                      <InfoRow label="错误" value={detail.account.last_error || '—'} />
                    </div>
                  </TabsContent>
                  <TabsContent value="mail">
                    <div className="space-y-4">
                      <div>
                        <h3 className="mb-2 font-medium">最近线程</h3>
                        <div className="space-y-2">
                          {detail.recent_threads.length ? (
                            detail.recent_threads.map((item) => (
                              <div key={item.id} className="rounded-md border px-3 py-2 text-body">
                                <div className="font-medium">{item.subject || '无主题'}</div>
                                <div className="mt-1 text-caption text-muted-foreground">
                                  {item.last_sender || '未知发件人'} · {item.message_count} 封 ·{' '}
                                  {item.unread_count} 未读 · {formatDateTime(item.last_message_at)}
                                </div>
                              </div>
                            ))
                          ) : (
                            <EmptyNote>暂无线程</EmptyNote>
                          )}
                        </div>
                      </div>
                      <div>
                        <h3 className="mb-2 font-medium">最近邮件</h3>
                        <div className="space-y-2">
                          {detail.recent_messages.length ? (
                            detail.recent_messages.map((item) => (
                              <div key={item.id} className="rounded-md border px-3 py-2 text-body">
                                <div className="font-medium">{item.subject || '无主题'}</div>
                                <div className="mt-1 text-caption text-muted-foreground">
                                  {item.direction} · {item.status} ·{' '}
                                  {item.has_attachments ? '含附件' : '无附件'} ·{' '}
                                  {formatDateTime(item.message_date || item.created_at)}
                                </div>
                                <div className="mt-1 text-caption text-muted-foreground">
                                  {item.preview || '无预览'}
                                </div>
                              </div>
                            ))
                          ) : (
                            <EmptyNote>暂无邮件</EmptyNote>
                          )}
                        </div>
                      </div>
                    </div>
                  </TabsContent>
                  <TabsContent value="approval">
                    <div className="space-y-2">
                      {detail.pending_drafts.length ? (
                        detail.pending_drafts.map((item) => (
                          <div key={item.id} className="rounded-md border px-3 py-2 text-body">
                            <div className="font-medium">{item.subject || '无主题'}</div>
                            <div className="mt-1 text-caption text-muted-foreground">
                              {item.to_addresses.join(', ') || '无收件人'} ·{' '}
                              {item.created_by_agent || '未知 Agent'} ·{' '}
                              {formatDateTime(item.created_at)}
                            </div>
                          </div>
                        ))
                      ) : (
                        <EmptyNote>当前没有待审核草稿</EmptyNote>
                      )}
                    </div>
                  </TabsContent>
                  <TabsContent value="audit">
                    <EmptyNote />
                  </TabsContent>
                </Tabs>
              ) : (
                <EmptyNote />
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <SensitiveActionConfirmDialog
        open={Boolean(pendingSensitiveAction)}
        title={getSensitiveDialogConfig()?.title ?? ''}
        targetLabel={getSensitiveDialogConfig()?.targetLabel ?? ''}
        impact={getSensitiveDialogConfig()?.impact ?? ''}
        confirmText={getSensitiveDialogConfig()?.confirmText}
        loading={actionLoading}
        onCancel={() => setPendingSensitiveAction(null)}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </AdminPage>
  )
}
