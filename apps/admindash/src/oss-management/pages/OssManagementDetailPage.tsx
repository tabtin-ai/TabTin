import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/utils'
import { getAdminOssFileDetail } from '@/oss-management/api/oss-management'
import type { AdminOssFileDetailResponse } from '@/oss-management/types'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

function getTaskStatusBadgeVariant(
  status: string
): 'secondary' | 'destructive' | 'success' | 'outline' {
  if (status === 'failed') {
    return 'destructive'
  }
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'cancelled') {
    return 'outline'
  }
  return 'secondary'
}

export function OssManagementDetailPage() {
  const navigate = useNavigate()
  const { fileId = '' } = useParams<{ fileId: string }>()

  const [detail, setDetail] = useState<AdminOssFileDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!fileId) {
      return
    }

    let cancelled = false
    const loadDetail = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await getAdminOssFileDetail(fileId)
        if (!cancelled) {
          setDetail(response)
        }
      } catch (detailError: unknown) {
        if (!cancelled) {
          setError(resolveErrorMessage(detailError, '加载资源详情失败'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadDetail()
    return () => {
      cancelled = true
    }
  }, [fileId])

  const file = detail?.file

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">资源详情</h1>
        </div>
        <Button size="sm" variant="outline" onClick={() => navigate('/assets')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回列表
        </Button>
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {loading && (
          <div className="rounded-md border bg-background px-3 py-8 text-center text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载详情中...
            </span>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && file && detail && (
          <div className="space-y-4">
            <div className="rounded-md border bg-background p-4">
              <div className="flex items-center gap-2">
                <h2 className="text-subtitle font-semibold">{file.file_name}</h2>
                <Badge variant={file.is_public ? 'success' : 'outline'}>
                  {file.is_public ? 'public' : 'private'}
                </Badge>
                <Badge
                  variant={
                    file.status === 'failed'
                      ? 'destructive'
                      : file.status === 'completed'
                        ? 'success'
                        : 'secondary'
                  }
                >
                  {file.status}
                </Badge>
              </div>
              <div className="mt-2 text-body text-muted-foreground">ID: {file.id}</div>
              <div className="mt-1 text-body text-muted-foreground">Key: {file.file_key}</div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">类型</div>
                <div className="mt-1 text-body font-medium">{file.file_type}</div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">大小</div>
                <div className="mt-1 text-body font-medium">{file.file_size_display}</div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">下载 / 查看</div>
                <div className="mt-1 text-body font-medium">
                  {file.download_count} / {file.view_count}
                </div>
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-body text-muted-foreground">引用数</div>
                <div className="mt-1 text-body font-medium">{detail.reference_count}</div>
              </div>
            </div>

            <div className="rounded-md border bg-background p-4 text-body">
              <h3 className="text-body font-semibold">归属信息</h3>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                <div>
                  <span className="text-body text-muted-foreground">organization_id：</span>
                  <span className="text-body">{file.organization_id || '—'}</span>
                </div>
                <div>
                  <span className="text-body text-muted-foreground">space_id：</span>
                  <span className="text-body">{file.space_id || '—'}</span>
                </div>
                <div>
                  <span className="text-body text-muted-foreground">上传来源：</span>
                  <span className="text-body">{file.upload_source || '—'}</span>
                </div>
                <div>
                  <span className="text-body text-muted-foreground">上传用户：</span>
                  <span className="text-body">{file.upload_user || '—'}</span>
                </div>
                <div>
                  <span className="text-body text-muted-foreground">创建时间：</span>
                  <span className="text-body">{formatDateTime(file.created_at)}</span>
                </div>
                <div>
                  <span className="text-body text-muted-foreground">更新时间：</span>
                  <span className="text-body">{formatDateTime(file.updated_at)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-md border bg-background p-4">
              <h3 className="text-body font-semibold">附件引用（最近 50 条）</h3>
              <div className="mt-3 overflow-auto rounded border">
                <table className="min-w-full text-body">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">引用 ID</th>
                      <th className="px-2 py-1 text-left font-medium">组织 / Space</th>
                      <th className="px-2 py-1 text-left font-medium">table / field / record</th>
                      <th className="px-2 py-1 text-left font-medium">状态</th>
                      <th className="px-2 py-1 text-left font-medium">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.references.map((reference) => (
                      <tr key={reference.reference_id} className="border-t">
                        <td className="px-2 py-1">{reference.reference_id}</td>
                        <td className="px-2 py-1">
                          <div>{reference.organization_id}</div>
                          <div className="text-muted-foreground">{reference.space_id || '—'}</div>
                        </td>
                        <td className="px-2 py-1">
                          <div>{reference.table_id}</div>
                          <div className="text-muted-foreground">
                            {reference.field_id} / {reference.record_id || '—'}
                          </div>
                        </td>
                        <td className="px-2 py-1">
                          <Badge variant={reference.is_deleted ? 'outline' : 'success'}>
                            {reference.is_deleted ? 'deleted' : 'active'}
                          </Badge>
                        </td>
                        <td className="px-2 py-1">{formatDateTime(reference.created_at)}</td>
                      </tr>
                    ))}
                    {detail.references.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                          暂无引用
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-md border bg-background p-4">
              <h3 className="text-body font-semibold">关联任务（最近 20 条）</h3>
              <div className="mt-3 overflow-auto rounded border">
                <table className="min-w-full text-body">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">任务</th>
                      <th className="px-2 py-1 text-left font-medium">状态</th>
                      <th className="px-2 py-1 text-left font-medium">进度</th>
                      <th className="px-2 py-1 text-left font-medium">数量</th>
                      <th className="px-2 py-1 text-left font-medium">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.related_tasks.map((task) => (
                      <tr key={task.task_id} className="border-t">
                        <td className="px-2 py-1">
                          <div className="font-medium">{task.task_name}</div>
                          <div className="text-muted-foreground">{task.task_type}</div>
                        </td>
                        <td className="px-2 py-1">
                          <Badge variant={getTaskStatusBadgeVariant(task.status)}>
                            {task.status}
                          </Badge>
                        </td>
                        <td className="px-2 py-1">{task.progress.toFixed(1)}%</td>
                        <td className="px-2 py-1">
                          {task.completed_files}/{task.total_files}（失败 {task.failed_files}）
                        </td>
                        <td className="px-2 py-1">{formatDateTime(task.created_at)}</td>
                      </tr>
                    ))}
                    {detail.related_tasks.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                          暂无关联任务
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
