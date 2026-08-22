import { PageSizeSelect } from '@/components/ui/pagination'
import { formatDateTime } from '@/lib/utils'
import { ApiError } from '@tabtin/api-client'
import { useCallback, useEffect, useState } from 'react'
import { multimodalApi } from '../../api/multimodal'
import type {
  MediaCapabilityDomain,
  MediaTaskDetail,
  MediaTaskItem,
  MediaTaskStatus,
} from '../../api/multimodal'

const DOMAIN_OPTIONS: Array<{ value: MediaCapabilityDomain | ''; label: string }> = [
  { value: '', label: '全部 Domain' },
  { value: 'image_gen', label: '图片生成 (image_gen)' },
  { value: 'video_gen', label: '视频生成 (video_gen)' },
  { value: 'audio_gen', label: '音频生成 (audio_gen)' },
]

const STATUS_OPTIONS: Array<{ value: MediaTaskStatus | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '排队中' },
  { value: 'running', label: '处理中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]

const STATUS_COLORS: Record<MediaTaskStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  running: 'bg-blue-100 text-blue-800',
  succeeded: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-200 text-gray-700',
}

const STATUS_LABELS: Record<MediaTaskStatus, string> = {
  pending: '排队中',
  running: '处理中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

interface TaskDetailModalProps {
  task: MediaTaskDetail
  onClose: () => void
}

function TaskDetailModal({ task, onClose }: TaskDetailModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-subtitle font-semibold">任务详情</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-muted"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-body">
          <div>
            <span className="text-muted-foreground">Task ID：</span>
            <span className="font-mono">{task.task_id}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Task Type：</span>
            <span className="font-mono">{task.task_type}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Capability Domain：</span>
            <span className="font-mono">{task.capability_domain}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Status：</span>
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-caption ${STATUS_COLORS[task.status] || ''}`}
            >
              {STATUS_LABELS[task.status] || task.status}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Organization：</span>
            <span className="font-mono">{task.organization_id || '-'}</span>
          </div>
          <div>
            <span className="text-muted-foreground">User：</span>
            <span className="font-mono">{task.user_id || '-'}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Model：</span>
            <span>
              {task.model_display_name || task.model_name || '-'}
              {task.provider_name && (
                <span className="text-muted-foreground"> · {task.provider_name}</span>
              )}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">创建：</span>
            <span>{formatDateTime(task.created_at)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">提交 provider：</span>
            <span>{formatDateTime(task.submitted_at)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">完成：</span>
            <span>{formatDateTime(task.completed_at)}</span>
          </div>
        </div>

        {task.prompt && (
          <div className="mt-4">
            <div className="text-caption text-muted-foreground mb-1">提示词</div>
            <div className="rounded bg-muted/30 p-3 text-body whitespace-pre-wrap">
              {task.prompt}
            </div>
          </div>
        )}

        {task.error_message && (
          <div className="mt-4">
            <div className="text-caption text-red-700 mb-1">错误信息</div>
            <div className="rounded bg-red-50 p-3 text-body text-red-900">
              <span className="font-mono">{task.error_code}</span>: {task.error_message}
            </div>
          </div>
        )}

        {(task.stored_urls.length > 0 || task.result_urls.length > 0) && (
          <div className="mt-4">
            <div className="text-caption text-muted-foreground mb-1">资产 URL</div>
            <ul className="space-y-1">
              {(task.stored_urls.length > 0 ? task.stored_urls : task.result_urls).map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-caption text-primary hover:underline break-all"
                  >
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {Object.keys(task.result_metadata).length > 0 && (
          <div className="mt-4">
            <div className="text-caption text-muted-foreground mb-1">元数据</div>
            <pre className="rounded bg-muted/30 p-3 text-caption overflow-x-auto">
              {JSON.stringify(task.result_metadata, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Tab 3：异步任务（image_gen / video_gen / audio_gen）。
 * 列：task_id / scene_key / capability_domain / organization_id / user_id / status / 创建时间。
 * 行内 action：详情 / 重试。
 */
export function MediaTasksTable() {
  const [tasks, setTasks] = useState<MediaTaskItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [domainFilter, setDomainFilter] = useState<MediaCapabilityDomain | ''>('')
  const [statusFilter, setStatusFilter] = useState<MediaTaskStatus | ''>('')
  const [organizationInput, setOrganizationInput] = useState('')
  const [organizationFilter, setOrganizationFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [actionBanner, setActionBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(
    null
  )
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailTask, setDetailTask] = useState<MediaTaskDetail | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await multimodalApi.listTasks({
        capability_domain: domainFilter || undefined,
        status: statusFilter || undefined,
        organization_id: organizationFilter || undefined,
        page,
        page_size: pageSize,
      })
      setTasks(res.tasks)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [domainFilter, statusFilter, organizationFilter, page, pageSize])

  useEffect(() => {
    load()
  }, [load])

  const handleRetry = async (task: MediaTaskItem) => {
    if (task.status !== 'failed') return
    setRetryingId(task.id)
    setActionBanner(null)
    try {
      const res = await multimodalApi.retryTask(task.id)
      setActionBanner({
        kind: 'info',
        text: `✓ task_id=${task.id.slice(0, 8)}… 已重置（${res.message}）`,
      })
      await load()
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `[${err.code}] ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      setActionBanner({ kind: 'error', text: `✗ 重试失败：${msg}` })
    } finally {
      setRetryingId(null)
    }
  }

  const handleDetail = async (task: MediaTaskItem) => {
    setDetailLoading(true)
    setActionBanner(null)
    try {
      const detail = await multimodalApi.taskDetail(task.id)
      setDetailTask(detail)
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `[${err.code}] ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      setActionBanner({ kind: 'error', text: `✗ 加载详情失败：${msg}` })
    } finally {
      setDetailLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border px-2 py-1.5 text-body bg-background"
          value={domainFilter}
          onChange={(e) => {
            setDomainFilter(e.target.value as MediaCapabilityDomain | '')
            setPage(1)
          }}
        >
          {DOMAIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border px-2 py-1.5 text-body bg-background"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as MediaTaskStatus | '')
            setPage(1)
          }}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="按 organization_id 过滤"
          value={organizationInput}
          onChange={(e) => setOrganizationInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setOrganizationFilter(organizationInput.trim())
              setPage(1)
            }
          }}
          className="rounded-md border px-2 py-1.5 text-body bg-background flex-1 min-w-[200px]"
        />
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-body hover:bg-muted"
          onClick={() => {
            setOrganizationFilter(organizationInput.trim())
            setPage(1)
          }}
        >
          应用
        </button>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-body hover:bg-muted"
          onClick={load}
          disabled={loading}
        >
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {actionBanner && (
        <div
          className={`rounded-md border px-3 py-2 text-caption ${
            actionBanner.kind === 'info'
              ? 'border-green-300 bg-green-50 text-green-900'
              : 'border-red-300 bg-red-50 text-red-900'
          }`}
        >
          {actionBanner.text}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-caption text-red-900">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-4 py-3 text-left font-medium">Task ID</th>
              <th className="px-4 py-3 text-left font-medium">Scene / Domain</th>
              <th className="px-4 py-3 text-left font-medium">Organization</th>
              <th className="px-4 py-3 text-left font-medium">User</th>
              <th className="px-4 py-3 text-center font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">创建时间</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-b hover:bg-muted/20">
                <td className="px-4 py-3">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
                    {t.task_id.slice(0, 8)}…
                  </code>
                </td>
                <td className="px-4 py-3">
                  <div>
                    <div className="font-mono text-caption">{t.scene_key || '-'}</div>
                    <div className="text-caption text-muted-foreground">
                      {t.capability_domain} · {t.task_type}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-caption">
                  {t.organization_id ? `${t.organization_id.slice(0, 12)}…` : '-'}
                </td>
                <td className="px-4 py-3 font-mono text-caption">
                  {t.user_id ? `${t.user_id.slice(0, 8)}…` : '-'}
                </td>
                <td className="px-4 py-3 text-center">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-caption ${STATUS_COLORS[t.status] || ''}`}
                  >
                    {STATUS_LABELS[t.status] || t.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-caption text-muted-foreground">
                  {formatDateTime(t.created_at)}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption text-primary hover:bg-primary/10 disabled:opacity-50"
                      onClick={() => handleDetail(t)}
                      disabled={detailLoading}
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption text-yellow-700 hover:bg-yellow-50 disabled:opacity-30"
                      onClick={() => handleRetry(t)}
                      disabled={t.status !== 'failed' || retryingId === t.id}
                      title={
                        t.status === 'failed' ? '重置为 pending 并重新投递' : '仅 failed 任务可重试'
                      }
                    >
                      {retryingId === t.id ? '重试中...' : '重试'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {tasks.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  没有任务记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-caption text-muted-foreground">
        <span>
          共 {total.toLocaleString()} 条 · 第 {page} / {totalPages} 页
        </span>
        <div className="flex items-center gap-1">
          <PageSizeSelect
            value={pageSize}
            onChange={(nextPageSize) => {
              setPageSize(nextPageSize)
              setPage(1)
            }}
          />
          <button
            type="button"
            className="rounded-md border px-3 py-1 hover:bg-muted disabled:opacity-50"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1 hover:bg-muted disabled:opacity-50"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页
          </button>
        </div>
      </div>

      {detailTask && <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} />}
    </div>
  )
}
