/**
 * 可交付 rich 块 → TurnArtifact（allowlist 正判，）。
 *
 * 可交付：
 *   - artifact_kind ∈ DELIVERABLE_ARTIFACT_KINDS（local_file / oss_file / platform_resource）
 *   - kind === widget 且具备 code / rendered_code / image_url
 * 其余（裸 resource_ref / table_preview / present file·image）忽略。
 */
import type { MessageBlock } from '@tabtin/chat-client'
import { stripShellPathQuotes } from '../../../services/localFileResourceResolver'
import type { TurnArtifact, TurnArtifactKind } from './turnArtifactTypes'

/** 与 host `PLATFORM_RESOURCE_ARTIFACT_KIND` 字符串对齐；前端自持常量。 */
export const LOCAL_FILE_ARTIFACT_KIND = 'local_file' as const
export const OSS_FILE_ARTIFACT_KIND = 'oss_file' as const
export const PLATFORM_RESOURCE_ARTIFACT_KIND = 'platform_resource' as const

export const DELIVERABLE_ARTIFACT_KINDS = [
  LOCAL_FILE_ARTIFACT_KIND,
  OSS_FILE_ARTIFACT_KIND,
  PLATFORM_RESOURCE_ARTIFACT_KIND,
] as const

export type DeliverableArtifactKind = (typeof DELIVERABLE_ARTIFACT_KINDS)[number]

const DELIVERABLE_ARTIFACT_KIND_SET: ReadonlySet<string> = new Set(DELIVERABLE_ARTIFACT_KINDS)

function tabtinRichToLegacyRich(block: MessageBlock): MessageBlock {
  const payload = (block.payload && typeof block.payload === 'object')
    ? block.payload as Record<string, unknown>
    : {}
  const rawGroupId = (block as Record<string, unknown>).group_id
  const groupId = typeof rawGroupId === 'string' ? rawGroupId : undefined
  return {
    ...payload,
    type: 'rich_content',
    kind: block.kind,
    summary: typeof block.summary === 'string' ? block.summary : '',
    ...(groupId ? { group_id: groupId } : {}),
  } as MessageBlock
}

export function normalizeRichBlock(block: MessageBlock): MessageBlock | null {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'rich_content') return block
  if (block.type === 'tabtin_rich_content') return tabtinRichToLegacyRich(block)
  return null
}

export function readArtifactKind(
  rawBlock: MessageBlock,
  normalized: MessageBlock,
): string {
  const outer = rawBlock as Record<string, unknown>
  const flat = normalized as Record<string, unknown>
  const payload = (outer.payload && typeof outer.payload === 'object')
    ? outer.payload as Record<string, unknown>
    : {}
  if (typeof flat.artifact_kind === 'string' && flat.artifact_kind) return flat.artifact_kind
  if (typeof payload.artifact_kind === 'string' && payload.artifact_kind) return payload.artifact_kind
  return ''
}

function widgetHasDeliverableContent(block: Record<string, unknown>): boolean {
  const hasCode = typeof block.code === 'string' && block.code.trim().length > 0
  const hasRendered = typeof block.rendered_code === 'string' && block.rendered_code.trim().length > 0
  const hasImage = typeof block.image_url === 'string' && block.image_url.length > 0
  return hasCode || hasRendered || hasImage
}

/** 是否可交付进「本轮产物」——allowlist 正判。 */
export function isDeliverableRichBlock(
  rawBlock: MessageBlock,
  normalized: MessageBlock,
): boolean {
  const artifactKind = readArtifactKind(rawBlock, normalized)
  if (DELIVERABLE_ARTIFACT_KIND_SET.has(artifactKind)) return true

  const flat = normalized as Record<string, unknown>
  const kind = typeof flat.kind === 'string' ? flat.kind : ''
  if (kind === 'widget') return widgetHasDeliverableContent(flat)
  return false
}

/** ：oss_file 用 FileRecord UUID 建打开链，不走 working_dir 相对路径。 */
function ossFileResourceUrl(block: Record<string, unknown>): string | null {
  if (block.artifact_kind !== OSS_FILE_ARTIFACT_KIND) return null
  const fileId = typeof block.file_id === 'string' ? block.file_id.trim() : ''
  if (!fileId) {
    // 兜底：url 已是 tabtin://resource/file/<uuid>?...
    if (typeof block.url === 'string' && block.url.startsWith('tabtin://resource/file/')) {
      return block.url
    }
    return null
  }
  const params = new URLSearchParams({ hint: 'tabfiles' })
  const title = (typeof block.filename === 'string' && stripShellPathQuotes(block.filename))
    || (typeof block.summary === 'string' ? block.summary : null)
  if (title) params.set('title', title)
  if (block.auto_open === true) params.set('auto_open', '1')
  if (typeof block.auto_open_token === 'string' && block.auto_open_token) {
    params.set('auto_open_token', block.auto_open_token)
  }
  return `tabtin://resource/file/${encodeURIComponent(fileId)}?${params.toString()}`
}

