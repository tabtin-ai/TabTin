import { clampEditorHeight, getMaxEditorHeight, LONG_TEXT_EDITOR_MIN_HEIGHT } from './editorHeight'

describe('editorHeight', () => {
  it('getMaxEditorHeight uses max(320, 40% viewport)', () => {
    expect(getMaxEditorHeight(0)).toBe(320)
    expect(getMaxEditorHeight(600)).toBe(320)
    expect(getMaxEditorHeight(1000)).toBe(400)
    expect(getMaxEditorHeight(2000)).toBe(800)
  })

  it('clampEditorHeight floors at min and caps at max', () => {
    expect(clampEditorHeight(40, LONG_TEXT_EDITOR_MIN_HEIGHT, 400)).toBe(
      LONG_TEXT_EDITOR_MIN_HEIGHT,
    )
    expect(clampEditorHeight(200, LONG_TEXT_EDITOR_MIN_HEIGHT, 400)).toBe(200)
    expect(clampEditorHeight(2000, LONG_TEXT_EDITOR_MIN_HEIGHT, 400)).toBe(400)
  })
})
