import { describe, expect, it } from 'vitest'
import { classifyCoverImageHint, extractViewCoverUrl } from '../attachmentReferences'

describe('extractViewCoverUrl', () => {
  it('returns plain string urls', () => {
    expect(extractViewCoverUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
    expect(extractViewCoverUrl(['https://cdn.example/b.png'])).toBe('https://cdn.example/b.png')
  })

  it('prefers thumbnail from attachment objects', () => {
    expect(extractViewCoverUrl([{
      url: 'https://cdn.example/full.png',
      thumbnail_url: 'https://cdn.example/thumb.png',
      name: 'a.png',
      file_id: 'f1',
    }])).toBe('https://cdn.example/thumb.png')
  })

  it('falls back to url when no thumbnail', () => {
    expect(extractViewCoverUrl([{
      url: 'https://cdn.example/full.png',
      name: 'a.png',
      file_id: 'f1',
    }])).toBe('https://cdn.example/full.png')
  })

  it('returns null for empty / non-cover values', () => {
    expect(extractViewCoverUrl(null)).toBeNull()
    expect(extractViewCoverUrl('')).toBeNull()
    expect(extractViewCoverUrl([])).toBeNull()
    expect(extractViewCoverUrl([{ name: 'no-url' }])).toBeNull()
  })

  it('skips non-image attachments without thumbnail (avoid broken <img>)', () => {
    expect(extractViewCoverUrl([{
      url: 'https://cdn.example/doc.pdf',
      name: 'doc.pdf',
      file_id: 'f-pdf',
      mime_type: 'application/pdf',
    }])).toBeNull()
  })

  it('uses thumbnail for non-image attachments when available', () => {
    expect(extractViewCoverUrl([{
      url: 'https://cdn.example/doc.pdf',
      thumbnail_url: 'https://cdn.example/doc-thumb.png',
      name: 'doc.pdf',
      file_id: 'f-pdf',
      mime_type: 'application/pdf',
    }])).toBe('https://cdn.example/doc-thumb.png')
  })

  it('skips non-image then picks next image attachment', () => {
    expect(extractViewCoverUrl([
      {
        url: 'https://cdn.example/doc.pdf',
        name: 'doc.pdf',
        file_id: 'f-pdf',
        mime_type: 'application/pdf',
      },
      {
        url: 'https://cdn.example/photo.jpg',
        name: 'photo.jpg',
        file_id: 'f-img',
        mime_type: 'image/jpeg',
      },
    ])).toBe('https://cdn.example/photo.jpg')
  })

  it('uses url for image.jpg even when mime is octet-stream', () => {
    expect(extractViewCoverUrl([{
      url: 'https://cdn.example/image.jpg',
      name: 'image.jpg',
      file_id: 'f-img',
      mime_type: 'application/octet-stream',
    }])).toBe('https://cdn.example/image.jpg')
  })

  it('still skips xlsx with octet-stream and no thumbnail', () => {
    expect(extractViewCoverUrl([{
      url: 'https://cdn.example/sheet.xlsx',
      name: '数字表格.xlsx',
      file_id: 'f-xlsx',
      mime_type: 'application/octet-stream',
    }])).toBeNull()
  })
})

describe('classifyCoverImageHint', () => {
  it('detects image mime and extensions', () => {
    expect(classifyCoverImageHint('image/png', null)).toBe(true)
    expect(classifyCoverImageHint('application/pdf', null)).toBe(false)
    expect(classifyCoverImageHint(null, 'a.webp')).toBe(true)
    expect(classifyCoverImageHint(null, 'notes')).toBeNull()
  })

  it('trusts image filename over octet-stream mime (upload mislabel)', () => {
    expect(classifyCoverImageHint('application/octet-stream', 'image.jpg')).toBe(true)
    expect(classifyCoverImageHint('application/octet-stream', '数字表格.xlsx')).toBe(false)
  })
})
