import type { RichContentBlock } from '@tabtin/chat-client'
import { parseResourcePointer } from '@tabtin/resource-router'
import { basename } from '../registry/toolCardUtils'

const PATH_BASED_RESOURCE_TYPES = new Set([
  'file',
  'code_file',
  'code_selection',
  'folder',
])

export type ResourceRefDisplayFields = Pick<
  RichContentBlock,
  'summary' | 'resource_name' | 'resource_id' | 'resource_type'
> & {
  filename?: string
  relative_path?: string
  title?: string
}

/**
 * resource_ref 卡片主标题：优先展示资源/文件名，summary 仅作无标识时的兜底。
 *
 * 字段语义（与 iOS RichResourceRefView 注释对齐）：
 * - filename / resource_name：资源本身的名字
 * - resource_id（path 形态）：code_file / file / folder 等 → 取 basename
 * - summary：Agent 附带的上下文描述（如「已为您生成报告」），不应压过文件名
 */
export function resolveResourceRefDisplayName(block: ResourceRefDisplayFields): string {
  const filename = block.filename?.trim()
  if (filename) return filename

  const resourceName = block.resource_name?.trim()
  if (resourceName) return resourceName

  const pathSource = block.resource_id?.trim() || block.relative_path?.trim()
  const resourceType = block.resource_type ?? ''
  if (pathSource) {
    const isPathLike =
      PATH_BASED_RESOURCE_TYPES.has(resourceType) ||
      /[/\\]/.test(pathSource)
    if (isPathLike) {
      const name = basename(pathSource)
      if (name) return name
    }
  }

  const title = block.title?.trim()
  if (title) return title

  const summary = block.summary?.trim()
  if (summary) return summary

  const id = block.resource_id?.trim()
  if (id) return id.length > 12 ? `${id.slice(0, 8)}…` : id

  return ''
}

export function resolvePresentToUserItemLabel(item: Record<string, unknown>): string | null {
  const kind = item.kind
  if (kind === 'file') {
    const filename = item.filename
    return typeof filename === 'string' && filename.trim() ? filename.trim() : null
  }

  if (kind === 'resource_ref') {
    const label = resolveResourceRefDisplayName({
      summary: typeof item.summary === 'string' ? item.summary : '',
      resource_name: typeof item.resource_name === 'string' ? item.resource_name : undefined,
      resource_id: typeof item.resource_id === 'string' ? item.resource_id : undefined,
      resource_type: typeof item.resource_type === 'string' ? item.resource_type : undefined,
      filename: typeof item.filename === 'string' ? item.filename : undefined,
      relative_path: typeof item.relative_path === 'string' ? item.relative_path : undefined,
      title: typeof item.title === 'string' ? item.title : undefined,
    })
    return label || null
  }

  const title = item.title
  if (typeof title === 'string' && title.trim()) return title.trim()

  return null
}

const FILE_LIKE_LINK_TYPES = new Set([
  'file',
  'code_file',
  'code_selection',
  'folder',
])

/** Markdown 中 tabtin 文件类资源链接：展示文件名，不用 Agent 写的链接文案。 */
export function resolveMarkdownResourceLinkLabel(href: string, linkText: string): string {
  try {
    const pointer = parseResourcePointer(href)
    if (!pointer.type || !FILE_LIKE_LINK_TYPES.has(pointer.type)) {
      return linkText
    }

    const titleFromMeta = typeof pointer.meta?.title === 'string'
      ? pointer.meta.title.trim()
      : ''
    if (titleFromMeta) return titleFromMeta

    const decodedId = decodeURIComponent(pointer.id)
    const name = basename(decodedId)
    if (name) return name
  } catch {
    // 解析失败保留原文案
  }
  return linkText
}
