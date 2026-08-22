import { Loader2, RefreshCw, Search, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getIntentUsers } from '@/api/users'
import { AdminStatCell } from '@/components/admin-page/AdminStatCell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import { formatDateTime } from '@/lib/utils'
import type { IntentUserListResponse } from '@/types/user'

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

export function IntentUsersPage() {
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [data, setData] = useState<IntentUserListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const latestCreatedAt = useMemo(() => data?.items[0]?.created_at ?? null, [data?.items])

  const totalPages = Math.max(data?.pagination.total_pages ?? 1, 1)

  const loadIntentUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getIntentUsers({
        keyword: keyword || undefined,
        page,
        page_size: pageSize,
      })
      setData(response)
    } catch (loadError: unknown) {
      setError(resolveErrorMessage(loadError, '加载意向用户失败'))
    } finally {
      setLoading(false)
    }
  }, [keyword, page, pageSize])

  useEffect(() => {
    void loadIntentUsers()
  }, [loadIntentUsers])

  const handleSearch = () => {
    setKeyword(keywordInput.trim())
    setPage(1)
  }

  const handleClear = () => {
    setKeywordInput('')
    setKeyword('')
    setPage(1)
  }

  const handlePageSizeChange = (nextPageSize: number) => {
    setPageSize(nextPageSize)
    setPage(1)
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">意向用户</h1>
        </div>
        <Button variant="outline" onClick={() => void loadIntentUsers()} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          刷新
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <AdminStatCell label="总意向用户" value={data?.summary.total_intent_users ?? 0} />
        <AdminStatCell label="当前筛选" value={data?.summary.filtered_intent_users ?? 0} />
        <AdminStatCell
          label="最近预约"
          value={latestCreatedAt ? formatDateTime(latestCreatedAt) : '—'}
        />
      </div>

      <div className="rounded-lg border bg-card">
        <div className="flex flex-col gap-3 border-b p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row">
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleSearch()
                  }
                }}
                placeholder="搜索手机号"
                className="pl-9"
              />
            </div>
            <Button onClick={handleSearch}>搜索</Button>
            {keyword ? (
              <Button variant="ghost" onClick={handleClear}>
                清空
              </Button>
            ) : null}
          </div>
          <PageSizeSelect value={pageSize} onChange={handlePageSizeChange} />
        </div>

        {error ? (
          <div className="p-8 text-center">
            <p className="text-body text-destructive">{error}</p>
            <Button variant="outline" className="mt-3" onClick={() => void loadIntentUsers()}>
              重新加载
            </Button>
          </div>
        ) : loading && !data ? (
          <div className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载意向用户中...
          </div>
        ) : data?.items.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-body">
              <thead className="border-b bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">手机号</th>
                  <th className="px-4 py-3 font-medium">预约时间</th>
                  <th className="px-4 py-3 font-medium">记录 ID</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{item.phone}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(item.created_at)}
                    </td>
                    <td className="px-4 py-3 font-mono text-caption text-muted-foreground">
                      {item.id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-10 text-center text-muted-foreground">
            <UserPlus className="h-8 w-8" />
            <div className="text-body font-medium text-foreground">暂无意向用户</div>
            <p className="text-body">客户端提交手机号预约后，会出现在这里。</p>
          </div>
        )}

        <div className="flex items-center justify-between border-t p-4 text-body text-muted-foreground">
          <span>共 {(data?.pagination.total ?? 0).toLocaleString()} 条</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </Button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
