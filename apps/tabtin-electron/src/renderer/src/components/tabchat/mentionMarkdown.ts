/** 群聊 @ 的正文形态：`[@名称](mention:user/<id>)`，渲染看名称，匹配看 id。 */

export const MENTION_MARKDOWN_SCHEME = 'mention'

export const MENTION_MARKDOWN_KIND = {
  user: 'user',
  agent: 'agent',
  all: 'all',
} as const

export type MentionMarkdownKind =
  (typeof MENTION_MARKDOWN_KIND)[keyof typeof MENTION_MARKDOWN_KIND]

export type MentionMarkdownTarget = {
  member_type: 'user' | 'agent' | 'all'
  display_name: string
  user_id: string | null
  agent_id: string | null
}

const MENTION_MARKDOWN_SPEC_PATTERN = `${MENTION_MARKDOWN_KIND.all}|${MENTION_MARKDOWN_KIND.user}\\/[^)\\s]+|${MENTION_MARKDOWN_KIND.agent}\\/[^)\\s]+`
const MENTION_MARKDOWN_PATTERN = `\\[@[^\\]]*\\]\\(${MENTION_MARKDOWN_SCHEME}:(${MENTION_MARKDOWN_SPEC_PATTERN})\\)`

function mentionMarkdownRegex(): RegExp {
  return new RegExp(MENTION_MARKDOWN_PATTERN, 'g')
}

function escapeMentionLabel(name: string): string {
  return name.replace(/[[\]]/g, '')
}

export function formatMentionHref(target: MentionMarkdownTarget): string {
  if (target.member_type === 'all') {
    return `${MENTION_MARKDOWN_SCHEME}:${MENTION_MARKDOWN_KIND.all}`
  }
  if (target.member_type === 'agent' && target.agent_id) {
    return `${MENTION_MARKDOWN_SCHEME}:${MENTION_MARKDOWN_KIND.agent}/${target.agent_id}`
  }
  return `${MENTION_MARKDOWN_SCHEME}:${MENTION_MARKDOWN_KIND.user}/${target.user_id ?? ''}`
}

export function formatMentionMarkdown(target: MentionMarkdownTarget): string {
  return `[@${escapeMentionLabel(target.display_name)}](${formatMentionHref(target)})`
}

export function isMentionHref(href: string | null | undefined): boolean {
  if (!href) return false
  if (href === `${MENTION_MARKDOWN_SCHEME}:${MENTION_MARKDOWN_KIND.all}`) return true
  return (
    href.startsWith(`${MENTION_MARKDOWN_SCHEME}:${MENTION_MARKDOWN_KIND.user}/`)
    || href.startsWith(`${MENTION_MARKDOWN_SCHEME}:${MENTION_MARKDOWN_KIND.agent}/`)
  )
}

export function parseMentionMarkdown(text: string): {
  mentioned_user_ids: string[]
  mentioned_agent_ids: string[]
  mention_all: boolean
} {
  const userIds = new Set<string>()
  const agentIds = new Set<string>()
  let mention_all = false
  if (!text) {
    return { mentioned_user_ids: [], mentioned_agent_ids: [], mention_all }
  }
  for (const match of text.matchAll(mentionMarkdownRegex())) {
    const spec = match[1] ?? ''
    if (spec === MENTION_MARKDOWN_KIND.all) {
      mention_all = true
      continue
    }
    const userPrefix = `${MENTION_MARKDOWN_KIND.user}/`
    const agentPrefix = `${MENTION_MARKDOWN_KIND.agent}/`
    if (spec.startsWith(userPrefix)) {
      const id = spec.slice(userPrefix.length)
      if (id) userIds.add(id)
    } else if (spec.startsWith(agentPrefix)) {
      const id = spec.slice(agentPrefix.length)
      if (id) agentIds.add(id)
    }
  }
  return {
    mentioned_user_ids: [...userIds],
    mentioned_agent_ids: [...agentIds],
    mention_all,
  }
}

export function stripMentionMarkdown(text: string): string {
  return text.replace(mentionMarkdownRegex(), ' ')
}

/** 预览/侧栏用：把 `[@名称](mention:…)` 收成 `@名称`，不露出 href。 */
export function formatMentionDisplayText(text: string): string {
  if (!text) return ''
  return splitMentionMarkdownSegments(text)
    .map((segment) => (segment.type === 'mention' ? segment.label : segment.value))
    .join('')
}

export function textHasMentionTarget(text: string, target: MentionMarkdownTarget): boolean {
  if (target.member_type === 'all') {
    return parseMentionMarkdown(text).mention_all
  }
  const href = formatMentionHref(target)
  return href.endsWith('/') ? false : text.includes(`](${href})`)
}

export const MENTION_HREF_ATTR = 'data-mention-href'
export const MENTION_COMPOSER_MARKDOWN_ATTR = 'data-mention-markdown'
export const MENTION_COMPOSER_CLIPBOARD_MIME = 'text/tabtin-mention-markdown'
export const TEXT_PLAIN_CLIPBOARD_MIME = 'text/plain'

export type MentionMarkdownSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; markdown: string; label: string; href: string }

export function splitMentionMarkdownSegments(text: string): MentionMarkdownSegment[] {
  const segments: MentionMarkdownSegment[] = []
  if (!text) {
    return [{ type: 'text', value: '' }]
  }
  let lastIndex = 0
  for (const match of text.matchAll(mentionMarkdownRegex())) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, index) })
    }
    const markdown = match[0]
    const spec = match[1] ?? ''
    const labelMatch = /^\[(@[^\]]*)\]/.exec(markdown)
    segments.push({
      type: 'mention',
      markdown,
      label: labelMatch?.[1] ?? '@',
      href: `${MENTION_MARKDOWN_SCHEME}:${spec}`,
    })
    lastIndex = index + markdown.length
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return segments.length > 0 ? segments : [{ type: 'text', value: '' }]
}

export function findComposerMentionTrigger(
  text: string,
  cursorPos: number,
): { query: string; startIndex: number } | null {
  const textBefore = text.slice(0, cursorPos)
  const atMatch = /@(\S{0,20})$/.exec(textBefore)
  if (!atMatch) return null
  const startIndex = cursorPos - atMatch[0].length
  for (const match of text.matchAll(mentionMarkdownRegex())) {
    const from = match.index ?? 0
    const to = from + match[0].length
    if (startIndex >= from && startIndex < to) return null
  }
  return { query: atMatch[1] ?? '', startIndex }
}
