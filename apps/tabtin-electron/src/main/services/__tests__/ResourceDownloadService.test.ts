import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceContentRef } from '@tabtin/action-tools/types'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
  net: { request: vi.fn() },
}))

vi.mock('../../api-proxy', () => ({
  isBlockedApiHost: (url: string) => {
    try {
      const hostname = new URL(url).hostname
      return hostname === '127.0.0.1'
        || hostname === '169.254.169.254'
        || hostname.startsWith('192.168.')
        || hostname === '10.0.0.1'
    } catch {
      return true
    }
  },
}))

vi.mock('../../shared/llm-image-url', async () => {
  const actual = await vi.importActual<typeof import('../../shared/llm-image-url')>('../../shared/llm-image-url')
  return actual
})

const { ResourceDownloadService } = await import('../ResourceDownloadService')

type EventHandler = (...args: unknown[]) => void

describe('ResourceDownloadService', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tabtin-resource-download-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('adds .json when captured text content is application/json', async () => {
    const service = new ResourceDownloadService()
    const contentRef: ResourceContentRef = {
      kind: 'text',
      data: '{"ok":true}',
      mimeType: 'application/json',
    }

    const result = await service.saveCapturedContent({
      filename: 'payload',
      contentRef,
      outputDir: tempDir,
    })

    expect(path.basename(result.filePath)).toBe('payload.json')
    expect(result.mimeType).toBe('application/json')
    await expect(readFile(result.filePath, 'utf8')).resolves.toBe('{"ok":true}')
  })

  it('fetchToBuffer 拒绝私网 host（SSRF）', async () => {
    const service = new ResourceDownloadService()
    await expect(service.fetchToBuffer({ url: 'http://127.0.0.1/secret' }))
      .rejects.toThrow(/not allowed/i)
    await expect(service.fetchToBuffer({ url: 'http://169.254.169.254/latest' }))
      .rejects.toThrow(/not allowed/i)
  })

  it('fetchToBuffer 放行本机 Django local-object（LLM data: 改写）', async () => {
    const { net } = await import('electron')
    const handlers: Record<string, EventHandler> = {}
    const request = {
      setHeader: vi.fn(),
      on: vi.fn((event: string, cb: EventHandler) => { handlers[event] = cb }),
      end: vi.fn(() => {
        const responseHandlers: Record<string, EventHandler> = {}
        const response = {
          statusCode: 200,
          headers: { 'content-type': 'image/png' },
          on: vi.fn((event: string, cb: EventHandler) => {
            responseHandlers[event] = cb
            if (event === 'end') {
              queueMicrotask(() => {
                responseHandlers.data?.(Buffer.from([1, 2, 3]))
                responseHandlers.end?.()
              })
            }
          }),
        }
        handlers.response?.(response)
      }),
      abort: vi.fn(),
    }
    vi.mocked(net.request).mockReturnValue(request as never)

    const service = new ResourceDownloadService()
    const result = await service.fetchToBuffer({
      url: 'http://127.0.0.1:6060/api/services/oss/local-object/abc',
    })
    expect(result.size).toBe(3)
    expect(result.mimeType).toBe('image/png')
  })

  it('fetchToBuffer 拒绝非 http(s)', async () => {
    const service = new ResourceDownloadService()
    await expect(service.fetchToBuffer({ url: 'file:///etc/passwd' }))
      .rejects.toThrow(/http/i)
  })

  it('download aborts and removes the partial file when maxBytes is exceeded', async () => {
    const { net } = await import('electron')
    const requestHandlers: Record<string, EventHandler> = {}
    const request = {
      setHeader: vi.fn(),
      on: vi.fn((event: string, cb: EventHandler) => { requestHandlers[event] = cb }),
      end: vi.fn(() => {
        const responseHandlers: Record<string, EventHandler> = {}
        const response = {
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
          on: vi.fn((event: string, cb: EventHandler) => {
            responseHandlers[event] = cb
            if (event === 'end') {
              queueMicrotask(() => {
                responseHandlers.data?.(Buffer.alloc(6))
                responseHandlers.end?.()
              })
            }
          }),
        }
        requestHandlers.response?.(response)
      }),
      abort: vi.fn(),
    }
    vi.mocked(net.request).mockReturnValue(request as never)

    const service = new ResourceDownloadService()
    await expect(service.download({
      url: 'https://cdn.example.test/report.html',
      filename: 'report.html',
      outputDir: tempDir,
      maxBytes: 5,
    })).rejects.toThrow(/too large/i)
    await expect(readdir(tempDir)).resolves.toEqual([])
  })
})
