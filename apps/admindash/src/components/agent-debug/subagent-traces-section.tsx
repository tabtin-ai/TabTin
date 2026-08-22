/**
 * SubagentTracesSection — LH2-A1（H3-C）
 *
 * 在父 trace-detail 页顶部展示"本父 trace 派生的所有子 Agent traces"。
 *
 * 数据来源：父 trace 的 events 中含 `child_trace_id` 字段的（agent-tool 在
 * `subagent_progress` / `subagent_completed` / `subagent_failed` event payload
 * 注入）。组件 dedupe 后按发现顺序渲染卡片。
 *
 * UX 设计：
 *   - 卡片显示 child trace_id 的前 8 位 + label（来自 SUBAGENT_STARTED.task）
 *   - 点击卡片跳到子 trace-detail（同一 SPA route，useTraceStream 自动接管）
 *   - 折叠区域，避免把父 trace-detail 关键信息（错误面板）挤下去
 *   - 0 个子 trace 时 **不渲染**（不占布局），避免普通对话页面无意义空槽
 */

import { Badge } from '@/components/ui/badge'
import type { Event } from '@/types/agent-debug'
import { ChevronDown, ChevronRight, Layers, GitBranch } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

interface SubagentTracesSectionProps {
  /** 当前父 trace 的所有 events（trace-detail 已加载的 store.events）。 */
  events: Event[]
}

interface SubagentTraceSummary {
  /** 子 trace UUID（来自 child_trace_id 字段） */
  childTraceId: string
  /** 子 Agent 任务标签（首次见到时取自 SUBAGENT_STARTED 同 subagent_run_id 的 input.label） */
  label: string | undefined
  /** 子 Agent 任务 prompt 摘要（前 80 字符，用于卡片副标题） */
  taskPreview: string | undefined
  /** 子 Agent 状态：'completed' | 'failed' | 'running' */
  status: 'completed' | 'failed' | 'running'
  /** subagent_run_id（与 child_trace_id 通常一致，但留独立字段防止未来 fork-query 解耦） */
  subagentRunId: string
  /** 步骤数（progress event 累计） */
  stepCount: number
}

const STARTED_TYPE = 'started'
const PROGRESS_TYPE = 'progress'
const COMPLETED_TYPE = 'completed'
const FAILED_TYPE = 'failed'

/**
 * 从父 trace events 中提取子 Agent 概览。
 *
 * 规则：
 *   - 以 SUBAGENT_STARTED event 为锚点（input 含 subagent_run_id + task + label）
 *   - SUBAGENT_PROGRESS 累计 step_count + 取 child_trace_id（H3-C 之后才有）
 *   - SUBAGENT_COMPLETED → status=completed；SUBAGENT_FAILED → status=failed
 *   - SUBAGENT_STARTED 但无后续 → running
 *   - **关键**：只对 H3-C 之后产生的 trace（payload 含 child_trace_id）显示卡片；
 *     旧 trace（H3-C 前）child_trace_id 永远是 undefined，本组件不渲染避免误导。
 */
