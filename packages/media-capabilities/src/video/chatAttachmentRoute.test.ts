import { describe, expect, it } from 'vitest'
import {
  isNativeChatDocumentPass,
  isNativeChatVideoPass,
  planChatAttachmentsForPromptInjection,
  runtimeTypeForChatVideoAttachment,
  shouldSendChatAttachmentToModelRuntime,
} from './chatAttachmentRoute.js'

describe('chatAttachmentRoute — document ', () => {
  it('supports + document file + url → native pass', () => {
    expect(isNativeChatDocumentPass(
      true,
      'file',
      'https://cdn.example/a.pdf',
    )).toBe(true)
  })

  it('resource-first 中普通文件资源不发送给模型', () => {
    expect(shouldSendChatAttachmentToModelRuntime(
      { type: 'file', url: 'https://cdn.example/source.zip', mime_type: 'application/zip', filename: 'source.zip' },
      { supportsDocumentInput: true, fileDeliveryMode: 'agent_resource_first' },
    )).toBe(false)
  })

  it('resource-first 中 PDF 也只作为工具可读资源，不自动送给模型', () => {
    expect(shouldSendChatAttachmentToModelRuntime(
      {
        type: 'file',
        url: 'https://cdn.example/report.pdf',
        mime_type: 'application/pdf',
        filename: 'report.pdf',
      },
      { supportsDocumentInput: true, fileDeliveryMode: 'agent_resource_first' },
    )).toBe(false)
  })

  it('resource-first 中图片和视频也只作为工具可读资源', () => {
    const caps = { fileDeliveryMode: 'agent_resource_first' as const }
    expect(shouldSendChatAttachmentToModelRuntime({ type: 'image', file_id: 'image-1' }, caps)).toBe(false)
    expect(shouldSendChatAttachmentToModelRuntime({ type: 'video', file_id: 'video-1' }, caps)).toBe(false)
  })

  it('非 file 不参与文档门控', () => {
    expect(isNativeChatDocumentPass(true, 'image', 'https://cdn.example/a.png')).toBe(false)
  })
})

describe('chatAttachmentRoute — video ', () => {
  it('supports + video + url → native pass', () => {
    expect(isNativeChatVideoPass(true, 'video', 'https://cdn.example.com/a.mp4')).toBe(true)
  })

  it('undefined / false 能力 → false（降级文案）', () => {
    expect(isNativeChatVideoPass(undefined, 'video', 'https://cdn.example.com/a.mp4')).toBe(false)
    expect(isNativeChatVideoPass(false, 'video', 'https://cdn.example.com/a.mp4')).toBe(false)
  })

  it('runtimeType：原生保留 video，否则降 file', () => {
    expect(
      runtimeTypeForChatVideoAttachment(true, 'video', 'https://cdn.example.com/a.mp4'),
    ).toBe('video')
    expect(runtimeTypeForChatVideoAttachment(false, 'video', 'https://x/a.mp4')).toBe('file')
    expect(runtimeTypeForChatVideoAttachment(true, 'image', 'https://x/a.png')).toBe('image')
  })
})

describe('planChatAttachmentsForPromptInjection', () => {
  it('缺 URL 的文档只保留 Agent 资源引用，不隐式抽正文、不阻断发送', () => {
    const plan = planChatAttachmentsForPromptInjection(
      [{ type: 'file', filename: 'a.pdf', mime_type: 'application/pdf' }],
      { supportsDocumentInput: true, fileDeliveryMode: 'agent_resource_first' },
    )
    expect(plan).toEqual({
      status: 'ok',
      toResolve: [],
    })
  })

  it('原生 document / video / image 不进 toResolve', () => {
    const plan = planChatAttachmentsForPromptInjection(
      [
        { type: 'image', url: 'https://x/a.png' },
        { type: 'file', url: 'https://x/a.pdf', filename: 'a.pdf', mime_type: 'application/pdf' },
        { type: 'video', url: 'https://x/a.mp4' },
      ],
      { supportsDocumentInput: true, supportsVideoInput: true },
    )
    expect(plan).toEqual({ status: 'ok', toResolve: [] })
  })

  it('视频无能力时进入文本解析；文档无能力时只保留资源引用', () => {
    const videoPlan = planChatAttachmentsForPromptInjection(
      [{ type: 'video', url: 'https://x/a.mp4', filename: 'a.mp4' }],
      { supportsVideoInput: false },
    )
    expect(videoPlan).toEqual({
      status: 'ok',
      toResolve: [{ type: 'video', url: 'https://x/a.mp4', filename: 'a.mp4' }],
    })

    const docPlan = planChatAttachmentsForPromptInjection(
      [{ type: 'file', url: 'https://x/a.pdf', filename: 'a.pdf', mime_type: 'application/pdf' }],
      { supportsDocumentInput: false, fileDeliveryMode: 'agent_resource_first' },
    )
    expect(docPlan).toEqual({
      status: 'ok',
      toResolve: [],
    })
  })

  it('ZIP 始终作为 Agent 资源，不直接发送给模型', () => {
    const plan = planChatAttachmentsForPromptInjection(
      [
        { type: 'file', url: 'https://cdn.example/source.zip', filename: 'source.zip', mime_type: 'application/zip' },
        { type: 'image', url: 'https://cdn.example/a.png' },
      ],
      { supportsDocumentInput: true, supportsVideoInput: true, fileDeliveryMode: 'agent_resource_first' },
    )
    expect(plan).toEqual({
      status: 'ok',
      toResolve: [],
    })
  })

  it('默认保留旧 Host 的文档硬门禁，避免共享路由静默改变 Daemon', () => {
    expect(planChatAttachmentsForPromptInjection(
      [{ type: 'file', url: 'https://x/a.pdf', filename: 'a.pdf', mime_type: 'application/pdf' }],
      { supportsDocumentInput: false },
    )).toEqual({ status: 'blocked', labels: ['a.pdf'] })

    expect(planChatAttachmentsForPromptInjection(
      [{ type: 'file', url: 'https://x/source.zip', filename: 'source.zip', mime_type: 'application/zip' }],
      { supportsDocumentInput: true },
    )).toEqual({ status: 'ok', toResolve: [] })
  })
})
