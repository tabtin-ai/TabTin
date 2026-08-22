/**
 * imResourceCard — 私信资源卡（TC-5）的协议映射工具（SSOT）。
 *
 * 两个发送入口（输入框「资源」按钮 / 资源右键「发送到对话」）共用：
 * 把 SpaceContextItem（item_type=tabdata|tabdoc）映射成卡片协议
 * （type=table|document），生成回退文本 content 与 metadata.card。
 *
 * 双轨 type：ContextItem 用 tabdata/tabdoc；卡片协议/ResourcePointer 用
 * table/document；hint_carrier_app_id 用 tabdata/tabdoc（见
 * docs/tabchat/tc-5-resource-card-design.md §2）。
 */

import type { SpaceContextItem } from '@/services/spaceApi'
import type { IMMessageMetadata } from '@/services/tabchatApi'

export interface ImResourceCardRef {
  type: 'table' | 'document'
  resourceId: string
  name: string
  spaceId?: string
  hintCarrierAppId?: 'tabdata' | 'tabdoc'
  description?: string
}

const ITEM_TYPE_TO_CARD: Record<string, { type: 'table' | 'document'; hint: 'tabdata' | 'tabdoc' }> = {
  tabdata: { type: 'table', hint: 'tabdata' },
  tabdoc: { type: 'document', hint: 'tabdoc' },
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function resolveCardResourceId(item: SpaceContextItem, type: 'table' | 'document'): string {
  const metadata = item.metadata ?? {}
  if (type === 'table') {
    return firstString(
      metadata.current_table_id,
      metadata.table_id,
      metadata.tableId,
      metadata.resource_id,
      item.resource_id,
    )
  }

  return firstString(
    metadata.current_doc_id,
    metadata.document_id,
    metadata.doc_id,
    metadata.documentId,
    metadata.docId,
    metadata.resource_id,
    item.resource_id,
  )
}

/** SpaceContextItem → 资源卡 ref；非 tabdata/tabdoc 或缺 resource_id 返回 null。 */
export function contextItemToCardRef(item: SpaceContextItem): ImResourceCardRef | null {
  const mapped = ITEM_TYPE_TO_CARD[item.item_type]
  if (!mapped) return null
  const resourceId = resolveCardResourceId(item, mapped.type)
  if (!resourceId) return null
  return {
    type: mapped.type,
    resourceId,
    name: item.title || '',
    spaceId: item.space_id ?? undefined,
    hintCarrierAppId: mapped.hint,
    description: item.preview || undefined,
  }
}

/** 回退文本（搜索 / 旧端 / preview 兜底，与后端 _build_preview 对齐）。 */
export function formatResourceCardContent(ref: ImResourceCardRef): string {
  const label = ref.type === 'table' ? '表格' : '文档'
  return `[${label}] ${ref.name}`.trim()
}

/** 资源卡 metadata（后端会以 DB 真实 name/space_id 回填覆盖）。 */
export function buildResourceCardMetadata(ref: ImResourceCardRef): IMMessageMetadata {
  return {
    card: {
      type: ref.type,
      resource_id: ref.resourceId,
      space_id: ref.spaceId,
      name: ref.name,
      hint_carrier_app_id: ref.hintCarrierAppId,
      description: ref.description,
    },
  }
}
