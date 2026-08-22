import { describe, expect, it } from 'vitest'
import {
  isAttachmentFieldType,
  isViewCoverFieldType,
} from '../attachmentFieldTypes'

describe('isViewCoverFieldType', () => {
  it('allows attachment only', () => {
    expect(isViewCoverFieldType('attachment')).toBe(true)
    expect(isViewCoverFieldType('ATTACHMENT')).toBe(true)
  })

  it('rejects non file-based field types including url and text', () => {
    for (const type of [
      'url',
      'text',
      'select',
      'multi_select',
      'checkbox',
      'number',
      'date',
      'file',
    ]) {
      expect(isViewCoverFieldType(type)).toBe(false)
    }
  })

  it('stays aligned with isAttachmentFieldType', () => {
    for (const type of ['attachment', 'media', 'url', 'text', null, undefined, 1]) {
      expect(isViewCoverFieldType(type)).toBe(isAttachmentFieldType(type))
    }
  })
})
