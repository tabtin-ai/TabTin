/**
 * 飞书导入弹窗状态机（纯函数，便于单测）
 */

export type FeishuImportPhase =
  | 'checking'
  | 'provider_setup'
  | 'provider_wait'
  | 'need_auth'
  | 'browsing'
  | 'review'
  | 'importing'
  | 'done'
  | 'error'

export type FeishuImportItemStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped'
  | 'cancelled'

export type FeishuImportItemKind = 'table' | 'docx'

export interface FeishuImportProgressItem {
  /** 面板唯一键：`${batchId}:${tableKey|docKey}` */
  key: string
  /** 飞书表键：`app_token:table_id`；文档项可为空串 */
  tableKey: string
  /** 资源类型：默认 table（兼容旧数据） */
  itemKind?: FeishuImportItemKind
  /** 文档 token（itemKind=docx） */
  docToken?: string
  batchId: string
  name: string
  status: FeishuImportItemStatus
  errorMessage?: string
}

export function phaseFromConnection(connection: boolean | {
  connected: boolean
  provider_configured?: boolean
  can_manage_provider?: boolean
}): Extract<FeishuImportPhase, 'provider_setup' | 'provider_wait' | 'need_auth' | 'browsing'> {
  if (typeof connection === 'boolean') {
    return connection ? 'browsing' : 'need_auth'
  }
  // 兼容尚未返回 Provider 字段的旧后端：缺失不等于“未配置”。
  if (connection.provider_configured === undefined) {
    return connection.connected ? 'browsing' : 'need_auth'
  }
  if (!connection.provider_configured) {
    return connection.can_manage_provider ? 'provider_setup' : 'provider_wait'
  }
  return connection.connected ? 'browsing' : 'need_auth'
}

export function phaseFromImportStatus(status: string): Extract<FeishuImportPhase, 'importing' | 'done' | 'error'> {
  const s = status.toLowerCase()
  if (s === 'completed' || s === 'success' || s === 'done') return 'done'
  if (s === 'failed' || s === 'error') return 'error'
  return 'importing'
}

/** 后端 ImportJob.result.phase */
export type FeishuImportTaskPhase =
  | 'phase_a'
  | 'phase_b'
  | 'phase_c'
  | 'phase_d'
  | 'done'
  | string

export type FeishuImportProgressHeader =
  | { kind: 'running'; done: number; total: number; queued: number }
  | { kind: 'docs'; done: number; total: number; queued: number }
  | { kind: 'postprocess'; step: 'links' | 'link_data' | 'attachments' | 'generic'; queued: number }
  | { kind: 'success' }
  | { kind: 'partial' }
  | { kind: 'error' }

function isTerminalItemStatus(status: FeishuImportItemStatus): boolean {
  return status === 'done'
    || status === 'skipped'
    || status === 'cancelled'
    || status === 'error'
}

/**
 * 进度面板标题：
 * - done/total 始终对整单 items 计数（表+文档），不随阶段分裂分母；
 * - 关联/附件（phase_b/c/d）优先于「文档」启发式，避免表后处理被误显示成导入文档。
 */
export function resolveFeishuImportProgressHeader(input: {
  status: 'idle' | 'running' | 'done' | 'error'
  items: FeishuImportProgressItem[]
  queuedCount: number
  taskPhase: string | null | undefined
}): FeishuImportProgressHeader {
  const { status, items, queuedCount, taskPhase } = input
  if (status === 'done') {
    const errorCount = items.filter((item) => item.status === 'error').length
    if (errorCount === 0) return { kind: 'success' }
    return items.some((item) => item.status === 'done')
      ? { kind: 'partial' }
      : { kind: 'error' }
  }
  if (status === 'error') return { kind: 'error' }
  if (status !== 'running') return { kind: 'running', done: 0, total: items.length, queued: queuedCount }

  const done = items.filter((item) => (
    item.status === 'done'
    || item.status === 'skipped'
    || item.status === 'cancelled'
  )).length
  const total = items.length
  const phase = String(taskPhase || '').toLowerCase()
  const tableItems = items.filter((item) => (item.itemKind ?? 'table') !== 'docx')
  const docItems = items.filter((item) => item.itemKind === 'docx')
  const hasActiveTableWork = tableItems.some((item) => (
    item.status === 'running' || item.status === 'pending'
  ))
  const hasActiveDocWork = docItems.some((item) => (
    item.status === 'running' || item.status === 'pending'
  ))
  const tablesSettled = tableItems.length === 0
    || tableItems.every((item) => isTerminalItemStatus(item.status))

  // 表侧后处理必须先于 docs 启发式：混选时文档仍 pending，但 phase 已是 b/c/d
  if (phase === 'phase_b') {
    return { kind: 'postprocess', step: 'links', queued: queuedCount }
  }
  if (phase === 'phase_c') {
    return { kind: 'postprocess', step: 'link_data', queued: queuedCount }
  }
  if (phase === 'phase_d') {
    return { kind: 'postprocess', step: 'attachments', queued: queuedCount }
  }

  if (phase === 'docs' || (tablesSettled && hasActiveDocWork && !hasActiveTableWork)) {
    return {
      kind: 'docs',
      done,
      total,
      queued: queuedCount,
    }
  }

  // 表已全部终态、尚无文档待办，但 phase 尚未切到 b/c/d（或轮询间隙）
  if (tablesSettled && !hasActiveTableWork && !hasActiveDocWork && tableItems.length > 0) {
    return { kind: 'postprocess', step: 'generic', queued: queuedCount }
  }

  return {
    kind: 'running',
    done,
    total,
    queued: queuedCount,
  }
}

