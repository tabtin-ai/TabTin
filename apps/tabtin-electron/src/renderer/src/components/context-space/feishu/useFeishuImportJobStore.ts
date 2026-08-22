/**
 * 飞书多维表导入进度（全局 store，支持排队）。
 *
 * 导入进行中再发起新导入 → 追加到同一进度面板排队；
 * 当前 batch 结束后自动开跑下一个。
 */
import { create } from 'zustand'
import { toast } from '@components/ui'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'
import { registerResetAction } from '@stores/sessionResetRegistry'
import { useCollections } from '@stores/useCollections'
import { useUnifiedResources } from '@stores/useUnifiedResources'
import {
  cancelFeishuImportTable,
  extractImportedTableIds,
  getFeishuImportTask,
  getFeishuDisplayName,
  isFeishuImportTerminalFailure,
  isFeishuImportTerminalSuccess,
  skipFeishuImportTable,
  startFeishuImport,
  type FeishuImportDocumentRef,
  type FeishuImportTableRef,
} from './feishuApi'
import {
  docSelectionKey,
  parseDocSelectionKey,
  parseTableSelectionKey,
  phaseFromImportStatus,
  progressItemKey,
  syncProgressItemsWithTask,
  tableSelectionKey,
  type FeishuImportProgressItem,
} from './feishuImportPhase'

const log = createLogger('FeishuImportJob')

const POLL_INTERVAL_MS = 1500
const POLL_MAX_ATTEMPTS = 80
const POLL_AFTER_TIMEOUT_INTERVAL_MS = 5000

export type FeishuImportJobUiStatus = 'idle' | 'running' | 'done' | 'error'

export type FeishuImportBatchStatus = 'queued' | 'running' | 'done' | 'error'

export interface FeishuImportBatch {
  id: string
  organizationId: string
  spaceId: string
  collectionId?: string | null
  tables: Array<FeishuImportTableRef & { name?: string }>
  documents: FeishuImportDocumentRef[]
  includeAttachments: boolean
  status: FeishuImportBatchStatus
  taskId: string | null
  errorMessage: string | null
}

interface StartFeishuImportJobInput {
  organizationId: string
  spaceId: string
  collectionId?: string | null
  tables?: Array<FeishuImportTableRef & { name?: string }>
  documents?: FeishuImportDocumentRef[]
  includeAttachments?: boolean
  /** 仅需 name；key/batchId 由 store 生成 */
  items: Array<{
    name: string
    tableKey?: string
    app_token?: string
    table_id?: string
    itemKind?: 'table' | 'docx'
    docToken?: string
  }>
}

interface FeishuImportJobStore {
  batches: FeishuImportBatch[]
  activeBatchId: string | null
  taskId: string | null
  /** 当前活跃任务的后端 phase（phase_a/b/c/d），供进度标题展示 */
  taskPhase: string | null
  items: FeishuImportProgressItem[]
  status: FeishuImportJobUiStatus
  errorMessage: string | null
  collapsed: boolean
  pollGeneration: number
  /** 防止 pump 重入 */
  pumping: boolean

  startJob: (input: StartFeishuImportJobInput) => Promise<void>
  skipItem: (key: string) => Promise<void>
  cancelItem: (key: string) => Promise<void>
  toggleCollapsed: () => void
  dismiss: () => void
}

function newBatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function refreshImportedDirectory(spaceId: string, organizationId: string | null) {
  void useUnifiedResources.getState().load(spaceId, true, 'organization').catch((err) => {
    log.warn('refresh resources after feishu import failed', err)
  })
  void useCollections.getState().load(spaceId, true).catch(() => {
    /* ignore */
  })
  if (organizationId) {
    void useCollections.getState().loadOrganization(organizationId, true).catch(() => {
      /* ignore */
    })
  }
}

function deriveUiStatus(batches: FeishuImportBatch[]): FeishuImportJobUiStatus {
  if (batches.length === 0) return 'idle'
  if (batches.some((batch) => batch.status === 'running' || batch.status === 'queued')) {
    return 'running'
  }
  if (batches.some((batch) => batch.status === 'error')) return 'error'
  return 'done'
}

