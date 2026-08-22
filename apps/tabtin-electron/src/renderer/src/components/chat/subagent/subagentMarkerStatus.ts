/**
 * subagentMarkerStatus — 对话内「派发标记」的状态字形（单一来源）
 *
 * 多 Agent UI 阶段 1 曾把对话内子任务收敛成完全静态标记（不转、无扫光），
 * 实时反馈只留给 chip。dogfood ：静态图标 + 常显 stop 让用户误以为卡死/
 * 已停；对齐工具 step（CompactToolUseRow）——活跃态要有活动感，
 * stop 仅 hover 显现。
 *
 * 设计契约：
 *   - **活跃态活动感在文案**：pending / running / queued 图标静态；进展用
 *     ShinyText 扫光（对齐 CompactToolUseRow——有扫光就不转圈，避免 icon
 *     完成瞬间突变）。queued 用 Clock，其余活跃用 CircleDashed。
 *   - **终态静态**：completed / failed / cancelled。
 *   - **除 failed 外不带语义色**：唯一需要一眼抓住的异常是失败。
 *
 * 被 SubagentAggregateView（对话内主路径）和 SubagentProgressCard（registry
 * 兜底）共用，避免两处各写一份字形漂移。
 */
import type React from 'react'
import { CircleDashed, Clock, Check, XCircle, Ban } from 'lucide-react'
import { TEXT_COLOR } from '../registry/chatDesignTokens'

export interface MarkerStatusGlyph {
  Icon: React.ComponentType<{ className?: string }>
  /** 字形 tone class——仅 failed 用语义红，其余中性灰。 */
  tone: string
}

export const MARKER_STATUS_GLYPH: Record<string, MarkerStatusGlyph> = {
  pending: { Icon: CircleDashed, tone: TEXT_COLOR.muted },
  queued: { Icon: Clock, tone: TEXT_COLOR.muted },
  running: { Icon: CircleDashed, tone: TEXT_COLOR.muted },
  completed: { Icon: Check, tone: TEXT_COLOR.muted },
  failed: { Icon: XCircle, tone: TEXT_COLOR.errorSoft },
  cancelled: { Icon: Ban, tone: TEXT_COLOR.muted },
}

export const MARKER_STATUS_FALLBACK: MarkerStatusGlyph = MARKER_STATUS_GLYPH.pending

/**
 * 子 Agent「活跃三态」单一来源：pending（已派发）/ queued（排队）/ running（运行中）——
 * 已派发、未达终态。pendingTasks 聚合（异步任务感知 B）与 SubagentAggregateView 行渲染
 * 共用此常量，避免两处各写一份 `{pending,queued,running}` 漂移（P2-3）。
 */
export const SUBAGENT_ACTIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'queued', 'running'])
