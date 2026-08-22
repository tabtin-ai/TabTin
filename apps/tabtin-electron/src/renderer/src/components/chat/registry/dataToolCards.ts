/**
 * SQL / 记录操作 / 字段操作 / TabDoc / 文档操作 / 数据提取
 */

import type { ToolCardDescriptor, ToolOutputData } from '@tabtin/chat-client'
import { truncate, getNestedArgs, unwrapData } from './toolCardUtils'
import { extractUpdateByFilterOutput } from '../cards/UpdateByFilterPreviewCard'

/* ─── 输出提取器 ─── */

export function extractSql(output: unknown): ToolOutputData | null {
  if (!output || typeof output !== 'object') return null
  const obj = output as Record<string, unknown>
  if (obj.columns && Array.isArray(obj.rows)) {
    return {
      kind: 'sql_result',
      columns: obj.columns as string[],
      rows: obj.rows as unknown[][],
      total_rows: typeof obj.total_rows === 'number' ? obj.total_rows : (obj.rows as unknown[][]).length,
    }
  }
  const arr = (obj.data ?? obj.result) as unknown[] | undefined
  if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
    const columns = Object.keys(arr[0] as object)
    return {
      kind: 'sql_result',
      columns,
      rows: arr.map((r: unknown) => columns.map(c => (r as Record<string, unknown>)[c])),
      total_rows: arr.length,
    }
  }
  return null
}

const TOOL_OPERATION_MAP: Record<string, 'create' | 'update' | 'delete'> = {
  create_record: 'create',
  batch_create_records: 'create',
  update_record: 'update',
  batch_update_records: 'update',
  delete_record: 'delete',
  batch_delete_records: 'delete',
}

export function extractRecordOp(toolName: string) {
  return (output: unknown): ToolOutputData | null => {
    const operation = TOOL_OPERATION_MAP[toolName] ?? 'delete'

    if (typeof output === 'string') {
      const idMatch = output.match(/ID:\s*(\S+)/)
      return { kind: 'record_op', operation, record_id: idMatch?.[1], message: output }
    }
    if (output && typeof output === 'object') {
      const d = unwrapData(output)
      return {
        kind: 'record_op',
        operation,
        record_id: String(d.id ?? d.record_id ?? ''),
        table_id: d.table_id as string | undefined,
        fields_count: d.data && typeof d.data === 'object' ? Object.keys(d.data as object).length : undefined,
      }
    }
    return null
  }
}

/* ─── 描述符 ─── */