function extractSubagentSummaries(events: Event[]): SubagentTraceSummary[] {
  const byRunId = new Map<string, SubagentTraceSummary>()

  // 排序后按时间线顺序处理
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (const event of sorted) {
    // event_type 在 ExecutionTrace 表中是 short name（subagent_started 这种带前缀
    // 的字符串，relay_trace_writer._derive_event_name 把它去前缀变成 'started' /
    // 'progress' / 'completed' / 'failed'）。这里两种都识别。
    const eventType = event.event_type
    const name = event.name

    const isSubagent =
      eventType.startsWith('subagent_') ||
      ['started', 'progress', 'completed', 'failed'].includes(name)
    if (!isSubagent) continue

    const payload = (event.input as Record<string, unknown> | null) ?? {}
    const runIdRaw = payload.subagent_run_id
    const childTraceIdRaw = payload.child_trace_id
    const childTraceId =
      typeof childTraceIdRaw === 'string' && childTraceIdRaw.length > 0
        ? childTraceIdRaw
        : undefined
    const runId =
      typeof runIdRaw === 'string' && runIdRaw.length > 0
        ? runIdRaw
        : childTraceId
    if (!runId) continue

    const existing = byRunId.get(runId) ?? {
      childTraceId: childTraceId ?? '',
      label: typeof payload.label === 'string' ? payload.label : undefined,
      taskPreview:
        typeof payload.task === 'string'
          ? (payload.task as string).slice(0, 80)
          : undefined,
      status: 'running' as const,
      subagentRunId: runId,
      stepCount: 0,
    }

    // 已知 child_trace_id 优先 — 后续 progress / completed events 才能拿到
    if (!existing.childTraceId && childTraceId) {
      existing.childTraceId = childTraceId
    }
    if (!existing.label && typeof payload.label === 'string') {
      existing.label = payload.label
    }
    if (!existing.taskPreview && typeof payload.task === 'string') {
      existing.taskPreview = (payload.task as string).slice(0, 80)
    }

    // status 转移：completed / failed 是终态
    const eventName = name
    if (eventName === COMPLETED_TYPE || eventType === 'subagent_completed') {
      existing.status = 'completed'
    } else if (eventName === FAILED_TYPE || eventType === 'subagent_failed') {
      existing.status = 'failed'
    } else if (eventName === PROGRESS_TYPE || eventType === 'subagent_progress') {
      const sc = payload.step_count
      if (typeof sc === 'number') existing.stepCount = sc
      // 只有 progress 之前没拿到 child_trace_id 才更新
      if (!existing.childTraceId && childTraceId) existing.childTraceId = childTraceId
    } else if (eventName === STARTED_TYPE || eventType === 'subagent_started') {
      // started 不改 status — running 是默认
    }

    byRunId.set(runId, existing)
  }

  // 过滤：没有 child_trace_id 的不渲染（旧 trace 没法跳转，渲染只会让运维迷惑）
  return Array.from(byRunId.values()).filter((s) => s.childTraceId.length > 0)
}

const STATUS_BADGES: Record<SubagentTraceSummary['status'], { label: string; className: string }> = {
  completed: {
    label: '完成',
    className: 'border-success/30 bg-success/10 text-success',
  },
  running: {
    label: '运行中',
    className: 'border-info/30 bg-info/10 text-info',
  },
  failed: {
    label: '失败',
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
}

export function SubagentTracesSection({ events }: SubagentTracesSectionProps) {
  const summaries = useMemo(() => extractSubagentSummaries(events), [events])
  const [expanded, setExpanded] = useState(true)
  const navigate = useNavigate()

  if (summaries.length === 0) return null

  return (
    <div className="border-b bg-info/5 px-6 py-3">
      <button
        type="button"
        className="flex items-center gap-2 text-body font-medium text-info hover:underline"
        onClick={() => setExpanded(!expanded)}
      >
        <Layers className="h-4 w-4" />
        子 Agent Trace（{summaries.length}）
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {expanded && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {summaries.map((s) => {
            const status = STATUS_BADGES[s.status]
            return (
              <button
                type="button"
                key={s.subagentRunId}
                className="flex flex-col items-start gap-1 rounded-md border border-border/60 bg-background px-3 py-2 text-left transition-colors hover:border-info/50 hover:bg-info/5"
                onClick={() => navigate(`/agent-debug/trace/${s.childTraceId}`)}
                data-testid="subagent-trace-card"
              >
                <div className="flex items-center gap-2 w-full">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span
                    className="text-body font-medium truncate flex-1"
                    title={s.label ?? s.taskPreview}
                  >
                    {s.label ?? s.taskPreview ?? '子 Agent 任务'}
                  </span>
                  <Badge variant="outline" className={`text-caption ${status.className}`}>
                    {status.label}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-caption text-muted-foreground font-mono">
                  <span title={s.childTraceId}>{s.childTraceId.substring(0, 8)}…</span>
                  {s.stepCount > 0 && <span>{s.stepCount} 步</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 导出供单元测试用
export const __test__ = { extractSubagentSummaries }