function buildBatchItems(
  batchId: string,
  input: StartFeishuImportJobInput,
): FeishuImportProgressItem[] {
  const tables = input.tables ?? []
  const documents = input.documents ?? []
  const tableItems: FeishuImportProgressItem[] = tables.map((table) => {
    const tableKey = tableSelectionKey(table.app_token, table.table_id)
    const named = input.items.find((row) => {
      if (row.itemKind === 'docx') return false
      if (row.tableKey) return row.tableKey === tableKey
      if (row.app_token && row.table_id) {
        return tableSelectionKey(row.app_token, row.table_id) === tableKey
      }
      return false
    })
    return {
      key: progressItemKey(batchId, tableKey),
      tableKey,
      itemKind: 'table' as const,
      batchId,
      name: getFeishuDisplayName(
        'table',
        named?.name || table.name,
        [table.table_id],
      ),
      status: 'pending' as const,
    }
  })
  const docItems: FeishuImportProgressItem[] = documents.map((doc) => {
    const docKey = docSelectionKey(doc.doc_token)
    const named = input.items.find((row) => (
      row.itemKind === 'docx' && (row.docToken === doc.doc_token || row.tableKey === docKey)
    ))
    return {
      key: progressItemKey(batchId, docKey),
      tableKey: docKey,
      itemKind: 'docx' as const,
      docToken: doc.doc_token,
      batchId,
      name: getFeishuDisplayName(
        'docx',
        named?.name || doc.name,
        [doc.doc_token],
      ),
      status: 'pending' as const,
    }
  })
  return [...tableItems, ...docItems]
}

async function pollUntilSettled(taskId: string, batchId: string, generation: number): Promise<'done' | 'error'> {
  let attempt = 0
  let pollingTimedOut = false
  while (true) {
    if (useFeishuImportJobStore.getState().pollGeneration !== generation) return 'error'

    const task = await getFeishuImportTask(taskId)
    if (useFeishuImportJobStore.getState().pollGeneration !== generation) return 'error'

    const nextPhase = phaseFromImportStatus(String(task.status || ''))
    const taskPhase = typeof task.result?.phase === 'string' ? task.result.phase : null
    useFeishuImportJobStore.setState((prev) => ({
      items: syncProgressItemsWithTask(prev.items, task, { batchId }),
      taskPhase,
      errorMessage: nextPhase === 'done'
        ? null
        : nextPhase === 'error'
          ? (task.error || task.message || '导入失败')
          : prev.errorMessage,
    }))

    if (nextPhase === 'done' || isFeishuImportTerminalSuccess(String(task.status || ''))) {
      extractImportedTableIds(task)
      return 'done'
    }
    if (nextPhase === 'error' || isFeishuImportTerminalFailure(String(task.status || ''))) {
      return 'error'
    }
    attempt += 1
    if (!pollingTimedOut && attempt >= POLL_MAX_ATTEMPTS) {
      pollingTimedOut = true
      log.warn('feishu import polling timed out; keep task actionable', {
        taskId,
        batchId,
        attempts: attempt,
      })
      useFeishuImportJobStore.setState({
        collapsed: false,
        errorMessage: i18n.t('home.assetBrowser.feishuImportTimeout', {
          ns: 'context',
          defaultValue: '导入超时，可跳过当前项或取消等待项',
        }),
      })
    }
    await new Promise((resolve) => setTimeout(
      resolve,
      pollingTimedOut ? POLL_AFTER_TIMEOUT_INTERVAL_MS : POLL_INTERVAL_MS,
    ))
  }
}

