import { describe, expect, it } from 'vitest'
import { guardLoadURL, shouldAllowLoadURL } from '../guard-load-url'

describe('guardLoadURL', () => {
  it('blocks xlsx URL as preview', () => {
    const decision = guardLoadURL({
      url: 'https://cdn.example.com/report.xlsx',
      source: 'test',
    })
    expect(decision).toEqual({
      action: 'block-preview',
      intent: {
        kind: 'preview',
        previewKind: 'xlsx',
        confidence: 'url',
      },
    })
    expect(shouldAllowLoadURL({ url: 'https://cdn.example.com/report.xlsx' })).toBe(false)
  })

  it('blocks pdf URL as preview', () => {
    expect(guardLoadURL({ url: 'https://cdn.example.com/doc.pdf' })).toMatchObject({
      action: 'block-preview',
      intent: { kind: 'preview', previewKind: 'pdf' },
    })
  })

  it('blocks extensionless URL when filename and mimeType identify xlsx', () => {
    expect(guardLoadURL({
      url: 'https://oss.example.com/signed/object?token=abc',
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })).toMatchObject({
      action: 'block-preview',
      intent: { kind: 'preview', previewKind: 'xlsx' },
    })
  })

  it('blocks extensionless URL when filename identifies pdf', () => {
    expect(guardLoadURL({
      url: 'https://oss.example.com/signed/object?token=abc',
      filename: 'report.pdf',
    })).toMatchObject({
      action: 'block-preview',
      intent: { kind: 'preview', previewKind: 'pdf' },
    })
  })

  it('allows extensionless URL without metadata', () => {
    expect(guardLoadURL({
      url: 'https://oss.example.com/signed/object?token=abc',
    })).toEqual({ action: 'allow' })
  })

  it('allows html pages', () => {
    expect(guardLoadURL({ url: 'https://example.com/index.html' })).toEqual({
      action: 'allow',
    })
    expect(guardLoadURL({ url: 'https://example.com/' })).toEqual({
      action: 'allow',
    })
  })

  it('allows unknown schemes (file / tabtin)', () => {
    expect(guardLoadURL({ url: 'file:///tmp/a.xlsx' })).toEqual({ action: 'allow' })
    expect(guardLoadURL({ url: 'tabtin://resource/file/a.xlsx' })).toEqual({
      action: 'allow',
    })
  })

  it('forceBrowser=true allows xlsx through BrowserView', () => {
    expect(guardLoadURL({
      url: 'https://cdn.example.com/report.xlsx',
      forceBrowser: true,
    })).toEqual({ action: 'allow' })
    expect(shouldAllowLoadURL({
      url: 'https://cdn.example.com/report.xlsx',
      forceBrowser: true,
    })).toBe(true)
  })
})
