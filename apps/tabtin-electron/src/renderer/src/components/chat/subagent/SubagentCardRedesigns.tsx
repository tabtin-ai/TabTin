/**
 * SubagentCardRedesigns — 子 Agent 任务卡片「重设计候选」（DEV 预览专用）
 *
 * 设计原则（2026-05-29 第二轮反馈：极简层次）：
 *   1. **单色优先**——状态不用「红黄绿蓝」一把抓。进行中 / 排队 / 完成 / 取消
 *      全部走中性灰，靠「图标形状 + 文案」区分，不靠颜色。
 *   2. **色彩只在点上**——整套卡片唯一允许的语义色是 `失败`（需要用户处理），
 *      其余一律灰阶。彩色面积逼近 0。
 *   3. **层次靠字号 / 字重 / 透明度**——标题用 foreground，元信息退 muted/60、
 *      时间退 muted/40；不靠描边、不靠竖线、不靠身份色块。
 *   4. **身份退成文字标签**——子 Agent 名字以次要灰字呈现
 *      用灰字标注，不再给每个子 Agent 一个彩色圆点 / 竖条。
 *
 * 这些候选是纯视觉探索：cancel / retry / drill-in 只做 hover 态展示，不接真实
 * store（选定方向后再回填到正式组件）。
 */

import React, { useState } from 'react'
import {
  Check,
  Loader2,
  XCircle,
  Clock,
  Ban,
  ChevronDown,
  ChevronRight,
  X,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useSpeakerRegistryStore } from '../../../stores/useSpeakerRegistryStore'
import type { SubagentRun, SubagentStatus } from '../../../stores/chat/shared/types'
import { formatDuration } from '../utils/format'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

/* ─── 共享小工具 ─────────────────────────────────────────────────────── */

function useSpeakerName(sessionId: string | null, speakerId?: string): string | undefined {
  return useSpeakerRegistryStore((s) => {
    if (!sessionId || !speakerId) return undefined
    return s.speakersBySessionId[sessionId]?.[speakerId]?.display_name
  })
}

function normalizeTs(v?: number): number | undefined {
  if (v == null) return undefined
  return v > 1e12 ? v / 1000 : v
}

function calcElapsed(run: SubagentRun): number | undefined {
  if (run.stats?.duration_ms && run.stats.duration_ms > 0) return run.stats.duration_ms
  if (run.elapsedMs && run.elapsedMs > 0) return run.elapsedMs
  const s = normalizeTs(run.startedAt)
  const e = normalizeTs(run.endedAt)
  if (s && e) return (e - s) * 1000
  if (s && (run.status === 'running' || run.status === 'pending')) {
    return Math.max(0, Date.now() - s * 1000)
  }
  return undefined
}

function aggElapsed(runs: SubagentRun[]): number | undefined {
  let max = 0
  for (const r of runs) {
    const e = calcElapsed(r)
    if (e && e > max) max = e
  }
  return max > 0 ? max : undefined
}

interface StatusMeta {
  Icon: React.ComponentType<{ className?: string }>
  /** 单色为主：除 failed 外全部灰阶 */
  tone: string
  label: string
  animate?: boolean
}

/**
 * 单色状态表——只有 `failed` 带语义色（text-destructive/80），其余灰阶。
 * 进行中靠 spinner 转动、完成靠 ✓、排队靠时钟、取消靠 — 区分，不靠颜色。
 */
function statusMeta(status: SubagentStatus): StatusMeta {
  switch (status) {
    case 'running':
      return { Icon: Loader2, tone: 'text-muted-foreground/60', label: '进行中', animate: true }
    case 'completed':
      return { Icon: Check, tone: 'text-muted-foreground/40', label: '已完成' }
    case 'failed':
      return { Icon: XCircle, tone: 'text-destructive/80', label: '失败' }
    case 'queued':
      return { Icon: Clock, tone: 'text-muted-foreground/40', label: '排队中' }
    case 'cancelled':
      return { Icon: Ban, tone: 'text-muted-foreground/40', label: '已取消' }
    default:
      return { Icon: Loader2, tone: 'text-muted-foreground/40', label: '启动中', animate: true }
  }
}

