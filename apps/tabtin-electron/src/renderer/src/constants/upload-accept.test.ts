import { describe, expect, it } from 'vitest'
import { buildAttachmentPickerAccept } from './upload'

describe('buildAttachmentPickerAccept', () => {
  it('includes image, document, media mimes and zip extension fallback', () => {
    const accept = buildAttachmentPickerAccept()
    expect(accept).toContain('image/png')
    expect(accept).toContain('application/pdf')
    expect(accept).toContain('video/mp4')
    expect(accept).toContain('.zip')
    expect(accept).not.toContain(',*,')
    expect(accept).not.toMatch(/(?:^|,)\*(?:,|$)/)
  })
})
