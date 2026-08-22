import { describe, it, expect, vi } from 'vitest'
import {
  HTML_UPLOAD_ACCEPT,
  isHtmlUploadFile,
  htmlTitleFromFileName,
  runHtmlUpload,
} from './html-upload'
import type { TabDocHtmlUploadPort } from '../ports'

const t = (key: string, opts?: Record<string, unknown>) =>
  (opts?.defaultValue as string) ?? key

function makeFile(name: string, type = ''): File {
  return new File(['<html></html>'], name, { type })
}

describe('isHtmlUploadFile', () => {
  it('accepts text/html mime regardless of name', () => {
    expect(isHtmlUploadFile({ name: 'index', type: 'text/html' })).toBe(true)
  })

  it('accepts .html / .htm extensions (case-insensitive)', () => {
    expect(isHtmlUploadFile({ name: 'page.html', type: '' })).toBe(true)
    expect(isHtmlUploadFile({ name: 'page.htm', type: '' })).toBe(true)
    expect(isHtmlUploadFile({ name: 'PAGE.HTML', type: '' })).toBe(true)
  })

  it('rejects non-html files', () => {
    expect(isHtmlUploadFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
    expect(isHtmlUploadFile({ name: 'photo.png', type: 'image/png' })).toBe(false)
    expect(isHtmlUploadFile({ name: 'archive.html.zip', type: 'application/zip' })).toBe(false)
    expect(isHtmlUploadFile({ name: 'noext', type: '' })).toBe(false)
  })
})

describe('htmlTitleFromFileName', () => {
  it('strips the .html / .htm extension', () => {
    expect(htmlTitleFromFileName('report.html')).toBe('report')
    expect(htmlTitleFromFileName('report.htm')).toBe('report')
    expect(htmlTitleFromFileName('My Prototype.HTML')).toBe('My Prototype')
  })

  it('drops path prefixes (Windows / posix)', () => {
    expect(htmlTitleFromFileName(String.raw`C:\Users\me\page.html`)).toBe('page')
    expect(htmlTitleFromFileName('/tmp/dir/page.html')).toBe('page')
  })

  it('falls back to the base name when there is no html extension', () => {
    expect(htmlTitleFromFileName('plainname')).toBe('plainname')
  })
})

describe('HTML_UPLOAD_ACCEPT', () => {
  it('covers both extensions and mime', () => {
    expect(HTML_UPLOAD_ACCEPT).toBe('.html,.htm,text/html')
  })
})

describe('runHtmlUpload', () => {
  const outcomeFile = makeFile('demo.html', 'text/html')

  it('returns block attrs on successful upload ( private src may be empty)', async () => {
    const port: TabDocHtmlUploadPort = {
      upload: vi.fn().mockResolvedValue({ url: '', fileId: 'file-1' }),
    }
    const result = await runHtmlUpload(outcomeFile, port, t, { documentId: 'doc-1' })
    expect(result).toEqual({ fileId: 'file-1', src: '', title: 'demo' })
    expect(port.upload).toHaveBeenCalledWith(outcomeFile, { documentId: 'doc-1' })
  })

  it('keeps host-provided url when present (legacy / non-empty)', async () => {
    const port: TabDocHtmlUploadPort = {
      upload: vi.fn().mockResolvedValue({ url: 'https://cdn/x.html', fileId: 'file-1' }),
    }
    const result = await runHtmlUpload(outcomeFile, port, t, { documentId: 'doc-1' })
    expect(result).toEqual({ fileId: 'file-1', src: 'https://cdn/x.html', title: 'demo' })
  })

  it('skips upload and returns null when validate fails', async () => {
    const upload = vi.fn()
    const port: TabDocHtmlUploadPort = {
      upload,
      validate: () => ({ valid: false, reason: 'fileTypeNotAllowed' }),
    }
    const result = await runHtmlUpload(outcomeFile, port, t, {})
    expect(result).toBeNull()
    expect(upload).not.toHaveBeenCalled()
  })

  it('returns null when upload rejects', async () => {
    const port: TabDocHtmlUploadPort = {
      upload: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const result = await runHtmlUpload(outcomeFile, port, t, {})
    expect(result).toBeNull()
  })

  it('returns null when upload resolves without a fileId', async () => {
    const port: TabDocHtmlUploadPort = {
      upload: vi.fn().mockResolvedValue({ url: 'https://cdn/x.html', fileId: '' }),
    }
    const result = await runHtmlUpload(outcomeFile, port, t, {})
    expect(result).toBeNull()
  })
})