const TOOL_LABELS: Record<string, string> = {
  file_read: '读取文件',
  web_search: '网页搜索',
  web_fetch: '网页抓取',
  code_grep: '代码检索',
  bash: '终端命令',
}

function toolLabel(name?: string): string {
  if (!name) return ''
  return TOOL_LABELS[name] ?? name
}

function countByStatus(runs: SubagentRun[]) {
  const c: Record<string, number> = {
    running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, pending: 0,
  }
  for (const r of runs) if (c[r.status] !== undefined) c[r.status]++
  return c
}

/**
 * 头部状态细分：「2 进行中 · 1 完成 · 1 失败」。
 * 全灰阶，唯一例外是 failed 段——它需要用户处理，给一点 destructive 色。
 */
const Breakdown: React.FC<{ runs: SubagentRun[] }> = ({ runs }) => {
  const c = countByStatus(runs)
  const parts: { text: string; danger?: boolean }[] = []
  if (c.running) parts.push({ text: `${c.running} 进行中` })
  if (c.queued) parts.push({ text: `${c.queued} 排队` })
  if (c.completed) parts.push({ text: `${c.completed} 完成` })
  if (c.failed) parts.push({ text: `${c.failed} 失败`, danger: true })
  if (c.cancelled) parts.push({ text: `${c.cancelled} 已取消` })
  if (!parts.length) return null
  return (
    <span className="truncate text-caption text-muted-foreground/60">
      {parts.map((p, i) => (
        <React.Fragment key={p.text}>
          {i > 0 ? ' · ' : ''}
          <span className={p.danger ? 'text-destructive/80' : undefined}>{p.text}</span>
        </React.Fragment>
      ))}
    </span>
  )
}

/** 行内 hover 浮现的控制（取消 / 重试）——静息时隐身，不占视觉 */
const RowControls: React.FC<{ run: SubagentRun }> = ({ run }) => {
  if (run.status === 'failed') {
    return (
      <ChatIconTooltip content="重试此子任务">
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted/40 hover:text-foreground group-hover:opacity-100"
          aria-label="重试此子任务"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </ChatIconTooltip>
    )
  }
  if (run.status === 'running' || run.status === 'queued') {
    return (
      <ChatIconTooltip content="取消此子任务">
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted/40 hover:text-foreground group-hover:opacity-100"
          aria-label="取消此子任务"
        >
          <X className="h-3 w-3" />
        </button>
      </ChatIconTooltip>
    )
  }
  return null
}

interface VariantProps {
  sessionId: string | null
  runs: SubagentRun[]
}

/* ─── 候选 A：极简单行（最紧凑，单色清单） ──────────────────────────── */

const MinimalRow: React.FC<{ run: SubagentRun; sessionId: string | null }> = ({ run, sessionId }) => {
  const meta = statusMeta(run.status)
  const name = useSpeakerName(sessionId, run.speakerId)
  const elapsed = calcElapsed(run)
  return (
    <div className="group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
      <meta.Icon className={cn('h-3.5 w-3.5 shrink-0', meta.tone, meta.animate && 'animate-spin')} />
      <span className="min-w-0 truncate text-body text-foreground/90">{run.label}</span>
      {name && <span className="shrink-0 text-caption text-muted-foreground/60">{name}</span>}
      <span className="ml-auto" />
      {run.status === 'running' && run.stepCount && (
        <span className="shrink-0 truncate text-caption text-muted-foreground/60">
          第 {run.stepCount} 步 · {toolLabel(run.latestTool)}
        </span>
      )}
      {elapsed && (
        <span className="shrink-0 text-caption text-muted-foreground/40 tabular-nums">
          {formatDuration(Math.round(elapsed))}
        </span>
      )}
      <RowControls run={run} />
    </div>
  )
}

