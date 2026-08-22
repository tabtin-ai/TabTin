import { llmAdminApi } from '@/api/llm-admin'
import { AdminPage } from '@/components/admin-page'
import { PageSizeSelect } from '@/components/ui/pagination'
import type { LlmAdminAuditLog } from '@/types/llm-admin'
import { useEffect, useState } from 'react'

export function AuditPage() {
  const [logs, setLogs] = useState<LlmAdminAuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalPages, setTotalPages] = useState(1)

  useEffect(() => {
    setLoading(true)
    llmAdminApi
      .listAuditLogs({ page, pageSize })
      .then((data) => {
        setLogs(data.logs)
        setTotalPages(data.total_pages)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [page, pageSize])

  return (
    <AdminPage>
      <div>
        <h1 className="text-heading font-bold">变更审计</h1>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">加载中...</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="px-4 py-3 text-left font-medium">操作</th>
                  <th className="px-4 py-3 text-left font-medium">目标类型</th>
                  <th className="px-4 py-3 text-left font-medium">目标 ID</th>
                  <th className="px-4 py-3 text-left font-medium">操作人</th>
                  <th className="px-4 py-3 text-left font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-caption text-blue-800">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-4 py-3">{log.target_type}</td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
                        {log.target_id}
                      </code>
                    </td>
                    <td className="px-4 py-3">{log.operator_username || '-'}</td>
                    <td className="px-4 py-3 text-caption text-muted-foreground">
                      {log.created_at ? new Date(log.created_at).toLocaleString('zh-CN') : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-center gap-2">
            <PageSizeSelect
              value={pageSize}
              onChange={(nextPageSize) => {
                setPageSize(nextPageSize)
                setPage(1)
              }}
            />
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded border px-3 py-1 text-body disabled:opacity-50"
            >
              上一页
            </button>
            <span className="px-3 py-1 text-body text-muted-foreground">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border px-3 py-1 text-body disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </>
      )}
    </AdminPage>
  )
}
