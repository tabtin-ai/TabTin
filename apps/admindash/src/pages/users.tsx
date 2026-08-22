import {
  Activity,
  Copy,
  Download,
  Loader2,
  MoreHorizontal,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  UserX,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  batchUpdateUserStatus,
  blockAllUserDevices,
  blockClientDevice,
  cleanupDirtyUserByPhone,
  exportAuditLogs,
  getUserDetail,
  getUserDevices,
  getUserOrganizations,
  getUserSessions,
  getUserWalletTransactions,
  getUsers,
  revokeAllUserSessions,
  revokeUserSession,
  unblockClientDevice,
  updateUserStatus,
} from '@/api/users'
import { EntityLink } from '@/components/entity-links/EntityLink'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { RechargeDialog } from '@/components/users/recharge-dialog'
import { TransactionDialog } from '@/components/users/transaction-dialog'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import type {
  AdminClientDevice,
  DirtyUserCleanupResponse,
  UserBatchMutationResponse,
  UserDetailResponse,
  UserListItem,
  UserListResponse,
  UserOrganizationItem,
  UserSessionInfo,
  UserStatus,
  UserStatusFilter,
  UserWalletTransactionsResponse,
} from '@/types/user'
import { Link, useSearchParams } from 'react-router-dom'

const STATUS_LABELS: Record<UserStatus, string> = {
  active: '启用',
  inactive: '停用',
}

const DEVICE_STATUS_LABELS: Record<AdminClientDevice['status'], string> = {
  active: '可用',
  blocked: '已封禁',
  revoked: '已吊销',
}

const ORGANIZATION_ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '编辑者',
  viewer: '查看者',
}

const ORGANIZATION_TYPE_LABELS: Record<string, string> = {
  personal: '个人',
  team: '团队',
}

type BatchActionKind = 'status'
type ClientGovernanceAction =
  | { kind: 'device_block'; device: AdminClientDevice }
  | { kind: 'device_unblock'; device: AdminClientDevice }
  | { kind: 'device_block_all'; userId: string }
  | { kind: 'session_revoke'; session: UserSessionInfo }
  | { kind: 'session_revoke_all'; userId: string }

interface PendingBatchAction {
  kind: BatchActionKind
  userIds: string[]
  value: UserStatus
}

interface PendingStatusAction {
  userId: string
  displayName: string
  nextStatus: UserStatus
}

interface FilterState {
  keyword: string
  status: UserStatusFilter
}

type AuditSuccessFilter = 'all' | 'success' | 'failed'

interface AuditFilterState {
  actionType: string
  success: AuditSuccessFilter
  startAt: string
  endAt: string
  limit: number
}

function buildStatusBadgeVariant(status: UserStatus): 'success' | 'secondary' {
  return status === 'active' ? 'success' : 'secondary'
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function buildBatchResultMessage(
  response: UserBatchMutationResponse,
  userNameMap: Map<string, string>
): string {
  if (!response.skipped.length) {
    return response.message
  }
  const preview = response.skipped
    .slice(0, 3)
    .map((item) => `${userNameMap.get(item.user_id) || item.user_id}: ${item.reason}`)
    .join('；')
  return `${response.message}。示例跳过原因：${preview}`
}

function toIsoFromDatetimeLocal(value: string): string | undefined {
  if (!value) {
    return undefined
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }
  return date.toISOString()
}

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
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
}: {
  label: string
  value: number | string | undefined
  icon: ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-3">
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value ?? 0}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value || '—'}</span>
    </div>
  )
}

function EmptyNote({ children = '暂无记录' }: { children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
      {children}
    </div>
  )
}

