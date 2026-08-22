import { describe, expect, it } from 'vitest'
import {
  docSelectionKey,
  getDirectResourceSelectionState,
  parseDocSelectionKey,
  parseTableSelectionKey,
  phaseFromConnection,
  phaseFromImportStatus,
  progressItemKey,
  resolveFeishuImportProgressHeader,
  syncProgressItemsWithTask,
  toggleBitableTableSelection,
  getBitableTableSelectionState,
  tableSelectionKey,
  type FeishuImportProgressItem,
} from '../feishuImportPhase'
import {
  extractImportedTableIds,
  filterFeishuResourcesByKind,
  getFeishuDisplayName,
  isFeishuImportTerminalFailure,
  isFeishuImportTerminalSuccess,
} from '../feishuApi'

function item(
  batchId: string,
  tableKey: string,
  name: string,
  status: FeishuImportProgressItem['status'] = 'pending',
): FeishuImportProgressItem {
  return {
    key: progressItemKey(batchId, tableKey),
    tableKey,
    batchId,
    name,
    status,
  }
}

const batchA = 'batch-a'
const baseItems: FeishuImportProgressItem[] = [
  item(batchA, 'app1:tbl1', '表一'),
  item(batchA, 'app1:tbl2', '表二'),
  item(batchA, 'app2:tbl3', '表三'),
]

