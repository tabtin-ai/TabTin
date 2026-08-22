import { describe, it, expect } from 'vitest'
import { buildCanvasMenuLabels } from '../canvasMenuLabels'

describe('buildCanvasMenuLabels', () => {
  const mockTranslate = (key: string) => `[${key}]`

  it('returns all fieldMenuLabels keys as strings', () => {
    const { fieldMenuLabels } = buildCanvasMenuLabels(mockTranslate)
    const expectedKeys = [
      'editField', 'duplicateField', 'insertFieldLeft', 'insertFieldRight',
      'sortField', 'filterField', 'groupField', 'freezeField',
      'setPrimaryField', 'primaryField',
      'hideField', 'hideAllSelectedFields', 'deleteField', 'deleteAllSelectedFields',
    ]
    for (const key of expectedKeys) {
      expect(fieldMenuLabels).toHaveProperty(key)
      expect(typeof (fieldMenuLabels as Record<string, string>)[key]).toBe('string')
    }
  })

  it('returns all recordMenuLabels keys as strings', () => {
    const { recordMenuLabels } = buildCanvasMenuLabels(mockTranslate)
    const expectedKeys = [
      'insertAbove', 'insertBelow', 'rowUnit', 'addSubRecord',
      'duplicate', 'copyLink', 'comment', 'viewHistory', 'sendToChat', 'sendMultipleToChat',
      'delete', 'deleteMultiple',
    ]
    for (const key of expectedKeys) {
      expect(recordMenuLabels).toHaveProperty(key)
      expect(typeof (recordMenuLabels as Record<string, string>)[key]).toBe('string')
    }
  })

  it('returns the all records checkbox tooltip label', () => {
    const labels = buildCanvasMenuLabels(mockTranslate)

    expect(labels.allRecordsCheckboxTooltip).toBe('[grid.allRecordsCheckboxTooltip]')
  })

  it('passes correct i18n keys to translate function', () => {
    const calls: string[] = []
    const spy = (key: string) => { calls.push(key); return key }
    buildCanvasMenuLabels(spy)
    expect(calls).toContain('menu.editField')
    expect(calls).toContain('menu.deleteRecord')
    expect(calls).toContain('menu.comment')
    expect(calls).toContain('menu.sendToChat')
    expect(calls).toContain('menu.sendMultipleToChat')
    expect(calls).toContain('record.history.open')
    expect(calls).toContain('grid.allRecordsCheckboxTooltip')
  })
})
