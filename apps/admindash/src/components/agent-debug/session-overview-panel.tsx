import { Badge } from '@/components/ui/badge'
import type { ThreadOverview, ThreadOverviewMessage, Trace } from '@/types/agent-debug'
import {
  AlertCircle,
  Bot,
  Boxes,
  BrainCircuit,
  Building2,
  Check,
  Clock,
  Coins,
  Copy,
  FolderKanban,
  MessageSquare,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  buildTraceUserPreviewMap,
  getExecutionRunSubtitle,
  getExecutionRunTitle,
} from './execution-run-labels'

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(value)
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const approvalLabels: Record<string, string> = {
  always_ask: '每次询问',
  auto: '自动批准低风险操作',
  full_access: '完全访问',
}

interface OverviewRowProps {
  icon: typeof UserRound
  label: string
  value: string | null | undefined
}

function OverviewItem({ icon: Icon, label, value }: OverviewRowProps) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="truncate text-body font-medium" title={value || undefined}>
          {value || '未记录'}
        </div>
      </div>
    </div>
  )
}

function OrganizationItem({
  organizationId,
  organizationName,
}: {
  organizationId: string
  organizationName: string | null
}) {
  const [copied, setCopied] = useState(false)

  const copyOrganizationId = async () => {
    await navigator.clipboard.writeText(organizationId)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="flex min-w-0 items-start gap-2 lg:col-span-2">
      <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <Link
        to={`/organizations/${encodeURIComponent(organizationId)}`}
        className="min-w-0 flex-1 rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="查看组织详情"
      >
        <div className="truncate text-body font-medium">{organizationName || '未命名组织'}</div>
        <div className="break-all text-caption text-muted-foreground">{organizationId}</div>
      </Link>
      <button
        type="button"
        className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={copyOrganizationId}
        aria-label={copied ? '组织 ID 已复制' : '复制组织 ID'}
        title={copied ? '已复制' : '复制组织 ID'}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

interface SessionOverviewPanelProps {
  overview: ThreadOverview
  traces: Trace[]
  /** 对话消息（用于把执行挂到用户原话）；缺省用 overview.messages */
  messages?: ThreadOverviewMessage[]
  onOpenTrace: (traceId: string) => void
}

export function SessionOverviewPanel({
  overview,
  traces,
  messages,
  onOpenTrace,
}: SessionOverviewPanelProps) {
  const session = overview.session
  const userPreviewByTraceId = useMemo(
    () => buildTraceUserPreviewMap(messages ?? overview.messages ?? []),
    [messages, overview.messages]
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <section className="shrink-0" aria-labelledby="session-subject-title">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="session-subject-title" className="text-subtitle font-semibold">
            会话主体
          </h2>
          {session && (
            <Badge variant={session.is_paused ? 'outline' : 'secondary'}>
              {session.is_paused ? '已暂停' : session.status}
            </Badge>
          )}
        </div>
        {session ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-md border px-3 py-2 lg:grid-cols-4 2xl:grid-cols-8">
            <OverviewItem
              icon={UserRound}
              label="用户"
              value={session.user_name || session.user_id}
            />
            <OrganizationItem
              organizationId={session.organization_id}
              organizationName={session.organization_name}
            />
            <OverviewItem
              icon={FolderKanban}
              label="Workspace"
              value={session.workspace_name || session.workspace_id}
            />
            {session.project_id && (
              <OverviewItem
                icon={Boxes}
                label="Project"
                value={session.project_name || session.project_id}
              />
            )}
            <OverviewItem icon={Bot} label="Agent" value={session.agent_name || session.agent_id} />
            <OverviewItem icon={BrainCircuit} label="模型" value={session.model_name} />
            <OverviewItem
              icon={ShieldCheck}
              label="运行模式 / 审批"
              value={`${session.agent_mode || '默认'} · ${
                approvalLabels[session.approval_mode] || session.approval_mode
              }`}
            />
          </div>
        ) : (
          <p className="rounded-md border px-3 py-4 text-body text-muted-foreground">
            该 Thread 没有关联到可读取的 ChatSession，仅能查看运行记录。
          </p>
        )}
      </section>

      {session && (
        <section className="shrink-0" aria-labelledby="usage-title">
          <h2 id="usage-title" className="mb-2 text-subtitle font-semibold">
            使用概览
          </h2>
          <div className="grid grid-cols-2 divide-x rounded-md border lg:grid-cols-4">
            <div className="flex items-start gap-3 px-3 py-2">
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-body font-semibold">{session.message_count}</div>
                <div className="text-caption text-muted-foreground">可见消息</div>
              </div>
            </div>
            <div
              className="flex items-start gap-3 px-3 py-2"
              title="模型输入包含系统提示、Agent 规则、工具定义与环境上下文"
            >
              <Coins className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-body font-semibold">
                  {formatNumber(session.input_tokens)} 输入 · {formatNumber(session.output_tokens)}{' '}
                  输出
                </div>
                <div className="text-caption text-muted-foreground">模型 Token（含系统上下文）</div>
              </div>
            </div>
            <div className="flex items-start gap-3 px-3 py-2">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-body font-semibold">{formatTime(session.created_at)}</div>
                <div className="text-caption text-muted-foreground">开始时间</div>
              </div>
            </div>
            <div className="flex items-start gap-3 px-3 py-2">
              <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-body font-semibold">{session.compaction_count}</div>
                <div className="text-caption text-muted-foreground">上下文压缩</div>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="runs-title">
        <div className="mb-2 flex shrink-0 items-end justify-between gap-4">
          <div>
            <h2 id="runs-title" className="text-subtitle font-semibold">
              执行记录
            </h2>
            <p className="mt-0.5 text-caption text-muted-foreground">
              每条代表一次 Agent 启动、续跑、重试或恢复，不等同于一轮对话
            </p>
          </div>
          <span className="shrink-0 text-caption text-muted-foreground">共 {traces.length} 条</span>
        </div>
        {overview.trace_summary.latest_error && (
          <div className="mb-2 flex shrink-0 gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-body text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="line-clamp-3">{overview.trace_summary.latest_error}</p>
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {traces.map((trace, index) => {
            const title = getExecutionRunTitle(trace, userPreviewByTraceId)
            const subtitle = getExecutionRunSubtitle(trace)
            return (
              <button
                key={trace.trace_id}
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpenTrace(trace.trace_id)}
                title={`${title}\n${subtitle}\n#${index + 1}`}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-body font-medium">{title}</span>
                    <span className="shrink-0 text-caption text-muted-foreground/80">
                      #{index + 1}
                    </span>
                  </div>
                  <div className="truncate text-caption text-muted-foreground">{subtitle}</div>
                </div>
                <Badge
                  variant={
                    trace.status === 'error'
                      ? 'destructive'
                      : trace.status === 'running'
                        ? 'default'
                        : 'secondary'
                  }
                  className="shrink-0"
                >
                  {trace.status === 'error'
                    ? '失败'
                    : trace.status === 'running'
                      ? '运行中'
                      : '完成'}
                </Badge>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
