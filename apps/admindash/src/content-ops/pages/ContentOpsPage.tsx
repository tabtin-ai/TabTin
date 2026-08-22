import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getContentOverview } from '@/content-ops/api/content-ops'
import type { ContentOverviewResponse } from '@/content-ops/types'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import {
  Database,
  FileText,
  FolderKanban,
  Loader2,
  Mail,
  Presentation,
  RefreshCw,
  Table2,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

interface ResourceModuleItem {
  title: string
  count: string
  issueCount: number
  icon: LucideIcon
  href: string
  updatedAt: string
  status: 'normal' | 'warning' | 'danger'
  tone?: 'default' | 'warning' | 'danger'
}

interface AttentionQueueItem {
  type: string
  count: number
  href: string
  priority: '普通' | '高' | '紧急'
  action: '查看' | '处理'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '加载失败'
}

function CompactKpi({
  title,
  value,
  status,
  icon: Icon,
  tone = 'default',
  onClick,
}: {
  title: string
  value: number | string
  status: string
  icon: LucideIcon
  tone?: 'default' | 'warning' | 'danger'
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex items-center justify-between rounded-lg border bg-background px-4 py-3 text-left transition-colors hover:border-primary/40',
        tone === 'warning' && 'border-warning/40',
        tone === 'danger' && 'border-destructive/30'
      )}
      onClick={onClick}
    >
      <div>
        <div className="text-caption text-muted-foreground">{title}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value}</div>
        <div className="mt-1 text-caption text-muted-foreground">{status}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </button>
  )
}

function priorityBadgeVariant(priority: AttentionQueueItem['priority']) {
  if (priority === '紧急') return 'destructive'
  if (priority === '高') return 'warning'
  return 'outline'
}

function moduleStatusLabel(status: ResourceModuleItem['status']) {
  if (status === 'danger') return '异常'
  if (status === 'warning') return '关注'
  return '正常'
}

function moduleStatusBadgeVariant(status: ResourceModuleItem['status']) {
  if (status === 'danger') return 'destructive'
  if (status === 'warning') return 'warning'
  return 'success'
}

