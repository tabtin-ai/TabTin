import { describe, expect, it } from 'vitest'
import { resolveVersionPreviewMode } from './resolveVersionPreviewMode'

describe('resolveVersionPreviewMode（默认 diff，可手动切全文）', () => {
  it('canDiff + 无 override → diff（默认就 diff，不分 editor_type）', () => {
    for (const editorType of ['agent', 'user', 'human', 'system', undefined]) {
      expect(
        resolveVersionPreviewMode({ editorType, canDiff: true, override: null })
      ).toBe('diff')
    }
  })

  it('canDiff=false（首版无 previous）→ full，不报错', () => {
    expect(
      resolveVersionPreviewMode({ editorType: 'agent', canDiff: false, override: null })
    ).toBe('full')
    expect(
      resolveVersionPreviewMode({ editorType: 'user', canDiff: false, override: null })
    ).toBe('full')
  })

  it('override=false → 手动切回全文（即便能 diff）', () => {
    expect(
      resolveVersionPreviewMode({ editorType: 'user', canDiff: true, override: false })
    ).toBe('full')
    expect(
      resolveVersionPreviewMode({ editorType: 'agent', canDiff: true, override: false })
    ).toBe('full')
  })

  it('override=true + canDiff → diff', () => {
    expect(
      resolveVersionPreviewMode({ editorType: 'user', canDiff: true, override: true })
    ).toBe('diff')
  })

  it('canDiff=false 时 override=true 也只能 full（不能 diff 就不 diff）', () => {
    expect(
      resolveVersionPreviewMode({ editorType: 'user', canDiff: false, override: true })
    ).toBe('full')
  })
})
