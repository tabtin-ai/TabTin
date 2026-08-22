/**
 * Agent Mode 视觉主题 — 单一真相源
 *
 * 统一定义每种模式的图标和颜色语义标记。
 * AgentModeSelector / ModeBanner / AgentModeBadge 等消费方
 * 从此处派生各自所需的样式变体，避免三处重复定义。
 */

import { MessageCircleQuestion, SquareTerminal, Map, GraduationCap, Users, Zap, type LucideIcon } from 'lucide-react'
import type { AgentModeName } from '@/stores/chat/shared/types'

export interface AgentModeTheme {
  icon: LucideIcon
  /** 色彩语义标记（对应 Tailwind token，如 'info'、'warning'） */
  color: string
  colorClass: string
}

export const AGENT_MODE_THEME: Record<AgentModeName, AgentModeTheme> = {
  ask:   { icon: MessageCircleQuestion, color: 'info',         colorClass: 'text-info' },
  agent: { icon: SquareTerminal,        color: 'success',      colorClass: 'text-success' },
  plan:  { icon: Map,                   color: 'warning',      colorClass: 'text-warning' },
  study: { icon: GraduationCap,         color: 'type-webhook', colorClass: 'text-type-webhook' },
  // PR4-yolo (PRD v3 §5.4.1)：yolo 档用警告色 + Zap 图标，与 AgentSecurityPanel
  // 「超级权限」toggle 图标语义对齐——告诉用户这是「最宽松、风险最高」的档位。
  yolo:  { icon: Zap,                   color: 'warning',      colorClass: 'text-warning' },
  group: { icon: Users,                 color: 'accent',       colorClass: 'text-accent' },
}
