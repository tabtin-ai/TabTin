import { describe, expect, it } from 'vitest'
import {
  clearCreateLifecycle,
  markCreateDeleting,
  markCreatePending,
  markCreatePersisted,
  partitionDeleteRecordIds,
  promoteStalePendingCreates,
  resolveRestSafeRecordId,
  type CollabCreateLifecycleEntry,
} from '../collabRecordLifecycle'

describe('collabRecordLifecycle', () => {
  it('协作新建尚未确认时，删除应折叠为取消且不进入权威 REST 集合', () => {
    const lifecycle = new Map<string, CollabCreateLifecycleEntry>()
    markCreatePending(lifecycle, 'pending-1', 1_000)
    markCreatePending(lifecycle, 'pending-2', 1_000)
    markCreatePersisted(lifecycle, 'done-1')

    const partitioned = partitionDeleteRecordIds(
      ['pending-1', 'done-1', 'pending-2', 'other'],
      (id) => lifecycle.get(id)?.state,
    )

    expect(partitioned.pendingCancelIds).toEqual(['pending-1', 'pending-2'])
    expect(partitioned.authoritativeDeleteIds).toEqual(['done-1', 'other'])
  })

  it('确认落库后删除应走权威 REST，且不再折叠', () => {
    const lifecycle = new Map<string, CollabCreateLifecycleEntry>()
    markCreatePending(lifecycle, 'r1', 1_000)
    markCreatePersisted(lifecycle, 'r1')

    const partitioned = partitionDeleteRecordIds(
      ['r1'],
      (id) => lifecycle.get(id)?.state,
    )

    expect(partitioned.pendingCancelIds).toEqual([])
    expect(partitioned.authoritativeDeleteIds).toEqual(['r1'])
  })

  it('deleting 态不再被当成 pending 折叠目标', () => {
    const lifecycle = new Map<string, CollabCreateLifecycleEntry>()
    markCreatePending(lifecycle, 'r1', 1_000)
    markCreateDeleting(lifecycle, 'r1')

    const partitioned = partitionDeleteRecordIds(
      ['r1'],
      (id) => lifecycle.get(id)?.state,
    )

    expect(partitioned.pendingCancelIds).toEqual([])
    expect(partitioned.authoritativeDeleteIds).toEqual(['r1'])
  })

  it('超时未收到 persist 回写时应晋升为 persisted，避免长期误折叠', () => {
    const lifecycle = new Map<string, CollabCreateLifecycleEntry>()
    markCreatePending(lifecycle, 'stale', 1_000)
    // fresh 需严格落在窗口内：now - createdAt < staleAfterMs
    markCreatePending(lifecycle, 'fresh', 5_001)

    const promoted = promoteStalePendingCreates(lifecycle, 5_000 + 8_000, 8_000)

    expect(promoted).toEqual(['stale'])
    expect(lifecycle.get('stale')?.state).toBe('persisted')
    expect(lifecycle.get('fresh')?.state).toBe('pending')
  })

  it('清除生命周期后按普通记录删除', () => {
    const lifecycle = new Map<string, CollabCreateLifecycleEntry>()
    markCreatePending(lifecycle, 'r1', 1_000)
    clearCreateLifecycle(lifecycle, 'r1')

    const partitioned = partitionDeleteRecordIds(
      ['r1'],
      (id) => lifecycle.get(id)?.state,
    )

    expect(partitioned.pendingCancelIds).toEqual([])
    expect(partitioned.authoritativeDeleteIds).toEqual(['r1'])
  })

  it('resolveRestSafeRecordId：草稿与 pending/deleting 协作新建不暴露给 REST', () => {
    const lifecycle = new Map<string, CollabCreateLifecycleEntry>()
    markCreatePending(lifecycle, 'pending-1', 1_000)
    markCreatePending(lifecycle, 'deleting-1', 1_000)
    markCreateDeleting(lifecycle, 'deleting-1')
    markCreatePersisted(lifecycle, 'done-1')

    const getState = (id: string) => lifecycle.get(id)?.state

    expect(
      resolveRestSafeRecordId(
        { __recordId: '__draft_row__', __rowType: 'draft' },
        getState,
      ),
    ).toBeUndefined()
    expect(
      resolveRestSafeRecordId({ __recordId: 'pending-1' }, getState),
    ).toBeUndefined()
    expect(
      resolveRestSafeRecordId({ __recordId: 'deleting-1' }, getState),
    ).toBeUndefined()
    expect(
      resolveRestSafeRecordId({ __recordId: 'done-1' }, getState),
    ).toBe('done-1')
    expect(
      resolveRestSafeRecordId({ __recordId: 'untracked' }, getState),
    ).toBe('untracked')
  })
})
