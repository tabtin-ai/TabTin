import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { AdminStatCell } from '@/components/admin-page/AdminStatCell'
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
import { PageSizeSelect } from '@/components/ui/pagination'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn, formatDateTime } from '@/lib/utils'
import { CheckCircle2, Eye, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import {
  type PendingReviewItem,
  approveVersion,
  getVersionDetail,
  listPendingReview,
  rejectVersion,
} from '../api/skill-review-api'

export function SkillReviewPage() {
  const [items, setItems] = useState<PendingReviewItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [detailItem, setDetailItem] = useState<PendingReviewItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailTab, setDetailTab] = useState('overview')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [approveDialogItem, setApproveDialogItem] = useState<PendingReviewItem | null>(null)
  const [approveNote, setApproveNote] = useState('')
  const [rejectDialogItem, setRejectDialogItem] = useState<PendingReviewItem | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listPendingReview(page, pageSize)
      setItems(res.items)
      setTotal(res.total)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [page, pageSize])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const openDetail = useCallback(async (item: PendingReviewItem, tab = 'overview') => {
    setDetailLoading(true)
    setDetailItem(item)
    setDetailTab(tab)
    try {
      const full = await getVersionDetail(item.skill_id, item.version_seq)
      setDetailItem(full)
    } catch {
      /* keep partial */
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const handleApprove = useCallback(
    async (item: PendingReviewItem, note = '') => {
      setActionLoading(true)
      try {
        await approveVersion(item.skill_id, item.version_seq, note)
        setApproveDialogItem(null)
        setApproveNote('')
        setDetailItem(null)
        fetchList()
      } catch {
        /* toast handled by client */
      } finally {
        setActionLoading(false)
      }
    },
    [fetchList]
  )

  const handleReject = useCallback(async () => {
    if (!rejectDialogItem) return
    setActionLoading(true)
    try {
      await rejectVersion(rejectDialogItem.skill_id, rejectDialogItem.version_seq, rejectNote)
      setRejectDialogItem(null)
      setRejectNote('')
      setDetailItem(null)
      fetchList()
    } catch {
      /* toast handled by client */
    } finally {
      setActionLoading(false)
    }
  }, [rejectDialogItem, rejectNote, fetchList])

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return items.filter((item) => {
      const matchesKeyword =
        !keyword ||
        item.skill_name.toLowerCase().includes(keyword) ||
        item.skill_slug.toLowerCase().includes(keyword) ||
        item.owner_name.toLowerCase().includes(keyword) ||
        item.owner_user_id.toLowerCase().includes(keyword)
      const matchesStatus = statusFilter === 'all' || item.review_status === statusFilter
      return matchesKeyword && matchesStatus
    })
  }, [items, search, statusFilter])

  const pendingCount = total

  function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    const displayValue = value === null || value === undefined || value === '' ? '—' : value
    return (
      <div className="flex items-start justify-between gap-4 border-b py-2 text-body last:border-0">
        <span className="text-muted-foreground">{label}</span>
        <span className="max-w-[360px] break-words text-right">{displayValue}</span>
      </div>
    )
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Skill 审核"
        icon={Sparkles}
        actions={
          <Button variant="outline" size="sm" onClick={fetchList} disabled={loading}>
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <AdminStatCell label="待审核" value={pendingCount} />
        <AdminStatCell label="已通过" value="暂无全量字段" />
        <AdminStatCell label="已驳回" value="暂无全量字段" />
        <AdminStatCell label="风险 Skill" value="暂无风险字段" />
      </div>

      <section className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Skill 名 / 提交人 / Organization"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-60 rounded-md border bg-background px-3 py-1.5 text-body"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-body"
          >
            <option value="all">全部当前页状态</option>
            <option value="pending">当前页待审核</option>
          </select>
          <select
            disabled
            className="rounded-md border bg-background px-3 py-1.5 text-body opacity-70"
          >
            <option>风险状态暂无字段</option>
          </select>
          <Button variant="outline" type="button" onClick={fetchList}>
            查询
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setSearch('')
              setStatusFilter('all')
            }}
          >
            重置
          </Button>
        </div>
      </section>

      <div className="flex items-center justify-between text-body text-muted-foreground">
        <span>当前页显示 {filteredItems.length} 条</span>
        <AdminStatCell
          label="当前页"
          value={`${page} / ${Math.max(1, Math.ceil(total / pageSize))}`}
        />
      </div>

      <div className="rounded-lg border bg-background">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Skill</th>
                  <th className="px-4 py-3 text-left font-medium">提交人 / Organization</th>
                  <th className="px-4 py-3 text-left font-medium">状态</th>
                  <th className="px-4 py-3 text-left font-medium">风险</th>
                  <th className="px-4 py-3 text-left font-medium">更新时间</th>
                  <th className="px-4 py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      暂无待审核 Skill
                    </td>
                  </tr>
                ) : null}
                {filteredItems.map((item) => (
                  <tr key={item.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {item.skill_emoji && <span>{item.skill_emoji}</span>}
                        <span className="font-medium">{item.skill_name}</span>
                        <Badge variant="outline" className="text-caption">
                          v{item.version_seq}
                        </Badge>
                      </div>
                      <code className="text-caption text-muted-foreground">{item.skill_slug}</code>
                    </td>
                    <td className="px-4 py-3">
                      <div>{item.owner_name}</div>
                      <code className="text-caption text-muted-foreground">
                        {item.owner_user_id || '暂无 Organization 字段'}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{item.review_status || '待审核'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">暂无风险字段</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(item.published_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => openDetail(item)}>
                        <Eye className="mr-1 h-3.5 w-3.5" />
                        详情
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openDetail(item, 'review')}>
                        审核
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRejectDialogItem(item)
                          setRejectNote('')
                        }}
                      >
                        更多
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div className="flex items-center justify-center gap-2 border-t p-3">
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
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= Math.ceil(total / pageSize)}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </div>

      {/* Detail Dialog */}
      <Dialog open={!!detailItem} onOpenChange={(open) => !open && setDetailItem(null)}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(720px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              {detailItem?.skill_emoji && <span>{detailItem.skill_emoji}</span>}
              {detailItem?.skill_name} v{detailItem?.version_seq}
            </DialogTitle>
            <DialogDescription>
              skill_id · <code>{detailItem?.skill_id || '—'}</code>
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : detailItem ? (
            <div className="px-6 py-4">
              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList className="flex flex-wrap">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="content">内容</TabsTrigger>
                  <TabsTrigger value="risk">风险</TabsTrigger>
                  <TabsTrigger value="review">审核记录</TabsTrigger>
                  <TabsTrigger value="audit">审计</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="skill_id" value={<code>{detailItem.skill_id}</code>} />
                    <InfoRow label="skill_slug" value={<code>{detailItem.skill_slug}</code>} />
                    <InfoRow label="description" value={detailItem.skill_description} />
                    <InfoRow label="submitter" value={detailItem.owner_name} />
                    <InfoRow label="organization" value="暂无 Organization 字段" />
                    <InfoRow label="version" value={`v${detailItem.version_seq}`} />
                    <InfoRow label="version_label" value={detailItem.version_label} />
                    <InfoRow
                      label="bundle_sha256"
                      value={<code>{detailItem.bundle_sha256}</code>}
                    />
                    <InfoRow label="created_at" value={formatDateTime(detailItem.published_at)} />
                    <InfoRow label="updated_at" value="暂无更新时间字段" />
                  </div>
                </TabsContent>
                <TabsContent value="content" className="mt-4 space-y-3">
                  {detailItem.change_note ? (
                    <div>
                      <div className="mb-1 text-body font-medium">变更说明</div>
                      <div className="rounded-md bg-muted p-3 text-body">
                        {detailItem.change_note}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      暂无变更说明
                    </div>
                  )}
                  {detailItem.skill_md_content ? (
                    <div>
                      <div className="mb-1 text-body font-medium">SKILL.md</div>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-caption font-mono">
                        {detailItem.skill_md_content}
                      </pre>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      暂无内容记录
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="risk" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前接口不包含风险状态
                  </div>
                </TabsContent>
                <TabsContent value="review" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="review_status" value={detailItem.review_status} />
                    <InfoRow label="reviewed_by" value={detailItem.reviewed_by} />
                    <InfoRow label="reviewed_at" value={formatDateTime(detailItem.reviewed_at)} />
                    <InfoRow label="review_note" value={detailItem.review_note} />
                  </div>
                </TabsContent>
                <TabsContent value="audit" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    暂无记录
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          ) : null}

          <DialogFooter className="gap-2 border-t px-6 py-4">
            <Button variant="outline" onClick={() => setDetailItem(null)}>
              关闭
            </Button>
            <Button
              variant="default"
              disabled={actionLoading}
              onClick={() => {
                if (detailItem) {
                  setApproveDialogItem(detailItem)
                  setApproveNote('')
                }
              }}
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
              通过
            </Button>
            <Button
              variant="destructive"
              disabled={actionLoading}
              onClick={() => {
                if (detailItem) {
                  setRejectDialogItem(detailItem)
                  setRejectNote('')
                }
              }}
            >
              <XCircle className="mr-1 h-3.5 w-3.5" />
              驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve Dialog */}
      <Dialog
        open={!!approveDialogItem}
        onOpenChange={(open) => !open && setApproveDialogItem(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认通过审核</DialogTitle>
            <DialogDescription>
              通过后该版本将进入发布流程，请确认风险检查与内容审核已完成。
            </DialogDescription>
          </DialogHeader>
          <div className="text-body text-muted-foreground mb-2">
            通过 {approveDialogItem?.skill_name} v{approveDialogItem?.version_seq}
          </div>
          <Textarea
            placeholder="审核备注（可选）"
            value={approveNote}
            onChange={(e) => setApproveNote(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveDialogItem(null)}>
              取消
            </Button>
            <Button
              variant="default"
              disabled={actionLoading}
              onClick={() => approveDialogItem && handleApprove(approveDialogItem, approveNote)}
            >
              确认通过
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={!!rejectDialogItem} onOpenChange={(open) => !open && setRejectDialogItem(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>驳回审核</DialogTitle>
          </DialogHeader>
          <div className="text-body text-muted-foreground mb-2">
            驳回 {rejectDialogItem?.skill_name} v{rejectDialogItem?.version_seq}
          </div>
          <Textarea
            placeholder="审核备注（内部可见，不暴露给作者）"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogItem(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={actionLoading} onClick={handleReject}>
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
