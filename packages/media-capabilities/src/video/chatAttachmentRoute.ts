/**
 * 聊天附件送模路由（ 视频 /  文档）——Electron / Daemon Host 共用一条流程。
 *
 * 对话资源与模型原生输入解耦：Electron resource-first 只向 Agent
 * 提供资源引用，所有附件均不自动解析或直传模型；默认模式保留 Daemon 旧路由。
 */

export type ChatAttachmentPromptCaps = {
  supportsDocumentInput?: boolean
  supportsVideoInput?: boolean
  fileDeliveryMode?: 'model_document_only' | 'agent_resource_first'
}

export type ChatAttachmentPromptRef = {
  type?: string
  file_id?: string
  url?: string
  filename?: string
  mime_type?: string
}

export type ChatAttachmentPromptPlan<T extends ChatAttachmentPromptRef> =
  | { status: 'blocked'; labels: string[] }
  | { status: 'ok'; toResolve: T[] }

/** 原生直传：指定 attachment type + 能力旗标 + 非空 URL。 */
export function isNativeChatUrlPass(
  expectedType: 'file' | 'video',
  supports: boolean | undefined,
  type: string | undefined,
  url?: string,
): boolean {
  return (
    type === expectedType
    && supports === true
    && typeof url === 'string'
    && url.length > 0
  )
}

export function isNativeChatDocumentPass(
  supportsDocumentInput: boolean | undefined,
  type: string | undefined,
  url?: string,
): boolean {
  return isNativeChatUrlPass('file', supportsDocumentInput, type, url)
}

export function isNativeChatVideoPass(
  supportsVideoInput: boolean | undefined,
  type: string | undefined,
  url?: string,
): boolean {
  return isNativeChatUrlPass('video', supportsVideoInput, type, url)
}

export function isBlockedChatDocumentAttachment(
  supportsDocumentInput: boolean | undefined,
  type: string | undefined,
  url?: string,
): boolean {
  if (type !== 'file') return false
  return !isNativeChatUrlPass('file', supportsDocumentInput, type, url)
}

/**
 * runtime attachments 上的 type：原生视频保留 `video`，否则降为 `file`
 *（再进  上传确认文案路径）。
 */
export function runtimeTypeForChatVideoAttachment(
  supportsVideoInput: boolean | undefined,
  type: string,
  url?: string,
): string {
  if (type !== 'video') return type
  return isNativeChatVideoPass(supportsVideoInput, type, url) ? 'video' : 'file'
}

/** 旧 Host 的 model-document-only 模式仍用此错误；resource-first 不产生 blocked。 */
export function formatBlockedChatDocumentError(labels: string[]): string {
  return `当前模型不支持文档直传，或附件缺少可访问地址：${labels.join('、')}`
}

/**
 * Host `buildEffectivePrompt` 唯一入口：筛出仍需文本解析管道的非文件附件。
 * resource-first 模式下，所有附件仅由资源元数据承接，不进入解析或 runtime 通道。
 */
export function planChatAttachmentsForPromptInjection<T extends ChatAttachmentPromptRef>(
  attachments: readonly T[] | undefined,
  caps: ChatAttachmentPromptCaps,
): ChatAttachmentPromptPlan<T> {
  const list = attachments ?? []
  if (caps.fileDeliveryMode === 'agent_resource_first') {
    return { status: 'ok', toResolve: [] }
  }
  const blocked = list.filter((attachment) => isBlockedChatDocumentAttachment(
    caps.supportsDocumentInput,
    attachment.type,
    attachment.url,
  ))
  if (blocked.length > 0) {
    return {
      status: 'blocked',
      labels: blocked.map(attachment => attachment.filename || '附件'),
    }
  }
  const toResolve = list.filter((a) => {
    if (a.type === 'image') return false
    if (isNativeChatDocumentPass(caps.supportsDocumentInput, a.type, a.url)) return false
    if (isNativeChatVideoPass(caps.supportsVideoInput, a.type, a.url)) return false
    return true
  })
  return { status: 'ok', toResolve }
}

/** 只把真正的原生多模态输入交给 runtime/provider。 */
export function shouldSendChatAttachmentToModelRuntime(
  _attachment: ChatAttachmentPromptRef,
  caps: ChatAttachmentPromptCaps,
): boolean {
  if (caps.fileDeliveryMode === 'agent_resource_first') return false
  return true
}
