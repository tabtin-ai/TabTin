import { spaceAdminApi } from '@/api/space-admin'
import {
  AdminAuditTimelineCard,
  type AdminTimelineItem,
} from '@/components/admin-page/AdminAuditTimelineCard'
import { EntityLink } from '@/components/entity-links/EntityLink'
import { OrganizationCreditLedgerSection } from '@/components/spaces/organization-credit-ledger-section'
import { OrganizationMemberUsage } from '@/components/spaces/organization-member-usage'
import { OrganizationWalletSection } from '@/components/spaces/organization-wallet-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import type {
  AdminActionLogItem,
  SpaceSummary,
  OrganizationMember,
  OrganizationSummary,
} from '@/types/space-admin'
import {
  ArrowLeft,
  ChevronRight,
  CreditCard,
  Loader2,
  RefreshCw,
  Search,
  Ticket,
  Users,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

const ACTION_LABELS: Record<string, string> = {
  organization_create: '创建组织',
  organization_update: '更新组织',
  organization_delete: '删除组织',
  space_create: '创建 Space',
  space_update: '更新 Space',
  space_archive: '归档 Space',
  space_restore: '恢复 Space',
  space_delete: '删除 Space',
  organization_wallet_recharge: '组织钱包充值',
  resource_delete: '删除资源',
  resource_restore: '恢复资源',
}

function mapOrganizationAuditItem(item: AdminActionLogItem): AdminTimelineItem {
  return {
    id: item.id,
    source: 'organization',
    action: item.action_type,
    summary: ACTION_LABELS[item.action_type] || item.action_type,
    actorId: item.operator_id,
    actorLabel: item.operator_name || item.operator_id,
    objectType: item.target_type,
    objectId: item.target_id,
    reason: item.error_message || item.message || item.trace_id,
    createdAt: item.created_at,
    severity: item.success === false ? 'warning' : 'info',
  }
}

type OrganizationSortMode =
  | 'updated_desc'
  | 'updated_asc'
  | 'created_desc'
  | 'created_asc'
  | 'name_asc'
  | 'name_desc'
  | 'space_desc'
  | 'member_desc'
  | 'wallet_desc'
  | 'wallet_asc'

const ORGANIZATION_SORT_OPTIONS: Array<{ label: string; value: OrganizationSortMode }> = [
  { label: '最近更新', value: 'updated_desc' },
  { label: '最早更新', value: 'updated_asc' },
  { label: '最新创建', value: 'created_desc' },
  { label: '最早创建', value: 'created_asc' },
  { label: '名称 A-Z', value: 'name_asc' },
  { label: '名称 Z-A', value: 'name_desc' },
  { label: 'Space 数高到低', value: 'space_desc' },
  { label: '成员数高到低', value: 'member_desc' },
  { label: '余额高到低', value: 'wallet_desc' },
  { label: '余额低到高', value: 'wallet_asc' },
]

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE_OPTIONS = [20, 30, 50, 100]


const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return '发生未知错误'
}

const SPACE_STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '暂停',
  completed: '完成',
  archived: '归档状态',
  trashed: '回收站中',
}

const ORGANIZATION_ROLE_LABELS: Record<OrganizationMember['role'], string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '编辑者',
  viewer: '查看者',
}

// =====================================================================
// 组织列表页 — /organizations
// =====================================================================

