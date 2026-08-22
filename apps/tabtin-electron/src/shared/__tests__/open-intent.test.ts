import { describe, expect, it } from 'vitest'
import {
  isDirectOpenIntentUrl,
  resolveOpenIntent,
  resolvePreviewKindHints,
} from '../open-intent'

describe('resolveOpenIntent', () => {
  it('forceBrowser wins over previewable extension / mime', () => {
    expect(resolveOpenIntent({
      url: 'https://cdn.example.com/a.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      forceBrowser: true,
    })).toEqual({ kind: 'browser' })
  })

  it('mimeType beats filename and url extension', () => {
    expect(resolveOpenIntent({
      url: 'https://cdn.example.com/a.bin',
      filename: 'notes.txt',
      mimeType: 'application/pdf',
    })).toEqual({
      kind: 'preview',
      previewKind: 'pdf',
      confidence: 'mime',
    })
  })

  it('filename beats url extension when mime missing', () => {
    expect(resolveOpenIntent({
      url: 'https://cdn.example.com/object/abc',
      filename: 'report.xlsx',
    })).toEqual({
      kind: 'preview',
      previewKind: 'xlsx',
      confidence: 'filename',
    })
  })

  it('url extension used when mime and filename absent', () => {
    expect(resolveOpenIntent({
      url: 'https://cdn.example.com/sheet.csv?sig=1',
    })).toEqual({
      kind: 'preview',
      previewKind: 'csv',
      confidence: 'url',
    })
  })

  it('maps ordinary https pages to browser', () => {
    expect(resolveOpenIntent({ url: 'https://example.com/' })).toEqual({ kind: 'browser' })
    expect(resolveOpenIntent({ url: 'https://example.com/index.html' })).toEqual({ kind: 'browser' })
  })

  it('maps non-direct schemes to unknown', () => {
    expect(resolveOpenIntent({ url: 'file:///tmp/a.xlsx' })).toEqual({ kind: 'unknown' })
    expect(resolveOpenIntent({ url: 'tabtin://resource/file/a.xlsx' })).toEqual({ kind: 'unknown' })
    expect(resolveOpenIntent({ url: '' })).toEqual({ kind: 'unknown' })
  })

  it('uses data: mime when mimeType omitted', () => {
    expect(resolveOpenIntent({
      url: 'data:image/png;base64,aaa',
    })).toEqual({
      kind: 'preview',
      previewKind: 'image',
      confidence: 'mime',
    })
  })

  it('preserves text/plain + .md path override', () => {
    expect(resolvePreviewKindHints({
      mimeType: 'text/plain',
      filename: 'readme.md',
    })).toEqual({ previewKind: 'md', confidence: 'filename' })
  })

  it('exposes isDirectOpenIntentUrl for scheme checks', () => {
    expect(isDirectOpenIntentUrl('https://x.com/a.xlsx')).toBe(true)
    expect(isDirectOpenIntentUrl('blob:https://x/1')).toBe(true)
    expect(isDirectOpenIntentUrl('file:///tmp/a.xlsx')).toBe(false)
  })

  it('accepts assetId without changing judgment', () => {
    expect(resolveOpenIntent({
      url: 'https://cdn.example.com/a.pdf',
      assetId: 'asset-1',
    }).kind).toBe('preview')
  })
})
