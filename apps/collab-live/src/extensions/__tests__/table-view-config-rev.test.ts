/**
 * 视图配置回退防护回归测试。
 *
 * 覆盖 collab-live 合并阶段的 config_rev 单调守卫：客户端未持久化的更高版本视图
 * 配置，不被 Django 旧快照（config_rev 更低）在 CRDT 合并中覆盖回退。
 */
import { describe, it, expect } from 'vitest'
import {
  viewConfigRev,
  selectViewsToRestoreByConfigRev,
} from '../table-database.js'

describe('viewConfigRev', () => {
  it('读取合法 config_rev', () => {
    expect(viewConfigRev({ config_rev: 5 })).toBe(5)
  })

  it('缺失 / 非法值按 0 处理', () => {
    expect(viewConfigRev({})).toBe(0)
    expect(viewConfigRev(null)).toBe(0)
    expect(viewConfigRev({ config_rev: 'x' })).toBe(0)
    expect(viewConfigRev({ config_rev: Number.NaN })).toBe(0)
  })
})

describe('selectViewsToRestoreByConfigRev', () => {
  it('客户端版本高于旧快照且高于合并结果时恢复客户端视图', () => {
    const preFetch = new Map<string, unknown>([
      ['v1', { id: 'v1', config_rev: 7, groups: [{ field_id: 'f1' }] }],
    ])
    const snapshotRev = new Map<string, number>([['v1', 3]])
    // 合并结果被旧快照拉回到 rev=3（LWW 让旧快照赢）
    const mergedRev = new Map<string, number>([['v1', 3]])

    const restores = selectViewsToRestoreByConfigRev(preFetch, snapshotRev, mergedRev)
    expect(restores).toHaveLength(1)
    expect(restores[0].id).toBe('v1')
    expect((restores[0].view as { config_rev: number }).config_rev).toBe(7)
  })

  it('合并结果已是最新版本时不恢复（避免回退他端并发写入）', () => {
    const preFetch = new Map<string, unknown>([['v1', { id: 'v1', config_rev: 7 }]])
    const snapshotRev = new Map<string, number>([['v1', 3]])
    // 另一端把 rev 推到了 8，合并结果已领先，客户端 7 不应覆盖
    const mergedRev = new Map<string, number>([['v1', 8]])

    expect(selectViewsToRestoreByConfigRev(preFetch, snapshotRev, mergedRev)).toHaveLength(0)
  })

  it('快照版本不低于客户端时不恢复（快照已是最新）', () => {
    const preFetch = new Map<string, unknown>([['v1', { id: 'v1', config_rev: 3 }]])
    const snapshotRev = new Map<string, number>([['v1', 3]])
    const mergedRev = new Map<string, number>([['v1', 3]])

    expect(selectViewsToRestoreByConfigRev(preFetch, snapshotRev, mergedRev)).toHaveLength(0)
  })

  it('首次加载 preFetch 为空时无任何恢复', () => {
    const restores = selectViewsToRestoreByConfigRev(
      new Map(),
      new Map([['v1', 5]]),
      new Map([['v1', 5]]),
    )
    expect(restores).toHaveLength(0)
  })

  it('快照缺该视图（rev 缺省 0）时，客户端任意正版本都恢复', () => {
    const preFetch = new Map<string, unknown>([['vNew', { id: 'vNew', config_rev: 1 }]])
    const restores = selectViewsToRestoreByConfigRev(preFetch, new Map(), new Map())
    expect(restores).toHaveLength(1)
    expect(restores[0].id).toBe('vNew')
  })
})
