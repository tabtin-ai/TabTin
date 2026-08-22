import type { ConversationMember } from '@/services/tabchatApi'
import { parseMentionMarkdown, stripMentionMarkdown } from './mentionMarkdown'

/** 跨语言识别 @所有人；发送时插入当前 locale 文案，解析时兼容中英文。 */
export const MENTION_ALL_ALIASES = ['所有人', 'Everyone', 'everyone'] as const

export function memberDisplayName(member: ConversationMember): string {
  return member.nickname || member.username || member.agent_id || member.user_id || ''
}

export function isAgentMember(member: ConversationMember): boolean {
  return member.member_type === 'agent' || (!member.user_id && !!member.agent_id)
}

export function textHasMentionAll(text: string): boolean {
  if (!text.trim()) return false
  // 与气泡高亮同款边界，避免 @EveryoneElse 一类前缀误命中。
  const escaped = MENTION_ALL_ALIASES.map((alias) =>
    alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return new RegExp(
    `@(?:${escaped.join('|')})(?=[\\s,;.!?，。！？、；：]|$)`,
  ).test(text)
}

export function textHasNamedMention(text: string, name: string): boolean {
  if (!text.trim() || !name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}(?=[\\s,;.!?，。！？、；：]|$)`).test(text)
}

/** 优先从 `[@名称](mention:…)` 取 id；剩余正文再兼容手打的唯一 @昵称。 */
export function resolveMentionsFromText(
  text: string,
  members: ConversationMember[],
): {
  mentioned_user_ids: string[]
  mentioned_agent_ids: string[]
  mention_all: boolean
} {
  const fromMarkdown = parseMentionMarkdown(text)
  const userIds = new Set<string>(fromMarkdown.mentioned_user_ids)
  const agentIds = new Set<string>(fromMarkdown.mentioned_agent_ids)
  const remainder = stripMentionMarkdown(text)
  const mention_all = fromMarkdown.mention_all || textHasMentionAll(remainder)
  if (!remainder.trim() || members.length === 0) {
    return {
      mentioned_user_ids: [...userIds],
      mentioned_agent_ids: [...agentIds],
      mention_all,
    }
  }

  const namedMembers = [...members]
    .map((member) => ({ member, name: memberDisplayName(member) }))
    .filter((item) => item.name.length > 0)
  const nameCounts = new Map<string, number>()
  for (const { name } of namedMembers) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  for (const { member, name } of namedMembers) {
    // 手输的同名 @ 无法判断具体身份；选择器插入的 markdown 已带唯一 ID。
    if (nameCounts.get(name) !== 1 || !textHasNamedMention(remainder, name)) continue
    if (isAgentMember(member) && member.agent_id) {
      agentIds.add(member.agent_id)
    } else if (member.user_id) {
      userIds.add(member.user_id)
    }
  }

  return {
    mentioned_user_ids: [...userIds],
    mentioned_agent_ids: [...agentIds],
    mention_all,
  }
}