describe('feishuImportPhase', () => {
  it('maps provider and personal authorization into distinct phases', () => {
    expect(phaseFromConnection(false)).toBe('need_auth')
    expect(phaseFromConnection(true)).toBe('browsing')
    expect(phaseFromConnection({ connected: true })).toBe('browsing')
    expect(phaseFromConnection({ connected: false })).toBe('need_auth')
    expect(phaseFromConnection({
      connected: false,
      provider_configured: false,
      can_manage_provider: true,
    })).toBe('provider_setup')
    expect(phaseFromConnection({
      connected: false,
      provider_configured: false,
      can_manage_provider: false,
    })).toBe('provider_wait')
    expect(phaseFromConnection({
      connected: false,
      provider_configured: true,
      can_manage_provider: false,
    })).toBe('need_auth')
  })

  it('does not treat doc selection keys as table keys', () => {
    const docKey = docSelectionKey('docxAbCdEfGhIjKlMnOpQrSt')
    expect(parseDocSelectionKey(docKey)).toBe('docxAbCdEfGhIjKlMnOpQrSt')
    expect(parseTableSelectionKey(docKey)).toBeNull()
    expect(parseTableSelectionKey(tableSelectionKey('app1', 'tbl1'))).toEqual({
      app_token: 'app1',
      table_id: 'tbl1',
    })
  })

  it('maps import status to importing / done / error', () => {
    expect(phaseFromImportStatus('pending')).toBe('importing')
    expect(phaseFromImportStatus('running')).toBe('importing')
    expect(phaseFromImportStatus('completed')).toBe('done')
    expect(phaseFromImportStatus('success')).toBe('done')
    expect(phaseFromImportStatus('failed')).toBe('error')
    expect(phaseFromImportStatus('error')).toBe('error')
  })

  it('round-trips selection keys', () => {
    const key = tableSelectionKey('app_x', 'tbl_y')
    expect(key).toBe('app_x:tbl_y')
    expect(parseTableSelectionKey(key)).toEqual({
      app_token: 'app_x',
      table_id: 'tbl_y',
    })
    expect(parseTableSelectionKey('bad')).toBeNull()
  })

  it('syncs per-table progress from created_tables', () => {
    const synced = syncProgressItemsWithTask(baseItems, {
      status: 'running',
      result: {
        created_tables: [{ app_token: 'app1', table_id: 'tbl1' }],
      },
    }, { batchId: batchA })
    expect(synced.map((row) => row.status)).toEqual(['done', 'running', 'pending'])
  })

  it('does not mutate queued batch items while syncing active batch', () => {
    const mixed = [
      ...baseItems,
      item('batch-b', 'app9:tbl9', '排队表'),
    ]
    const synced = syncProgressItemsWithTask(mixed, {
      status: 'running',
      result: {
        created_tables: [{ app_token: 'app1', table_id: 'tbl1' }],
      },
    }, { batchId: batchA })
    expect(synced.map((row) => row.status)).toEqual(['done', 'running', 'pending', 'pending'])
    expect(synced[3].batchId).toBe('batch-b')
  })

  it('marks first unfinished item as error on failure', () => {
    const synced = syncProgressItemsWithTask(baseItems, {
      status: 'failed',
      result: {
        created_tables: [{ app_token: 'app1', table_id: 'tbl1' }],
      },
    }, { batchId: batchA })
    expect(synced.map((row) => row.status)).toEqual(['done', 'error', 'pending'])
  })

  it('does not mark resources done when terminal success lacks created results', () => {
    const synced = syncProgressItemsWithTask(baseItems, {
      status: 'completed',
      result: { created_tables: [] },
    }, { batchId: batchA })
    expect(synced.every((row) => row.status === 'error')).toBe(true)
  })

  it('maps failed_documents to per-document errors', () => {
    const doc: FeishuImportProgressItem = {
      key: progressItemKey(batchA, 'doc:docx1'),
      tableKey: 'doc:docx1',
      itemKind: 'docx',
      docToken: 'docx1',
      batchId: batchA,
      name: '方案.xmind',
      status: 'running',
    }
    const [synced] = syncProgressItemsWithTask([doc], {
      status: 'success',
      result: {
        created_documents: [],
        failed_documents: [{ doc_token: 'docx1', error: '不支持的文档类型' }],
      },
    }, { batchId: batchA })
    expect(synced.status).toBe('error')
    expect(synced.errorMessage).toBe('不支持的文档类型')
  })

  it('maps failed_tables and advances to the next table', () => {
    const synced = syncProgressItemsWithTask(baseItems, {
      status: 'running',
      result: {
        failed_tables: [{
          app_token: 'app1',
          table_id: 'tbl1',
          error: 'permission denied for schema as_example',
        }],
      },
    }, { batchId: batchA })

    expect(synced.map((row) => row.status)).toEqual(['error', 'running', 'pending'])
    expect(synced[0].errorMessage).toBe('permission denied for schema as_example')
  })

  it('toggles every table in a bitable without a selection limit', () => {
    const tables = [
      { table_id: 'tbl1', name: '表一' },
      { table_id: 'tbl2', name: '表二' },
      { table_id: 'tbl3', name: '表三' },
    ]
    const selected = toggleBitableTableSelection(
      new Set(['doc:docx1']),
      'app1',
      tables,
      true,
    )
    expect([...selected]).toEqual(['doc:docx1', 'app1:tbl1', 'app1:tbl2', 'app1:tbl3'])
    expect(getBitableTableSelectionState(selected, 'app1', tables)).toBe('checked')

    const cleared = toggleBitableTableSelection(selected, 'app1', tables, false)
    expect([...cleared]).toEqual(['doc:docx1'])
    expect(getBitableTableSelectionState(cleared, 'app1', tables)).toBe('unchecked')
  })

  it('derives direct resource selection without including deeper descendants', () => {
    const directResources = [
      { kind: 'docx' as const, token: 'doc1' },
      {
        kind: 'bitable' as const,
        token: 'app1',
        tables: [
          { table_id: 'tbl1', name: '表一' },
          { table_id: 'tbl2', name: '表二' },
        ],
      },
    ]
    expect(getDirectResourceSelectionState(
      new Set(['doc:nested-doc', 'nested-app:nested-table']),
      directResources,
    )).toBe('unchecked')
    expect(getDirectResourceSelectionState(
      new Set(['doc:doc1']),
      directResources,
    )).toBe('indeterminate')
    expect(getDirectResourceSelectionState(
      new Set(['doc:doc1', 'app1:tbl1', 'app1:tbl2']),
      directResources,
    )).toBe('checked')
  })

  it('honors skipped / cancelled keys from server', () => {
    const synced = syncProgressItemsWithTask(baseItems, {
      status: 'running',
      result: {
        created_tables: [{ app_token: 'app1', table_id: 'tbl1' }],
        skipped_keys: ['app1:tbl2'],
        cancelled_keys: ['app2:tbl3'],
      },
    }, { batchId: batchA })
    expect(synced.map((row) => row.status)).toEqual(['done', 'skipped', 'cancelled'])
  })

  it('keeps optimistic skipped / cancelled while advancing the next running item', () => {
    const optimistic: FeishuImportProgressItem[] = [
      item(batchA, 'app1:tbl1', '表一', 'skipped'),
      item(batchA, 'app1:tbl2', '表二', 'pending'),
      item(batchA, 'app2:tbl3', '表三', 'cancelled'),
    ]
    const synced = syncProgressItemsWithTask(optimistic, {
      status: 'running',
      result: { created_tables: [] },
    }, { batchId: batchA })
    expect(synced.map((row) => row.status)).toEqual(['skipped', 'running', 'cancelled'])
  })
})

