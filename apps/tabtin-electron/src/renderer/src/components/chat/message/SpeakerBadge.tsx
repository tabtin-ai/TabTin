/**
 * SpeakerBadge — 在消息气泡或子任务卡片上标注"谁在说话"。
 *
 * - 主 Agent / 无 speakerId → 不渲染（默认行为）
 * - 子 Agent → 16px 生成头像 + display_name 小标签
 *   （display_color 任意 hex 圆点已退役，改用 AgentAvatar 哈希色板；
 *   见 docs/agent-runtime/agent-avatar-design.html 方案 B）
 * - speakerRegistryStore 查无记录 → 不渲染（兼容历史消息）
 *
 * 字号 text-caption（12px），颜色 /60（次要信息），遵守 AGENTS.md 规范。
 */

import React from 'react'
import { cn } from '@utils/cn'
import { useSpeakerRegistryStore } from '../../../stores/useSpeakerRegistryStore'
import { TEXT } from '../registry/chatDesignTokens'
import { AgentAvatar } from './messages/common/AgentAvatar'

interface SpeakerBadgeProps {
  sessionId?: string | null
  speakerId?: string | null
  className?: string
}

export const SpeakerBadge: React.FC<SpeakerBadgeProps> = React.memo(({ sessionId, speakerId, className }) => {
  const speaker = useSpeakerRegistryStore((s) => {
    if (!sessionId || !speakerId) return undefined
    return s.speakersBySessionId[sessionId]?.[speakerId]
  })

  // sub_agent / peer_agent 渲染 badge；main_agent / user / 未知 → 不显示
  if (!speaker || speaker.kind === 'main_agent' || speaker.kind === 'user') return null

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'bg-muted/20',
        TEXT.meta,
        'text-foreground/60',
        className,
      )}
      title={speaker.display_name}
      data-testid="speaker-badge"
    >
      <AgentAvatar agentId={speaker.speaker_id} name={speaker.display_name} />
      <span className="max-w-[12rem] truncate">{speaker.display_name}</span>
    </span>
  )
})

SpeakerBadge.displayName = 'SpeakerBadge'
