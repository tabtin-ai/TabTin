import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '@tabtin/agent-runtime'
import { createAttachmentTools } from '../src/tools/attachment-tools.js'

const context: ToolContext = {
  threadId: 'thread-1',
  runtimeId: 'runtime-1',
  toolUseId: 'tool-1',
  workspaceRoot: '/workspace',
  abortSignal: new AbortController().signal,
  messages: [],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('save_attachment', () => {
  it('downloads the original uploaded bytes into the current Workspace', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        file_id: 'file-1',
        file_name: 'report.html',
        file_size: 42,
        mime_type: 'text/html',
        access_url: 'https://cdn.example.test/report.html',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const saveToWorkspace = vi.fn(async () => ({
      relativePath: 'attachments/report.html',
      size: 42,
      mimeType: 'text/html',
    }))
    const richBlocks: Array<{ kind: string; payload?: Record<string, unknown> }> = []
    const tool = createAttachmentTools({
      apiBaseUrl: 'https://api.example.test/api',
      apiAuthToken: 'token',
      organizationId: 'org-1',
      saveToWorkspace,
    }).find((candidate) => candidate.name === 'save_attachment')

    expect(tool).toBeDefined()
    const result = await tool!.execute({ file_id: 'file-1' }, {
      ...context,
      emitRichContentBlock: (block) => { richBlocks.push(block) },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/services/oss/files/file-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
          'X-TabTin-Organization-Id': 'org-1',
        }),
      }),
    )
    expect(saveToWorkspace).toHaveBeenCalledWith({
      fileId: 'file-1',
      filename: 'report.html',
      mimeType: 'text/html',
      expectedSize: 42,
      sourceUrl: 'https://cdn.example.test/report.html',
      workspaceRoot: '/workspace',
      abortSignal: context.abortSignal,
    })
    expect(JSON.parse(result.content as string)).toMatchObject({
      success: true,
      file_id: 'file-1',
      relative_path: 'attachments/report.html',
      filename: 'report.html',
      file_size: 42,
      mime_type: 'text/html',
      next_command: 'tabtin browser open --url attachments/report.html',
    })
    expect(tool!.description).toContain('browser open')
    expect(tool!.description).toContain('present_to_user')
    expect(richBlocks).toHaveLength(0)
  })

  it('routes image analysis to read_file without emitting a duplicate rich-content card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        file_id: 'image-1',
        file_name: 'photo.jpg',
        file_size: 42,
        mime_type: 'image/jpeg',
        access_url: 'https://cdn.example.test/photo.jpg',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const saveToWorkspace = vi.fn(async () => ({
      relativePath: 'attachments/photo.jpg',
      size: 42,
      mimeType: 'image/jpeg',
    }))
    const richBlocks: unknown[] = []
    const tool = createAttachmentTools({
      apiBaseUrl: 'https://api.example.test/api',
      apiAuthToken: 'token',
      saveToWorkspace,
    }).find((candidate) => candidate.name === 'save_attachment')

    const result = await tool!.execute({ file_id: 'image-1' }, {
      ...context,
      emitRichContentBlock: (block) => { richBlocks.push(block) },
    })

    expect(JSON.parse(result.content as string)).toMatchObject({
      relative_path: 'attachments/photo.jpg',
      next_tool: 'read_file',
      hint: expect.stringContaining('Only call present_to_user when the user explicitly asks'),
    })
    expect(richBlocks).toHaveLength(0)
  })

  it('preserves backend permission errors instead of reporting a generic network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false,
      message: 'forbidden',
      data: null,
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })))
    const saveToWorkspace = vi.fn()
    const tool = createAttachmentTools({
      apiBaseUrl: 'https://api.example.test/api',
      apiAuthToken: 'token',
      saveToWorkspace,
    }).find((candidate) => candidate.name === 'save_attachment')

    const result = await tool!.execute({ file_id: 'file-1' }, context)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string)).toMatchObject({
      success: false,
      error_kind: 'permission_denied',
      upstream_status: 403,
    })
    expect(saveToWorkspace).not.toHaveBeenCalled()
  })

  it('save_attachment 以 v3 extractPath 暴露 attachments 目录', () => {
    const tool = createAttachmentTools({
      apiBaseUrl: 'https://api.example.test/api',
      apiAuthToken: 'token',
      saveToWorkspace: vi.fn(),
    }).find((candidate) => candidate.name === 'save_attachment')

    expect(tool?.extractPath?.({})).toBe('attachments')
    expect(tool?.extractPolicyParams).toBeUndefined()
  })
})