export const DATA_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  /* ── SQL ─── */
  sql_query: {
    id: 'sql_result', category: 'tool', labelKey: 'chat.card.sql_result', icon: 'Database',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'SqlResultCard', extractOutput: extractSql,
  },
  execute_sql: {
    id: 'sql_result', category: 'tool', labelKey: 'chat.card.sql_result', icon: 'Database',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'SqlResultCard', extractOutput: extractSql,
  },
  table_query: {
    id: 'sql_result', category: 'tool', labelKey: 'chat.card.sql_result', icon: 'Database',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'SqlResultCard', extractOutput: extractSql,
  },
  sql_execute: {
    id: 'sql_result', category: 'tool', labelKey: 'chat.card.sql_result', icon: 'Database',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'SqlResultCard', extractOutput: extractSql,
  },
  sql_catalog: {
    id: 'sql_catalog', category: 'tool', labelKey: 'chat.card.sql_result', icon: 'Database',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },

  /* ── 文档操作 (legacy 非命名空间) ─── */
  search_documents: {
    id: 'web_search', category: 'tool', labelKey: 'chat.card.web_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  read_document: {
    id: 'file_read', category: 'tool', labelKey: 'chat.card.read_file', icon: 'FileText',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  write_document: {
    id: 'file_write', category: 'tool', labelKey: 'chat.card.write_file', icon: 'FileText',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard',
  },

  /* ── 记录操作 ─── */
  create_record: {
    id: 'record_op', category: 'tool', labelKey: 'chat.card.record_op', icon: 'PlusCircle',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'RecordOpCard',
    extractOutput: extractRecordOp('create_record'),
  },
  update_record: {
    id: 'record_op', category: 'tool', labelKey: 'chat.card.record_op', icon: 'RefreshCw',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'RecordOpCard',
    extractOutput: extractRecordOp('update_record'),
  },
  delete_record: {
    id: 'record_op', category: 'tool', labelKey: 'chat.card.record_op', icon: 'Trash2',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'RecordOpCard',
    extractOutput: extractRecordOp('delete_record'),
  },
  batch_create_records: {
    id: 'record_op', category: 'tool', labelKey: 'chat.card.record_op', icon: 'PlusCircle',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'RecordOpCard',
    extractOutput: extractRecordOp('batch_create_records'),
  },
  batch_update_records: {
    id: 'record_op', category: 'tool', labelKey: 'chat.card.record_op', icon: 'RefreshCw',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'RecordOpCard',
    extractOutput: extractRecordOp('batch_update_records'),
  },
  batch_delete_records: {
    id: 'record_op', category: 'tool', labelKey: 'chat.card.record_op', icon: 'Trash2',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'RecordOpCard',
    extractOutput: extractRecordOp('batch_delete_records'),
  },

  /* ── A3 update-by-filter ─── */
  update_by_filter: {
    id: 'update_by_filter_preview', category: 'tool', labelKey: 'chat.card.update_by_filter', icon: 'Filter',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'UpdateByFilterPreviewCard',
    extractOutput: extractUpdateByFilterOutput,
  },
  update_records_by_filter: {
    id: 'update_by_filter_preview', category: 'tool', labelKey: 'chat.card.update_by_filter', icon: 'Filter',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'UpdateByFilterPreviewCard',
    extractOutput: extractUpdateByFilterOutput,
  },

  /* ── 字段操作 ─── */
  create_field: { id: 'field_op', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Database', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  update_field: { id: 'field_op', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Database', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  delete_field: { id: 'field_op', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Database', riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard' },
  batch_transform_field: { id: 'field_op', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Database', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },

  create_task_table: { id: 'table_create', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Database', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },
  create_view: { id: 'view_create', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Database', riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard' },

  /* ── TabDoc 操作（命名空间） ─── */
  'tabdoc_search_documents': {
    id: 'doc_search', category: 'tool', labelKey: 'chat.card.doc_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: false, renderer: 'DocSearchCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.query ? truncate(String(args.query), 40) : null },
  },
  'tabdoc_read_document': {
    id: 'doc_read', category: 'tool', labelKey: 'chat.card.doc_read', icon: 'BookOpen',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.document_id ? truncate(String(args.document_id), 16) : null },
  },
  'tabdoc_create_document': {
    id: 'doc_create', category: 'tool', labelKey: 'chat.card.doc_create', icon: 'FilePlus',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.title ? truncate(String(args.title), 40) : null },
  },
  'tabdoc_update_document': {
    id: 'doc_update', category: 'tool', labelKey: 'chat.card.doc_update', icon: 'FilePenLine',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.document_id ? truncate(String(args.document_id), 16) : null },
  },
  'tabdoc_list_documents': {
    id: 'doc_list', category: 'tool', labelKey: 'chat.card.doc_list', icon: 'FolderTree',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  'tabdoc_list_blocks': {
    id: 'doc_blocks', category: 'tool', labelKey: 'chat.card.doc_list_blocks', icon: 'LayoutList',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.document_id ? truncate(String(args.document_id), 16) : null },
  },
  'tabdoc_read_block': {
    id: 'doc_block_read', category: 'tool', labelKey: 'chat.card.doc_read_block', icon: 'Blocks',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.block_id ? truncate(String(args.block_id), 16) : null },
  },
  'tabdoc_update_block': {
    id: 'doc_block_update', category: 'tool', labelKey: 'chat.card.doc_update_block', icon: 'FilePenLine',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.block_id ? truncate(String(args.block_id), 16) : null },
  },
  'tabdoc_insert_block': {
    id: 'doc_block_insert', category: 'tool', labelKey: 'chat.card.doc_insert_block', icon: 'FilePlus2',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.document_id ? truncate(String(args.document_id), 16) : null },
  },
  'tabdoc_delete_block': {
    id: 'doc_block_delete', category: 'tool', labelKey: 'chat.card.doc_delete_block', icon: 'Trash2',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.block_id ? truncate(String(args.block_id), 16) : null },
  },
}
