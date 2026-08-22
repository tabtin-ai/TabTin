import { describe, expect, it } from 'vitest'
import {
  collabProjectionMetadataDropped,
  collabYdocRecordsMissingFromStore,
  hasServerScopedRecordsQuery,
  shouldProjectViewRecordsFromCollabYdoc,
  shouldFetchConfirmedRuntimeViewRecords,
  shouldUseRestRecordsQuery,
} from './collabViewRecordsSync'

describe('collabViewRecordsSync', () => {
  it('hasServerScopedRecordsQuery 识别服务端限定 query 参数', () => {
    expect(hasServerScopedRecordsQuery({ search: 'foo', page: 1, page_size: 50 })).toBe(true)
    expect(hasServerScopedRecordsQuery({ search: '  ', page: 1, page_size: 50 })).toBe(false)
    expect(hasServerScopedRecordsQuery({ date_range: '2026-01-01,2026-01-31', page: 1, page_size: 50 })).toBe(true)
    expect(hasServerScopedRecordsQuery({ per_group_limit: 20, page: 1, page_size: 50 })).toBe(true)
    expect(hasServerScopedRecordsQuery({ group_offsets: { __ungrouped__: 10 }, page: 1, page_size: 50 })).toBe(true)
  })

  it('shouldUseRestRecordsQuery 与投影门禁互补', () => {
    expect(shouldUseRestRecordsQuery(false, false)).toBe(true)
    expect(shouldUseRestRecordsQuery(true, false)).toBe(false)
    expect(shouldUseRestRecordsQuery(true, true)).toBe(true)
  })

  it('shouldProjectViewRecordsFromCollabYdoc 等首次同步完成后才允许 Y.Doc 接管', () => {
    expect(shouldProjectViewRecordsFromCollabYdoc(true, false, true)).toBe(true)
    expect(shouldProjectViewRecordsFromCollabYdoc(true, false, false)).toBe(false)
    expect(shouldProjectViewRecordsFromCollabYdoc(false, false, true)).toBe(false)
    expect(shouldProjectViewRecordsFromCollabYdoc(true, true, true)).toBe(false)
  })

  it('新建协作视图只在 REST 确认后为截断表加载记录', () => {
    expect(shouldFetchConfirmedRuntimeViewRecords({
      isCollabRuntime: true,
      isTruncated: true,
      currentViewId: 'view-new',
      lastLoadedRestViewIds: [],
      isAwaitingRestConfirmation: true,
    })).toBe(false)

    expect(shouldFetchConfirmedRuntimeViewRecords({
      isCollabRuntime: true,
      isTruncated: true,
      currentViewId: 'view-new',
      lastLoadedRestViewIds: ['view-new'],
      isAwaitingRestConfirmation: true,
    })).toBe(true)

    expect(shouldFetchConfirmedRuntimeViewRecords({
      isCollabRuntime: true,
      isTruncated: false,
      currentViewId: 'view-new',
      lastLoadedRestViewIds: ['view-new'],
      isAwaitingRestConfirmation: true,
    })).toBe(false)

    expect(shouldFetchConfirmedRuntimeViewRecords({
      isCollabRuntime: true,
      isTruncated: true,
      currentViewId: 'view-new',
      lastLoadedRestViewIds: ['view-new'],
      isAwaitingRestConfirmation: false,
    })).toBe(false)
  })

  it('collabYdocRecordsMissingFromStore 检测 Y.Doc 有而 store 缺的 record', () => {
    expect(
      collabYdocRecordsMissingFromStore(
        { records: [{ id: 'r1' }, { id: 'r2' }] },
        { records: [{ id: 'r1' }] },
      ),
    ).toBe(true)
    expect(
      collabYdocRecordsMissingFromStore(
        { records: [{ id: 'r1' }] },
        { records: [{ id: 'r1' }] },
      ),
    ).toBe(false)
  })

  it('collabProjectionMetadataDropped 检测 REST 覆盖丢失分组/层级 metadata', () => {
    // 投影有分组树，store 被 REST 覆盖成平铺（无 groups.nodes）→ 需要 re-assert
    expect(
      collabProjectionMetadataDropped(
        { metadata: { groups: { nodes: [{ key: 'a' }] } } },
        { metadata: {} },
      ),
    ).toBe(true)
    // 投影有层级树，store 丢失 sub_records.tree_data → 需要 re-assert
    expect(
      collabProjectionMetadataDropped(
        { metadata: { sub_records: { tree_data: { r1: {} } } } },
        { metadata: { sub_records: null } },
      ),
    ).toBe(true)
    // 两侧都有分组 → 不需要 re-assert
    expect(
      collabProjectionMetadataDropped(
        { metadata: { groups: { nodes: [{ key: 'a' }] } } },
        { metadata: { groups: { nodes: [{ key: 'a' }] } } },
      ),
    ).toBe(false)
    // 投影本就无分组 → 不需要 re-assert（避免误触发）
    expect(collabProjectionMetadataDropped({ metadata: {} }, { metadata: {} })).toBe(false)
  })
})
