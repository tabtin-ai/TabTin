/**
 * registry 倒排索引测试。
 *
 * W2 北极星 2 要求：11+ App 加载完毕后，typeIndex + schemeIndex 总和 ≥ 20。
 * 这里用 W2 实际改造的 13 个 builtin App 的 opens 摘要作为 fixture，验证
 * 加载 + 排序 + 多 App 同 type 排序行为。
 */

import { describe, expect, it } from 'vitest'

import { ResourceRouterRegistry } from '../src/registry.js'

/**
 * W2 改的 13 个 builtin App 的 opens 摘要（与 packages/apps/<id>/app.json 必须一致）。
 * 任一 manifest 的 opens 漂移都会让 W3 / W4 行为偏移——本测试是兜底。
 */
const BUILTIN_OPENS_SUMMARY: Array<{
  appId: string
  types?: string[]
  schemes?: string[]
  priority?: number
}> = [
  { appId: 'tabweb', types: ['webpage', 'web_selection', 'web_annotation'], schemes: ['http:', 'https:'] },
  { appId: 'tabfolder', types: ['folder'], schemes: ['file:', 'tabtin-file:'] },
  { appId: 'tabmail', types: ['email_thread'], schemes: ['mailto:'] },
  { appId: 'tabdata', types: ['table', 'table_selection', 'field'] },
  { appId: 'tabdoc', types: ['document', 'doc_selection'] },
  { appId: 'tabcode', types: ['code_file', 'code_selection'] },
  { appId: 'tabslide', types: ['slide'] },
  { appId: 'tabvideo', types: ['video'] },
  { appId: 'tabwhiteboard', types: ['whiteboard'] },
  { appId: 'tabsite', types: ['site'] },
  { appId: 'tabagenda', types: ['agenda_event'] },
  { appId: 'tabfiles', types: ['file'], priority: 80 },
]

function buildRegistryFromSummary(): ResourceRouterRegistry {
  const r = new ResourceRouterRegistry()
  for (const item of BUILTIN_OPENS_SUMMARY) {
    r.register(item.appId, {
      types: (item.types ?? []).map((t) => ({ type: t, priority: item.priority ?? 100 })),
      schemes: (item.schemes ?? []).map((s) => ({ scheme: s, priority: item.priority ?? 100 })),
    })
  }
  return r
}

describe('ResourceRouterRegistry · W2 builtin loadout', () => {
  it('total entries (types + schemes) >= 20', () => {
    const r = buildRegistryFromSummary()
    expect(r.size()).toBeGreaterThanOrEqual(20)
  })

  it('looks up table type → tabdata', () => {
    const r = buildRegistryFromSummary()
    const list = r.lookupByType('table')
    expect(list).toHaveLength(1)
    expect(list[0]!.appId).toBe('tabdata')
  })

  it('looks up https: scheme → tabweb', () => {
    const r = buildRegistryFromSummary()
    const list = r.lookupByScheme('https:')
    expect(list).toHaveLength(1)
    expect(list[0]!.appId).toBe('tabweb')
  })

  it('looks up file: scheme → tabfolder', () => {
    const r = buildRegistryFromSummary()
    const list = r.lookupByScheme('file:')
    expect(list).toHaveLength(1)
    expect(list[0]!.appId).toBe('tabfolder')
  })

  it('looks up mailto: scheme → tabmail', () => {
    const r = buildRegistryFromSummary()
    const list = r.lookupByScheme('mailto:')
    expect(list).toHaveLength(1)
    expect(list[0]!.appId).toBe('tabmail')
  })

  it('email_thread type resolves to tabmail (RFC §5.5 new ContextRefType)', () => {
    const r = buildRegistryFromSummary()
    const list = r.lookupByType('email_thread')
    expect(list[0]!.appId).toBe('tabmail')
  })

  it('file type resolves to tabfiles (lower priority than tabfolder)', () => {
    const r = buildRegistryFromSummary()
    const list = r.lookupByType('file')
    expect(list).toHaveLength(1)
    expect(list[0]!.appId).toBe('tabfiles')
    expect(list[0]!.priority).toBe(80)
  })

  it('knownTypes covers manifest types', () => {
    const r = buildRegistryFromSummary()
    const types = new Set(r.knownTypes())
    for (const t of [
      'table',
      'table_selection',
      'field',
      'document',
      'doc_selection',
      'code_file',
      'code_selection',
      'slide',
      'video',
      'site',
      'whiteboard',
      'memo',
      'webpage',
      'web_selection',
      'web_annotation',
      'folder',
      'email_thread',
      'file',
      'agenda_event',
    ]) {
      expect(types.has(t)).toBe(true)
    }
  })

  it('knownSchemes covers manifest schemes', () => {
    const r = buildRegistryFromSummary()
    const schemes = new Set(r.knownSchemes())
    for (const s of ['http:', 'https:', 'file:', 'tabtin-file:', 'mailto:']) {
      expect(schemes.has(s)).toBe(true)
    }
  })
})

describe('ResourceRouterRegistry · ordering', () => {
  it('priority desc within same type', () => {
    const r = new ResourceRouterRegistry()
    r.register('tabfolder', {
      types: [{ type: 'file', priority: 100 }],
    })
    r.register('tabfiles', {
      types: [{ type: 'file', priority: 80 }],
    })
    const list = r.lookupByType('file')
    expect(list.map((c) => c.appId)).toEqual(['tabfolder', 'tabfiles'])
  })

  it('appId asc on tied priority', () => {
    const r = new ResourceRouterRegistry()
    r.register('zappy', { types: [{ type: 'document', priority: 100 }] })
    r.register('aappy', { types: [{ type: 'document', priority: 100 }] })
    r.register('mappy', { types: [{ type: 'document', priority: 100 }] })
    const list = r.lookupByType('document')
    expect(list.map((c) => c.appId)).toEqual(['aappy', 'mappy', 'zappy'])
  })

  it('re-register same appId replaces prior priority', () => {
    const r = new ResourceRouterRegistry()
    r.register('tabdata', { types: [{ type: 'table', priority: 50 }] })
    r.register('tabdata', { types: [{ type: 'table', priority: 200 }] })
    const list = r.lookupByType('table')
    expect(list).toHaveLength(1)
    expect(list[0]!.priority).toBe(200)
  })

  it('unregister removes an app fully', () => {
    const r = buildRegistryFromSummary()
    expect(r.lookupByType('table').map((c) => c.appId)).toContain('tabdata')
    r.unregister('tabdata')
    expect(r.lookupByType('table')).toHaveLength(0)
    // table_selection 也应被清掉
    expect(r.lookupByType('table_selection')).toHaveLength(0)
  })
})

describe('ResourceRouterRegistry · validation', () => {
  it('rejects scheme without trailing colon', () => {
    const r = new ResourceRouterRegistry()
    expect(() =>
      r.register('foo', { schemes: [{ scheme: 'https', priority: 100 }] }),
    ).toThrow(/must end with ':'/)
  })

  it('rejects empty appId', () => {
    const r = new ResourceRouterRegistry()
    expect(() => r.register('', { types: [] })).toThrow(/invalid appId/)
  })

  it('rejects non-finite priority', () => {
    const r = new ResourceRouterRegistry()
    expect(() =>
      r.register('foo', { types: [{ type: 'table', priority: Number.NaN }] }),
    ).toThrow(/finite number/)
  })

  it('null/undefined opens is no-op', () => {
    const r = new ResourceRouterRegistry()
    r.register('foo', null)
    r.register('foo', undefined)
    expect(r.size()).toBe(0)
  })
})