export function ContentOpsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<ContentOverviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attentionSectionRef = useRef<HTMLDivElement | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getContentOverview())
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    if (searchParams.get('focus') !== 'attention') {
      return
    }
    attentionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [searchParams])

  const totalManagedResources = useMemo(() => data?.totals.managed_resources ?? 0, [data])
  const pendingAttention = useMemo(() => data?.totals.pending_attention ?? 0, [data])
  const attentionQueues = useMemo<AttentionQueueItem[]>(() => {
    if (!data) {
      return []
    }

    return [
      {
        type: 'Slides 草稿 / 版本风险',
        count: data.slides.dirty_projects,
        href: '/slides?attention=dirty',
        priority: data.slides.dirty_projects > 0 ? '高' : '普通',
        action: '处理',
      },
      {
        type: '异常邮箱',
        count: data.mail.error_accounts,
        href: '/mail?attention=error',
        priority: data.mail.error_accounts > 0 ? '紧急' : '普通',
        action: '处理',
      },
      {
        type: '未读邮件',
        count: data.mail.unread_messages,
        href: '/mail?attention=unread',
        priority: data.mail.unread_messages > 0 ? '高' : '普通',
        action: '查看',
      },
      {
        type: '回收站风险',
        count: data.trash.expiring_soon_3_days,
        href: '/trash?attention=expiring',
        priority: data.trash.expiring_soon_3_days > 0 ? '高' : '普通',
        action: '处理',
      },
    ]
  }, [data])

  const resourceModules = useMemo<ResourceModuleItem[]>(() => {
    if (!data) {
      return []
    }

    return [
      {
        title: 'Organization / Space',
        count: String(data.organizations.total_organizations),
        issueCount: data.organizations.trashed_spaces,
        icon: FolderKanban,
        href: '/spaces',
        updatedAt: '—',
        status: data.organizations.trashed_spaces > 0 ? 'warning' : 'normal',
      },
      {
        title: '表格',
        count: String(data.tables.total_tables),
        issueCount: 0,
        icon: Table2,
        href: '/tables',
        updatedAt: '—',
        status: 'normal',
      },
      {
        title: '文档',
        count: String(data.docs.total_documents),
        issueCount: data.docs.documents_with_permission_overrides,
        icon: FileText,
        href: '/docs',
        updatedAt: '—',
        status: data.docs.documents_with_permission_overrides > 0 ? 'warning' : 'normal',
      },
      {
        title: 'Slides',
        count: String(data.slides.total_projects),
        issueCount: data.slides.dirty_projects,
        icon: Presentation,
        href: '/slides',
        updatedAt: '—',
        status: data.slides.dirty_projects > 0 ? 'warning' : 'normal',
        tone: data.slides.dirty_projects > 0 ? 'warning' : 'default',
      },
      {
        title: '邮件',
        count: String(data.mail.total_accounts),
        issueCount: data.mail.error_accounts,
        icon: Mail,
        href: '/mail',
        updatedAt: '—',
        status: data.mail.error_accounts > 0 ? 'danger' : 'normal',
        tone: data.mail.error_accounts > 0 ? 'danger' : 'default',
      },
      {
        title: '回收站',
        count: String(data.trash.total_trashed_resources),
        issueCount: data.trash.expiring_soon_3_days,
        icon: Trash2,
        href: '/trash',
        updatedAt: '—',
        status: data.trash.expiring_soon_3_days > 0 ? 'warning' : 'normal',
        tone: data.trash.expiring_soon_3_days > 0 ? 'warning' : 'default',
      },
    ]
  }, [data])

  return (
    <AdminPage>
      <AdminPageHeader
        title="资源总览"
        icon={Database}
        actions={
          <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
        }
      />

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          内容总览加载失败：{error}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <CompactKpi
          title="资源总量"
          value={loading && !data ? '加载中…' : totalManagedResources}
          status="受管资源"
          icon={Database}
        />
        <CompactKpi
          title="待处理风险"
          value={loading && !data ? '加载中…' : pendingAttention}
          status={pendingAttention > 0 ? '需处理' : '正常'}
          icon={RefreshCw}
          tone={pendingAttention > 0 ? 'warning' : 'default'}
          onClick={() => setSearchParams({ focus: 'attention' }, { replace: true })}
        />
        <CompactKpi
          title="未读邮件"
          value={loading && !data ? '加载中…' : (data?.mail.unread_messages ?? 0)}
          status={(data?.mail.unread_messages ?? 0) > 0 ? '待查看' : '正常'}
          icon={Mail}
          tone={(data?.mail.unread_messages ?? 0) > 0 ? 'warning' : 'default'}
          onClick={() => navigate('/mail?attention=unread')}
        />
        <CompactKpi
          title="回收站风险"
          value={loading && !data ? '加载中…' : (data?.trash.expiring_soon_3_days ?? 0)}
          status={(data?.trash.expiring_soon_3_days ?? 0) > 0 ? '即将过期' : '正常'}
          icon={Trash2}
          tone={(data?.trash.expiring_soon_3_days ?? 0) > 0 ? 'danger' : 'default'}
          onClick={() => navigate('/trash?attention=expiring')}
        />
      </div>

      <div ref={attentionSectionRef}>
        <AdminListCard title="待处理队列">
          <div className="overflow-hidden rounded-md border bg-background">
            <table className="min-w-full text-body">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">类型</th>
                  <th className="px-4 py-2 text-left font-medium">数量</th>
                  <th className="px-4 py-2 text-left font-medium">优先级</th>
                  <th className="px-4 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {attentionQueues.map((item) => (
                  <tr key={item.type}>
                    <td className="px-4 py-3 font-medium">{item.type}</td>
                    <td className="px-4 py-3 tabular-nums">{item.count}</td>
                    <td className="px-4 py-3">
                      <Badge variant={priorityBadgeVariant(item.priority)}>{item.priority}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button asChild size="sm" variant={item.count > 0 ? 'outline' : 'ghost'}>
                        <Link to={item.href}>{item.action}</Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminListCard>
      </div>

      <AdminListCard title="资源模块状态">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {resourceModules.map((item) => (
            <div
              key={item.title}
              className={cn(
                'rounded-lg border bg-background p-4',
                item.tone === 'warning' && 'border-warning/40',
                item.tone === 'danger' && 'border-destructive/30'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <item.icon className="h-4 w-4 text-muted-foreground" />
                    <h3 className="truncate font-semibold">{item.title}</h3>
                  </div>
                  <div className="mt-2 text-heading font-semibold tabular-nums">{item.count}</div>
                </div>
                <Badge variant={moduleStatusBadgeVariant(item.status)}>
                  {moduleStatusLabel(item.status)}
                </Badge>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-body text-muted-foreground">
                <div>
                  <div className="text-caption">异常</div>
                  <div className="font-medium text-foreground tabular-nums">{item.issueCount}</div>
                </div>
                <div>
                  <div className="text-caption">最近更新</div>
                  <div className="font-medium text-foreground">{item.updatedAt}</div>
                </div>
              </div>
              <Button asChild variant="outline" size="sm" className="mt-3 h-8">
                <Link to={item.href}>查看</Link>
              </Button>
            </div>
          ))}
        </div>
      </AdminListCard>

      <AdminListCard title="最近活动">
        <div className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
          暂无活动
        </div>
      </AdminListCard>
    </AdminPage>
  )
}
