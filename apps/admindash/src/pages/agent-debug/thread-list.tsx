/**
 * Thread List 页面
 * 主入口，卡片式展示所有会话列表
 */

import { THREAD_GRID, ThreadCard } from '@/components/agent-debug/thread-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDebounce } from '@/hooks/useDebounce'
import { useAgentDebugStore } from '@/stores/agent-debug-store'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Filter,
  MessageSquare,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  type ThreadListQueryState,
  parseThreadListQuery,
  serializeThreadListQuery,
} from './thread-list-query-state'

export function ThreadListPage() {
  const { threads, threadsPagination, threadsLoading, threadsError, loadThreads } =
    useAgentDebugStore()

  const [searchParams, setSearchParams] = useSearchParams()
  const listQuery = useMemo(() => parseThreadListQuery(searchParams), [searchParams])
  const debouncedSearchKeyword = useDebounce(listQuery.keyword, 400)
  const debouncedSessionTitleFilter = useDebounce(listQuery.sessionTitle, 400)
  const debouncedUserFilter = useDebounce(listQuery.user, 400)
  const debouncedOrganizationFilter = useDebounce(listQuery.organization, 400)
  const [autoRefresh, setAutoRefresh] = useState(false)

  const updateListQuery = useCallback(
    (updates: Partial<ThreadListQueryState>) => {
      setSearchParams(serializeThreadListQuery({ ...listQuery, ...updates }), { replace: true })
    },
    [listQuery, setSearchParams]
  )

  const threadQuery = useMemo(
    () => ({
      keyword: debouncedSearchKeyword.trim() || undefined,
      sessionTitle: debouncedSessionTitleFilter.trim() || undefined,
      user: debouncedUserFilter.trim() || undefined,
      organization: debouncedOrganizationFilter.trim() || undefined,
      status: listQuery.status,
      page: listQuery.page,
      pageSize: listQuery.pageSize,
    }),
    [
      debouncedOrganizationFilter,
      debouncedSearchKeyword,
      debouncedSessionTitleFilter,
      debouncedUserFilter,
      listQuery.page,
      listQuery.pageSize,
      listQuery.status,
    ]
  )

  // 加载会话列表：服务端分页，避免前端只聚合当前 trace 页导致漏会话。
  useEffect(() => {
    void loadThreads(threadQuery)
  }, [loadThreads, threadQuery])

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return

    const interval = setInterval(() => {
      void loadThreads(threadQuery)
    }, 5000)

    return () => clearInterval(interval)
  }, [autoRefresh, loadThreads, threadQuery])

  // 统计信息
  const stats = {
    total: threadsPagination.total,
    withErrors: threads.filter((t) => t.statusStats.error > 0).length,
    running: threads.filter((t) => t.statusStats.running > 0).length,
    completed: threads.filter(
      (t) => t.statusStats.completed > 0 && t.statusStats.error === 0 && t.statusStats.running === 0
    ).length,
  }

  return (
    <div className="panel-container">
      {/* 顶部工具栏 */}
      <div className="flex h-14 items-center justify-between border-b px-6 bg-background">
        <div>
          <h1 className="text-title font-semibold flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-primary" />
            会话列表
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={autoRefresh ? 'border-primary' : ''}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? '自动刷新' : '手动刷新'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadThreads(threadQuery)}
            disabled={threadsLoading}
          >
            <RefreshCw className={`h-4 w-4 ${threadsLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* 统计栏 */}
      <div className="flex items-center gap-4 border-b bg-muted/10 px-6 py-3">
        <div className="flex items-center gap-2 text-body">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{stats.total}</span>
          <span className="text-muted-foreground">总计</span>
        </div>
        <div className="flex items-center gap-2 text-body">
          <AlertCircle className="h-4 w-4 text-destructive" />
          <span className="font-medium">{stats.withErrors}</span>
          <span className="text-muted-foreground">有错误</span>
        </div>
        <div className="flex items-center gap-2 text-body">
          <Clock className="h-4 w-4 text-info" />
          <span className="font-medium">{stats.running}</span>
          <span className="text-muted-foreground">运行中</span>
        </div>
        <div className="flex items-center gap-2 text-body">
          <CheckCircle2 className="h-4 w-4 text-success" />
          <span className="font-medium">{stats.completed}</span>
          <span className="text-muted-foreground">已完成</span>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/10 px-6 py-3">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="relative min-w-0">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索会话 ID..."
              className="w-full pl-9"
              value={listQuery.keyword}
              onChange={(e) => {
                updateListQuery({ keyword: e.target.value, page: 1 })
              }}
            />
          </div>
          <Input
            placeholder="会话名"
            className="min-w-0 w-full"
            value={listQuery.sessionTitle}
            onChange={(e) => {
              updateListQuery({ sessionTitle: e.target.value, page: 1 })
            }}
          />
          <Input
            placeholder="用户名 / 手机号 / 用户 ID"
            className="min-w-0 w-full"
            value={listQuery.user}
            onChange={(e) => {
              updateListQuery({ user: e.target.value, page: 1 })
            }}
          />
          <Input
            placeholder="组织名 / 组织 ID"
            className="min-w-0 w-full"
            value={listQuery.organization}
            onChange={(e) => {
              updateListQuery({ organization: e.target.value, page: 1 })
            }}
          />
        </div>

        <Select
          value={listQuery.status}
          onValueChange={(value) => {
            updateListQuery({ status: value as ThreadListQueryState['status'], page: 1 })
          }}
        >
          <SelectTrigger className="w-36 shrink-0">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="error">有错误</SelectItem>
            <SelectItem value="running">运行中</SelectItem>
            <SelectItem value="completed">已完成</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Thread 列表 */}
      <div className="flex-1 overflow-hidden">
        {threadsError ? (
          <div className="flex h-full items-center justify-center text-destructive">
            <p>错误：{threadsError}</p>
          </div>
        ) : threads.length === 0 && !threadsLoading ? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <MessageSquare className="h-12 w-12 mb-4 opacity-20" />
            <p>未找到会话</p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="min-w-[1480px]">
              <div
                className={`sticky top-0 z-20 grid ${THREAD_GRID} gap-4 border-b bg-background px-5 py-2 text-caption font-medium text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]`}
              >
                <span>会话 ID</span>
                <span>会话名</span>
                <span>用户</span>
                <span>组织</span>
                <span>状态</span>
                <span>执行次数</span>
                <span>总耗时</span>
                <span>最近活动</span>
                <span aria-hidden="true" />
              </div>
              {threads.map((thread) => (
                <ThreadCard
                  key={thread.threadId}
                  threadId={thread.threadId}
                  sessionTitle={thread.sessionTitle}
                  userId={thread.userId}
                  userName={thread.userName}
                  userPhone={thread.userPhone}
                  organizationId={thread.organizationId}
                  organizationName={thread.organizationName}
                  traceCount={thread.traceCount}
                  errorCount={thread.statusStats.error}
                  runningCount={thread.statusStats.running}
                  completedCount={thread.statusStats.completed}
                  firstStartedAt={thread.firstStartedAt}
                  latestStartedAt={thread.latestStartedAt}
                  totalDurationMs={thread.totalDurationMs}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex h-12 items-center justify-between border-t px-6 bg-muted/10 text-body">
        <div className="text-muted-foreground">
          显示 {threads.length} / {threadsPagination.total} 个会话，第 {threadsPagination.page}/
          {Math.max(threadsPagination.totalPages, 1)} 页
        </div>
        <Pagination
          page={listQuery.page}
          total={threadsPagination.total}
          pageSize={listQuery.pageSize}
          onChange={(page) => updateListQuery({ page })}
          onPageSizeChange={(nextPageSize) => {
            updateListQuery({ page: 1, pageSize: nextPageSize })
          }}
          className="min-w-[420px] justify-end"
        />
      </div>
    </div>
  )
}