async function pumpQueue(): Promise<void> {
  const store = useFeishuImportJobStore.getState()
  if (store.pumping) return
  if (store.activeBatchId) return

  const next = store.batches.find((batch) => batch.status === 'queued')
  if (!next) {
    const uiStatus = deriveUiStatus(store.batches)
    useFeishuImportJobStore.setState({ status: uiStatus, taskId: null, taskPhase: null })
    if (uiStatus === 'done') {
      const hasDone = store.items.some((item) => item.status === 'done')
      const hasErrors = store.items.some((item) => item.status === 'error')
      toast({
        title: hasErrors
          ? hasDone
            ? i18n.t('home.assetBrowser.feishuImportPartialSuccess', {
                ns: 'context',
                defaultValue: '部分导入成功',
              })
            : i18n.t('home.assetBrowser.feishuImportFailed', {
                ns: 'context',
                defaultValue: '导入失败',
              })
          : i18n.t('home.assetBrowser.feishuImportSuccess', {
              ns: 'context',
              defaultValue: '导入成功',
            }),
      })
      if (hasErrors) return
      const generation = store.pollGeneration
      window.setTimeout(() => {
        const latest = useFeishuImportJobStore.getState()
        if (latest.pollGeneration === generation && latest.status === 'done') {
          latest.dismiss()
        }
      }, 2800)
    }
    return
  }

  const generation = store.pollGeneration
  useFeishuImportJobStore.setState({
    pumping: true,
    activeBatchId: next.id,
    taskId: null,
    taskPhase: 'phase_a',
    status: 'running',
    errorMessage: null,
    batches: store.batches.map((batch) => (
      batch.id === next.id ? { ...batch, status: 'running' as const } : batch
    )),
    // 当前 batch 第一项标为 running，排队 batch 保持 pending
    items: store.items.map((item) => {
      if (item.batchId !== next.id) return item
      if (item.status === 'cancelled' || item.status === 'skipped' || item.status === 'done') {
        return item
      }
      return item
    }),
  })

  // 启动时把 batch 内第一个未完成项标 running
  useFeishuImportJobStore.setState((prev) => {
    let marked = false
    return {
      items: prev.items.map((item) => {
        if (item.batchId !== next.id) return item
        if (item.status !== 'pending') return item
        if (!marked) {
          marked = true
          return { ...item, status: 'running' as const }
        }
        return item
      }),
    }
  })

  try {
    // 排除已在排队阶段被取消的表
    const liveItems = useFeishuImportJobStore.getState().items.filter((item) => (
      item.batchId === next.id && item.status !== 'cancelled'
    ))
    const tables = next.tables.filter((table) => {
      const tableKey = tableSelectionKey(table.app_token, table.table_id)
      return liveItems.some((item) => (
        (item.itemKind ?? 'table') !== 'docx' && item.tableKey === tableKey
      ))
    })
    const documents = next.documents.filter((doc) => {
      const docKey = docSelectionKey(doc.doc_token)
      return liveItems.some((item) => (
        item.itemKind === 'docx'
        && (item.docToken === doc.doc_token || item.tableKey === docKey)
      ))
    })

    if (tables.length === 0 && documents.length === 0) {
      useFeishuImportJobStore.setState((prev) => ({
        pumping: false,
        activeBatchId: null,
        taskId: null,
        taskPhase: null,
        batches: prev.batches.map((batch) => (
          batch.id === next.id ? { ...batch, status: 'done' as const } : batch
        )),
      }))
      await pumpQueue()
      return
    }

    const result = await startFeishuImport({
      organization_id: next.organizationId,
      space_id: next.spaceId,
      collection_id: next.collectionId,
      tables,
      documents,
      include_attachments: next.includeAttachments,
    })
    if (!result?.task_id) {
      throw new Error('导入任务创建失败')
    }
    if (useFeishuImportJobStore.getState().pollGeneration !== generation) return

    useFeishuImportJobStore.setState((prev) => ({
      taskId: result.task_id,
      batches: prev.batches.map((batch) => (
        batch.id === next.id ? { ...batch, taskId: result.task_id } : batch
      )),
    }))

    const outcome = await pollUntilSettled(result.task_id, next.id, generation)
    if (useFeishuImportJobStore.getState().pollGeneration !== generation) return

    refreshImportedDirectory(next.spaceId, next.organizationId)

    useFeishuImportJobStore.setState((prev) => ({
      pumping: false,
      activeBatchId: null,
      taskId: null,
      taskPhase: null,
      batches: prev.batches.map((batch) => (
        batch.id === next.id
          ? {
              ...batch,
              status: outcome === 'done' ? 'done' as const : 'error' as const,
              errorMessage: outcome === 'error' ? prev.errorMessage : null,
            }
          : batch
      )),
      status: 'running',
    }))

    await pumpQueue()
  } catch (err) {
    log.error('feishu import batch failed', { batchId: next.id, err })
    if (useFeishuImportJobStore.getState().pollGeneration !== generation) return
    const message = err instanceof Error ? err.message : String(err)
    useFeishuImportJobStore.setState((prev) => ({
      pumping: false,
      activeBatchId: null,
      taskId: null,
      taskPhase: null,
      errorMessage: message,
      batches: prev.batches.map((batch) => (
        batch.id === next.id
          ? { ...batch, status: 'error' as const, errorMessage: message }
          : batch
      )),
      items: syncProgressItemsWithTask(
        prev.items,
        { status: 'failed' },
        { batchId: next.id },
      ),
      status: 'running',
    }))
    // 单批失败不堵后续排队
    await pumpQueue()
  }
}

