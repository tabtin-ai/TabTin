/**
 * adaptIndustryParams — 行业格式 type 适配（W3 review P0 修复）
 *
 * Router 行业分支 derivePointerOpenParams 传 type=pointer.scheme（如 'https' /
 * 'file' / 'mailto'），但 ContextRegistry 注册的 handler 用 ContextItemType
 * （'tabweb' / 'tabfolder' / 'tabmail'）—— 两者不直接对齐会导致 tab 渲染失败。
 *
 * 本测试守护"https → tabweb / file → tabfolder / mailto → tabmail"等行业
 * 格式落点正确（RFC §1.4 行业格式 → ContextItemType 反查链路）。
 */

import { describe, it, expect } from 'vitest'
import { adaptIndustryParams } from '../resourceRouter'

describe('adaptIndustryParams (W3 / RFC §1.4 行业格式 type 适配)', () => {
  // ── 自有格式：backend type 必须归一化成 frontend handler type ──
  //
  // 回归：早期实现对自有格式「不动 type」，理由是 tab 渲染时 getHandler 自己
  // 会 backendTypeMap 反查。但 tab 渲染容忍 backend type ≠ 整条链路都容忍——
  // WorkbenchRestoreCoordinator 的资源存在性校验按 frontend type 索引
  // （membership.byType 的 key 是 'tabdoc' / 'tabmemo'），若 context tab 用
  // backend type 建 tabKey（'document:id'），校验时查不到 key → 存在的资源被
  // 误判 stale 自清，表现为「点击产物第一次打不开、active 跳回 home tab」。
  // 所以这里必须用 handler.type 归一化。
  it('自有格式 type=document（backend）→ 归一化成 frontend type tabdoc', () => {
    const out = adaptIndustryParams(
      { type: 'document', id: 'doc_xyz' },
      {
        resolveHandlerByType: (t) => (t === 'document' ? { type: 'tabdoc', appId: 'tabdoc' } : undefined),
        lookupCarriersByScheme: () => [],
        resolveHandlerByAppId: () => undefined,
      },
    )
    expect(out.type).toBe('tabdoc')
    expect(out.id).toBe('doc_xyz')
  })

  it('自有格式 type=memo（backend）→ 归一化成 frontend type tabmemo', () => {
    const out = adaptIndustryParams(
      { type: 'memo', id: 'mem_xyz' },
      {
        resolveHandlerByType: (t) => (t === 'memo' ? { type: 'tabmemo', appId: 'tabmemo' } : undefined),
        lookupCarriersByScheme: () => [],
        resolveHandlerByAppId: () => undefined,
      },
    )
    expect(out.type).toBe('tabmemo')
    expect(out.id).toBe('mem_xyz')
  })

  it('自有格式 type 已是 frontend（tabmemo）→ 命中 handler 且 type 相同 → 不变', () => {
    const out = adaptIndustryParams(
      { type: 'tabmemo', id: 'mem_xyz' },
      {
        resolveHandlerByType: (t) => (t === 'tabmemo' ? { type: 'tabmemo', appId: 'tabmemo' } : undefined),
        lookupCarriersByScheme: () => [],
        resolveHandlerByAppId: () => undefined,
      },
    )
    expect(out.type).toBe('tabmemo')
    expect(out.id).toBe('mem_xyz')
  })

  it('自有格式 type=tracker（backend）→ 归一化成 frontend type tabtracker', () => {
    const out = adaptIndustryParams(
      { type: 'tracker', id: 'trk_xyz' },
      {
        resolveHandlerByType: (t) => (t === 'tracker' ? { type: 'tabtracker', appId: 'tabtracker' } : undefined),
        lookupCarriersByScheme: () => [],
        resolveHandlerByAppId: () => undefined,
      },
    )
    expect(out.type).toBe('tabtracker')
    expect(out.id).toBe('trk_xyz')
  })

  // ── 行业格式：scheme 反查 carrier → handler.type 升级 ──
  it('https → resolveHandlerByType 找不到 → schemes 反查 tabweb → type=tabweb', () => {
    const out = adaptIndustryParams(
      { type: 'https', id: 'https://example.com', meta: { url: 'https://example.com' } },
      {
        resolveHandlerByType: (t) => (t === 'https' ? undefined : { type: t, appId: 'x' }),
        lookupCarriersByScheme: (scheme) => (scheme === 'https:' ? [{ appId: 'tabweb' }] : []),
        resolveHandlerByAppId: (appId) => (appId === 'tabweb' ? { type: 'tabweb' } : undefined),
      },
    )
    expect(out.type).toBe('tabweb')
    expect(out.id).toBe('https://example.com')
    expect(out.meta?.['url']).toBe('https://example.com')
  })

  it('file → schemes 反查 tabfolder → type=tabfolder', () => {
    const out = adaptIndustryParams(
      { type: 'file', id: 'file:///tmp/x.json' },
      {
        resolveHandlerByType: (t) => (t === 'file' ? undefined : { type: t, appId: 'x' }),
        lookupCarriersByScheme: (scheme) => (scheme === 'file:' ? [{ appId: 'tabfolder' }] : []),
        resolveHandlerByAppId: (appId) => (appId === 'tabfolder' ? { type: 'tabfolder' } : undefined),
      },
    )
    expect(out.type).toBe('tabfolder')
  })

  it('mailto → schemes 反查 tabmail → type=tabmail', () => {
    const out = adaptIndustryParams(
      { type: 'mailto', id: 'mailto:foo@bar.com' },
      {
        resolveHandlerByType: () => undefined,
        lookupCarriersByScheme: (scheme) => (scheme === 'mailto:' ? [{ appId: 'tabmail' }] : []),
        resolveHandlerByAppId: (appId) => (appId === 'tabmail' ? { type: 'tabmail' } : undefined),
      },
    )
    expect(out.type).toBe('tabmail')
  })

  // ── 兜底：找不到 carrier → 不动 type（让下游 tab 渲染走 fallback / 抛错）──
  it('没声明 schemes 的协议（如 weixin）→ 不动 params', () => {
    const out = adaptIndustryParams(
      { type: 'weixin', id: 'weixin://wxpay/...' },
      {
        resolveHandlerByType: () => undefined,
        lookupCarriersByScheme: () => [], // 没 carrier
        resolveHandlerByAppId: () => undefined,
      },
    )
    expect(out.type).toBe('weixin') // 维持原样
  })

  it('schemes 反查到 carrier 但 handler 缺失 → 不动 params', () => {
    const out = adaptIndustryParams(
      { type: 'tel', id: 'tel:13800138000' },
      {
        resolveHandlerByType: () => undefined,
        lookupCarriersByScheme: () => [{ appId: 'ghost-app' }], // manifest 写了但 handler 没注册
        resolveHandlerByAppId: () => undefined,
      },
    )
    expect(out.type).toBe('tel')
  })

  // ── scheme 字符串归一化：带冒号 / 不带冒号都能查到 ──
  it('type 不带冒号也能反查（router derivePointerOpenParams 默认不带）', () => {
    const out = adaptIndustryParams(
      { type: 'https', id: 'https://x' },
      {
        resolveHandlerByType: () => undefined,
        lookupCarriersByScheme: (scheme) => (scheme === 'https:' ? [{ appId: 'tabweb' }] : []),
        resolveHandlerByAppId: () => ({ type: 'tabweb' }),
      },
    )
    expect(out.type).toBe('tabweb')
  })

  it('type 带冒号（极端情况）也能反查', () => {
    const out = adaptIndustryParams(
      { type: 'https:', id: 'https://x' },
      {
        resolveHandlerByType: () => undefined,
        lookupCarriersByScheme: (scheme) => (scheme === 'https:' ? [{ appId: 'tabweb' }] : []),
        resolveHandlerByAppId: () => ({ type: 'tabweb' }),
      },
    )
    expect(out.type).toBe('tabweb')
  })

  // ── meta / title 字段透传不丢 ──
  it('meta / title 在 type 改写后仍透传', () => {
    const out = adaptIndustryParams(
      {
        type: 'https',
        id: 'https://example.com',
        title: '示例',
        meta: { url: 'https://example.com', preview: 'demo' },
      },
      {
        resolveHandlerByType: () => undefined,
        lookupCarriersByScheme: () => [{ appId: 'tabweb' }],
        resolveHandlerByAppId: () => ({ type: 'tabweb' }),
      },
    )
    expect(out.type).toBe('tabweb')
    expect(out.title).toBe('示例')
    expect(out.meta?.['url']).toBe('https://example.com')
    expect(out.meta?.['preview']).toBe('demo')
  })
})
