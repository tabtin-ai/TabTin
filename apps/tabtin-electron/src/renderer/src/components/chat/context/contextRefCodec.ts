/**
 * ContextRef ↔ message block 双向编解码（与 blockToContextRef / contextRefsToBlocks 同构）。
 *
 * 字段命名权威见 Django context_resolver._TAB_RESOURCE_ID_FIELDS。
 */

import { type ContextRef, type ContextRefType, createContextRef } from '../types'
import { refBasename } from './contextRefDisplay'

export const BLOCK_TYPE_TO_REF: Record<string, ContextRefType> = {
  table_selection: 'table_selection',
  field: 'field',
  doc_selection: 'doc_selection',
  code_file: 'code_file',
  code_selection: 'code_selection',
  web_selection: 'web_selection',
  web_annotation: 'web_annotation',
  webpage: 'webpage',
  memo: 'memo',
  whiteboard: 'whiteboard',
  phone_device: 'phone_device',
  desktop_device: 'desktop_device',
  terminal_session: 'terminal_session',
  tracker: 'tracker',
  agenda_event: 'agenda_event',
  slide: 'slide',
  video: 'video',
  site: 'site',
  folder: 'folder',
  // ：云盘 / TabFiles「添加到对话」——资源轴 type=file，关键 ID 为 file_id
  file: 'file',
  mcp_server: 'mcp_server',
  // ：粘贴「复制对话引用」——进 blocks，不再只靠正文 XML
  conversation_reference: 'conversation_reference',
}

export interface BlockContextFields {
  label: string
  spaceId: string | undefined
  spaceName: string | undefined
  tabType: string | undefined
}

export function extractBlockContext(block: Record<string, unknown>): BlockContextFields {
  return {
    label: (block.preview as string) || '',
    spaceId: typeof block.space_id === 'string' ? block.space_id : undefined,
    spaceName: typeof block.space_name === 'string' ? block.space_name : undefined,
    tabType: typeof block.tab_type === 'string' ? block.tab_type : undefined,
  }
}

function withContext(
  refType: ContextRefType,
  resourceId: string,
  label: string,
  ctx: BlockContextFields,
  meta?: Record<string, unknown>,
): ContextRef {
  return createContextRef(refType, resourceId, label, {
    spaceId: ctx.spaceId,
    spaceName: ctx.spaceName,
    tabType: ctx.tabType,
    meta: Object.keys(meta ?? {}).length > 0 ? meta : undefined,
  })
}