export function OrganizationsListPage() {
  const navigate = useNavigate()

  const [organizationKeywordInput, setOrganizationKeywordInput] = useState('')
  const [ownerKeywordInput, setOwnerKeywordInput] = useState('')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [ownerKeyword, setOwnerKeyword] = useState('')
  const [organizationSortMode, setOrganizationSortMode] = useState<OrganizationSortMode>('updated_desc')

  const [organizationPool, setOrganizationPool] = useState<OrganizationSummary[]>([])
  const [organizationsTotal, setOrganizationsTotal] = useState(0)
  const [organizationsPage, setOrganizationsPage] = useState(1)
  const [organizationsPageSize, setOrganizationsPageSize] = useState(20)
  const [organizationsTotalPages, setOrganizationsTotalPages] = useState(1)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [actionLoading, setActionLoading] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')

  const organizations = organizationPool

  const loadOrganizations = useCallback(
    async ({ keyword, owner, page }: { keyword?: string; owner?: string; page?: number } = {}) => {
      setListLoading(true)
      setListError(null)

      try {
        const normalizedOwner = owner?.trim() || ''
        const nextPage = page ?? 1
        const response = await spaceAdminApi.listOrganizations({
          search: keyword,
          ownerId: UUID_PATTERN.test(normalizedOwner) ? normalizedOwner : undefined,
          ownerKeyword: normalizedOwner,
          sort: organizationSortMode,
          page: nextPage,
          pageSize: organizationsPageSize,
        })
        const nextOrganizations = response.organizations || []
        setOrganizationPool(nextOrganizations)
        setOrganizationsTotal(response.total || nextOrganizations.length)
        setOrganizationsPage(response.pagination?.page ?? nextPage)
        setOrganizationsTotalPages(Math.max(response.pagination?.total_pages ?? 1, 1))
      } catch (loadError) {
        setListError(`组织加载失败：${toErrorMessage(loadError)}`)
        setOrganizationPool([])
        setOrganizationsTotal(0)
        setOrganizationsPage(1)
        setOrganizationsTotalPages(1)
      } finally {
        setListLoading(false)
      }
    },
    [organizationSortMode, organizationsPageSize]
  )

  useEffect(() => {
    void loadOrganizations({ keyword: searchKeyword, owner: ownerKeyword, page: organizationsPage })
  }, [searchKeyword, ownerKeyword, organizationsPage, loadOrganizations])

  // 从用户侧切回 AdminDash 标签页时重拉列表，避免成员数列停在进页快照
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void loadOrganizations({
        keyword: searchKeyword,
        owner: ownerKeyword,
        page: organizationsPage,
      })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadOrganizations, searchKeyword, ownerKeyword, organizationsPage])

  const defaultCount = useMemo(
    () => organizations.filter((organization) => organization.is_default).length,
    [organizations]
  )

  const handleSearch = () => {
    setOrganizationsPage(1)
    setSearchKeyword(organizationKeywordInput.trim())
    setOwnerKeyword(ownerKeywordInput.trim())
  }

  const handleSortChange = (value: string) => {
    setOrganizationSortMode(value as OrganizationSortMode)
    setOrganizationsPage(1)
  }

  const handleOrganizationsPageSizeChange = (value: string) => {
    setOrganizationsPage(1)
    setOrganizationsPageSize(Number(value))
  }

  const handleSelectOrganization = (organizationId: string) => {
    navigate(`/organizations/${organizationId}`)
  }

  const handleCreateOrganization = async () => {
    const name = createName.trim()
    if (!name) {
      setListError('组织创建失败：名称不能为空')
      return
    }

    setActionLoading(true)
    setActionMessage(null)
    setListError(null)

    try {
      const created = await spaceAdminApi.createOrganization({
        name,
        description: createDescription.trim(),
      })

      setActionMessage(`组织创建成功：${created.name}`)
      setCreateName('')
      setCreateDescription('')
      setCreateOpen(false)
      navigate(`/organizations/${created.id}`)
    } catch (createError) {
      setListError(`组织创建失败：${toErrorMessage(createError)}`)
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">组织管理</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setCreateOpen((prev) => !prev)
              setActionMessage(null)
            }}
            disabled={actionLoading}
          >
            {createOpen ? '收起创建' : '新建组织'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void loadOrganizations({
                keyword: searchKeyword,
                owner: ownerKeyword,
                page: organizationsPage,
              })
            }
            disabled={listLoading}
          >
            {listLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden bg-muted/5 p-4">
        <div className="flex h-full min-h-0 flex-col gap-4">
          {actionMessage ? (
            <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
              {actionMessage}
            </div>
          ) : null}

          {createOpen ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-subtitle">创建组织</CardTitle>
                <CardDescription>仅超级管理员可执行</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <Input
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="请输入组织名称"
                  />
                  <Input
                    value={createDescription}
                    onChange={(event) => setCreateDescription(event.target.value)}
                    placeholder="请输入组织描述（可选）"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={() => void handleCreateOrganization()} disabled={actionLoading}>
                    {actionLoading ? '创建中...' : '确认创建'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCreateOpen(false)
                      setCreateName('')
                      setCreateDescription('')
                    }}
                    disabled={actionLoading}
                  >
                    取消
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="text-subtitle">组织宽屏列表</CardTitle>
              <CardDescription>
                总数 {organizationsTotal} · 当前页 {organizations.length} · 第 {organizationsPage}/
                {organizationsTotalPages} 页 · 本页默认 {defaultCount}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-0">
              <div className="grid gap-2 lg:grid-cols-[1.1fr_1fr_220px_auto]">
                <Input
                  placeholder="按名称/描述搜索组织"
                  value={organizationKeywordInput}
                  onChange={(event) => setOrganizationKeywordInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleSearch()
                    }
                  }}
                />

                <Input
                  placeholder="搜索用户（owner 名称或 ID）"
                  value={ownerKeywordInput}
                  onChange={(event) => setOwnerKeywordInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleSearch()
                    }
                  }}
                />

                <Select value={organizationSortMode} onValueChange={handleSortChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="排序方式" />
                  </SelectTrigger>
                  <SelectContent>
                    {ORGANIZATION_SORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button onClick={handleSearch}>
                  <Search className="mr-2 h-4 w-4" />
                  搜索
                </Button>
              </div>

              {listError ? (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
                  {listError}
                </div>
              ) : null}

              {listLoading ? (
                <div className="flex h-48 items-center justify-center rounded-md border bg-background text-body text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载中...
                </div>
              ) : null}

              {!listLoading && organizations.length === 0 ? (
                <div className="rounded-md border border-dashed p-8 text-center text-body text-muted-foreground">
                  暂无组织数据
                </div>
              ) : null}

              {!listLoading && organizations.length > 0 ? (
                <>
                  <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
                    <table className="min-w-full text-body">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">组织</th>
                          <th className="px-3 py-2 text-left font-medium">所有者</th>
                          <th className="px-3 py-2 text-right font-medium">credits 余额</th>
                          <th className="px-3 py-2 text-left font-medium">Space 数</th>
                          <th className="px-3 py-2 text-left font-medium">成员数</th>
                          <th className="px-3 py-2 text-left font-medium">默认</th>
                          <th className="px-3 py-2 text-left font-medium">更新时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {organizations.map((organization) => (
                          <tr
                            key={organization.id}
                            className="cursor-pointer border-t transition-colors hover:bg-muted/30"
                            onMouseDown={() => handleSelectOrganization(organization.id)}
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium">{organization.name}</div>
                              <div className="line-clamp-1 text-body text-muted-foreground">
                                {organization.description || '暂无描述'}
                              </div>
                              <div className="text-caption text-muted-foreground">
                                {organization.id}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-body">
                              {organization.owner_name || organization.owner_id || '-'}
                            </td>
                            <td className="px-3 py-2 text-right text-body font-mono">
                              {organization.wallet_credits != null
                                ? `${organization.wallet_credits.toLocaleString()} 点`
                                : '-'}
                            </td>
                            <td className="px-3 py-2 text-body">{organization.space_count}</td>
                            <td className="px-3 py-2 text-body">{organization.member_count}</td>
                            <td className="px-3 py-2">
                              {organization.is_default ? (
                                <Badge variant="warning">默认</Badge>
                              ) : (
                                <Badge variant="secondary">否</Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 text-body text-muted-foreground">
                              {formatDateTime(organization.updated_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-body text-muted-foreground">
                    <span>
                      共 {organizationsTotal} 条，第 {organizationsPage}/{organizationsTotalPages} 页
                    </span>
                    <div className="flex items-center gap-2">
                      <span>每页</span>
                      <Select
                        value={String(organizationsPageSize)}
                        onValueChange={handleOrganizationsPageSizeChange}
                      >
                        <SelectTrigger className="h-8 w-[92px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAGE_SIZE_OPTIONS.map((option) => (
                            <SelectItem key={option} value={String(option)}>
                              {option} 条
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={listLoading || organizationsPage <= 1}
                        onClick={() => setOrganizationsPage((page) => Math.max(page - 1, 1))}
                      >
                        上一页
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={listLoading || organizationsPage >= organizationsTotalPages}
                        onClick={() =>
                          setOrganizationsPage((page) => Math.min(page + 1, organizationsTotalPages))
                        }
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 组织详情页 — /organizations/:organizationId
// =====================================================================

const SPACE_PREVIEW_PAGE_SIZE = 10

export function OrganizationDetailPage() {
  const navigate = useNavigate()
  const { organizationId } = useParams<{ organizationId: string }>()
  const { adminPermissions } = useAuthStore()

  const [organizationDetail, setOrganizationDetail] = useState<OrganizationSummary | null>(null)
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationMember[]>([])
  const [organizationMembersTotal, setOrganizationMembersTotal] = useState<number | null>(null)
  const [organizationMembersPage, setOrganizationMembersPage] = useState(1)
  const [organizationMembersPageSize, setOrganizationMembersPageSize] = useState(20)
  const [organizationMembersTotalPages, setOrganizationMembersTotalPages] = useState(1)
  const [organizationSpaces, setOrganizationSpaces] = useState<SpaceSummary[]>([])
  const [organizationAuditLogs, setOrganizationAuditLogs] = useState<AdminActionLogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)

  // 切回后台标签页时重拉详情与成员状态
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setReloadVersion((value) => value + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    if (!organizationId) {
      return
    }

    let active = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const [detail, memberData, spaceData] = await Promise.all([
          spaceAdminApi.getOrganization(organizationId),
          spaceAdminApi.listOrganizationMembers(organizationId, {
            page: organizationMembersPage,
            pageSize: organizationMembersPageSize,
          }),
          spaceAdminApi.listSpaces({
            organizationId,
            page: 1,
            pageSize: SPACE_PREVIEW_PAGE_SIZE,
          }),
        ])

        if (!active) {
          return
        }

        setOrganizationDetail(detail)
        setOrganizationMembers(memberData.members || [])
        setOrganizationMembersTotal(memberData.total ?? 0)
        setOrganizationMembersPage(memberData.pagination?.page ?? organizationMembersPage)
        setOrganizationMembersTotalPages(Math.max(memberData.pagination?.total_pages ?? 1, 1))
        setOrganizationSpaces(spaceData.spaces || [])

        try {
          const auditData = await spaceAdminApi.listOrganizationAuditLogs(organizationId, {
            page: 1,
            pageSize: 8,
          })
          if (!active) {
            return
          }
          setOrganizationAuditLogs(auditData.items || [])
        } catch {
          if (!active) {
            return
          }
          setOrganizationAuditLogs([])
        }
      } catch (loadError) {
        if (!active) {
          return
        }
        setError(`组织详情加载失败：${toErrorMessage(loadError)}`)
        setOrganizationDetail(null)
        setOrganizationMembers([])
        setOrganizationMembersTotal(null)
        setOrganizationMembersPage(1)
        setOrganizationMembersTotalPages(1)
        setOrganizationSpaces([])
        setOrganizationAuditLogs([])
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    })()

    return () => {
      active = false
    }
  }, [organizationId, organizationMembersPage, organizationMembersPageSize, reloadVersion])

  const totalSpaces = organizationDetail?.space_count ?? organizationSpaces.length
  const totalMembers = organizationMembersTotal ?? organizationDetail?.member_count ?? 0
  const canOpenWalletList = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.WALLET_LIST)
  const canOpenCreditPackages = hasAdminPermission(
    adminPermissions,
    ADMIN_PERMISSION.CREDIT_PACKAGE_LIST
  )
  const canOpenBillingEvents = hasAdminPermission(
    adminPermissions,
    ADMIN_PERMISSION.BILLING_EVENT_LIST
  )
  const canOpenUsage = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.USAGE_EVENT_LIST)
  const canOpenInvoices = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.INVOICE_LIST)
  const canOpenCostAnalysis = hasAdminPermission(
    adminPermissions,
    ADMIN_PERMISSION.COST_ANALYSIS_VIEW
  )
  const canOpenRisk = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.ANOMALY_ALERT_LIST)
  const canOpenAudit = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.AUDIT_LOG_LIST)

  const handleOrganizationMembersPageSizeChange = (value: string) => {
    setOrganizationMembersPage(1)
    setOrganizationMembersPageSize(Number(value))
  }

  if (!organizationId) {
    return (
      <div className="flex h-full items-center justify-center text-body text-muted-foreground">
        缺少 organizationId 参数
      </div>
    )
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate('/organizations')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回列表
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-title font-semibold">
              {organizationDetail?.name || '组织详情'}
            </h1>
            <EntityLink type="organization" id={organizationId} label={organizationId} compact />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {error ? (
          <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}

        {loading && !organizationDetail ? (
          <div className="flex h-32 items-center justify-center text-body text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载组织详情...
          </div>
        ) : null}

        {!loading && !organizationDetail ? (
          <div className="rounded-md border border-dashed p-4 text-body text-muted-foreground">
            未找到组织详情
          </div>
        ) : null}

        {!loading && organizationDetail ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">组织名称</div>
                <div className="mt-1 font-medium">{organizationDetail.name}</div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">所有者</div>
                <div className="mt-1 font-medium">
                  <EntityLink
                    type="user"
                    id={organizationDetail.owner_id}
                    label={organizationDetail.owner_name || organizationDetail.owner_id}
                    compact
                  />
                </div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">成员数</div>
                <div className="mt-1 flex items-center gap-2 font-medium">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  {totalMembers}
                </div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">Space 数</div>
                <div className="mt-1 font-medium">{totalSpaces}</div>
              </div>
              <div className="rounded-md border bg-background p-3 md:col-span-2 xl:col-span-4">
                <div className="text-body text-muted-foreground">描述</div>
                <div className="mt-1 text-body">{organizationDetail.description || '暂无描述'}</div>
              </div>
            </div>

            <Card>
              <CardHeader className="space-y-1 pb-2">
                <CardTitle className="text-subtitle">Organization 排障导航</CardTitle>
                <CardDescription>
                  从组织入口直达成员、Space、credits钱包、用量、扣费、账单、审计和风险状态，跳转时自动携带
                  organizationId。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
                <Button
                  variant="outline"
                  className="justify-start"
                  onClick={() => navigate(`/organizations/${organizationId}#members`)}
                >
                  成员
                </Button>
                <Button
                  variant="outline"
                  className="justify-start"
                  onClick={() => navigate(`/spaces?organizationId=${organizationId}`)}
                >
                  Space
                </Button>
                {canOpenWalletList ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => navigate(`/billing/wallets?keyword=${organizationId}`)}
                  >
                    credits 钱包 / 流水
                  </Button>
                ) : null}
                {canOpenUsage ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => navigate(`/ai-ops/usage?organization_id=${organizationId}`)}
                  >
                    用量统计
                  </Button>
                ) : null}
                {canOpenBillingEvents ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => navigate(`/billing/events?organization_id=${organizationId}`)}
                  >
                    扣费事件
                  </Button>
                ) : null}
                {canOpenInvoices ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() =>
                      navigate(
                        `/billing/payment-orders?organization=${encodeURIComponent(organizationId)}`
                      )
                    }
                  >
                    支付订单
                  </Button>
                ) : null}
                {canOpenCostAnalysis ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => navigate(`/billing/cost-analysis?organization_id=${organizationId}`)}
                  >
                    成本分析
                  </Button>
                ) : null}
                {canOpenRisk ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => navigate(`/billing/anomalies?organization_id=${organizationId}`)}
                  >
                    风险状态
                  </Button>
                ) : null}
                {canOpenAudit ? (
                  <Button
                    variant="outline"
                    className="justify-start"
                    onClick={() => navigate(`/billing/audit-log?organization_id=${organizationId}`)}
                  >
                    审计
                  </Button>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="space-y-1 pb-2">
                <CardTitle className="flex items-center gap-2 text-subtitle">
                  <CreditCard className="h-4 w-4" />
                  计费资产总览
                </CardTitle>
                <CardDescription>
                  客服排障入口：成员预算只是限制，当前实际扣费主体仍是组织套餐credits或credits钱包；Cash
                  Wallet 暂未接入。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {canOpenWalletList ? (
                  <button
                    type="button"
                    className="rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/40"
                    onClick={() => navigate(`/billing/wallets?keyword=${organizationId}`)}
                  >
                    <div className="flex items-center gap-2 text-body text-muted-foreground">
                      <Wallet className="h-4 w-4" />
                      credits 余额
                    </div>
                    <div className="mt-1 font-medium">
                      {organizationDetail.wallet_credits != null
                        ? `${organizationDetail.wallet_credits.toLocaleString()} 点`
                        : '进入 credits 钱包查看'}
                    </div>
                  </button>
                ) : null}
                {canOpenCreditPackages ? (
                  <button
                    type="button"
                    className="rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/40"
                    onClick={() => navigate('/billing/products#credits')}
                  >
                    <div className="flex items-center gap-2 text-body text-muted-foreground">
                      <Ticket className="h-4 w-4" />
                      credits 资源包配置
                    </div>
                    <div className="mt-1 font-medium">单位：点；现金钱包后端暂未接入</div>
                  </button>
                ) : null}
                {canOpenBillingEvents ? (
                  <button
                    type="button"
                    className="rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/40"
                    onClick={() => navigate(`/billing/events?organization_id=${organizationId}`)}
                  >
                    <div className="text-body text-muted-foreground">最近扣费来源</div>
                    <div className="mt-1 font-medium">查看 Billing Event</div>
                  </button>
                ) : null}
                {canOpenUsage ? (
                  <button
                    type="button"
                    className="rounded-md border bg-background p-3 text-left transition-colors hover:border-primary/40"
                    onClick={() => navigate('/ai-ops/usage')}
                  >
                    <div className="text-body text-muted-foreground">成员预算与用量</div>
                    <div className="mt-1 font-medium">限制口径，不是成员钱包</div>
                  </button>
                ) : null}
                {!canOpenWalletList &&
                !canOpenCreditPackages &&
                !canOpenBillingEvents &&
                !canOpenUsage ? (
                  <div className="rounded-md border border-dashed bg-muted/20 p-3 text-body text-muted-foreground md:col-span-2 xl:col-span-4">
                    当前账号为只读组织治理视图；计费中心、钱包管理和模型用量入口仅对有对应权限的管理员展示。
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <OrganizationWalletSection organizationId={organizationId} organizationName={organizationDetail.name} />

            <OrganizationCreditLedgerSection organizationId={organizationId} />

            <OrganizationMemberUsage organizationId={organizationId} />

            <Card>
              <CardHeader className="space-y-1 pb-2">
                <CardTitle className="text-subtitle">组织成员</CardTitle>
                <CardDescription>
                  共 {organizationMembersTotal ?? 0} 人，第 {organizationMembersPage}/
                  {organizationMembersTotalPages} 页；按加入时间倒序。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {organizationMembers.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
                    当前组织暂无成员
                  </div>
                ) : (
                  <>
                    <div className="overflow-auto rounded-md border">
                      <table className="min-w-full text-body">
                        <thead className="bg-muted/30">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">成员</th>
                            <th className="px-3 py-2 text-left font-medium">角色</th>
                            <th className="px-3 py-2 text-left font-medium">加入时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {organizationMembers.map((member) => (
                            <tr key={member.id} className="border-t">
                              <td className="px-3 py-2">
                                <div className="font-medium">
                                  <EntityLink
                                    type="user"
                                    id={member.user_id}
                                    label={member.user_name || member.user_id}
                                    compact
                                  />
                                </div>
                                <div className="text-caption text-muted-foreground">
                                  {member.user_id}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <Badge variant="outline">
                                  {ORGANIZATION_ROLE_LABELS[member.role] || member.role}
                                </Badge>
                              </td>
                              <td className="px-3 py-2 text-body text-muted-foreground">
                                {formatDateTime(member.joined_at)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-body text-muted-foreground">
                      <span>
                        共 {organizationMembersTotal ?? 0} 人，第 {organizationMembersPage}/
                        {organizationMembersTotalPages} 页
                      </span>
                      <div className="flex items-center gap-2">
                        <span>每页</span>
                        <Select
                          value={String(organizationMembersPageSize)}
                          onValueChange={handleOrganizationMembersPageSizeChange}
                        >
                          <SelectTrigger className="h-8 w-[92px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PAGE_SIZE_OPTIONS.map((option) => (
                              <SelectItem key={option} value={String(option)}>
                                {option} 条
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={loading || organizationMembersPage <= 1}
                          onClick={() => setOrganizationMembersPage((page) => Math.max(page - 1, 1))}
                        >
                          上一页
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={loading || organizationMembersPage >= organizationMembersTotalPages}
                          onClick={() =>
                            setOrganizationMembersPage((page) =>
                              Math.min(page + 1, organizationMembersTotalPages)
                            )
                          }
                        >
                          下一页
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="space-y-1 pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-subtitle">该组织下的 Space</CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/spaces?organizationId=${organizationId}`)}
                  >
                    查看全部 {totalSpaces}
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
                <CardDescription>
                  最多展示 {SPACE_PREVIEW_PAGE_SIZE} 条；点击单行查看 Space 详情。
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                {organizationSpaces.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
                    当前组织暂无 Space
                  </div>
                ) : (
                  <div className="overflow-auto rounded-md border">
                    <table className="min-w-full text-body">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Space</th>
                          <th className="px-3 py-2 text-left font-medium">状态</th>
                          <th className="px-3 py-2 text-left font-medium">表格数</th>
                          <th className="px-3 py-2 text-left font-medium">更新时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {organizationSpaces.map((space) => (
                          <tr
                            key={space.id}
                            className="cursor-pointer border-t transition-colors hover:bg-muted/30"
                            onMouseDown={() => navigate(`/spaces/${space.id}`)}
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium">
                                <EntityLink type="space" id={space.id} label={space.name} compact />
                              </div>
                              <div className="line-clamp-1 text-body text-muted-foreground">
                                {space.description || '暂无描述'}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">
                                  {SPACE_STATUS_LABELS[space.status] || space.status}
                                </Badge>
                                {space.is_archived ? (
                                  <Badge variant="secondary">已归档</Badge>
                                ) : (
                                  <Badge variant="success">未归档</Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2">{space.table_count}</td>
                            <td className="px-3 py-2 text-body text-muted-foreground">
                              {formatDateTime(space.updated_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            <AdminAuditTimelineCard
              title="Organization 统一时间线"
              items={organizationAuditLogs.map(mapOrganizationAuditItem)}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
