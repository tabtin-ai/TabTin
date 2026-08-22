/**
 * Event Details Panel 组件
 * 右侧事件详情面板,优化信息层级,突出关键信息
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Event, LLMEvent } from '@/types/agent-debug'
import { countChanges, smartDiff } from '@/utils/objectDiff'
import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  DollarSign,
  GitBranch,
  GitCompare,
  Info,
  Zap,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getEventNameLabel, getEventPhaseLabel, getEventTypeLabel } from './event-labels'
import { LLMEventViewer } from './llm-event-viewer'
import { SmartFieldList } from './smart-field-list'

interface EventDetailsPanelProps {
  event: Event | null
  previousEvent?: Event | null
}

// 可折叠的字段组件
function CollapsibleSection({
  title,
  defaultExpanded = false,
  children,
  count,
  changeStats,
}: {
  title: string
  defaultExpanded?: boolean
  children: React.ReactNode
  count?: number
  changeStats?: { added: number; modified: number; deleted: number; unchanged: number }
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  const totalChanges = changeStats
    ? changeStats.added + changeStats.modified + changeStats.deleted
    : 0

  const hasChanges = totalChanges > 0

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className={cn(
          'flex w-full items-center justify-between px-4 py-3 text-left transition-colors',
          hasChanges ? 'hover:bg-warning/10' : 'hover:bg-muted/30'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold text-subtitle">{title}</span>
          {count !== undefined && (
            <Badge variant="outline" className="text-body font-normal">
              {count} 个字段
            </Badge>
          )}
          {changeStats && totalChanges > 0 && (
            <div className="flex items-center gap-2">
              {changeStats.added > 0 && (
                <Badge variant="default" className="text-body bg-info hover:bg-info">
                  +{changeStats.added}
                </Badge>
              )}
              {changeStats.modified > 0 && (
                <Badge variant="default" className="text-body bg-warning hover:bg-warning">
                  ~{changeStats.modified}
                </Badge>
              )}
              {changeStats.deleted > 0 && (
                <Badge
                  variant="default"
                  className="text-body bg-muted-foreground hover:bg-muted-foreground/80"
                >
                  -{changeStats.deleted}
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isExpanded && count !== undefined && (
            <span className="text-body text-muted-foreground">点击收起</span>
          )}
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>
      {isExpanded && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

export function EventDetailsPanel({ event, previousEvent }: EventDetailsPanelProps) {
  const [showDiff, setShowDiff] = useState(false) // 默认关闭 Diff
  const navigate = useNavigate()

  // 各区域的 ref，用于快速跳转
  const inputSectionRef = useRef<HTMLDivElement>(null)
  const outputSectionRef = useRef<HTMLDivElement>(null)
  const errorSectionRef = useRef<HTMLDivElement>(null)

  // 快速跳转函数
  const scrollToSection = (ref: React.RefObject<HTMLDivElement | null>) => {
    if (ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  // 格式化耗时
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  // 判断是否慢查询
  const isSlow = useMemo(() => {
    return event ? event.duration_ms !== null && event.duration_ms >= 1000 : false
  }, [event])

  // 计算智能 Diff
  const { inputSmartDiff, outputSmartDiff } = useMemo(() => {
    if (!event || !showDiff) {
      return { inputSmartDiff: undefined, outputSmartDiff: undefined }
    }

    // Input Smart Diff: 比较前一个事件的 output 和当前事件的 input
    const inputSmartDiff = previousEvent?.output
      ? smartDiff(previousEvent.output, event.input)
      : undefined

    // Output Smart Diff: 比较当前事件的 input 和 output
    const outputSmartDiff =
      event.input && event.output ? smartDiff(event.input, event.output) : undefined

    return { inputSmartDiff, outputSmartDiff }
  }, [event, previousEvent, showDiff])

  // 变化统计（只统计公共字段的真实变化）
  const inputChangeStats = inputSmartDiff
    ? countChanges(inputSmartDiff.commonFieldsDiff)
    : undefined
  const outputChangeStats = outputSmartDiff
    ? countChanges(outputSmartDiff.commonFieldsDiff)
    : undefined

  if (!event) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Info className="h-12 w-12 mx-auto opacity-20" />
          <p className="text-body">选择左侧事件以查看详情</p>
        </div>
      </div>
    )
  }

  const inputFields = event.input ? Object.keys(event.input) : []
  const outputFields = event.output ? Object.keys(event.output) : []
  const isLLMEvent = event.event_type === 'llm'
  const phase = event.ended_at ? 'end' : 'start'

  // LH2-A1（H3-C / Review M1 修复）：SUBAGENT_* 父视角事件提供"跳到子 trace"按钮。
  //
  // 两个降级策略：
  //   1. 优先用 input.child_trace_id（PROGRESS / COMPLETED / FAILED 带）
  //   2. 缺省时用 input.subagent_run_id（STARTED / PROGRESS / COMPLETED / FAILED 都带）
  //
  // SUBAGENT_STARTED emit 时子 runtime 还没启动，没有 child_trace_id；但
  // 当前 fork-query 实现里 child runId === child trace_id === subagent_run_id
  // 是不变量（agent-tool 生成的 childId 既是 subagent_run_id 也是 forkQuery
  // 创建 runtime 时的 runId）。所以用 subagent_run_id 跳转**等价**于跳到
  // 真正的子 trace，让用户从时间线第一条 STARTED 节点就能进入子 trace。
  //
  // event_type 是 short name（'subagent_started' 等去前缀；relay_trace_writer
  // _derive_event_name 又把它换成 'started' / 'progress' / ...），所以两套都识别。
  const subagentJumpTraceId = (() => {
    const input = event.input as Record<string, unknown> | null
    if (!input) return undefined
    if (typeof input.child_trace_id === 'string' && input.child_trace_id.length > 0) {
      return input.child_trace_id
    }
    if (typeof input.subagent_run_id === 'string' && input.subagent_run_id.length > 0) {
      return input.subagent_run_id
    }
    return undefined
  })()

  // 处理复制事件 JSON
  const handleCopyJSON = () => {
    const payload = {
      id: event.id,
      seq: event.seq,
      event_type: event.event_type,
      name: event.name,
      input: event.input,
      output: event.output,
      duration_ms: event.duration_ms,
      usage: event.usage,
      error: event.error,
    }
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <div className="flex-shrink-0 border-b border-border px-4 py-3 bg-background/95 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-title font-semibold">事件 #{event.seq}</h2>
            <Badge variant="outline" className="text-body" title={event.event_type}>
              {getEventTypeLabel(event.event_type)}
            </Badge>
            {event.error && (
              <Badge variant="destructive" className="text-body">
                <AlertTriangle className="h-3 w-3 mr-1" />
                错误
              </Badge>
            )}
            {isSlow && !event.error && (
              <Badge
                variant="secondary"
                className="text-body bg-warning/10 text-warning border-warning/30"
              >
                <Clock className="h-3 w-3 mr-1" />
                偏慢
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* LH2-A1：SUBAGENT_* event 提供"跳到子 trace"快捷入口（M1 修复后
                STARTED 节点也能跳——通过 subagent_run_id 降级，与 child_trace_id
                等价）。 */}
            {subagentJumpTraceId && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-info/40 text-info hover:bg-info/10"
                onClick={() => navigate(`/agent-debug/trace/${subagentJumpTraceId}`)}
                title={`查看子 Agent trace ${subagentJumpTraceId}`}
                data-testid="event-details-subagent-link"
              >
                <GitBranch className="mr-1 h-3 w-3" />
                子 trace: {subagentJumpTraceId.substring(0, 8)}…
              </Button>
            )}
            {previousEvent && (
              <Button
                variant={showDiff ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowDiff(!showDiff)}
                className="h-8"
              >
                <GitCompare className="mr-1 h-3 w-3" />
                {showDiff ? '对比开' : '对比关'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleCopyJSON}>
              <Copy className="mr-2 h-4 w-4" />
              复制 JSON
            </Button>
          </div>
        </div>
        <p
          className="text-body text-muted-foreground mt-1 truncate"
          title={`${getEventNameLabel(event.name)}（${event.name}）`}
        >
          {getEventNameLabel(event.name)}
        </p>
      </div>

      {/* 关键信息速览卡片 - 醒目显示 */}
      <div className="flex-shrink-0 border-b bg-gradient-to-r from-info/5 via-type-ai/5 to-destructive/5 px-4 py-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* 耗时 */}
          {event.duration_ms !== null && (
            <div className="flex items-center gap-2 bg-white/70 backdrop-blur-sm rounded-lg px-3 py-2 border">
              <Clock className={cn('h-4 w-4', isSlow ? 'text-warning' : 'text-muted-foreground')} />
              <div>
                <p className="text-caption text-muted-foreground font-medium uppercase">耗时</p>
                <p className={cn('font-mono font-bold text-body', isSlow && 'text-warning')}>
                  {formatDuration(event.duration_ms)}
                </p>
              </div>
            </div>
          )}

          {/* Tokens */}
          {event.usage?.total_tokens && (
            <div className="flex items-center gap-2 bg-white/70 backdrop-blur-sm rounded-lg px-3 py-2 border">
              <Zap className="h-4 w-4 text-info" />
              <div>
                <p className="text-caption text-muted-foreground font-medium uppercase">Token 数</p>
                <p className="font-mono font-bold text-body text-info">
                  {event.usage.total_tokens?.toLocaleString()}
                </p>
              </div>
            </div>
          )}

          {/* 成本 */}
          {event.usage && event.usage.estimated_cost_usd !== undefined && (
            <div className="flex items-center gap-2 bg-white/70 backdrop-blur-sm rounded-lg px-3 py-2 border">
              <DollarSign className="h-4 w-4 text-success" />
              <div>
                <p className="text-caption text-muted-foreground font-medium uppercase">成本</p>
                <p className="font-mono font-bold text-body text-success">
                  ${event.usage.estimated_cost_usd.toFixed(6)}
                </p>
              </div>
            </div>
          )}

          {/* 状态 */}
          <div className="flex items-center gap-2 bg-white/70 backdrop-blur-sm rounded-lg px-3 py-2 border">
            {event.error ? (
              <>
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <div>
                  <p className="text-caption text-muted-foreground font-medium uppercase">状态</p>
                  <p className="font-semibold text-body text-destructive">失败</p>
                </div>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 text-success" />
                <div>
                  <p className="text-caption text-muted-foreground font-medium uppercase">状态</p>
                  <p className="font-semibold text-body text-success">成功</p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* 快速跳转按钮 */}
        {!isLLMEvent && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/30">
            <span className="text-body text-muted-foreground font-medium">快速跳转:</span>
            {event.input && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-body"
                onClick={() => scrollToSection(inputSectionRef)}
              >
                <ArrowDown className="mr-1 h-3 w-3" />
                输入
              </Button>
            )}
            {event.output && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-body"
                onClick={() => scrollToSection(outputSectionRef)}
              >
                <ArrowDown className="mr-1 h-3 w-3" />
                输出
              </Button>
            )}
            {event.error && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-body text-destructive"
                onClick={() => scrollToSection(errorSectionRef)}
              >
                <AlertTriangle className="mr-1 h-3 w-3" />
                错误
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 详情内容 */}
      <ScrollArea className="flex-1">
        <div>
          {/* LLM Event 专用视图 */}
          {isLLMEvent ? (
            <div className="p-4">
              <LLMEventViewer event={event as LLMEvent} />
            </div>
          ) : (
            <>
              {/* Input Section */}
              {event.input && (
                <div ref={inputSectionRef}>
                  <CollapsibleSection
                    title="📥 输入"
                    count={inputFields.length}
                    changeStats={inputChangeStats}
                    defaultExpanded={false}
                  >
                    <SmartFieldList data={event.input} smartDiff={inputSmartDiff} showTopN={8} />
                  </CollapsibleSection>
                </div>
              )}

              {/* Output Section */}
              {event.output && (
                <div ref={outputSectionRef}>
                  <CollapsibleSection
                    title="📤 输出"
                    count={outputFields.length}
                    changeStats={outputChangeStats}
                    defaultExpanded={false}
                  >
                    <SmartFieldList data={event.output} smartDiff={outputSmartDiff} showTopN={8} />
                  </CollapsibleSection>
                </div>
              )}
            </>
          )}

          {/* Metadata Section */}
          <CollapsibleSection title="🏷️ 元数据" defaultExpanded={false}>
            <div className="space-y-2 text-body">
              <div className="flex justify-between gap-4">
                <span className="shrink-0 text-muted-foreground">事件 ID</span>
                <span className="font-mono break-all text-right">{event.id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">序号</span>
                <span className="font-mono">#{event.seq}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">类型</span>
                <span title={event.event_type}>{getEventTypeLabel(event.event_type)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">阶段</span>
                <span>{getEventPhaseLabel(phase)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">开始时间</span>
                <span className="text-body">
                  {new Date(event.started_at).toLocaleString('zh-CN')}
                </span>
              </div>
              {event.ended_at && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">结束时间</span>
                  <span className="text-body">
                    {new Date(event.ended_at).toLocaleString('zh-CN')}
                  </span>
                </div>
              )}
              {event.duration_ms !== null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">耗时</span>
                  <span className="font-mono">{event.duration_ms} 毫秒</span>
                </div>
              )}
              {event.parent_event_id !== null && (
                <div className="flex justify-between gap-4">
                  <span className="shrink-0 text-muted-foreground">父事件</span>
                  <span className="font-mono break-all text-right">{event.parent_event_id}</span>
                </div>
              )}
            </div>
          </CollapsibleSection>

          {/* Usage Section (for LLM events) */}
          {!isLLMEvent && event.usage && (
            <CollapsibleSection title="📊 用量" defaultExpanded={true}>
              <div className="space-y-2 text-body">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">输入 Token</span>
                  <span className="font-mono">{event.usage.prompt_tokens}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">输出 Token</span>
                  <span className="font-mono">{event.usage.completion_tokens}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">总 Token</span>
                  <span className="font-mono font-semibold">{event.usage.total_tokens}</span>
                </div>
                {event.usage.estimated_cost_usd !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">预估成本</span>
                    <span className="font-mono text-success">
                      ${event.usage.estimated_cost_usd.toFixed(6)}
                    </span>
                  </div>
                )}
              </div>
            </CollapsibleSection>
          )}

          {/* Error Section */}
          {event.error && (
            <div ref={errorSectionRef}>
              <CollapsibleSection title="❌ 错误" defaultExpanded={true}>
                <div className="rounded-md border-2 border-destructive/50 bg-destructive/10 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                    <p className="text-body text-destructive whitespace-pre-wrap flex-1">
                      {event.error}
                    </p>
                  </div>
                </div>
              </CollapsibleSection>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