export const useFeishuImportJobStore = create<FeishuImportJobStore>((set, get) => ({
  batches: [],
  activeBatchId: null,
  taskId: null,
  taskPhase: null,
  items: [],
  status: 'idle',
  errorMessage: null,
  collapsed: false,
  pollGeneration: 0,
  pumping: false,

  startJob: async (input) => {
    const batchId = newBatchId()
    const items = buildBatchItems(batchId, input)
    if (items.length === 0) return

    const batch: FeishuImportBatch = {
      id: batchId,
      organizationId: input.organizationId,
      spaceId: input.spaceId,
      collectionId: input.collectionId,
      tables: input.tables ?? [],
      documents: input.documents ?? [],
      includeAttachments: Boolean(input.includeAttachments),
      status: 'queued',
      taskId: null,
      errorMessage: null,
    }

    set((prev) => {
      const appendToActiveQueue = prev.status === 'running'
      return {
        batches: appendToActiveQueue ? [...prev.batches, batch] : [batch],
        items: appendToActiveQueue ? [...prev.items, ...items] : items,
        status: 'running',
        errorMessage: null,
        collapsed: false,
      }
    })

    log.info('feishu import batch enqueued', {
      batchId,
      tables: items.length,
      queueSize: get().batches.filter((row) => row.status === 'queued').length,
    })

    await pumpQueue()
  },

  skipItem: async (key) => {
    const { taskId, items, activeBatchId, status } = get()
    if (status !== 'running' || !taskId || !activeBatchId) return
    const item = items.find((row) => row.key === key)
    if (!item || item.status !== 'running' || item.batchId !== activeBatchId) return
    if (item.itemKind === 'docx' || parseDocSelectionKey(item.tableKey)) {
      log.warn('skip feishu import ignored for docx item', { key })
      return
    }
    const parsed = parseTableSelectionKey(item.tableKey)
    if (!parsed) {
      log.warn('skip feishu import ignored: invalid table key', { key, tableKey: item.tableKey })
      return
    }

    set({
      items: items.map((row) => (
        row.key === key ? { ...row, status: 'skipped' as const } : row
      )),
    })
    try {
      await skipFeishuImportTable(taskId, parsed)
    } catch (err) {
      log.error('skip feishu import table failed', { key, err })
      set({
        items: get().items.map((row) => (
          row.key === key ? { ...row, status: 'running' as const } : row
        )),
      })
      toast({
        title: i18n.t('home.assetBrowser.feishuImportItemSkipFailed', {
          ns: 'context',
          defaultValue: '跳过失败',
        }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  },

  cancelItem: async (key) => {
    const state = get()
    const item = state.items.find((row) => row.key === key)
    if (!item || item.status !== 'pending') return

    const batch = state.batches.find((row) => row.id === item.batchId)
    if (!batch) return

    // 排队中的 batch：本地剔除即可，不必打 API
    if (batch.status === 'queued') {
      const nextItems = state.items.filter((row) => row.key !== key)
      const remainingInBatch = nextItems.filter((row) => row.batchId === batch.id)
      const nextBatches = remainingInBatch.length === 0
        ? state.batches.filter((row) => row.id !== batch.id)
        : state.batches.map((row) => (
          row.id === batch.id
            ? {
                ...row,
                tables: row.tables.filter((table) => (
                  tableSelectionKey(table.app_token, table.table_id) !== item.tableKey
                )),
                documents: row.documents.filter((doc) => (
                  docSelectionKey(doc.doc_token) !== item.tableKey
                  && doc.doc_token !== item.docToken
                )),
              }
            : row
        ))
      set({
        items: nextItems,
        batches: nextBatches,
        status: deriveUiStatus(nextBatches),
      })
      return
    }

    // 文档项暂不支持运行中 cancel（后端无对应 action）
    if (item.itemKind === 'docx' || parseDocSelectionKey(item.tableKey)) {
      log.warn('cancel feishu import ignored for docx item', { key })
      return
    }

    // 进行中的 batch：走后端 cancel
    if (batch.status !== 'running' || !state.taskId || item.batchId !== state.activeBatchId) {
      return
    }
    const parsed = parseTableSelectionKey(item.tableKey)
    if (!parsed) return

    set({
      items: state.items.map((row) => (
        row.key === key ? { ...row, status: 'cancelled' as const } : row
      )),
    })
    try {
      await cancelFeishuImportTable(state.taskId, parsed)
    } catch (err) {
      log.error('cancel feishu import table failed', { key, err })
      set({
        items: get().items.map((row) => (
          row.key === key ? { ...row, status: 'pending' as const } : row
        )),
      })
      toast({
        title: i18n.t('home.assetBrowser.feishuImportItemCancelFailed', {
          ns: 'context',
          defaultValue: '取消失败',
        }),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    }
  },

  toggleCollapsed: () => set((prev) => ({ collapsed: !prev.collapsed })),

  dismiss: () => set((prev) => ({
    batches: [],
    activeBatchId: null,
    taskId: null,
    taskPhase: null,
    items: [],
    status: 'idle',
    errorMessage: null,
    collapsed: false,
    pumping: false,
    pollGeneration: prev.pollGeneration + 1,
  })),
}))

registerResetAction('feishu-import-job', 'reset', () => {
  useFeishuImportJobStore.getState().dismiss()
})