export function tableSelectionKey(appToken: string, tableId: string): string {
  return `${appToken}:${tableId}`
}

export function docSelectionKey(docToken: string): string {
  return `doc:${docToken}`
}

export function parseDocSelectionKey(key: string): string | null {
  if (!key.startsWith('doc:')) return null
  const token = key.slice(4)
  return token.length > 0 ? token : null
}

export function progressItemKey(batchId: string, tableKey: string): string {
  return `${batchId}:${tableKey}`
}

export function parseTableSelectionKey(key: string): { app_token: string; table_id: string } | null {
  // 文档选中键是 `doc:<token>`，不能按表键切开（否则会变成 app_token=doc → 飞书 NOTEXIST）
  if (parseDocSelectionKey(key)) return null
  const idx = key.indexOf(':')
  if (idx <= 0 || idx >= key.length - 1) return null
  return {
    app_token: key.slice(0, idx),
    table_id: key.slice(idx + 1),
  }
}

export type BitableTableSelectionState = 'unchecked' | 'indeterminate' | 'checked'

export type FeishuDirectSelectableResource =
  | { kind: 'docx'; token: string; name?: string }
  | {
      kind: 'bitable'
      token: string
      name?: string
      tables?: Array<{ table_id: string; name?: string }>
    }

export function getBitableTableSelectionState(
  selected: Set<string>,
  appToken: string,
  tables: Array<{ table_id: string }>,
): BitableTableSelectionState {
  if (tables.length === 0) return 'unchecked'
  const selectedCount = tables.filter((table) => (
    selected.has(tableSelectionKey(appToken, table.table_id))
  )).length
  if (selectedCount === 0) return 'unchecked'
  if (selectedCount === tables.length) return 'checked'
  return 'indeterminate'
}

export function toggleBitableTableSelection(
  selected: Set<string>,
  appToken: string,
  tables: Array<{ table_id: string }>,
  checked: boolean,
): Set<string> {
  const next = new Set(selected)
  if (!checked) {
    for (const table of tables) {
      next.delete(tableSelectionKey(appToken, table.table_id))
    }
    return next
  }

  for (const table of tables) {
    const key = tableSelectionKey(appToken, table.table_id)
    next.add(key)
  }
  return next
}

export function getDirectResourceSelectionState(
  selected: Set<string>,
  resources: FeishuDirectSelectableResource[],
): BitableTableSelectionState {
  if (resources.length === 0) return 'unchecked'

  const states = resources.map((resource): BitableTableSelectionState => {
    if (resource.kind === 'docx') {
      return selected.has(docSelectionKey(resource.token)) ? 'checked' : 'unchecked'
    }
    if (resource.tables) {
      return getBitableTableSelectionState(selected, resource.token, resource.tables)
    }
    return [...selected].some((key) => (
      parseTableSelectionKey(key)?.app_token === resource.token
    )) ? 'indeterminate' : 'unchecked'
  })

  if (states.every((state) => state === 'checked')) return 'checked'
  if (states.every((state) => state === 'unchecked')) return 'unchecked'
  return 'indeterminate'
}

function keysFromRows(
  rows: Array<{ app_token?: string; table_id?: string }> | undefined,
): Set<string> {
  const keys = new Set<string>()
  for (const row of rows ?? []) {
    if (
      typeof row.app_token === 'string'
      && row.app_token.length > 0
      && typeof row.table_id === 'string'
      && row.table_id.length > 0
    ) {
      keys.add(tableSelectionKey(row.app_token, row.table_id))
    }
  }
  return keys
}

function keysFromStringList(list: unknown): Set<string> {
  if (!Array.isArray(list)) return new Set()
  return new Set(list.filter((item): item is string => typeof item === 'string' && item.length > 0))
}

function matchKey(item: FeishuImportProgressItem): string {
  return item.tableKey || item.key
}

