/**
 * 边界 parser 测试 ── 不只是 happy path。
 *
 * 任何"看着不该出现的输入"都必须有定义良好的退化行为：
 *  - 完全不合法 URI → scheme: 'unknown'
 *  - 自有格式头部对但 path 形态不合法 → scheme: 'tabtin' + type: null + id: raw
 *  - 多值 query → meta 收敛为数组
 *  - hint 重复出现 → 只取第一个
 */

import { describe, expect, it } from 'vitest'

import { parseResourcePointer, serializeSelfFormat } from '../src/parser.js'

describe('parseResourcePointer · self format', () => {
  it('accepts urlencoded chinese in title meta', () => {
    const p = parseResourcePointer(
      'tabtin://resource/document/doc_xyz?hint=tabdoc&title=%E9%A1%B9%E7%9B%AE',
    )
    expect(p.scheme).toBe('tabtin')
    expect(p.type).toBe('document')
    expect(p.hint).toBe('tabdoc')
    expect(p.meta?.title).toBe('项目')
  })

  it('treats hint="" the same as missing hint', () => {
    const p = parseResourcePointer('tabtin://resource/table/tbl_x?hint=')
    expect(p.hint).toBeNull()
  })

  it('treats unknown self-format type as pass-through (manifest cross-ref is registry job)', () => {
    const p = parseResourcePointer('tabtin://resource/some_future_type/id_42')
    expect(p.scheme).toBe('tabtin')
    expect(p.type).toBe('some_future_type')
    expect(p.id).toBe('id_42')
  })

  it.each(['tabtin-preprod', 'tabtin-dev'] as const)(
    'parses %s resource links as TabTin self format while preserving raw',
    (scheme) => {
      const raw = `${scheme}://resource/table/tbl_x?hint=tabdata&recordIds=rec_1`
      const p = parseResourcePointer(raw)
      expect(p.scheme).toBe('tabtin')
      expect(p.type).toBe('table')
      expect(p.id).toBe('tbl_x')
      expect(p.meta?.recordIds).toBe('rec_1')
      expect(p.raw).toBe(raw)
    },
  )

  it('normalises agent typo `type=doc` to canonical `document`', () => {
    const p = parseResourcePointer('tabtin://resource/doc/doc_xyz?hint=tabdoc')
    expect(p.type).toBe('document')
    expect(p.hint).toBe('tabdoc')
    expect(p.id).toBe('doc_xyz')
  })

  it('normalises agent typo `hint=document` to carrier `tabdoc`', () => {
    const p = parseResourcePointer('tabtin://resource/document/doc_xyz?hint=document')
    expect(p.type).toBe('document')
    expect(p.hint).toBe('tabdoc')
  })

  it('normalises both type=doc and hint=document typos in one URI', () => {
    const p = parseResourcePointer('tabtin://resource/doc/doc_xyz?hint=document')
    expect(p.type).toBe('document')
    expect(p.hint).toBe('tabdoc')
  })

  it('normalises hint=doc (app-id shorthand typo) to canonical tabdoc', () => {
    const p = parseResourcePointer('tabtin://resource/doc/doc_xyz?hint=doc')
    expect(p.type).toBe('document')
    expect(p.hint).toBe('tabdoc')
  })

  it('keeps meta multi-value query as array', () => {
    const p = parseResourcePointer('tabtin://resource/table/tbl_x?tag=a&tag=b&tag=c')
    expect(p.meta?.tag).toEqual(['a', 'b', 'c'])
  })

  it('returns degraded shape (type=null) for malformed self-format prefix', () => {
    const p = parseResourcePointer('tabtin://resource/')
    expect(p.scheme).toBe('tabtin')
    expect(p.type).toBeNull()
    expect(p.id).toBe('tabtin://resource/')
  })

  it('returns degraded shape when id segment is missing', () => {
    const p = parseResourcePointer('tabtin://resource/table')
    expect(p.scheme).toBe('tabtin')
    expect(p.type).toBeNull()
    expect(p.id).toBe('tabtin://resource/table')
  })
})

