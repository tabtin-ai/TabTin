import { agentDebugApi } from '@/api/agent-debug'
import { ConversationTimeline } from '@/components/agent-debug/conversation-timeline'
import { ResizablePanel } from '@/components/agent-debug/resizable-panel'
import { SessionOverviewPanel } from '@/components/agent-debug/session-overview-panel'
import { TraceOperationsDrawer } from '@/components/agent-debug/trace-operations-drawer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAgentDebugStore } from '@/stores/agent-debug-store'
import type { ThreadOverview, ThreadOverviewMessage } from '@/types/agent-debug'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Loader2,
  MessageSquare,
  PanelRight,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { buildChatMessagesFilename } from './chat-message-export'
import { loadThreadConversation } from './thread-conversation-loader'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

export function ThreadDetailPage() {
  const { threadId } = useParams<{ threadId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const threadListHref = `/threads${location.search}`
  const {
    currentThread,
    currentThreadLoading,
    currentThreadError,
    loadThread,
    clearCurrentThread,
  } = useAgentDebugStore()
  const [overview, setOverview] = useState<ThreadOverview | null>(null)
  const [messages, setMessages] = useState<ThreadOverviewMessage[]>([])
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [showOverview, setShowOverview] = useState(true)
  const [copied, setCopied] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [exportingConversation, setExportingConversation] = useState(false)
  const [conversationExportError, setConversationExportError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!threadId) return
    void loadThread(threadId)
    setOverviewLoading(true)
    setOverviewError(null)
    setOverview(null)
    setMessages([])
    void loadThreadConversation(threadId)
      .then((result) => {
        setOverview(result.overview)
        setMessages(result.messages)
        setOverviewError(result.warning)
      })
      .catch(() => setOverviewError('会话消息加载失败，运行记录仍可查看'))
      .finally(() => setOverviewLoading(false))
    return clearCurrentThread
  }, [clearCurrentThread, loadThread, threadId])

  const copyThreadId = async () => {
    if (!threadId) return
    await navigator.clipboard.writeText(threadId)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const refreshConversationAndTraces = async () => {
    if (!threadId || refreshing) return

    setRefreshing(true)
    try {
      const [threadOk, conversation] = await Promise.all([
        loadThread(threadId, { silent: true }),
        loadThreadConversation(threadId),
      ])
      setOverview(conversation.overview)
      setMessages(conversation.messages)
      if (!threadOk) {
        setOverviewError(
          conversation.warning
            ? `${conversation.warning}；执行记录刷新失败`
            : '执行记录刷新失败，请稍后重试'
        )
      } else {
        setOverviewError(conversation.warning)
      }
    } catch {
      setOverviewError('刷新失败，请稍后重试')
    } finally {
      setRefreshing(false)
    }
  }

  const exportConversationJson = async () => {
    if (!threadId || exportingConversation) return

    setExportingConversation(true)
    setConversationExportError(null)
    try {
      const payload = await agentDebugApi.getThreadChatMessages(threadId)
      if (!payload.messages.length) {
        setConversationExportError('当前会话没有可导出的对话消息')
        return
      }

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = buildChatMessagesFilename(threadId, payload)
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setConversationExportError('对话消息导出失败，请稍后重试')
    } finally {
      setExportingConversation(false)
    }
  }

  if (currentThreadLoading || overviewLoading) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-body">正在整理会话记录…</span>
      </div>
    )
  }

  if (currentThreadError || !currentThread) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <AlertCircle className="mb-3 h-10 w-10 text-destructive" />
        <h1 className="text-title font-semibold">无法打开该会话</h1>
        <p className="mt-1 text-body text-muted-foreground">
          {currentThreadError || '未找到对应的运行记录'}
        </p>
        <Button variant="outline" className="mt-4" onClick={() => navigate(threadListHref)}>
          返回会话列表
        </Button>
      </div>
    )
  }

  const { traces, statusStats, totalDurationMs } = currentThread
  const sessionTitle = overview?.session?.title || '未命名会话'

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <header className="shrink-0 border-b bg-background px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <Button
              variant="ghost"
              size="icon"
              aria-label="返回会话列表"
              onClick={() => navigate(threadListHref)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5 shrink-0 text-primary" />
                <h1 className="truncate text-title font-semibold">{sessionTitle}</h1>
              </div>
              <button
                type="button"
                className="mt-1 flex max-w-full items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                onClick={copyThreadId}
                title={threadId}
              >
                <span className="truncate">{threadId}</span>
                {copied ? (
                  <CheckCircle2 className="h-3 w-3 text-success" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{traces.length} 次执行</Badge>
            <Badge variant="outline">
              <Clock className="mr-1 h-3 w-3" />
              {formatDuration(totalDurationMs)}
            </Badge>
            {statusStats.error > 0 && (
              <Badge variant="destructive">{statusStats.error} 次失败</Badge>
            )}
            {statusStats.running > 0 && <Badge>{statusStats.running} 次运行中</Badge>}
            <Button
              variant={showOverview ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setShowOverview((value) => !value)}
              aria-pressed={showOverview}
            >
              <PanelRight className="mr-2 h-4 w-4" />
              运营概览
            </Button>
          </div>
        </div>
      </header>

      {overviewError && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-5 py-2 text-body">
          {overviewError}
        </div>
      )}

      <main className="min-h-0 flex-1">
        <ResizablePanel
          key={showOverview && overview ? 'split' : 'full'}
          leftPanel={
            <section
              className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
              aria-labelledby="chat-title"
            >
              <div className="shrink-0 border-b px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="chat-title" className="text-subtitle font-semibold">
                    对话记录
                  </h2>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-caption"
                      disabled={refreshing || !threadId}
                      onClick={() => void refreshConversationAndTraces()}
                      aria-label="刷新对话记录与执行记录"
                      title="同步对话内容与执行记录"
                    >
                      {refreshing ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {refreshing ? '刷新中' : '刷新'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-caption"
                      disabled={exportingConversation || !threadId}
                      onClick={() => void exportConversationJson()}
                    >
                      {exportingConversation ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {exportingConversation ? '正在导出' : '导出 JSON'}
                    </Button>
                  </div>
                </div>
                <p className="mt-0.5 text-caption text-muted-foreground">
                  仅展示用户可感知的消息；思考与工具执行过程请在「本轮运行诊断」中查看
                </p>
                {conversationExportError && (
                  <p className="mt-1 text-caption text-destructive">{conversationExportError}</p>
                )}
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {messages.length > 0 ? (
                  <ConversationTimeline
                    messages={messages}
                    traces={traces}
                    truncated={overview?.messages_truncated ?? messages.length >= 200}
                    onOpenTrace={setSelectedTraceId}
                  />
                ) : (
                  <div className="flex min-h-64 items-center justify-center text-body text-muted-foreground">
                    暂无可读取的对话消息
                  </div>
                )}
              </ScrollArea>
            </section>
          }
          rightPanel={
            showOverview && overview ? (
              <aside className="flex max-h-[45%] w-full shrink-0 flex-col border-t bg-background xl:max-h-none xl:min-w-0 xl:flex-1 xl:border-t-0">
                <SessionOverviewPanel
                  overview={overview}
                  traces={traces}
                  messages={messages}
                  onOpenTrace={setSelectedTraceId}
                />
              </aside>
            ) : null
          }
          defaultLeftWidth={showOverview && overview ? 45 : 100}
          minLeftWidth={25}
          maxLeftWidth={75}
          stackBelowXl
          disabled={!showOverview || !overview}
          resizeHandleLabel="调整对话记录与会话概览的宽度"
        />
      </main>
      <TraceOperationsDrawer
        traceId={selectedTraceId}
        messages={messages}
        onClose={() => setSelectedTraceId(null)}
      />
    </div>
  )
}