/** 按任务结果同步指定 batch 内各表/文档导入态（其它 batch 原样保留，供排队） */
export function syncProgressItemsWithTask(
  items: FeishuImportProgressItem[],
  task: {
    status: string
    result?: {
      phase?: string
      created_tables?: Array<{ app_token?: string; table_id?: string }>
      failed_tables?: Array<{
        app_token?: string
        table_id?: string
        error?: string
      }>
      created_documents?: Array<{ doc_token?: string }>
      failed_documents?: Array<{ doc_token?: string; error?: string }>
      skipped_tables?: Array<{ app_token?: string; table_id?: string }>
      cancelled_tables?: Array<{ app_token?: string; table_id?: string }>
      skipped_keys?: string[]
      cancelled_keys?: string[]
    } | null
  },
  options?: { batchId?: string },
): FeishuImportProgressItem[] {
  const createdKeys = keysFromRows(task.result?.created_tables)
  const failedTableErrors = new Map(
    (task.result?.failed_tables ?? [])
      .map((row) => [
        tableSelectionKey(
          String(row.app_token || '').trim(),
          String(row.table_id || '').trim(),
        ),
        String(row.error || '').trim() || '导入失败',
      ] as const)
      .filter(([key]) => key !== ':'),
  )
  const createdDocTokens = new Set(
    (task.result?.created_documents ?? [])
      .map((row) => String(row.doc_token || '').trim())
      .filter(Boolean),
  )
  const failedDocErrors = new Map(
    (task.result?.failed_documents ?? [])
      .map((row) => [
        String(row.doc_token || '').trim(),
        String(row.error || '').trim() || '导入失败',
      ] as const)
      .filter(([token]) => Boolean(token)),
  )
  const skippedKeys = new Set([
    ...keysFromRows(task.result?.skipped_tables),
    ...keysFromStringList(task.result?.skipped_keys),
  ])
  const cancelledKeys = new Set([
    ...keysFromRows(task.result?.cancelled_tables),
    ...keysFromStringList(task.result?.cancelled_keys),
  ])
  const terminal = phaseFromImportStatus(String(task.status || ''))
  const phase = String(task.result?.phase || '').toLowerCase()
  const batchId = options?.batchId
  let markedTable = false
  let markedDoc = false

  return items.map((item) => {
    if (batchId && item.batchId !== batchId) {
      return item
    }

    if (item.itemKind === 'docx') {
      const token = item.docToken || parseDocSelectionKey(item.tableKey) || ''
      if (token && createdDocTokens.has(token)) {
        return { ...item, status: 'done' as const, errorMessage: undefined }
      }
      if (token && failedDocErrors.has(token)) {
        return {
          ...item,
          status: 'error' as const,
          errorMessage: failedDocErrors.get(token),
        }
      }
      if (terminal === 'done') {
        return { ...item, status: 'error' as const, errorMessage: '未生成导入资源' }
      }
      if (terminal === 'error') {
        if (item.status === 'done') return item
        if (!markedDoc) {
          markedDoc = true
          return { ...item, status: 'error' as const }
        }
        return { ...item, status: 'pending' as const }
      }
      // 文档阶段开始前保持 pending；进入 docs 后顺序标 running
      if (phase === 'docs') {
        if (item.status === 'done' || item.status === 'error') return item
        if (!markedDoc) {
          markedDoc = true
          return { ...item, status: 'running' as const }
        }
        return { ...item, status: 'pending' as const }
      }
      return { ...item, status: item.status === 'running' ? 'pending' as const : item.status }
    }

    const tableKey = matchKey(item)
    if (createdKeys.has(tableKey)) {
      return { ...item, status: 'done' as const }
    }
    if (failedTableErrors.has(tableKey)) {
      return {
        ...item,
        status: 'error' as const,
        errorMessage: failedTableErrors.get(tableKey),
      }
    }
    if (skippedKeys.has(tableKey) || item.status === 'skipped') {
      return { ...item, status: 'skipped' as const }
    }
    if (cancelledKeys.has(tableKey) || item.status === 'cancelled') {
      return { ...item, status: 'cancelled' as const }
    }
    if (terminal === 'done') {
      return { ...item, status: 'error' as const, errorMessage: '未生成导入资源' }
    }
    if (terminal === 'error') {
      if (!markedTable) {
        markedTable = true
        return { ...item, status: 'error' as const }
      }
      return { ...item, status: 'pending' as const }
    }
    // 文档阶段：表项已终态，勿再标 running
    if (phase === 'docs' || phase === 'done') {
      if (isTerminalItemStatus(item.status)) return item
      return { ...item, status: 'done' as const }
    }
    if (!markedTable) {
      markedTable = true
      return { ...item, status: 'running' as const }
    }
    return { ...item, status: 'pending' as const }
  })
}