describe('parseResourcePointer · industry formats', () => {
  it('https with full url passes through', () => {
    const p = parseResourcePointer('https://example.com/foo?q=1#bar')
    expect(p.scheme).toBe('https')
    expect(p.type).toBeNull()
    expect(p.id).toBe('https://example.com/foo?q=1#bar')
    expect(p.hint).toBeNull()
  })

  it('file:// preserves urlencoded path', () => {
    const p = parseResourcePointer('file:///Users/x/path%20with%20space/y.md')
    expect(p.scheme).toBe('file')
    expect(p.id).toBe('file:///Users/x/path%20with%20space/y.md')
  })

  it('mailto: with subject preserved as raw', () => {
    const p = parseResourcePointer('mailto:a@b.com?subject=Hello')
    expect(p.scheme).toBe('mailto')
    expect(p.id).toBe('mailto:a@b.com?subject=Hello')
    expect(p.hint).toBeNull()
  })

  it('tel: passes through', () => {
    const p = parseResourcePointer('tel:+1-555-0100')
    expect(p.scheme).toBe('tel')
  })

  it('weixin:// recognised as industry, scheme retained', () => {
    const p = parseResourcePointer('weixin://dl/business/?ticket=t123')
    expect(p.scheme).toBe('weixin')
    expect(p.type).toBeNull()
    expect(p.id).toBe('weixin://dl/business/?ticket=t123')
  })

  it('industry never carries hint (D5)', () => {
    const p = parseResourcePointer('https://example.com?hint=tabweb')
    expect(p.hint).toBeNull()
  })
})

describe('parseResourcePointer · garbage/unknown', () => {
  it('non-uri text returns scheme=unknown', () => {
    const p = parseResourcePointer('this is not a uri')
    expect(p.scheme).toBe('unknown')
    expect(p.type).toBeNull()
    expect(p.id).toBe('this is not a uri')
  })

  it('empty string returns scheme=unknown', () => {
    const p = parseResourcePointer('')
    expect(p.scheme).toBe('unknown')
  })
})

describe('parseResourcePointer · baseDir passthrough', () => {
  it('baseDir is stored on pointer when provided', () => {
    const p = parseResourcePointer('tabtin://resource/file/x', '/Users/foo')
    expect(p.baseDir).toBe('/Users/foo')
  })

  it('baseDir is undefined when not provided', () => {
    const p = parseResourcePointer('tabtin://resource/file/x')
    expect(p.baseDir).toBeUndefined()
  })
})

describe('serializeSelfFormat round-trip', () => {
  it('serializes minimal pointer back', () => {
    const out = serializeSelfFormat({
      type: 'table',
      id: 'tbl_abc',
      hint: null,
    })
    expect(out).toBe('tabtin://resource/table/tbl_abc')
  })

  it('serializes an environment-specific resource scheme', () => {
    const out = serializeSelfFormat(
      { type: 'table', id: 'tbl_abc', hint: 'tabdata' },
      'tabtin-preprod',
    )
    expect(out).toBe('tabtin-preprod://resource/table/tbl_abc?hint=tabdata')
    expect(parseResourcePointer(out).scheme).toBe('tabtin')
  })

  it('serializes pointer with hint and meta', () => {
    const out = serializeSelfFormat({
      type: 'document',
      id: 'doc_xyz',
      hint: 'tabdoc',
      meta: { title: '项目' },
    })
    // urlencoded; both Python urllib.parse.quote_plus 与 URLSearchParams 应一致
    const reparsed = parseResourcePointer(out)
    expect(reparsed.type).toBe('document')
    expect(reparsed.id).toBe('doc_xyz')
    expect(reparsed.hint).toBe('tabdoc')
    expect(reparsed.meta?.title).toBe('项目')
  })

  it('round-trips slash-encoded path', () => {
    const out = serializeSelfFormat({
      type: 'code_file',
      id: '/Users/x/y.md',
      hint: 'tabcode',
    })
    const reparsed = parseResourcePointer(out)
    expect(reparsed.id).toBe('/Users/x/y.md')
  })

  it('throws on missing type', () => {
    expect(() =>
      serializeSelfFormat({ type: null, id: 'x', hint: null }),
    ).toThrow(/type is required/)
  })
})
