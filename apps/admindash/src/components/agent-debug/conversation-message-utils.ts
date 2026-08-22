import type { ThreadMessageAttachment, ThreadOverviewMessage } from '@/types/agent-debug'

const TOOL_PROCESS_PLACEHOLDERS = new Set(['[工具调用]', '[思考中]', '（此消息没有可读文本）'])

const MD_RESOURCE_LINK_RE = /\[([^\]]+)\]\((tabtin:\/\/resource\/[^)\s"'`]+)\)/g
const BARE_RESOURCE_URI_RE = /tabtin:\/\/resource\/[^\s)\]"'`]+/g
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE_RE = /`[^`\n]*`/g
const TRAILING_URI_PUNCT_RE = /[.,;:!?。，、；：！？…]+$/u

/** 纯工具过程气泡：不进对话列表，思考/工具细节在「本轮运行诊断」查看。 */
export function isToolProcessOnlyMessage(message: ThreadOverviewMessage): boolean {
  if (message.role === 'tool') return true
  if (message.message_kind === 'hitl_interaction') return true

  const attachments = collectDisplayAttachments(message)
  const hasFiles = attachments.length > 0
  const content = (message.content || '').trim()

  // 有可展示文件 / 资源产物的 tool_artifact / 助手消息仍保留
  if (hasFiles) return false

  if (message.message_kind === 'tool_artifact') return true

  if (message.role === 'assistant') {
    if (!content || TOOL_PROCESS_PLACEHOLDERS.has(content)) return true
  }

  return false
}

export function isBrowserOpenableUrl(url?: string | null): boolean {
  if (!url) return false
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  )
}

function stripCodeSegments(text: string): string {
  return text.replace(FENCED_CODE_BLOCK_RE, ' ').replace(INLINE_CODE_RE, ' ')
}

function sanitizeResourceHref(href: string): string {
  return href.replace(TRAILING_URI_PUNCT_RE, '')
}

function parseTabtinResource(
  href: string
): { resourceType: string; resourceId: string } | null {
  if (!href.startsWith('tabtin://resource/')) return null
  const rest = href.slice('tabtin://resource/'.length).split('?', 1)[0]
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const resourceType = rest.slice(0, slash)
  let resourceId = rest.slice(slash + 1)
  try {
    resourceId = decodeURIComponent(resourceId)
  } catch {
    // keep raw
  }
  if (!resourceType || !resourceId) return null
  if (resourceId.includes('…') || resourceId.includes('\u2026')) return null
  if (resourceType !== 'file' && resourceId.includes('...')) return null
  return { resourceType, resourceId }
}

function attachmentKindForResource(resourceType: string): string {
  const normalized = resourceType.toLowerCase()
  if (normalized === 'document' || normalized === 'doc' || normalized === 'tabdoc') {
    return 'document'
  }
  if (normalized === 'table' || normalized === 'tabdata') return 'table'
  if (normalized === 'file') return 'file'
  return 'resource'
}

/** 从正文解析 tabtin://resource 链接（旧后端未投影 attachments 时的前端兜底）。 */
export function extractResourceLinkAttachments(content: string): ThreadMessageAttachment[] {
  if (!content || !content.includes('tabtin://resource/')) return []
  const text = stripCodeSegments(content)
  if (!text.includes('tabtin://resource/')) return []

  const labelByUrl = new Map<string, string>()
  for (const match of text.matchAll(MD_RESOURCE_LINK_RE)) {
    const label = (match[1] ?? '').replace(/[*`_~]/g, '').trim()
    const href = sanitizeResourceHref(match[2] ?? '')
    if (href && label && !labelByUrl.has(href)) labelByUrl.set(href, label)
  }

  const out: ThreadMessageAttachment[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(BARE_RESOURCE_URI_RE)) {
    const href = sanitizeResourceHref(match[0])
    const parsed = parseTabtinResource(href)
    if (!parsed) continue
    const key = `${parsed.resourceType}:${parsed.resourceId}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      kind: attachmentKindForResource(parsed.resourceType),
      filename: labelByUrl.get(href) || parsed.resourceId,
      source: 'agent',
      url: href,
      resource_type: parsed.resourceType,
      resource_id: parsed.resourceId,
      file_id: parsed.resourceType === 'file' ? parsed.resourceId : undefined,
    })
  }
  return out
}

function attachmentDedupeKey(attachment: ThreadMessageAttachment): string {
  if (attachment.resource_type && attachment.resource_id) {
    return `${attachment.resource_type}:${attachment.resource_id}`.toLowerCase()
  }
  if (attachment.file_id) return `file:${attachment.file_id}`.toLowerCase()
  return (attachment.url || attachment.preview_url || attachment.filename).toLowerCase()
}

/** 合并接口 attachments + 正文资源链接，去重后供时间轴展示。 */
export function collectDisplayAttachments(
  message: ThreadOverviewMessage
): ThreadMessageAttachment[] {
  const merged: ThreadMessageAttachment[] = []
  const seen = new Set<string>()
  for (const item of [...(message.attachments ?? []), ...extractResourceLinkAttachments(message.content || '')]) {
    const key = attachmentDedupeKey(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

/** AdminDash 内可跳转的资源路径；浏览器打不开的 tabtin:// 会映射到管理页。 */
export function resolveAttachmentAdminPath(attachment: ThreadMessageAttachment): string | null {
  const resourceType = (attachment.resource_type || '').toLowerCase()
  const resourceId = attachment.resource_id || attachment.file_id
  if (resourceId) {
    if (
      attachment.kind === 'document' ||
      resourceType === 'document' ||
      resourceType === 'doc' ||
      resourceType === 'tabdoc'
    ) {
      return `/docs/${encodeURIComponent(resourceId)}`
    }
    if (attachment.kind === 'table' || resourceType === 'table' || resourceType === 'tabdata') {
      return `/tables/${encodeURIComponent(resourceId)}`
    }
    if (attachment.kind === 'file' || resourceType === 'file') {
      return `/assets/${encodeURIComponent(resourceId)}`
    }
  }
  if (attachment.file_id) return `/assets/${encodeURIComponent(attachment.file_id)}`
  return null
}

export function resolveAttachmentOpenUrl(attachment: ThreadMessageAttachment): string | null {
  if (isBrowserOpenableUrl(attachment.url)) return attachment.url!
  if (isBrowserOpenableUrl(attachment.preview_url)) return attachment.preview_url!
  return null
}

export function isImageAttachment(attachment: ThreadMessageAttachment): boolean {
  if (attachment.kind === 'image') return true
  return Boolean(attachment.mime_type?.startsWith('image/'))
}

export function attachmentKindLabel(attachment: ThreadMessageAttachment): string {
  if (attachment.kind === 'document') return '文档'
  if (attachment.kind === 'table') return '多维表'
  if (attachment.kind === 'image') return '图片'
  if (attachment.kind === 'resource') return '资源'
  return '文件'
}