export const SubagentRedesignMinimalRow: React.FC<VariantProps> = ({ sessionId, runs }) => {
  const elapsed = aggElapsed(runs)
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 px-2 pb-1">
        <span className="shrink-0 text-body font-medium text-foreground/80">{runs.length} 个子任务</span>
        <Breakdown runs={runs} />
        {elapsed && (
          <span className="ml-auto shrink-0 text-caption text-muted-foreground/40 tabular-nums">
            {formatDuration(Math.round(elapsed))}
          </span>
        )}
      </div>
      {runs.map((run) => (
        <MinimalRow key={run.subagentRunId} run={run} sessionId={sessionId} />
      ))}
    </div>
  )
}

/* ─── 候选 B：双行（标题 + 次要灰行） ──────────────────── */

const TwoLineRow: React.FC<{ run: SubagentRun; sessionId: string | null }> = ({ run, sessionId }) => {
  const meta = statusMeta(run.status)
  const name = useSpeakerName(sessionId, run.speakerId)
  const elapsed = calcElapsed(run)

  // 第二行次要信息：进行中 → 步数 / 工具；否则 → 任务原文
  const secondary =
    run.status === 'running' && run.stepCount
      ? `第 ${run.stepCount} 步 · ${toolLabel(run.latestTool)}`
      : run.task

  return (
    <div className="group flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/20">
      <meta.Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', meta.tone, meta.animate && 'animate-spin')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-body text-foreground/90">{run.label}</span>
          <span className="ml-auto" />
          <RowControls run={run} />
          <span
            className={cn(
              'shrink-0 text-caption',
              run.status === 'failed' ? 'text-destructive/80' : 'text-muted-foreground/60',
            )}
          >
            {meta.label}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-caption text-muted-foreground/60">
          {name && <span className="shrink-0">{name}</span>}
          {secondary && (
            <>
              {name && <span className="shrink-0 text-muted-foreground/40">·</span>}
              <span className="min-w-0 truncate">{secondary}</span>
            </>
          )}
          {elapsed && (
            <span className="ml-auto shrink-0 text-muted-foreground/40 tabular-nums">
              {formatDuration(Math.round(elapsed))}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export const SubagentRedesignTwoLine: React.FC<VariantProps> = ({ sessionId, runs }) => {
  const elapsed = aggElapsed(runs)
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 px-2 pb-1">
        <span className="shrink-0 text-body font-medium text-foreground/80">{runs.length} 个子任务</span>
        <Breakdown runs={runs} />
        {elapsed && (
          <span className="ml-auto shrink-0 text-caption text-muted-foreground/40 tabular-nums">
            {formatDuration(Math.round(elapsed))}
          </span>
        )}
      </div>
      {runs.map((run) => (
        <TwoLineRow key={run.subagentRunId} run={run} sessionId={sessionId} />
      ))}
    </div>
  )
}

/* ─── 候选 C：折叠摘要（默认一行，点开看详情） ─────────────────────── */

export const SubagentRedesignFoldSummary: React.FC<VariantProps> = ({ sessionId, runs }) => {
  const [open, setOpen] = useState(false)
  const c = countByStatus(runs)
  const elapsed = aggElapsed(runs)
  const allDone = c.running === 0 && c.queued === 0 && c.pending === 0
  const HeadIcon = allDone ? Check : Loader2
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/20"
      >
        <HeadIcon
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground/60',
            !allDone && 'animate-spin',
          )}
        />
        <span className="shrink-0 text-body text-foreground/90">{runs.length} 个子任务</span>
        <Breakdown runs={runs} />
        <span className="ml-auto" />
        {elapsed && (
          <span className="shrink-0 text-caption text-muted-foreground/40 tabular-nums">
            {formatDuration(Math.round(elapsed))}
          </span>
        )}
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
        )}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-1">
          {runs.map((run) => (
            <TwoLineRow key={run.subagentRunId} run={run} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  )
}