function metaFromBlock(block: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {}
  for (const key of keys) {
    if (block[key] !== undefined) meta[key] = block[key]
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

type BlockDecoder = (block: Record<string, unknown>, ctx: BlockContextFields) => ContextRef | null

const DECODE_BY_REF_TYPE: Partial<Record<ContextRefType, BlockDecoder>> = {
  table: (block, ctx) => {
    if (!block.table_id) return null
    const meta = metaFromBlock(block, ['record_ids', 'field_ids'])
    return withContext('table', block.table_id as string, ctx.label, ctx, meta)
  },
  table_selection: (block, ctx) => {
    if (!block.table_id) return null
    const meta = metaFromBlock(block, ['record_ids', 'field_ids'])
    return withContext('table_selection', block.table_id as string, ctx.label, ctx, meta)
  },
  field: (block, ctx) => {
    if (typeof block.table_id !== 'string') return null
    const fieldId = Array.isArray(block.field_ids)
      ? block.field_ids.find((value): value is string => typeof value === 'string')
      : typeof block.field_id === 'string'
        ? block.field_id
        : undefined
    if (!fieldId) return null
    return withContext('field', fieldId, ctx.label, ctx, { tableId: block.table_id })
  },
  document: (block, ctx) => {
    if (!block.doc_id) return null
    const meta = metaFromBlock(block, ['block_ids', 'full_text'])
    return withContext('document', block.doc_id as string, ctx.label, ctx, meta)
  },
  doc_selection: (block, ctx) => {
    if (!block.doc_id) return null
    const meta = metaFromBlock(block, ['block_ids', 'full_text'])
    return withContext('doc_selection', block.doc_id as string, ctx.label, ctx, meta)
  },
  code_file: (block, ctx) => decodeCodeRef(block, ctx, 'code_file'),
  code_selection: (block, ctx) => decodeCodeRef(block, ctx, 'code_selection'),
  web_selection: (block, ctx) => decodeUrlMetaRef(block, ctx, 'web_selection', 'url', ['page_title']),
  web_annotation: (block, ctx) => decodeWebAnnotationRef(block, ctx),
  webpage: (block, ctx) => decodeUrlMetaRef(block, ctx, 'webpage', 'url', ['page_title', 'favicon']),
  memo: (block, ctx) => decodeIdRef(block, ctx, 'memo', 'memo_id'),
  whiteboard: (block, ctx) => decodeIdRef(block, ctx, 'whiteboard', 'canvas_id'),
  phone_device: (block, ctx) => decodeDeviceRef(block, ctx, 'phone_device'),
  desktop_device: (block, ctx) => decodeDeviceRef(block, ctx, 'desktop_device'),
  terminal_session: (block, ctx) => decodeTerminalSessionRef(block, ctx),
  tracker: (block, ctx) => decodeIdRef(block, ctx, 'tracker', 'tracker_id'),
  agenda_event: (block, ctx) => decodeIdRef(block, ctx, 'agenda_event', 'event_id'),
  slide: (block, ctx) => decodeIdRef(block, ctx, 'slide', 'slide_id'),
  video: (block, ctx) => decodeIdRef(block, ctx, 'video', 'video_id'),
  site: (block, ctx) => decodeIdRef(block, ctx, 'site', 'site_id'),
  folder: (block, ctx) => decodeFolderRef(block, ctx),
  file: (block, ctx) => decodeIdRef(block, ctx, 'file', 'file_id'),
  mcp_server: (block, ctx) => {
    const connectionId = typeof block.connection_id === 'string' ? block.connection_id : ''
    if (!connectionId) return null
    const serverName = typeof block.server_name === 'string' ? block.server_name : ctx.label
    const sourceLabel = typeof block.source_label === 'string' ? block.source_label : undefined
    return withContext('mcp_server', connectionId, serverName || connectionId, ctx, {
      serverName: serverName || connectionId,
      ...(sourceLabel ? { sourceLabel } : {}),
    })
  },
  conversation_reference: (block, ctx) => {
    const sessionId = typeof block.session_id === 'string' ? block.session_id : ''
    if (!sessionId) return null
    const meta: Record<string, unknown> = {}
    if (typeof block.raw_block === 'string') meta.rawBlock = block.raw_block
    if (typeof block.preview === 'string') meta.preview = block.preview
    if (typeof block.message_count === 'number') meta.messageCount = block.message_count
    if (typeof block.last_activity_label === 'string') meta.lastActivityLabel = block.last_activity_label
    if (typeof block.organization_id === 'string') meta.organizationId = block.organization_id
    return withContext(
      'conversation_reference',
      sessionId,
      ctx.label || sessionId,
      ctx,
      Object.keys(meta).length > 0 ? meta : undefined,
    )
  },
}

function decodeIdRef(
  block: Record<string, unknown>,
  ctx: BlockContextFields,
  refType: ContextRefType,
  idField: string,
): ContextRef | null {
  const id = typeof block[idField] === 'string' ? block[idField] : ''
  if (!id) return null
  return withContext(refType, id, ctx.label, ctx)
}

function decodeCodeRef(
  block: Record<string, unknown>,
  ctx: BlockContextFields,
  refType: 'code_file' | 'code_selection',
): ContextRef | null {
  const filePath = typeof block.file_path === 'string' ? block.file_path : ''
  if (!filePath) return null
  const meta: Record<string, unknown> = { filePath }
  if (typeof block.root_path === 'string') meta.rootPath = block.root_path
  if (typeof block.language === 'string') meta.language = block.language
  if (typeof block.preview === 'string') meta.preview = block.preview
  if (refType === 'code_selection') {
    if (typeof block.start_line === 'number') meta.startLine = block.start_line
    if (typeof block.end_line === 'number') meta.endLine = block.end_line
  }
  return withContext(refType, filePath, refBasename(filePath), ctx, meta)
}

function decodeUrlMetaRef(
  block: Record<string, unknown>,
  ctx: BlockContextFields,
  refType: ContextRefType,
  urlField: string,
  metaFields: string[],
): ContextRef | null {
  const url = typeof block[urlField] === 'string' ? block[urlField] : ''
  if (!url) return null
  const meta: Record<string, unknown> = { url }
  if (typeof block.page_title === 'string') meta.pageTitle = block.page_title
  if (refType === 'webpage' && typeof block.favicon === 'string') meta.favicon = block.favicon
  for (const field of metaFields) {
    if (field === 'page_title' && typeof block.page_title === 'string') meta.pageTitle = block.page_title
    if (field === 'favicon' && typeof block.favicon === 'string') meta.favicon = block.favicon
  }
  return withContext(refType, url, ctx.label, ctx, meta)
}

function decodeWebAnnotationRef(block: Record<string, unknown>, ctx: BlockContextFields): ContextRef | null {
  const url = typeof block.url === 'string' ? block.url : ''
  if (!url) return null
  const meta: Record<string, unknown> = { url }
  if (typeof block.page_title === 'string') meta.pageTitle = block.page_title
  if (typeof block.favicon === 'string') meta.favicon = block.favicon
  if (typeof block.annotation_id === 'string') meta.annotationId = block.annotation_id
  if (typeof block.screenshot_attachment_id === 'string') meta.screenshotAttachmentId = block.screenshot_attachment_id
  if (typeof block.screenshot_filename === 'string') meta.screenshotFilename = block.screenshot_filename
  if (block.selection && typeof block.selection === 'object') meta.selection = block.selection
  if (block.rect && typeof block.rect === 'object') meta.rect = block.rect
  if (block.dom && typeof block.dom === 'object') meta.dom = block.dom
  if (block.content_snapshot && typeof block.content_snapshot === 'object') meta.contentSnapshot = block.content_snapshot
  return withContext('web_annotation', url, ctx.label, ctx, meta)
}

function decodeDeviceRef(
  block: Record<string, unknown>,
  ctx: BlockContextFields,
  refType: 'phone_device' | 'desktop_device',
): ContextRef | null {
  const deviceId = typeof block.device_id === 'string' ? block.device_id : ''
  if (!deviceId) return null
  const meta: Record<string, unknown> = {}
  if (typeof block.device_name === 'string') meta.deviceName = block.device_name
  return withContext(refType, deviceId, ctx.label, ctx, Object.keys(meta).length > 0 ? meta : undefined)
}

function decodeTerminalSessionRef(block: Record<string, unknown>, ctx: BlockContextFields): ContextRef | null {
  const sessionId = typeof block.session_id === 'string' ? block.session_id : ''
  if (!sessionId) return null
  const meta: Record<string, unknown> = {}
  if (typeof block.cwd === 'string') meta.cwd = block.cwd
  return withContext('terminal_session', sessionId, ctx.label, ctx, Object.keys(meta).length > 0 ? meta : undefined)
}

function decodeFolderRef(block: Record<string, unknown>, ctx: BlockContextFields): ContextRef | null {
  const folderPath = typeof block.folder_path === 'string' ? block.folder_path : ''
  if (!folderPath) return null
  const meta: Record<string, unknown> = {}
  if (typeof block.folder_kind === 'string') meta.kind = block.folder_kind
  return withContext('folder', folderPath, ctx.label, ctx, Object.keys(meta).length > 0 ? meta : undefined)
}

export function decodeBlockToContextRef(block: Record<string, unknown>): ContextRef | null {
  const blockType = block.type as string | undefined
  if (!blockType) return null
  const refType = BLOCK_TYPE_TO_REF[blockType]
  if (!refType) return null
  const decoder = DECODE_BY_REF_TYPE[refType]
  if (!decoder) return null
  return decoder(block, extractBlockContext(block))
}

function blockTypeForRef(ref: ContextRef): string {
  if (ref.type === 'table') return 'table_selection'
  return ref.type
}

function appendSpaceFields(base: Record<string, unknown>, ref: ContextRef): void {
  if (ref.spaceId) base.space_id = ref.spaceId
  if (ref.spaceName) base.space_name = ref.spaceName
}

type RefEncoder = (ref: ContextRef, base: Record<string, unknown>) => void

const ENCODE_BY_REF_TYPE: Partial<Record<ContextRefType, RefEncoder>> = {
  table: encodeTableRef,
  table_selection: encodeTableRef,
  field: (ref, base) => {
    base.table_id = ref.meta?.tableId as string
    base.field_ids = [ref.resourceId]
    if (ref.meta?.record_ids) base.record_ids = ref.meta.record_ids
    if (ref.meta?.field_ids) base.field_ids = ref.meta.field_ids
    if (ref.meta?.view_id) base.view_id = ref.meta.view_id
  },
  document: encodeDocRef,
  doc_selection: encodeDocRef,
  code_file: encodeCodeRef,
  code_selection: encodeCodeRef,
  web_selection: (ref, base) => {
    if (ref.meta?.url) base.url = ref.meta.url
    if (ref.meta?.pageTitle) base.page_title = ref.meta.pageTitle
  },
  web_annotation: encodeWebAnnotationRef,
  webpage: (ref, base) => {
    base.url = ref.resourceId
    if (ref.meta?.pageTitle) base.page_title = ref.meta.pageTitle
    if (ref.meta?.favicon) base.favicon = ref.meta.favicon
  },
  memo: (ref, base) => { base.memo_id = ref.resourceId },
  whiteboard: (ref, base) => { base.canvas_id = ref.resourceId },
  phone_device: encodeDeviceRef,
  desktop_device: encodeDeviceRef,
  terminal_session: (ref, base) => {
    base.session_id = ref.resourceId
    if (ref.meta?.cwd) base.cwd = ref.meta.cwd
  },
  tracker: (ref, base) => { base.tracker_id = ref.resourceId },
  agenda_event: (ref, base) => { base.event_id = ref.resourceId },
  slide: (ref, base) => { base.slide_id = ref.resourceId },
  video: (ref, base) => { base.video_id = ref.resourceId },
  site: (ref, base) => { base.site_id = ref.resourceId },
  folder: (ref, base) => {
    base.folder_path = ref.resourceId
    if (ref.meta?.kind) base.folder_kind = ref.meta.kind
  },
  // ：与 Django _TAB_RESOURCE_ID_FIELDS['file'] 对齐，必须写出 file_id
  file: (ref, base) => { base.file_id = ref.resourceId },
  mcp_server: (ref, base) => {
    base.connection_id = ref.resourceId
    base.server_name = (ref.meta?.serverName as string | undefined) || ref.label
    if (ref.meta?.sourceLabel) base.source_label = ref.meta.sourceLabel
  },
  conversation_reference: (ref, base) => {
    base.session_id = ref.resourceId
    if (typeof ref.meta?.rawBlock === 'string') base.raw_block = ref.meta.rawBlock
    if (typeof ref.meta?.preview === 'string') base.preview = ref.meta.preview
    if (typeof ref.meta?.messageCount === 'number') base.message_count = ref.meta.messageCount
    if (typeof ref.meta?.lastActivityLabel === 'string') {
      base.last_activity_label = ref.meta.lastActivityLabel
    }
    if (typeof ref.meta?.organizationId === 'string') {
      base.organization_id = ref.meta.organizationId
    }
  },
}

function encodeTableRef(ref: ContextRef, base: Record<string, unknown>): void {
  base.table_id = ref.type === 'field' ? (ref.meta?.tableId as string) : ref.resourceId
  if (ref.meta?.record_ids) base.record_ids = ref.meta.record_ids
  if (ref.meta?.field_ids) base.field_ids = ref.meta.field_ids
  if (ref.meta?.view_id) base.view_id = ref.meta.view_id
}

function encodeDocRef(ref: ContextRef, base: Record<string, unknown>): void {
  base.doc_id = ref.resourceId
  if (ref.meta?.block_ids) base.block_ids = ref.meta.block_ids
  if (ref.meta?.full_text) base.full_text = ref.meta.full_text
}

function encodeCodeRef(ref: ContextRef, base: Record<string, unknown>): void {
  base.file_path = ref.meta?.filePath || ref.resourceId
  if (ref.meta?.rootPath) base.root_path = ref.meta.rootPath
  if (ref.meta?.language) base.language = ref.meta.language
  if (ref.type === 'code_selection') {
    if (ref.meta?.startLine != null) base.start_line = ref.meta.startLine
    if (ref.meta?.endLine != null) base.end_line = ref.meta.endLine
  }
}

function encodeWebAnnotationRef(ref: ContextRef, base: Record<string, unknown>): void {
  base.url = ref.meta?.url || ref.resourceId
  if (ref.meta?.pageTitle) base.page_title = ref.meta.pageTitle
  if (ref.meta?.favicon) base.favicon = ref.meta.favicon
  if (ref.meta?.annotationId) base.annotation_id = ref.meta.annotationId
  if (ref.meta?.selection) base.selection = ref.meta.selection
  if (ref.meta?.rect) base.rect = ref.meta.rect
  if (ref.meta?.dom) base.dom = ref.meta.dom
  // ：注释落点内容快照（框选时已在原 tab 采集、穿透 shadow DOM）
  if (ref.meta?.contentSnapshot) base.content_snapshot = ref.meta.contentSnapshot
  if (ref.meta?.screenshotAttachmentId) base.screenshot_attachment_id = ref.meta.screenshotAttachmentId
  if (ref.meta?.screenshotFilename) base.screenshot_filename = ref.meta.screenshotFilename
}

function encodeDeviceRef(ref: ContextRef, base: Record<string, unknown>): void {
  base.device_id = ref.resourceId
  if (ref.meta?.deviceName) base.device_name = ref.meta.deviceName
}

export function encodeContextRefToBlock(ref: ContextRef): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: blockTypeForRef(ref),
    preview: (ref.meta?.preview as string) || ref.label,
  }
  if (ref.tabType) base.tab_type = ref.tabType
  const encoder = ENCODE_BY_REF_TYPE[ref.type]
  if (encoder) encoder(ref, base)
  appendSpaceFields(base, ref)
  return base
}

export function encodeContextRefsToBlocks(refs: ContextRef[]): Array<Record<string, unknown>> {
  return refs.map(encodeContextRefToBlock)
}