describe('feishuApi helpers', () => {
  it('uses readable untitled labels instead of resource identifiers', () => {
    expect(getFeishuDisplayName('docx', '', ['docxABC'])).toBe('未命名文档')
    expect(getFeishuDisplayName('bitable', 'baseABC', ['baseABC'])).toBe('未命名多维表')
    expect(getFeishuDisplayName('table', null, ['tblABC'])).toBe('未命名数据表')
  })

  it('derives all resource tabs from one normalized search result', () => {
    const resources = [
      { token: 'docx1', name: '文档', kind: 'docx' as const },
      { token: 'base1', name: '多维表', kind: 'bitable' as const },
    ]
    const all = filterFeishuResourcesByKind(resources, 'all')
    const docs = filterFeishuResourcesByKind(resources, 'docx')
    const bitables = filterFeishuResourcesByKind(resources, 'bitable')
    expect(new Set(all.map((row) => row.token))).toEqual(new Set([
      ...docs.map((row) => row.token),
      ...bitables.map((row) => row.token),
    ]))
  })

  it('extracts table ids from task payloads', () => {
    expect(extractImportedTableIds({
      status: 'success',
      result: {
        created_tables: [
          { tabdata_table_id: 'td-1', table_id: 'tbl_x' },
          { tabdata_table_id: 'td-2' },
        ],
      },
    })).toEqual(['td-1', 'td-2'])
    expect(extractImportedTableIds({ status: 'completed', table_ids: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(extractImportedTableIds({
      status: 'completed',
      tables: [{ table_id: 't1' }, { id: 't2' }],
    })).toEqual(['t1', 't2'])
  })

  it('recognizes terminal statuses', () => {
    expect(isFeishuImportTerminalSuccess('completed')).toBe(true)
    expect(isFeishuImportTerminalSuccess('SUCCESS')).toBe(true)
    expect(isFeishuImportTerminalFailure('failed')).toBe(true)
    expect(isFeishuImportTerminalFailure('running')).toBe(false)
  })

  describe('resolveFeishuImportProgressHeader', () => {
    const runningItems: FeishuImportProgressItem[] = [
      item(batchA, 'app1:tbl1', '表一', 'running'),
      item(batchA, 'app1:tbl2', '表二', 'pending'),
    ]
    const settledItems: FeishuImportProgressItem[] = [
      item(batchA, 'app1:tbl1', '表一', 'done'),
      item(batchA, 'app1:tbl2', '表二', 'done'),
    ]

    it('keeps done/total while tables are still importing', () => {
      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: runningItems,
        queuedCount: 0,
        taskPhase: 'phase_a',
      })).toEqual({ kind: 'running', done: 0, total: 2, queued: 0 })
    })

    it('switches to postprocess copy by backend phase after tables settle', () => {
      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: settledItems,
        queuedCount: 0,
        taskPhase: 'phase_b',
      })).toEqual({ kind: 'postprocess', step: 'links', queued: 0 })

      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: settledItems,
        queuedCount: 1,
        taskPhase: 'phase_c',
      })).toEqual({ kind: 'postprocess', step: 'link_data', queued: 1 })

      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: settledItems,
        queuedCount: 0,
        taskPhase: 'phase_d',
      })).toEqual({ kind: 'postprocess', step: 'attachments', queued: 0 })
    })

    it('falls back to generic postprocess when tables settled but phase lags', () => {
      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: settledItems,
        queuedCount: 0,
        taskPhase: 'phase_a',
      })).toEqual({ kind: 'postprocess', step: 'generic', queued: 0 })
    })

    it('prefers phase_b/c/d even if an item still looks pending', () => {
      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: [
          item(batchA, 'app1:tbl1', '表一', 'done'),
          item(batchA, 'app1:tbl2', '表二', 'pending'),
        ],
        queuedCount: 0,
        taskPhase: 'phase_b',
      })).toEqual({ kind: 'postprocess', step: 'links', queued: 0 })
    })

    it('shows docs progress with stable total across tables+docs', () => {
      const mixed: FeishuImportProgressItem[] = [
        { ...item(batchA, 'app1:tbl1', '表一', 'done'), itemKind: 'table' },
        { ...item(batchA, 'app1:tbl2', '表二', 'done'), itemKind: 'table' },
        {
          key: progressItemKey(batchA, 'doc:docx1'),
          tableKey: 'doc:docx1',
          itemKind: 'docx',
          docToken: 'docx1',
          batchId: batchA,
          name: '文档一',
          status: 'running',
        },
        {
          key: progressItemKey(batchA, 'doc:docx2'),
          tableKey: 'doc:docx2',
          itemKind: 'docx',
          docToken: 'docx2',
          batchId: batchA,
          name: '文档二',
          status: 'pending',
        },
        {
          key: progressItemKey(batchA, 'doc:docx3'),
          tableKey: 'doc:docx3',
          itemKind: 'docx',
          docToken: 'docx3',
          batchId: batchA,
          name: '文档三',
          status: 'pending',
        },
      ]
      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: mixed,
        queuedCount: 0,
        taskPhase: 'docs',
      })).toEqual({ kind: 'docs', done: 2, total: 5, queued: 0 })
    })

    it('keeps postprocess title while docs wait during phase_b/c/d', () => {
      const mixed: FeishuImportProgressItem[] = [
        { ...item(batchA, 'app1:tbl1', '表一', 'done'), itemKind: 'table' },
        { ...item(batchA, 'app1:tbl2', '表二', 'done'), itemKind: 'table' },
        {
          key: progressItemKey(batchA, 'doc:docx1'),
          tableKey: 'doc:docx1',
          itemKind: 'docx',
          docToken: 'docx1',
          batchId: batchA,
          name: '文档一',
          status: 'pending',
        },
      ]
      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: mixed,
        queuedCount: 0,
        taskPhase: 'phase_b',
      })).toEqual({ kind: 'postprocess', step: 'links', queued: 0 })

      expect(resolveFeishuImportProgressHeader({
        status: 'running',
        items: mixed,
        queuedCount: 0,
        taskPhase: 'phase_d',
      })).toEqual({ kind: 'postprocess', step: 'attachments', queued: 0 })
    })

    it('shows partial success when terminal items contain success and failure', () => {
      expect(resolveFeishuImportProgressHeader({
        status: 'done',
        items: [
          item(batchA, 'app1:tbl1', '表一', 'done'),
          item(batchA, 'app1:tbl2', '表二', 'error'),
        ],
        queuedCount: 0,
        taskPhase: 'done',
      })).toEqual({ kind: 'partial' })
    })
  })
})
