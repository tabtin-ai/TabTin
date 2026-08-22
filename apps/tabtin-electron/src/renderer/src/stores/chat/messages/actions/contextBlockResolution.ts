/**
 * @引用上下文块 → 注入文本的解析（原 sendMessageHelpers 拆出）。
 *
 * 优先打后端 `/resolve-context` 拿权威渲染；失败 / 无 token 时回落到本地兜底
 * 渲染（webpage / table / file）。这是发送链路里**唯一打 API** 的上下文解析点。
 */
import { useAuthStore } from '@stores/useAuthStore'
import { getApiRuntimeConfig, type EnvLike } from '@tabtin/config'
import { electronFetch } from '@/services/electronFetch'
import { isMcpFocusBlock, renderMcpFocusContext } from '@/components/chat/context/mcpFocusContext'

const CONTEXT_REF_TYPES = new Set([
  'table', 'table_selection', 'document', 'doc_selection', 'field',
  'code_file', 'code_selection', 'web_selection', 'web_annotation',
  'webpage', 'memo', 'whiteboard',
  'phone_device', 'desktop_device', 'terminal_session',
  'slide', 'video', 'site', 'folder',
  'tracker', 'agenda_event',
  'plan',
  //  / ：云盘 TabFiles「添加到对话」——与 Django context_ref_types 对齐
  'file',
])

const { chatApiBaseUrl: _resolveCtxBaseUrl } = getApiRuntimeConfig(
  (typeof import.meta !== 'undefined' ? import.meta.env : {}) as EnvLike,
)

export async function resolveContextBlocks(
  blocks: Array<Record<string, unknown>>,
): Promise<string> {
  const refBlocks = blocks.filter(b => CONTEXT_REF_TYPES.has(b.type as string))
  const mcpBlocks = blocks.filter(isMcpFocusBlock)
  if (refBlocks.length === 0 && mcpBlocks.length === 0) return ''
  const mcpFocusText = renderMcpFocusContext(mcpBlocks)
  const fallbackText = joinContextParts(resolveLocalContextFallback(refBlocks), mcpFocusText)

  if (refBlocks.length === 0) return mcpFocusText

  const token = useAuthStore.getState().accessToken
  if (!token) return fallbackText

  try {
    const resp = await electronFetch(`${_resolveCtxBaseUrl}/resolve-context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ blocks: refBlocks }),
    })
    if (!resp.ok) return fallbackText

    const json = await resp.json()
    const resourceText = json?.data?.context_text || resolveLocalContextFallback(refBlocks)
    return joinContextParts(resourceText, mcpFocusText)
  } catch {
    return fallbackText
  }
}

function joinContextParts(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join('\n\n---\n\n')
}

function resolveLocalContextFallback(blocks: Array<Record<string, unknown>>): string {
  const parts = blocks
    .map(renderLocalContextFallback)
    .filter((part): part is string => Boolean(part))
  return parts.join('\n\n---\n\n')
}

function renderLocalContextFallback(block: Record<string, unknown>): string | null {
  return (
    renderWebpageContextFallback(block)
    ?? renderTableContextFallback(block)
    ?? renderFileContextFallback(block)
  )
}

function renderWebpageContextFallback(block: Record<string, unknown>): string | null {
  if (block.type !== 'webpage') return null
  const url = stringValue(block.url)
  if (!url) return null
  const title = stringValue(block.page_title) || stringValue(block.preview) || url
  const tabType = stringValue(block.tab_type)
  return [
    `## 网页: ${title}`,
    `url: ${url}`,
    ...(tabType ? [`来源标签: ${tabType}`] : []),
  ].join('\n')
}

function renderTableContextFallback(block: Record<string, unknown>): string | null {
  const type = stringValue(block.type)
  if (type !== 'table' && type !== 'table_selection' && type !== 'field') return null

  const tableId = stringValue(block.table_id)
  const preview = stringValue(block.preview)
  const spaceName = stringValue(block.space_name)
  const spaceId = stringValue(block.space_id)
  if (!tableId && !preview) return null

  const title =
    type === 'field'
      ? `字段引用: ${preview || tableId}`
      : type === 'table_selection'
        ? `表格选区: ${preview || tableId}`
        : `表格引用: ${preview || tableId}`

  const recordIds = Array.isArray(block.record_ids) ? block.record_ids : []
  const fieldIds = Array.isArray(block.field_ids) ? block.field_ids : []
  const lines = [
    `## ${title}`,
    ...(tableId ? [`table_id: ${tableId}`] : []),
    ...(spaceName || spaceId
      ? [
          `此表属于 Space「${spaceName || spaceId}」` +
            (spaceId ? ` (space_id=${spaceId})` : '') +
            '，可能不在当前执行 Space 的表列表中，请按 table_id 直读。',
        ]
      : []),
    ...(recordIds.length > 0 ? [`records: ${recordIds.length}`] : []),
    ...(fieldIds.length > 0 ? [`fields: ${fieldIds.length}`] : []),
    ...(tableId ? ['表格数据解析失败，请重试。'] : []),
  ]
  return lines.join('\n')
}

/** ：与 Django `_resolve_tab_resource_ref(type=file)` 对齐的本地最小兜底 */
function renderFileContextFallback(block: Record<string, unknown>): string | null {
  if (block.type !== 'file') return null
  const fileId = stringValue(block.file_id)
  const preview = stringValue(block.preview)
  if (!fileId && !preview) return null
  const title = preview || fileId
  const tabType = stringValue(block.tab_type)
  return [
    `## 文件: ${title}`,
    ...(fileId ? [`file_id: ${fileId}`] : []),
    ...(tabType ? [`来源标签: ${tabType}`] : []),
  ].join('\n')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
