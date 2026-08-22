/**
 * AgentAvatar — 多 Agent 会话「行内身份牌」头像。
 *
 * ：优先展示 settings.avatar_url；无自定义时回退 TabTin logo。
 * 历史色块首字逻辑保留在 getAgentIdentityAvatar，供测试与兼容引用。
 */

import React, { useState } from 'react'
import { cn } from '@utils/cn'
import {
  AGENT_AVATAR_20,
  AGENT_IDENTITY_PALETTE,
  type AgentIdentityPaletteEntry,
} from '../../../registry/chatDesignTokens'
import { resolveAgentAvatarUrl } from '@/utils/resolveAgentAvatar'
import { TABTIN_APP_ICON_URL } from '@/constants/appIcon'

/** djb2 字符串哈希；只依赖输入内容，跨端 / 跨会话稳定。 */
function djb2Hash(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash
}

export interface AgentIdentityAvatar {
  /** 头像展示的首字符（中文首字 / 拉丁首字母大写） */
  initial: string
  /** 命中的身份色板项 */
  palette: AgentIdentityPaletteEntry
}

/**
 * 由 agent 身份（id + name）生成头像要素（历史色块首字；#7764 起默认展示改走 logo）。
 * 哈希优先用 id（稳定身份），id 缺失时退化用 name；两者皆缺时固定落第 0 色。
 */
export function getAgentIdentityAvatar(
  id?: string | null,
  name?: string | null,
): AgentIdentityAvatar {
  const displaySource = name?.trim() || id?.trim() || ''
  // Array.from 按码点切分，避免把代理对（emoji 等）截成乱码
  const firstChar = Array.from(displaySource)[0] ?? '?'
  const initial = firstChar.toUpperCase()

  const hashSource = id?.trim() || name?.trim() || ''
  const palette =
    AGENT_IDENTITY_PALETTE[djb2Hash(hashSource) % AGENT_IDENTITY_PALETTE.length]

  return { initial, palette }
}

interface AgentAvatarProps {
  /** 稳定身份 id（agent_id / speaker_id） */
  agentId?: string | null
  /** 展示名；同时作为 a11y 名字 */
  name?: string | null
  /** 自定义头像 URL；空则显示 TabTin logo */
  avatarUrl?: string | null
  className?: string
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  agentId,
  name,
  avatarUrl,
  className,
}) => {
  const resolved = resolveAgentAvatarUrl(avatarUrl)
  const [src, setSrc] = useState(resolved)
  const label = name?.trim() || agentId || undefined

  // avatarUrl 变化时重置（含失败后回退 logo 的场景）
  React.useEffect(() => {
    setSrc(resolveAgentAvatarUrl(avatarUrl))
  }, [avatarUrl])

  return (
    <img
      src={src}
      alt={label || ''}
      role="img"
      aria-label={label}
      title={label}
      // 禁止浏览器原生拖图：悬浮球等父级要接 pointer/drag，避免头像被单独拖走
      draggable={false}
      className={cn(AGENT_AVATAR_20, '[-webkit-user-drag:none]', className)}
      data-testid="agent-avatar"
      onError={() => {
        if (src !== TABTIN_APP_ICON_URL) setSrc(TABTIN_APP_ICON_URL)
      }}
    />
  )
}
