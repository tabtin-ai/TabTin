/**
 * AgentTemplateIcon — 模板 icon slug → 图标渲染（ 分身版）。
 *
 * manifest 的 `icon` 字段是标识符（"bot" / "code"，见 packages/agents/README），
 * 不是 emoji。这里维护 slug → lucide 图标映射，未知 slug 走 Bot 兜底；
 * 若值本身不是 ASCII 标识符（emoji / 汉字等异形数据）则按字面直出。
 */

import React from 'react'
import {
  Bot,
  Code2,
  FileText,
  Globe,
  Mail,
  Presentation,
  Table2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@utils/cn'

// slug 口径对齐阵容提案 v2 七个号的赛道（daily/code/docs/data/surf/slides/errands），
// 兼容旧占位模板的 "bot" 与后端可能采用的近义 slug。
const ICON_BY_SLUG: Record<string, LucideIcon> = {
  bot: Bot,
  daily: Bot,
  code: Code2,
  docs: FileText,
  doc: FileText,
  'file-text': FileText,
  data: Table2,
  table: Table2,
  surf: Globe,
  web: Globe,
  globe: Globe,
  slides: Presentation,
  presentation: Presentation,
  errands: Mail,
  mail: Mail,
}

const ASCII_SLUG_RE = /^[a-z0-9-]+$/i

export const AgentTemplateIcon: React.FC<{ icon?: string | null; className?: string }> = ({
  icon,
  className,
}) => {
  const slug = icon?.trim() ?? ''
  if (slug && !ASCII_SLUG_RE.test(slug)) {
    // 异形数据（emoji / 汉字）按字面直出
    return <span aria-hidden className={cn('leading-none', className)}>{slug}</span>
  }
  const Icon = ICON_BY_SLUG[slug.toLowerCase()] ?? Bot
  return <Icon aria-hidden className={className} />
}
AgentTemplateIcon.displayName = 'AgentTemplateIcon'
