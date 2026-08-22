/**
 * AppDeepLink — `tabtin://resource/<type>/<id>?<query>` deep link 解析单测。
 *
 * W3 改造（专题"Agent 产物在 Space 内的打开" RFC §10.3）：
 *   生成端（TrackerRunStatusIndicator / TrackerRunBreadcrumb）写出
 *   `tabtin://resource/<type>/<id>?hint=<app>&...`，AppDeepLink 解析端必须
 *   能完整还原 ResourcePointer，再交给 ResourceRouter 派发。
 *
 * 本测试守护"链接形态契约稳定 + 非法 path silent noop"。
 */

import { describe, it, expect, vi } from 'vitest'

// AppDeepLink 透传 notificationNavigation 的 ensureOrganization / ensureSpace helper，
// 在 vitest 里会顺带拉起 chatApi → ws-gateway-client 等只在 main 进程可用的模块；
// 测试只覆盖纯函数 `_parseResourceDeepLink`，所以把整条 navigation 链路 mock 空。
vi.mock('@services/notificationNavigation', () => ({
  ensureOrganizationSelected: vi.fn(async () => 'ready' as const),
  ensureNotificationSpaceSelected: vi.fn(async () => true),
}))

vi.mock('@/services/resourceRouter', () => ({
  resourceRouter: { open: vi.fn(async () => ({ outcome: 'in_space_opened' })) },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ selectedSpace: null }),
  },
}))

import { _parseResourceDeepLink } from './AppDeepLink'

describe('_parseResourceDeepLink (W3 / RFC §10.3)', () => {
  it('解析 resource/<type>/<id> 命中 ResourcePointer', () => {
    const url = 'tabtin://resource/memo/mem_xyz?hint=tabmemo&run=r1&tracker=t1'
    const out = _parseResourceDeepLink('resource/memo/mem_xyz', url)
    expect(out).toBeDefined()
    expect(out!.scheme).toBe('tabtin')
    expect(out!.type).toBe('memo')
    expect(out!.id).toBe('mem_xyz')
    expect(out!.hint).toBe('tabmemo')
    expect(out!.meta).toMatchObject({ run: 'r1', tracker: 't1' })
  })

  it('artifact_ref 字段（memoId/docId/...）作为 meta 透传', () => {
    const url = 'tabtin://resource/memo/mem_xyz?hint=tabmemo&memoId=mem_xyz&run=r1'
    const out = _parseResourceDeepLink('resource/memo/mem_xyz', url)
    expect(out).toBeDefined()
    expect(out!.meta?.memoId).toBe('mem_xyz')
    expect(out!.meta?.run).toBe('r1')
  })

  it('codePath 内 / 也能 urldecode 还原', () => {
    const path = '/Users/developer/sandbox/log.json'
    const encoded = encodeURIComponent(path)
    const url = `tabtin://resource/code_file/${encoded}?hint=tabcode`
    const out = _parseResourceDeepLink(`resource/code_file/${encoded}`, url)
    expect(out).toBeDefined()
    expect(out!.id).toBe(path)
    expect(out!.hint).toBe('tabcode')
  })

  it('record_ids 多值 query → meta 数组', () => {
    const url = 'tabtin://resource/table/tbl_abc?hint=tabdata&recordIds=r1&recordIds=r2'
    const out = _parseResourceDeepLink('resource/table/tbl_abc', url)
    expect(out).toBeDefined()
    expect(out!.meta?.recordIds).toEqual(['r1', 'r2'])
  })

  it('非 resource/ 起始 path → undefined（silent noop）', () => {
    expect(_parseResourceDeepLink('invite/abc-token-1234567890123456', 'tabtin://invite/abc-token-1234567890123456')).toBeUndefined()
    expect(_parseResourceDeepLink('random-path', 'tabtin://random-path')).toBeUndefined()
    expect(_parseResourceDeepLink('', '')).toBeUndefined()
  })

  it('resource/ 起始但缺 type 或 id → undefined', () => {
    expect(_parseResourceDeepLink('resource/', 'tabtin://resource/')).toBeUndefined()
    expect(_parseResourceDeepLink('resource/memo', 'tabtin://resource/memo')).toBeUndefined()
  })

  it('保留无 hint 的 path（D5 自有格式 hint 可选）', () => {
    const url = 'tabtin://resource/document/doc_xyz'
    const out = _parseResourceDeepLink('resource/document/doc_xyz', url)
    expect(out).toBeDefined()
    expect(out!.type).toBe('document')
    expect(out!.id).toBe('doc_xyz')
    expect(out!.hint).toBeNull()
  })

  it.each(['tabtin-preprod', 'tabtin-dev'])(
    'parses %s environment-specific resource links',
    (scheme) => {
      const url = `${scheme}://resource/table/tbl_env?hint=tabdata&recordIds=rec_1`
      const out = _parseResourceDeepLink('resource/table/tbl_env', url)
      expect(out).toBeDefined()
      expect(out!.scheme).toBe('tabtin')
      expect(out!.id).toBe('tbl_env')
      expect(out!.meta?.recordIds).toBe('rec_1')
    },
  )
})
