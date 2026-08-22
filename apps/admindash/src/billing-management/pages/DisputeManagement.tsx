import { getApiClient } from '@/api/tabtin-client'
import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardList, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const DEFAULT_PAGE_SIZE = 20

interface Dispute {
  id: string
  transaction_id: string
  organization_id: string
  user_id: string
  reason: string
  status: string
  admin_notes: string
  sla_deadline: string | null
  resolved_at: string | null
  created_at: string | null
}

const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  investigating: '调查中',
  resolved: '已解决',
  rejected: '已驳回',
}

function getStatusVariant(status: string) {
  if (status === 'open') return 'warning' as const
  if (status === 'investigating') return 'default' as const
  if (status === 'resolved') return 'success' as const
  if (status === 'rejected') return 'destructive' as const
  return 'outline' as const
}

export function DisputeManagement() {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()

  const [items, setItems] = useState<Dispute[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [adminNotes, setAdminNotes] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getApiClient().raw<{ disputes: Dispute[]; total: number }>(
        'GET',
        '/services/billing/admin/billing/disputes',
        { params: { page, page_size: pageSize, status: statusFilter || undefined } }
      )
      setItems(data.disputes || [])
      setTotal(data.total || 0)
    } catch {
      showToast('加载申诉列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, statusFilter, showToast])

  useEffect(() => {
    void load()
  }, [load])

  const handleResolve = async (disputeId: string, status: 'resolved' | 'rejected') => {
    setResolvingId(disputeId)
    try {
      await getApiClient().raw(
        'PUT',
        `/services/billing/admin/billing/disputes/${disputeId}/resolve`,
        { body: { status, admin_notes: adminNotes[disputeId] || '' } }
      )
      showToast(`申诉已${status === 'resolved' ? '解决' : '驳回'}`, 'success')
      void load()
    } catch {
      showToast('操作失败', 'error')
    } finally {
      setResolvingId(null)
    }
  }

  const openCount = items.filter((d) => d.status === 'open').length
  const overdueCount = items.filter(
    (d) => d.sla_deadline && new Date(d.sla_deadline) < new Date() && d.status === 'open'
  ).length

  return (
    <AdminPage>
      {toastEl}
      <AdminPageHeader
        title="申诉工单"
        icon={ClipboardList}
        badges={
          <>
            <Badge variant="outline">总工单 {total}</Badge>
            {overdueCount > 0 && <Badge variant="destructive">超时 {overdueCount}</Badge>}
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate('/billing')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回计费首页
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <AdminMetricCard
          title="待处理"
          value={openCount.toLocaleString()}
          icon={AlertTriangle}
          tone={openCount > 0 ? 'warning' : 'default'}
        />
        <AdminMetricCard
          title="SLA 超时"
          value={overdueCount.toLocaleString()}
          icon={AlertTriangle}
          tone={overdueCount > 0 ? 'danger' : 'default'}
        />
        <AdminMetricCard
          title="总工单"
          value={total.toLocaleString()}
          icon={CheckCircle2}
          tone="default"
        />
      </div>

      <AdminListCard
        title="工单列表"
        actions={
          <Select
            value={statusFilter || '__all__'}
            onValueChange={(v) => {
              setStatusFilter(v === '__all__' ? '' : v)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部状态</SelectItem>
              <SelectItem value="open">待处理</SelectItem>
              <SelectItem value="investigating">调查中</SelectItem>
              <SelectItem value="resolved">已解决</SelectItem>
              <SelectItem value="rejected">已驳回</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">暂无工单</div>
        ) : (
          <div className="space-y-4">
            {items.map((d) => (
              <div key={d.id} className="rounded-lg border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={getStatusVariant(d.status)}>
                        {STATUS_LABEL[d.status] || d.status}
                      </Badge>
                      {d.sla_deadline &&
                        new Date(d.sla_deadline) < new Date() &&
                        d.status === 'open' && <Badge variant="destructive">SLA 超时</Badge>}
                    </div>
                    <p className="text-body">{d.reason}</p>
                    <div className="grid gap-1 text-body text-muted-foreground sm:grid-cols-3">
                      <span>组织: {d.organization_id?.slice(0, 8)}...</span>
                      <span>用户: {d.user_id?.slice(0, 8)}...</span>
                      <span>创建: {formatDateTime(d.created_at)}</span>
                    </div>
                    {d.admin_notes && (
                      <p className="text-body text-muted-foreground">处理备注: {d.admin_notes}</p>
                    )}
                  </div>
                  {(d.status === 'open' || d.status === 'investigating') && (
                    <div className="flex flex-col gap-2">
                      <Input
                        placeholder="处理备注"
                        className="w-48"
                        value={adminNotes[d.id] || ''}
                        onChange={(e) =>
                          setAdminNotes((prev) => ({ ...prev, [d.id]: e.target.value }))
                        }
                      />
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          onClick={() => handleResolve(d.id, 'resolved')}
                          disabled={resolvingId === d.id}
                        >
                          {resolvingId === d.id && (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          )}
                          解决
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleResolve(d.id, 'rejected')}
                          disabled={resolvingId === d.id}
                        >
                          驳回
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <Pagination
          page={page}
          total={total}
          pageSize={pageSize}
          onChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPage(1)
            setPageSize(nextPageSize)
          }}
        />
      </AdminListCard>
    </AdminPage>
  )
}