function resourceSpaceId(block: Record<string, unknown>): string | undefined {
  const value = typeof block.space_id === 'string'
    ? block.space_id
    : typeof block.resource_space_id === 'string'
      ? block.resource_space_id
      : ''
  return value.trim() || undefined
}

function resourceRefHref(block: Record<string, unknown>): string | null {
  if (typeof block.url === 'string' && block.url.startsWith('tabtin://')) return block.url
  const resourceType = typeof block.resource_type === 'string' ? block.resource_type : ''
  const resourceId = typeof block.resource_id === 'string' ? block.resource_id : ''
  if (!resourceType || !resourceId) return null
  const base = `tabtin://resource/${resourceType}/${encodeURIComponent(resourceId)}`
  const hint = typeof block.hint_carrier_app_id === 'string' ? block.hint_carrier_app_id : null
  return hint ? `${base}?hint=${encodeURIComponent(hint)}` : base
}

export function mapResourceTypeToKind(resourceType: string): TurnArtifactKind {
  const normalized = resourceType.toLowerCase()
  if (normalized === 'tabdoc' || normalized === 'doc' || normalized === 'document') return 'doc'
  if (normalized === 'tabdata' || normalized === 'table') return 'table'
  return 'resource'
}

function widgetChatHref(widgetId: string): string {
  return `tabtin://chat/widget/${encodeURIComponent(widgetId)}`
}

/** 可交付 local_file 的工作区相对路径；无效则 null。 */
export function localFileRelativePath(block: Record<string, unknown>): string | null {
  if (block.artifact_kind !== LOCAL_FILE_ARTIFACT_KIND) return null
  if (typeof block.relative_path !== 'string' || !block.relative_path) return null
  const relativePath = stripShellPathQuotes(block.relative_path)
  return relativePath || null
}

/**
 * rich → 即时入卡的 TurnArtifact。
 * local_file 由编排层并入 path 净算，此处不映射；table_preview / present 不入卡。
 */
export function richBlockToArtifact(
  block: MessageBlock,
  messageId: string,
  blockIndex: number,
): Omit<TurnArtifact, 'subtitleKey'> | null {
  const raw = block as Record<string, unknown>
  const kindRaw = typeof raw.kind === 'string' ? raw.kind : ''
  if (kindRaw === 'file' || kindRaw === 'image') {
    // 仅 oss_file；local_file 走 path ops
    const href = ossFileResourceUrl(raw)
    if (!href) return null
    const title = (typeof raw.filename === 'string' && stripShellPathQuotes(raw.filename))
      || (typeof raw.summary === 'string' ? raw.summary : 'File')
    const fileSize = typeof raw.file_size === 'number' && Number.isFinite(raw.file_size)
      ? raw.file_size
      : undefined
    return {
      id: `${messageId}::rich::${blockIndex}::${href}`,
      kind: 'file',
      title,
      href,
      ...(fileSize != null ? { fileSize } : {}),
    }
  }
  if (kindRaw === 'resource_ref') {
    const href = resourceRefHref(raw)
    if (!href) return null
    const resourceType = typeof raw.resource_type === 'string' ? raw.resource_type : 'resource'
    const title = (typeof raw.resource_name === 'string' && raw.resource_name)
      || (typeof raw.summary === 'string' ? raw.summary : resourceType)
    return {
      id: `${messageId}::rich::${blockIndex}::${href}`,
      kind: mapResourceTypeToKind(resourceType),
      title,
      href,
      ...(resourceSpaceId(raw) ? { resourceSpaceId: resourceSpaceId(raw) } : {}),
    }
  }
  if (kindRaw === 'widget') {
    const widgetId = typeof raw.widget_id === 'string' ? raw.widget_id : ''
    if (!widgetId || widgetId.startsWith('pending:')) return null
    if (!widgetHasDeliverableContent(raw)) return null
    const title = (typeof raw.title === 'string' && raw.title)
      || (typeof raw.summary === 'string' ? raw.summary : 'Widget')
    return {
      id: `${messageId}::rich::${blockIndex}::widget::${widgetId}`,
      kind: 'widget',
      title,
      href: widgetChatHref(widgetId),
      sourceMessageId: messageId,
      widgetId,
    }
  }
  return null
}
