import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ThreadMessageAttachment, ThreadOverviewMessage, Trace } from '@/types/agent-debug'
import {
  AlertCircle,
  Bot,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  MessageSquare,
  UserRound,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  attachmentKindLabel,
  collectDisplayAttachments,
  isImageAttachment,
  isToolProcessOnlyMessage,
  resolveAttachmentAdminPath,
  resolveAttachmentOpenUrl,
} from './conversation-message-utils'
import { resolveDisplayText } from './message-process-blocks'

const HIDDEN_MESSAGE_KINDS = new Set([
  'environment_context',
  'agent_profile_context',
  'hitl_interaction',
  'system_prompt_context',
  'external_archive_context',
])

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return 'Agent'
  if (role === 'tool') return '工具'
  return '系统'
}

function formatFileSize(size?: number): string | null {
  if (typeof size !== 'number' || size < 0) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function MessageAttachments({ attachments }: { attachments: ThreadMessageAttachment[] }) {
  if (attachments.length === 0) return null

  const hasAgentArtifact = attachments.some((item) => item.source === 'agent')

  return (
    <div className="mt-3 border-t pt-3">
      {hasAgentArtifact && (
        <p className="mb-2 text-caption font-medium text-muted-foreground">生成产物</p>
      )}
      <ul className="space-y-2">
        {attachments.map((attachment, index) => {
          const openUrl = resolveAttachmentOpenUrl(attachment)
          const adminPath = resolveAttachmentAdminPath(attachment)
          const previewUrl = resolveAttachmentOpenUrl({
            ...attachment,
            url: attachment.preview_url || attachment.url,
          })
          const showImage = isImageAttachment(attachment) && previewUrl
          const key =
            attachment.resource_id ||
            attachment.file_id ||
            attachment.url ||
            `${attachment.filename}-${index}`
          const sizeLabel = formatFileSize(attachment.size)
          const meta =
            [attachmentKindLabel(attachment), attachment.mime_type, sizeLabel]
              .filter(Boolean)
              .join(' · ') || '文件'

          return (
            <li
              key={key}
              className="rounded-md border bg-background/80 px-3 py-2 text-left"
            >
              <div className="flex items-start gap-3">
                {showImage ? (
                  <a
                    href={openUrl || previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block shrink-0"
                    title="预览"
                  >
                    <img
                      src={previewUrl!}
                      alt={attachment.filename}
                      className="h-16 w-16 rounded object-cover border"
                    />
                  </a>
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded border bg-muted">
                    <FileText className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-body font-medium">{attachment.filename}</p>
                    {attachment.source === 'agent' && (
                      <Badge variant="outline" className="text-caption">
                        Agent 产物
                      </Badge>
                    )}
                    {attachment.source === 'user' && (
                      <Badge variant="secondary" className="text-caption">
                        用户附件
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-caption text-muted-foreground">{meta}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {openUrl && (
                      <>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-caption" asChild>
                          <a href={openUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="mr-1 h-3 w-3" />
                            预览
                          </a>
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-caption" asChild>
                          <a
                            href={openUrl}
                            download={attachment.filename}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Download className="mr-1 h-3 w-3" />
                            下载
                          </a>
                        </Button>
                      </>
                    )}
                    {!openUrl && adminPath && (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-caption" asChild>
                        <Link to={adminPath}>
                          <ExternalLink className="mr-1 h-3 w-3" />
                          {attachment.kind === 'document' ? '查看文档' : '在管理后台打开'}
                        </Link>
                      </Button>
                    )}
                    {!openUrl && !adminPath && (
                      <span className="text-caption text-muted-foreground">暂无可打开链接</span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface ConversationTimelineProps {
  messages: ThreadOverviewMessage[]
  traces: Trace[]
  truncated: boolean
  onOpenTrace: (traceId: string) => void
}

export function ConversationTimeline({
  messages,
  traces,
  truncated,
  onOpenTrace,
}: ConversationTimelineProps) {
  const visibleMessages = messages.filter(
    (message) =>
      !HIDDEN_MESSAGE_KINDS.has(message.message_kind) && !isToolProcessOnlyMessage(message)
  )
  const traceMap = new Map(traces.map((trace) => [trace.trace_id, trace]))

  if (visibleMessages.length === 0) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center text-muted-foreground">
        <MessageSquare className="mb-3 h-10 w-10 opacity-20" />
        <p className="text-body font-medium text-foreground">暂无可展示的对话</p>
        <p className="mt-1 text-caption">
          内部上下文与工具调用过程已隐藏；思考与执行过程请通过「查看本轮运行诊断」查看
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-5 py-6">
      {truncated && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-body">
          当前展示最早 200 条消息，完整历史需通过分页继续加载。
        </div>
      )}

      {visibleMessages.map((message) => {
        const isUser = message.role === 'user'
        const trace = message.trace_id ? traceMap.get(message.trace_id) : undefined
        const attachments = collectDisplayAttachments(message)
        const text = resolveDisplayText(message.content, message.content_blocks_json)
        const showPlaceholderText = !text && attachments.length === 0

        return (
          <article
            key={message.id}
            className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
          >
            <div
              className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
              }`}
              aria-hidden="true"
            >
              {isUser ? <UserRound className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
            </div>

            <div className={`min-w-0 max-w-[82%] ${isUser ? 'text-right' : 'text-left'}`}>
              <div
                className={`mb-1 flex flex-wrap items-center gap-2 text-caption text-muted-foreground ${
                  isUser ? 'justify-end' : 'justify-start'
                }`}
              >
                <span className="font-medium text-foreground">{roleLabel(message.role)}</span>
                <span>{formatTime(message.created_at)}</span>
                {message.model_name && <span>{message.model_name}</span>}
                {message.subagent_run_id && <Badge variant="outline">子 Agent</Badge>}
                {message.error && <Badge variant="destructive">异常</Badge>}
              </div>

              <div
                className={`rounded-lg border px-4 py-3 text-left text-body leading-relaxed ${
                  isUser ? 'border-primary/20 bg-primary/10' : 'bg-background'
                }`}
              >
                {text ? (
                  <p className="whitespace-pre-wrap break-words">{text}</p>
                ) : null}
                {showPlaceholderText && (
                  <p className="text-muted-foreground">（此消息没有可读文本）</p>
                )}
                <MessageAttachments attachments={attachments} />
                {message.error && (
                  <div className="mt-3 flex gap-2 border-t pt-3 text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{String(message.error.error_message || '本轮执行出现异常')}</span>
                  </div>
                )}
              </div>

              {trace && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 px-2 text-caption"
                  onClick={() => onOpenTrace(trace.trace_id)}
                >
                  查看本轮运行诊断
                  <ChevronRight className="ml-1 h-3 w-3" />
                </Button>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}