function UserIdentity({
  user,
  onCopy,
}: {
  user: UserListItem
  onCopy: (userId: string) => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-caption font-semibold">
        {(user.display_name || user.username || 'U').slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium">{user.display_name}</div>
        <button
          type="button"
          className="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-caption text-muted-foreground hover:text-primary"
          onClick={(event) => {
            event.stopPropagation()
            onCopy(user.id)
          }}
          title={user.id}
        >
          <span className="truncate">{compactId(user.id)}</span>
          <Copy className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

export function UsersPage() {
  const { user: currentUser } = useAuthStore()
  const [searchParams] = useSearchParams()

  const queryKeyword = useMemo(() => searchParams.get('keyword')?.trim() || '', [searchParams])
  const queryUserId = useMemo(() => searchParams.get('userId')?.trim() || null, [searchParams])

  const [filters, setFilters] = useState<FilterState>({
    keyword: queryKeyword,
    status: 'all',
  })
  const [keywordInput, setKeywordInput] = useState(queryKeyword)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [listData, setListData] = useState<UserListResponse | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [pendingQueryUserId, setPendingQueryUserId] = useState<string | null>(queryUserId)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)

  const [detail, setDetail] = useState<UserDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [savingStatus, setSavingStatus] = useState(false)

  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [pendingBatchAction, setPendingBatchAction] = useState<PendingBatchAction | null>(null)
  const [pendingStatusAction, setPendingStatusAction] = useState<PendingStatusAction | null>(null)
  const [clientDevices, setClientDevices] = useState<AdminClientDevice[]>([])
  const [clientSessions, setClientSessions] = useState<UserSessionInfo[]>([])
  const [clientLoading, setClientLoading] = useState(false)
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientSubmitting, setClientSubmitting] = useState(false)
  const [pendingClientAction, setPendingClientAction] = useState<ClientGovernanceAction | null>(
    null
  )
  const [userOrganizations, setUserOrganizations] = useState<UserOrganizationItem[]>([])
  const [userOrganizationsTotal, setUserOrganizationsTotal] = useState(0)
  const [userOrganizationsLoading, setUserOrganizationsLoading] = useState(false)
  const [userOrganizationsError, setUserOrganizationsError] = useState<string | null>(null)

  const [exportingAudit, setExportingAudit] = useState(false)
  const [showAuditFilters, setShowAuditFilters] = useState(false)
  const [auditFilters, setAuditFilters] = useState<AuditFilterState>({
    actionType: '',
    success: 'all',
    startAt: '',
    endAt: '',
    limit: 10000,
  })
  const [operationMessage, setOperationMessage] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [testUserResetOpen, setTestUserResetOpen] = useState(false)
  const [testUserResetPhone, setTestUserResetPhone] = useState('')
  const [testUserResetConfirm, setTestUserResetConfirm] = useState('')
  const [testUserResetLoading, setTestUserResetLoading] = useState(false)
  const [testUserResetResult, setTestUserResetResult] = useState<DirtyUserCleanupResponse | null>(
    null
  )
  const [testUserResetError, setTestUserResetError] = useState<string | null>(null)

  const [txDialogOpen, setTxDialogOpen] = useState(false)
  const [txData, setTxData] = useState<UserWalletTransactionsResponse | null>(null)
  const [txLoading, setTxLoading] = useState(false)
  const [txPage, setTxPage] = useState(1)
  const [txPageSize, setTxPageSize] = useState(20)
  const [txTypeFilter, setTxTypeFilter] = useState('all')

  const [rechargeDialogOpen, setRechargeDialogOpen] = useState(false)
  const selectedUserFromList = useMemo(
    () => listData?.items.find((item) => item.id === selectedUserId) ?? null,
    [listData, selectedUserId]
  )

  const listUserMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of listData?.items ?? []) {
      map.set(item.id, item.display_name)
    }
    return map
  }, [listData?.items])

  const loadUsers = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const response = await getUsers({
        keyword: filters.keyword || undefined,
        status: filters.status,
        page,
        page_size: pageSize,
      })
      setListData(response)
    } catch (error: unknown) {
      setListError(resolveErrorMessage(error, '加载用户列表失败'))
    } finally {
      setListLoading(false)
    }
  }, [filters.keyword, filters.status, page, pageSize])

  const loadUserDetail = useCallback(async (userId: string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await getUserDetail(userId)
      setDetail(response)
    } catch (error: unknown) {
      setDetailError(resolveErrorMessage(error, '加载用户详情失败'))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const loadClientGovernance = useCallback(async (userId: string) => {
    setClientLoading(true)
    setClientError(null)
    try {
      const [devicesResponse, sessionsResponse] = await Promise.all([
        getUserDevices(userId),
        getUserSessions(userId),
      ])
      setClientDevices(devicesResponse.items)
      setClientSessions(sessionsResponse.items)
    } catch (error: unknown) {
      setClientError(resolveErrorMessage(error, '加载设备与 Session 失败'))
      setClientDevices([])
      setClientSessions([])
    } finally {
      setClientLoading(false)
    }
  }, [])

  const loadUserOrganizations = useCallback(async (userId: string) => {
    setUserOrganizationsLoading(true)
    setUserOrganizationsError(null)
    try {
      const response = await getUserOrganizations(userId, { page: 1, page_size: 100 })
      setUserOrganizations(response.organizations || [])
      setUserOrganizationsTotal(response.total ?? response.organizations?.length ?? 0)
    } catch (error: unknown) {
      setUserOrganizationsError(resolveErrorMessage(error, '加载用户组织失败'))
      setUserOrganizations([])
      setUserOrganizationsTotal(0)
    } finally {
      setUserOrganizationsLoading(false)
    }
  }, [])

  useEffect(() => {
    setKeywordInput((previous) => (previous === queryKeyword ? previous : queryKeyword))
    setFilters((previous) => {
      if (previous.keyword === queryKeyword) {
        return previous
      }
      return {
        ...previous,
        keyword: queryKeyword,
      }
    })
    setPendingQueryUserId((previous) => (previous === queryUserId ? previous : queryUserId))
    setPage(1)
  }, [queryKeyword, queryUserId])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  useEffect(() => {
    if (!listData) {
      return
    }
    if (pendingQueryUserId && listData.items.some((item) => item.id === pendingQueryUserId)) {
      if (selectedUserId !== pendingQueryUserId) {
        setSelectedUserId(pendingQueryUserId)
        setDetailDrawerOpen(true)
        return
      }
      setPendingQueryUserId(null)
      return
    }
    if (pendingQueryUserId) {
      if (selectedUserId !== pendingQueryUserId) {
        setSelectedUserId(pendingQueryUserId)
        return
      }
      setPendingQueryUserId(null)
      return
    }
    if (
      selectedUserId &&
      selectedUserId !== queryUserId &&
      listData.items.length > 0 &&
      !listData.items.some((item) => item.id === selectedUserId)
    ) {
      setSelectedUserId(null)
      setDetail(null)
      return
    }
    if (listData.items.length === 0) {
      setSelectedUserId(null)
      setDetail(null)
    }
  }, [listData, pendingQueryUserId, queryUserId, selectedUserId])

  useEffect(() => {
    if (!listData) {
      return
    }
    const currentIds = new Set(listData.items.map((item) => item.id))
    setSelectedUserIds((previous) => previous.filter((id) => currentIds.has(id)))
  }, [listData])

  useEffect(() => {
    if (!selectedUserId) {
      setDetail(null)
      setClientDevices([])
      setClientSessions([])
      setUserOrganizations([])
      setUserOrganizationsTotal(0)
      setUserOrganizationsError(null)
      return
    }
    void loadUserDetail(selectedUserId)
    void loadClientGovernance(selectedUserId)
    void loadUserOrganizations(selectedUserId)
  }, [loadClientGovernance, loadUserDetail, loadUserOrganizations, selectedUserId])

  const handleSearch = () => {
    setPage(1)
    setFilters((prev) => ({
      ...prev,
      keyword: keywordInput.trim(),
    }))
  }

  const handleRefresh = () => {
    setOperationMessage(null)
    setOperationError(null)
    void loadUsers()
    if (selectedUserId) {
      void loadUserDetail(selectedUserId)
      void loadClientGovernance(selectedUserId)
      void loadUserOrganizations(selectedUserId)
    }
  }

  const openTestUserReset = () => {
    setTestUserResetPhone('')
    setTestUserResetConfirm('')
    setTestUserResetResult(null)
    setTestUserResetError(null)
    setTestUserResetOpen(true)
  }

  const runTestUserReset = async (dryRun: boolean) => {
    const phone = testUserResetPhone.trim()
    if (!phone) {
      setTestUserResetError('请输入要重置的手机号')
      return
    }
    if (!dryRun && testUserResetConfirm.trim() !== 'DELETE_DIRTY_USER_DATA') {
      setTestUserResetError('真实重置前请输入 DELETE_DIRTY_USER_DATA')
      return
    }
    setTestUserResetLoading(true)
    setTestUserResetError(null)
    try {
      const response = await cleanupDirtyUserByPhone({
        phone,
        dry_run: dryRun,
        include_search: true,
        confirm_phone: dryRun ? undefined : phone,
        confirmation: dryRun ? '' : 'DELETE_DIRTY_USER_DATA',
      })
      setTestUserResetResult(response)
      setOperationError(null)
      setOperationMessage(response.message)
      if (!dryRun) {
        await loadUsers()
        if (selectedUserId === response.user_id) {
          setSelectedUserId(null)
          setDetail(null)
          setDetailDrawerOpen(false)
        }
      }
    } catch (error: unknown) {
      setTestUserResetError(resolveErrorMessage(error, '重置测试用户失败'))
    } finally {
      setTestUserResetLoading(false)
    }
  }

  const currentUserId = currentUser?.id
  const selectedUser = detail?.user ?? selectedUserFromList
  const isSelfSelected = selectedUser?.id === currentUserId
  const currentPageUserIds = useMemo(
    () => (listData?.items ?? []).map((item) => item.id),
    [listData?.items]
  )

  const selectedCount = selectedUserIds.length
  const selectedOnPageCount = currentPageUserIds.filter((id) => selectedUserIds.includes(id)).length
  const allSelectedOnPage =
    currentPageUserIds.length > 0 && selectedOnPageCount === currentPageUserIds.length

  const toggleSelectAllOnPage = () => {
    if (allSelectedOnPage) {
      setSelectedUserIds((previous) => previous.filter((id) => !currentPageUserIds.includes(id)))
      return
    }
    setSelectedUserIds((previous) => {
      const merged = new Set(previous)
      for (const userId of currentPageUserIds) {
        merged.add(userId)
      }
      return Array.from(merged)
    })
  }

  const toggleSelectUser = (userId: string) => {
    setSelectedUserIds((previous) => {
      if (previous.includes(userId)) {
        return previous.filter((id) => id !== userId)
      }
      return [...previous, userId]
    })
  }

  const openUserDetail = (userId: string) => {
    setSelectedUserId(userId)
    setDetailDrawerOpen(true)
  }

  const copyUserId = async (userId: string) => {
    try {
      await navigator.clipboard.writeText(userId)
      setOperationError(null)
      setOperationMessage('已复制用户 ID')
    } catch {
      setOperationMessage(null)
      setOperationError('复制失败')
    }
  }

  const openBatchConfirm = (kind: BatchActionKind, value: UserStatus) => {
    if (!selectedCount) {
      setOperationError('请先勾选至少一个用户')
      return
    }
    setOperationError(null)
    setOperationMessage(null)
    setPendingBatchAction({
      kind,
      value,
      userIds: [...selectedUserIds],
    })
  }

  const closeBatchConfirm = () => {
    if (batchSubmitting) {
      return
    }
    setPendingBatchAction(null)
  }

  const executePendingBatchAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingBatchAction) {
      return
    }
    setBatchSubmitting(true)
    setOperationError(null)
    setOperationMessage(null)

    try {
      const response = await batchUpdateUserStatus(
        pendingBatchAction.userIds,
        pendingBatchAction.value as UserStatus,
        payload.reason,
        payload.ticket_id
      )
      setOperationMessage(buildBatchResultMessage(response, listUserMap))

      const shouldReloadDetail =
        selectedUserId !== null && pendingBatchAction.userIds.includes(selectedUserId)

      setSelectedUserIds([])
      setPendingBatchAction(null)

      await loadUsers()
      if (shouldReloadDetail && selectedUserId) {
        await loadUserDetail(selectedUserId)
      }
    } catch (error: unknown) {
      setOperationError(resolveErrorMessage(error, '批量操作失败'))
    } finally {
      setBatchSubmitting(false)
    }
  }

  const handleStatusToggle = async () => {
    if (!selectedUser) {
      return
    }
    const nextStatus: UserStatus = selectedUser.status === 'active' ? 'inactive' : 'active'
    setPendingStatusAction({
      userId: selectedUser.id,
      displayName: selectedUser.display_name,
      nextStatus,
    })
  }

  const executePendingStatusAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingStatusAction) {
      return
    }
    setSavingStatus(true)
    setOperationError(null)
    setOperationMessage(null)
    try {
      const response = await updateUserStatus(
        pendingStatusAction.userId,
        pendingStatusAction.nextStatus,
        payload.reason,
        payload.ticket_id
      )
      setOperationMessage(response.message)
      setDetail((prev) => (prev ? { ...prev, user: response.user } : prev))
      await loadUsers()
      await loadUserDetail(pendingStatusAction.userId)
      setPendingStatusAction(null)
    } catch (error: unknown) {
      setOperationError(resolveErrorMessage(error, '更新用户状态失败'))
    } finally {
      setSavingStatus(false)
    }
  }

  const executePendingClientAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingClientAction || !selectedUserId) {
      return
    }
    setClientSubmitting(true)
    setOperationError(null)
    setOperationMessage(null)
    try {
      if (pendingClientAction.kind === 'device_block') {
        await blockClientDevice(
          pendingClientAction.device.device_id || pendingClientAction.device.id,
          payload
        )
        setOperationMessage('设备已封禁，后续 API 请求会返回 DEVICE_BLOCKED')
      } else if (pendingClientAction.kind === 'device_unblock') {
        await unblockClientDevice(
          pendingClientAction.device.device_id || pendingClientAction.device.id,
          payload
        )
        setOperationMessage('设备已恢复访问')
      } else if (pendingClientAction.kind === 'device_block_all') {
        await blockAllUserDevices(pendingClientAction.userId, payload)
        setOperationMessage('该用户全部设备已封禁')
      } else if (pendingClientAction.kind === 'session_revoke') {
        await revokeUserSession(
          pendingClientAction.session.session_id || pendingClientAction.session.id,
          payload
        )
        setOperationMessage('Session 已吊销，客户端需要重新登录')
      } else {
        await revokeAllUserSessions(pendingClientAction.userId, payload)
        setOperationMessage('该用户全部 Session 已吊销')
      }
      setPendingClientAction(null)
      await loadClientGovernance(selectedUserId)
      await loadUserDetail(selectedUserId)
    } catch (error: unknown) {
      setOperationError(resolveErrorMessage(error, '设备/Session 操作失败'))
    } finally {
      setClientSubmitting(false)
    }
  }

  const handleExportAudit = async () => {
    setExportingAudit(true)
    setOperationError(null)
    setOperationMessage(null)
    try {
      const successFilter =
        auditFilters.success === 'all' ? undefined : auditFilters.success === 'success'
      const blob = await exportAuditLogs({
        user_ids: selectedUserIds.length ? selectedUserIds : undefined,
        keyword: filters.keyword || undefined,
        action_type: auditFilters.actionType || undefined,
        success: successFilter,
        start_at: toIsoFromDatetimeLocal(auditFilters.startAt),
        end_at: toIsoFromDatetimeLocal(auditFilters.endAt),
        limit: auditFilters.limit,
      })

      if (blob.type.includes('application/json')) {
        const text = await blob.text()
        try {
          const parsed = JSON.parse(text)
          throw new Error(parsed?.message || '导出失败')
        } catch {
          throw new Error('导出失败')
        }
      }

      const filename = selectedUserIds.length
        ? `audit_selected_${selectedUserIds.length}_${Date.now()}.csv`
        : `audit_filtered_${Date.now()}.csv`
      downloadBlob(blob, filename)
      setOperationMessage('审计日志导出成功')
    } catch (error: unknown) {
      setOperationError(resolveErrorMessage(error, '审计日志导出失败'))
    } finally {
      setExportingAudit(false)
    }
  }

  const loadUserTransactions = useCallback(
    async (userId: string, pg = 1, typeFilter = 'all', nextPageSize = txPageSize) => {
      setTxLoading(true)
      try {
        const res = await getUserWalletTransactions(userId, {
          page: pg,
          page_size: nextPageSize,
          transaction_type: typeFilter === 'all' ? undefined : typeFilter,
        })
        setTxData(res)
      } catch (error: unknown) {
        setOperationError(resolveErrorMessage(error, '加载交易记录失败'))
      } finally {
        setTxLoading(false)
      }
    },
    [txPageSize]
  )

  const openTxDialog = () => {
    if (!selectedUserId) return
    setTxPage(1)
    setTxPageSize(20)
    setTxTypeFilter('all')
    setTxData(null)
    setTxDialogOpen(true)
    void loadUserTransactions(selectedUserId, 1, 'all', 20)
  }

  const handleTxPageChange = (newPage: number) => {
    setTxPage(newPage)
    if (selectedUserId) void loadUserTransactions(selectedUserId, newPage, txTypeFilter)
  }

  const handleTxPageSizeChange = (nextPageSize: number) => {
    setTxPageSize(nextPageSize)
    setTxPage(1)
    if (selectedUserId) void loadUserTransactions(selectedUserId, 1, txTypeFilter, nextPageSize)
  }

  const handleTxTypeFilterChange = (value: string) => {
    setTxTypeFilter(value)
    setTxPage(1)
    if (selectedUserId) void loadUserTransactions(selectedUserId, 1, value)
  }

  const openRechargeDialog = () => {
    setRechargeDialogOpen(true)
  }

  const handleRechargeSuccess = (message: string) => {
    setOperationError(null)
    setOperationMessage(message)
    if (selectedUserId) {
      void loadUserDetail(selectedUserId)
      void loadUsers()
    }
  }

  const summary = listData?.summary
  const pagination = listData?.pagination

  const resetAuditFilters = () => {
    setAuditFilters({
      actionType: '',
      success: 'all',
      startAt: '',
      endAt: '',
      limit: 10000,
    })
  }

  const pendingActionLabel = useMemo(() => {
    if (!pendingBatchAction) {
      return ''
    }
    return `批量修改账号状态为「${STATUS_LABELS[pendingBatchAction.value as UserStatus]}」`
  }, [pendingBatchAction])

  const pendingActionPreview = useMemo(() => {
    if (!pendingBatchAction) {
      return ''
    }
    return pendingBatchAction.userIds
      .slice(0, 5)
      .map((id) => listUserMap.get(id) ?? id)
      .join('、')
  }, [pendingBatchAction, listUserMap])

  const pendingClientActionText = useMemo(() => {
    if (!pendingClientAction) {
      return { title: '', targetLabel: '', impact: '' }
    }
    if (pendingClientAction.kind === 'device_block') {
      return {
        title: '请确认封禁客户端设备',
        targetLabel: pendingClientAction.device.device_name || pendingClientAction.device.device_id,
        impact: '该设备后续 API、Daemon、Desktop 请求会被服务端拒绝。',
      }
    }
    if (pendingClientAction.kind === 'device_unblock') {
      return {
        title: '请确认恢复客户端设备',
        targetLabel: pendingClientAction.device.device_name || pendingClientAction.device.device_id,
        impact: '该设备后续请求会恢复通过设备管控检查。',
      }
    }
    if (pendingClientAction.kind === 'device_block_all') {
      return {
        title: '请确认封禁该用户全部设备',
        targetLabel: selectedUser?.display_name || pendingClientAction.userId,
        impact: '该用户所有已登记设备会被封禁，客户端后续请求会失败。',
      }
    }
    if (pendingClientAction.kind === 'session_revoke') {
      return {
        title: '请确认吊销 Session',
        targetLabel: pendingClientAction.session.session_id || pendingClientAction.session.id,
        impact: '该 Session 会立即失效，客户端需要重新登录。',
      }
    }
    return {
      title: '请确认吊销该用户全部 Session',
      targetLabel: selectedUser?.display_name || pendingClientAction.userId,
      impact: '该用户全部 Session 会立即失效，所有端需要重新登录。',
    }
  }, [pendingClientAction, selectedUser])

  return (
    <div className="panel-container bg-muted/20">
      <div className="flex min-h-16 items-center justify-between gap-4 border-b bg-background px-6 py-3">
        <div>
          <h1 className="text-title font-semibold">客户用户</h1>
        </div>
        <div className="flex items-center gap-2">
          {currentUser?.is_superuser ? (
            <Button size="sm" variant="outline" onClick={openTestUserReset}>
              重置测试用户
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowAuditFilters((previous) => !previous)}
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            审计
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleExportAudit}
            disabled={listLoading || exportingAudit}
          >
            {exportingAudit ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            导出
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={listLoading || detailLoading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <CompactMetric label="总用户" value={summary?.total_users} icon={ShieldCheck} />
          <CompactMetric label="启用" value={summary?.active_users} icon={UserCheck} />
          <CompactMetric label="停用" value={summary?.inactive_users} icon={UserX} />
          <CompactMetric
            label="活跃会话"
            value={(listData?.items ?? []).reduce(
              (total, item) => total + item.active_session_count,
              0
            )}
            icon={Activity}
          />
        </div>

        <div className="rounded-xl border bg-background">
          {showAuditFilters ? (
            <div className="flex flex-wrap items-end gap-2 border-b bg-muted/20 px-4 py-3">
              <Input
                className="h-9 w-44"
                placeholder="动作类型"
                value={auditFilters.actionType}
                onChange={(event) =>
                  setAuditFilters((previous) => ({
                    ...previous,
                    actionType: event.target.value.trim(),
                  }))
                }
              />
              <Select
                value={auditFilters.success}
                onValueChange={(value) =>
                  setAuditFilters((previous) => ({
                    ...previous,
                    success: value as AuditSuccessFilter,
                  }))
                }
              >
                <SelectTrigger className="h-9 w-28">
                  <SelectValue placeholder="结果" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="success">成功</SelectItem>
                  <SelectItem value="failed">失败</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="h-9 w-48"
                type="datetime-local"
                aria-label="审计开始时间"
                value={auditFilters.startAt}
                onChange={(event) =>
                  setAuditFilters((previous) => ({ ...previous, startAt: event.target.value }))
                }
              />
              <Input
                className="h-9 w-48"
                type="datetime-local"
                aria-label="审计结束时间"
                value={auditFilters.endAt}
                onChange={(event) =>
                  setAuditFilters((previous) => ({ ...previous, endAt: event.target.value }))
                }
              />
              <Button size="sm" variant="ghost" onClick={resetAuditFilters}>
                重置
              </Button>
            </div>
          ) : null}

          <div className="flex min-h-[64px] flex-wrap items-center gap-3 border-b px-4 py-3">
            <div className="relative min-w-[280px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 pl-9"
                placeholder="ID / 用户名 / 昵称 / 邮箱 / 手机号"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleSearch()
                }}
              />
            </div>
            <Select
              value={filters.status}
              onValueChange={(value) => {
                setPage(1)
                setFilters((prev) => ({ ...prev, status: value as UserStatusFilter }))
              }}
            >
              <SelectTrigger className="h-9 w-32">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">启用</SelectItem>
                <SelectItem value="inactive">停用</SelectItem>
              </SelectContent>
            </Select>
            <span className="ml-auto whitespace-nowrap text-body text-muted-foreground">
              共 {summary?.filtered_users ?? pagination?.total ?? 0} 条结果
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setKeywordInput('')
                setFilters({ keyword: '', status: 'all' })
                setPage(1)
              }}
            >
              重置
            </Button>
            <Button size="sm" onClick={handleSearch}>
              查询
            </Button>
          </div>

          {selectedCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-body">
              <span className="font-medium">已选择 {selectedCount} 项</span>
              <PermissionGate permission={ADMIN_PERMISSION.USER_UPDATE_STATUS}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  onClick={() => openBatchConfirm('status', 'active')}
                  disabled={batchSubmitting}
                >
                  批量启用
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  onClick={() => openBatchConfirm('status', 'inactive')}
                  disabled={batchSubmitting}
                >
                  批量停用
                </Button>
              </PermissionGate>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                onClick={handleExportAudit}
                disabled={exportingAudit}
              >
                导出选中
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => setSelectedUserIds([])}
                disabled={batchSubmitting}
              >
                清除
              </Button>
            </div>
          ) : null}

          {operationMessage ? (
            <div className="border-b border-success/20 bg-success/5 px-4 py-2 text-body text-success">
              {operationMessage}
            </div>
          ) : null}
          {operationError ? (
            <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-body text-destructive">
              {operationError}
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full text-body" aria-label="客户用户列表">
              <thead className="border-b bg-muted/30 text-left text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={allSelectedOnPage}
                      onChange={toggleSelectAllOnPage}
                      aria-label="全选当前页"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">用户</th>
                  <th className="px-3 py-2 font-medium">联系方式</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">Organization</th>
                  <th className="px-3 py-2 font-medium">最近登录</th>
                  <th className="px-3 py-2 font-medium">注册时间</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {listLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      加载中
                    </td>
                  </tr>
                ) : listError ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-destructive">
                      {listError}
                    </td>
                  </tr>
                ) : listData?.items.length ? (
                  listData.items.map((item) => {
                    const isChecked = selectedUserIds.includes(item.id)
                    return (
                      <tr
                        key={item.id}
                        tabIndex={0}
                        className="h-16 cursor-pointer border-b last:border-0 hover:bg-muted/20"
                        onClick={() => openUserDetail(item.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            openUserDetail(item.id)
                          }
                        }}
                      >
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary"
                            checked={isChecked}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleSelectUser(item.id)}
                            aria-label={`选择用户 ${item.display_name}`}
                          />
                        </td>
                        <td className="max-w-[260px] px-3 py-2">
                          <UserIdentity user={item} onCopy={copyUserId} />
                        </td>
                        <td className="max-w-[220px] px-3 py-2 text-muted-foreground">
                          <div className="truncate">{item.email || '未绑定'}</div>
                          <div className="mt-0.5 truncate text-caption">
                            {item.phone || '未绑定'}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={buildStatusBadgeVariant(item.status)}>
                            {STATUS_LABELS[item.status]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {item.organization_summary?.organization_count ? (
                            <div className="min-w-0">
                              {item.organization_summary.primary_organization_id ? (
                                <EntityLink
                                  type="organization"
                                  id={item.organization_summary.primary_organization_id}
                                  label={
                                    item.organization_summary.primary_organization_name ||
                                    item.organization_summary.primary_organization_id
                                  }
                                  compact
                                />
                              ) : (
                                <span>
                                  {item.organization_summary.primary_organization_name || '—'}
                                </span>
                              )}
                              {item.organization_summary.organization_count > 1 ? (
                                <div className="mt-0.5 text-caption">
                                  共 {item.organization_summary.organization_count} 个
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            '暂无记录'
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                          {formatDateTime(item.last_login)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                          {formatDateTime(item.date_joined)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation()
                                openUserDetail(item.id)
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
                                openUserDetail(item.id)
                              }}
                              aria-label="更多"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t px-4 py-2 text-body text-muted-foreground">
            <span>
              共 {pagination?.total ?? 0} 条，{pagination?.page ?? 0}/{pagination?.total_pages ?? 0}
            </span>
            <div className="flex items-center gap-2">
              <PageSizeSelect
                value={pageSize}
                options={[10, 20, 30, 50, 100]}
                onChange={(nextPageSize) => {
                  setPageSize(nextPageSize)
                  setPage(1)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!pagination || pagination.page <= 1 || listLoading}
                onClick={() => setPage((prev) => Math.max(prev - 1, 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !pagination ||
                  pagination.total_pages === 0 ||
                  pagination.page >= pagination.total_pages ||
                  listLoading
                }
                onClick={() =>
                  setPage((prev) =>
                    pagination ? Math.min(prev + 1, pagination.total_pages || prev + 1) : prev + 1
                  )
                }
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={detailDrawerOpen} onOpenChange={setDetailDrawerOpen}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-w-[560px] translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 rounded-none p-0 sm:rounded-none data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>用户详情</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-hidden">
            {detailLoading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                加载中
              </div>
            ) : detailError ? (
              <div className="flex h-full items-center justify-center px-4 text-destructive">
                {detailError}
              </div>
            ) : detail?.user ? (
              <Tabs defaultValue="overview" className="flex h-full flex-col">
                <div className="border-b px-5 py-3">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-subtitle font-semibold">
                        {detail.user.display_name}
                      </div>
                      <div className="mt-1 text-caption text-muted-foreground">
                        <EntityLink
                          type="user"
                          id={detail.user.id}
                          label={compactId(detail.user.id, 12, 6)}
                          compact
                        />
                      </div>
                    </div>
                    <Badge variant={buildStatusBadgeVariant(detail.user.status)}>
                      {STATUS_LABELS[detail.user.status]}
                    </Badge>
                  </div>
                  <TabsList className="h-8 w-full justify-start overflow-x-auto">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="organization">Organization</TabsTrigger>
                    <TabsTrigger value="wallet">钱包</TabsTrigger>
                    <TabsTrigger value="sessions">客户端</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>
                </div>
                <ScrollArea className="flex-1">
                  <div className="p-5">
                    <TabsContent value="overview" className="mt-0 space-y-4">
                      <div className="rounded-lg border p-3 text-body">
                        <InfoRow label="用户 ID" value={detail.user.id} />
                        <InfoRow
                          label="用户名"
                          value={detail.user.username ? `@${detail.user.username}` : '—'}
                        />
                        <InfoRow label="邮箱" value={detail.user.email || '未绑定'} />
                        <InfoRow label="手机" value={detail.user.phone || '未绑定'} />
                        <InfoRow label="最近登录" value={formatDateTime(detail.user.last_login)} />
                        <InfoRow label="注册时间" value={formatDateTime(detail.user.date_joined)} />
                        <InfoRow label="活跃会话" value={detail.user.active_session_count} />
                      </div>

                      <div className="rounded-md border p-3">
                        <div className="mb-2 text-body font-semibold text-muted-foreground">
                          账号控制
                        </div>
                        <div className="flex gap-2">
                          <PermissionGate permission={ADMIN_PERMISSION.DEVICE_BLOCK}>
                            <Button
                              size="sm"
                              variant={detail.user.status === 'active' ? 'outline' : 'default'}
                              onClick={handleStatusToggle}
                              disabled={
                                savingStatus || (isSelfSelected && detail.user.status === 'active')
                              }
                            >
                              {savingStatus ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : null}
                              {detail.user.status === 'active' ? '停用' : '启用'}
                            </Button>
                          </PermissionGate>
                          <Button asChild size="sm" variant="ghost">
                            <Link to="/admin-accounts">后台账号</Link>
                          </Button>
                        </div>
                        {isSelfSelected ? (
                          <div className="text-body text-muted-foreground">当前账号受保护</div>
                        ) : null}
                      </div>
                    </TabsContent>

                    <TabsContent value="organization" className="mt-0 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-body font-semibold">
                          加入的组织
                          {userOrganizationsTotal > 0 ? ` · ${userOrganizationsTotal}` : ''}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => selectedUserId && loadUserOrganizations(selectedUserId)}
                          disabled={userOrganizationsLoading || !selectedUserId}
                        >
                          {userOrganizationsLoading ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-4 w-4" />
                          )}
                          刷新
                        </Button>
                      </div>

                      {userOrganizationsError ? (
                        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-body text-destructive">
                          {userOrganizationsError}
                        </div>
                      ) : null}

                      {userOrganizationsLoading ? (
                        <EmptyNote>
                          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                          加载组织中
                        </EmptyNote>
                      ) : userOrganizations.length ? (
                        <div className="space-y-2">
                          {userOrganizations.map((organization) => (
                            <div
                              key={organization.membership_id}
                              className="rounded-lg border p-3 text-body"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <EntityLink
                                    type="organization"
                                    id={organization.organization_id}
                                    label={organization.organization_name}
                                  />
                                  <div className="mt-1 text-caption text-muted-foreground">
                                    {ORGANIZATION_TYPE_LABELS[organization.organization_type] ||
                                      organization.organization_type ||
                                      '组织'}
                                    {organization.is_default ? ' · 默认' : ''}
                                    {organization.organization_status === 'deleting'
                                      ? ' · 删除中'
                                      : ''}
                                    {' · '}
                                    {organization.member_count} 名成员
                                  </div>
                                </div>
                                <Badge variant="secondary">
                                  {ORGANIZATION_ROLE_LABELS[organization.role] || organization.role}
                                </Badge>
                              </div>
                              <div className="mt-2 text-caption text-muted-foreground">
                                加入于 {formatDateTime(organization.joined_at)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyNote>该用户尚未加入任何组织</EmptyNote>
                      )}
                    </TabsContent>

                    <TabsContent value="wallet" className="mt-0 space-y-4">
                      {detail.user.wallet ? (
                        <div className="rounded-lg border p-3 text-body">
                          <InfoRow
                            label="余额"
                            value={detail.user.wallet.credits.toLocaleString()}
                          />
                          <InfoRow
                            label="冻结"
                            value={detail.user.wallet.credits_frozen.toLocaleString()}
                          />
                        </div>
                      ) : (
                        <EmptyNote />
                      )}
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={openTxDialog}>
                          <Receipt className="mr-2 h-4 w-4" />
                          账单
                        </Button>
                        <Button size="sm" onClick={openRechargeDialog}>
                          <Plus className="mr-2 h-4 w-4" />
                          充值
                        </Button>
                      </div>
                    </TabsContent>

                    <TabsContent value="sessions" className="mt-0 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-body font-semibold">Devices & Sessions</div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => selectedUserId && loadClientGovernance(selectedUserId)}
                            disabled={clientLoading || !selectedUserId}
                          >
                            {clientLoading ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            刷新
                          </Button>
                          <PermissionGate permission={ADMIN_PERMISSION.USER_UPDATE_STATUS}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                !selectedUserId || clientDevices.length === 0 || clientSubmitting
                              }
                              onClick={() =>
                                selectedUserId &&
                                setPendingClientAction({
                                  kind: 'device_block_all',
                                  userId: selectedUserId,
                                })
                              }
                            >
                              封禁全部设备
                            </Button>
                          </PermissionGate>
                          <PermissionGate permission={ADMIN_PERMISSION.SESSION_REVOKE}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                !selectedUserId || clientSessions.length === 0 || clientSubmitting
                              }
                              onClick={() =>
                                selectedUserId &&
                                setPendingClientAction({
                                  kind: 'session_revoke_all',
                                  userId: selectedUserId,
                                })
                              }
                            >
                              吊销全部 Session
                            </Button>
                          </PermissionGate>
                        </div>
                      </div>

                      {clientError ? (
                        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-body text-destructive">
                          {clientError}
                        </div>
                      ) : null}

                      <div className="space-y-2">
                        <div className="text-body font-semibold">设备</div>
                        {clientLoading ? (
                          <EmptyNote>
                            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                            加载设备中
                          </EmptyNote>
                        ) : clientDevices.length ? (
                          clientDevices.map((device) => (
                            <div
                              key={device.id || device.device_id}
                              className="rounded-lg border p-3 text-body"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate font-medium">
                                    {device.device_name || device.device_id}
                                  </div>
                                  <div className="mt-1 text-caption text-muted-foreground">
                                    {device.client_type || 'client'} ·{' '}
                                    {device.platform || 'unknown'} · v{device.app_version || '—'}
                                  </div>
                                  <div className="mt-1 font-mono text-caption text-muted-foreground">
                                    {device.device_id}
                                  </div>
                                </div>
                                <Badge
                                  variant={
                                    device.status === 'active'
                                      ? 'success'
                                      : device.status === 'blocked'
                                        ? 'destructive'
                                        : 'secondary'
                                  }
                                >
                                  {DEVICE_STATUS_LABELS[device.status] || device.status}
                                </Badge>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground">
                                <span>
                                  {device.ip_address || '未知 IP'} · 最后在线{' '}
                                  {formatDateTime(device.last_seen_at)}
                                </span>
                                <PermissionGate
                                  permission={
                                    device.status === 'blocked'
                                      ? ADMIN_PERMISSION.DEVICE_UNBLOCK
                                      : ADMIN_PERMISSION.DEVICE_BLOCK
                                  }
                                >
                                  {device.status === 'blocked' ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={clientSubmitting}
                                      onClick={() =>
                                        setPendingClientAction({ kind: 'device_unblock', device })
                                      }
                                    >
                                      恢复设备
                                    </Button>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={clientSubmitting}
                                      onClick={() =>
                                        setPendingClientAction({ kind: 'device_block', device })
                                      }
                                    >
                                      封禁设备
                                    </Button>
                                  )}
                                </PermissionGate>
                              </div>
                              {device.blocked_reason ? (
                                <div className="mt-2 rounded bg-muted px-2 py-1 text-caption text-muted-foreground">
                                  封禁原因：{device.blocked_reason}
                                </div>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <EmptyNote>暂无设备记录</EmptyNote>
                        )}
                      </div>

                      <div className="space-y-2">
                        <div className="text-body font-semibold">Session</div>
                        {clientLoading ? (
                          <EmptyNote>
                            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                            加载 Session 中
                          </EmptyNote>
                        ) : clientSessions.length ? (
                          clientSessions.map((session) => (
                            <div key={session.id} className="rounded-lg border p-3 text-body">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-medium">
                                    {session.client_type || session.session_type || 'session'}
                                  </div>
                                  <div className="mt-1 font-mono text-caption text-muted-foreground">
                                    {session.session_id || session.id}
                                  </div>
                                </div>
                                <Badge
                                  variant={
                                    session.revoked_at
                                      ? 'destructive'
                                      : session.is_active
                                        ? 'success'
                                        : 'outline'
                                  }
                                >
                                  {session.revoked_at
                                    ? '已吊销'
                                    : session.is_active
                                      ? '在线'
                                      : '离线'}
                                </Badge>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground">
                                <span>
                                  {session.ip_address || '未知 IP'} · 最后活动{' '}
                                  {formatDateTime(session.last_activity || session.last_seen_at)}
                                </span>
                                <PermissionGate permission={ADMIN_PERMISSION.SESSION_REVOKE}>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={clientSubmitting || Boolean(session.revoked_at)}
                                    onClick={() =>
                                      setPendingClientAction({ kind: 'session_revoke', session })
                                    }
                                  >
                                    吊销 Session
                                  </Button>
                                </PermissionGate>
                              </div>
                              {session.revoked_reason ? (
                                <div className="mt-2 rounded bg-muted px-2 py-1 text-caption text-muted-foreground">
                                  吊销原因：{session.revoked_reason}
                                </div>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <EmptyNote>暂无 Session 记录</EmptyNote>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="audit" className="mt-0">
                      {detail.recent_actions.length ? (
                        <div className="space-y-2">
                          {detail.recent_actions.map((action) => (
                            <div key={action.id} className="rounded-lg border p-3 text-body">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-medium">{action.action_type}</span>
                                <Badge variant={action.success ? 'success' : 'destructive'}>
                                  {action.success ? '成功' : '失败'}
                                </Badge>
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                {action.description || '—'}
                              </div>
                              <div className="mt-1 text-caption text-muted-foreground">
                                {action.ip_address} · {formatDateTime(action.created_at)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyNote />
                      )}
                    </TabsContent>
                  </div>
                </ScrollArea>
              </Tabs>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                暂无记录
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={testUserResetOpen} onOpenChange={setTestUserResetOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>重置测试用户</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-body">
            <div className="rounded-md border bg-muted/30 p-3 text-muted-foreground">
              该入口仅用于 test / dev 环境清理脏账号数据。默认先 dry-run
              预检查；真实重置会清理该手机号对应账号及客户端业务数据，生产环境后端会拒绝。
            </div>
            <label className="block font-medium" htmlFor="test-user-reset-phone">
              手机号
            </label>
            <Input
              id="test-user-reset-phone"
              value={testUserResetPhone}
              onChange={(event) => setTestUserResetPhone(event.target.value)}
              placeholder="例如 15921194230"
              disabled={testUserResetLoading}
            />
            <label className="block font-medium" htmlFor="test-user-reset-confirm">
              真实重置确认串
            </label>
            <Input
              id="test-user-reset-confirm"
              value={testUserResetConfirm}
              onChange={(event) => setTestUserResetConfirm(event.target.value)}
              placeholder="真实重置请输入 DELETE_DIRTY_USER_DATA"
              disabled={testUserResetLoading}
            />
            {testUserResetError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                {testUserResetError}
              </div>
            ) : null}
            {testUserResetResult ? (
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="font-medium">{testUserResetResult.message}</div>
                <div className="mt-1 text-muted-foreground">
                  手机号 {testUserResetResult.phone} / 用户{' '}
                  {testUserResetResult.user_id || '未找到'} /{' '}
                  {testUserResetResult.dry_run ? '预检查' : '已真实重置'}
                </div>
                <pre className="mt-3 max-h-56 overflow-auto rounded bg-muted/40 p-2 text-caption">
                  {JSON.stringify(
                    {
                      counts_before: testUserResetResult.counts_before,
                      counts_after: testUserResetResult.counts_after,
                      cleanup_stats: testUserResetResult.cleanup_stats,
                      delete_result: testUserResetResult.delete_result,
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={testUserResetLoading}
                onClick={() => setTestUserResetOpen(false)}
              >
                关闭
              </Button>
              <Button
                variant="outline"
                disabled={testUserResetLoading || !testUserResetPhone.trim()}
                onClick={() => void runTestUserReset(true)}
              >
                {testUserResetLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                预检查
              </Button>
              <Button
                variant="destructive"
                disabled={
                  testUserResetLoading ||
                  !testUserResetPhone.trim() ||
                  testUserResetConfirm.trim() !== 'DELETE_DIRTY_USER_DATA'
                }
                onClick={() => void runTestUserReset(false)}
              >
                真实重置
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SensitiveActionConfirmDialog
        open={Boolean(pendingBatchAction)}
        title="请确认批量客户状态变更"
        targetLabel={`客户用户 ${pendingBatchAction?.userIds.length ?? 0} 人`}
        impact={`${pendingActionLabel || '批量状态变更'}。示例用户：${pendingActionPreview || '—'}`}
        confirmText="确认"
        loading={batchSubmitting}
        onCancel={closeBatchConfirm}
        onConfirm={executePendingBatchAction}
      />

      <SensitiveActionConfirmDialog
        open={Boolean(pendingStatusAction)}
        title={
          pendingStatusAction?.nextStatus === 'active' ? '请确认启用客户用户' : '请确认停用客户用户'
        }
        targetLabel={
          pendingStatusAction
            ? `${pendingStatusAction.displayName} (${pendingStatusAction.userId})`
            : '客户用户'
        }
        impact={
          pendingStatusAction?.nextStatus === 'active'
            ? '该客户用户将恢复登录和产品访问能力。'
            : '该客户用户将被停用，后续登录会被拦截。'
        }
        loading={savingStatus}
        onCancel={() => setPendingStatusAction(null)}
        onConfirm={executePendingStatusAction}
      />

      <SensitiveActionConfirmDialog
        open={Boolean(pendingClientAction)}
        title={pendingClientActionText.title}
        targetLabel={pendingClientActionText.targetLabel}
        impact={pendingClientActionText.impact}
        loading={clientSubmitting}
        onCancel={() => setPendingClientAction(null)}
        onConfirm={executePendingClientAction}
      />

      <TransactionDialog
        open={txDialogOpen}
        onOpenChange={setTxDialogOpen}
        userName={selectedUser?.display_name || '用户'}
        data={txData}
        loading={txLoading}
        page={txPage}
        pageSize={txPageSize}
        typeFilter={txTypeFilter}
        onPageChange={handleTxPageChange}
        onPageSizeChange={handleTxPageSizeChange}
        onTypeFilterChange={handleTxTypeFilterChange}
      />

      {selectedUserId ? (
        <RechargeDialog
          open={rechargeDialogOpen}
          onOpenChange={setRechargeDialogOpen}
          userId={selectedUserId}
          userName={selectedUser?.display_name || '用户'}
          walletCredits={detail?.user.wallet?.credits ?? null}
          onSuccess={handleRechargeSuccess}
          onError={(msg) => setOperationError(msg)}
        />
      ) : null}
    </div>
  )
}
