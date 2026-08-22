import { describe, expect, it } from 'vitest'
import { buildRichResourcePointer } from '../buildRichResourcePointer'

describe('buildRichResourcePointer', () => {
  it('normalises agent resource_type=doc to canonical document ', () => {
    const pointer = buildRichResourcePointer('doc', 'doc_xyz')
    expect(pointer.scheme).toBe('tabtin')
    expect(pointer.type).toBe('document')
    expect(pointer.id).toBe('doc_xyz')
    expect(pointer.raw).toContain('tabtin://resource/doc/doc_xyz')
  })

  it('keeps canonical document type unchanged', () => {
    const pointer = buildRichResourcePointer('document', 'doc_abc')
    expect(pointer.type).toBe('document')
    expect(pointer.id).toBe('doc_abc')
  })

  it('normalises hint=document / hint=doc to tabdoc carrier id', () => {
    expect(buildRichResourcePointer('document', 'd1', 'document').hint).toBe('tabdoc')
    expect(buildRichResourcePointer('doc', 'd1', 'doc').hint).toBe('tabdoc')
  })

  it('preserves an already-canonical hint_carrier_app_id', () => {
    const pointer = buildRichResourcePointer('doc', 'd1', 'tabdoc')
    expect(pointer.type).toBe('document')
    expect(pointer.hint).toBe('tabdoc')
  })

  it('leaves table / slide types untouched', () => {
    expect(buildRichResourcePointer('table', 't1').type).toBe('table')
    expect(buildRichResourcePointer('slide', 's1').type).toBe('slide')
  })
})
