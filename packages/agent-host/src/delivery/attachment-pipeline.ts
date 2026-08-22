/**
 * AttachmentPipeline —— 抽 `resolveFileAttachments` 主流程与 `fallbackAttachmentText`。
 *
 * 两端 Host（Electron / Daemon）的 `resolveFileAttachments` 外壳完全一致：
 *   1. `Promise.allSettled` 并行 resolve 单个附件；
 *   2. resolve 失败 / 返回空时用 `fallback` 文本兜底；
 *   3. 每条包一层 `<context type="attached">` wrapper（SSoT 议题 2），带 filename
 *      与 `stale_after_turn=<turnId>`；
 *   4. 用 `\n\n` 串联成 prompt 追加片段。
 *
 * 单附件的实际解析（本地 DocParse / 云端 summary / 音频 ASR / 视频短路 …）由
 * 平台在 `resolveOne` 里保留——平台差异（Electron 有视频短路 / data-URL 重写 /
 * 全局 API_BASE_URL；Daemon 用 config-driven）都是单件级别的**内在**差异，不适合
 * 抽到共享层（抽了要注入 5+ 依赖，反而复杂化）。
 */

import { buildUserContextWrapper } from '@tabtin/agent-prompt'

export interface AttachmentDescriptor {
  type?: string
  file_id?: string
  filename?: string
  mime_type?: string
  size?: number
  url?: string
}

export interface AttachmentPipelineLogger {
  debug(message: string): void
}

export interface ResolveAttachmentsOptions {
  logger?: AttachmentPipelineLogger
  /** 阶段 6 议题 2：本轮 user message client id → wrapper `stale_after_turn` 属性。 */
  turnId?: string
  /** 缺省 filename（wrapper `filename` 属性）——两端旧实现均用 `'附件'`。 */
  defaultFilename?: string
}

/** 普通文件不抽文本、不直传模型，只向 Agent 提供保真资源入口。 */
export function formatGenericAttachmentResourceText(
  attachment: Pick<AttachmentDescriptor, 'file_id' | 'filename' | 'mime_type'>,
): string {
  const filename = attachment.filename || '附件'
  const mime = attachment.mime_type ? ` (${attachment.mime_type})` : ''
  const fileId = attachment.file_id
  if (!fileId) return `[对话文件资源: ${filename}${mime}]`
  return [
    `[对话文件资源: ${filename}${mime}]`,
    `原始文件已上传；需要读取、解压或处理时，先调用 save_attachment(file_id=${fileId}) 保真保存到当前 Workspace。`,
  ].join('\n')
}

/**
 * 对话附件总是 Agent 可访问资源；无论是否同时走模型原生文档通道，
 * 都必须把权威 FileRecord UUID 告诉 Agent。对象存储 URL 可能只是哈希键，
 * 不能从 URL、对象键或文件名推导 file_id。
 */
export function findAttachmentsMissingResourceIdentity(
  attachments: readonly AttachmentDescriptor[],
): string[] {
  return attachments
    .filter(attachment => !attachment.file_id?.trim())
    .map(attachment => attachment.filename || '附件')
}

export function formatAttachmentResourceMetadata(
  attachments: readonly AttachmentDescriptor[],
  options: Pick<ResolveAttachmentsOptions, 'turnId' | 'defaultFilename'> = {},
): string {
  return attachments
    .filter((attachment) => attachment.file_id?.trim())
    .map((attachment) => {
      const filename = attachment.filename ?? options.defaultFilename ?? '附件'
      return buildUserContextWrapper(
        'attached',
        [
          `[对话附件: ${filename}]`,
          '附件已作为 Agent 可访问的对话资源上传。',
          attachment.url ? `附件链接：${attachment.url}` : '',
          '读取原始字节必须使用 save_attachment(file_id=...)；读取支持的文档内容可使用 parse_document(file_id=...)；',
          '不得从附件 URL、对象键或文件名推导 file_id。',
        ].filter(Boolean).join('\n'),
        {
          file_id: attachment.file_id,
          filename,
          url: attachment.url,
          stale_after_turn: options.turnId,
        },
      )
    })
    .join('\n\n')
}

/** 保留旧共享 API 的 file-only 语义；Electron resource-first 使用上面的全附件函数。 */
export function formatDocumentAttachmentMetadata(
  attachments: readonly AttachmentDescriptor[],
  options: Pick<ResolveAttachmentsOptions, 'turnId' | 'defaultFilename'> = {},
): string {
  return formatAttachmentResourceMetadata(
    attachments.filter(attachment => attachment.type === 'file'),
    options,
  )
}

/**
 * `resolveFileAttachments` 外壳：并行 resolve → wrapper 包裹 → 拼接。
 *
 * @param attachments 已过滤（image 已剔）的附件列表；顺序即输出顺序。
 * @param resolveOne 单件解析器；返回 `null` 或抛错都视作失败走 fallback 文本。
 * @param fallback 兜底文本生成器（filename+mime，与旧 `fallbackAttachmentText` 同）。
 */
export async function resolveFileAttachmentsShell(
  attachments: readonly AttachmentDescriptor[],
  resolveOne: (attachment: AttachmentDescriptor) => Promise<string | null>,
  fallback: (attachment: AttachmentDescriptor) => string,
  options: ResolveAttachmentsOptions = {},
): Promise<string> {
  if (attachments.length === 0) return ''

  const results = await Promise.allSettled(
    attachments.map((a) => resolveOne(a)),
  )

  const lines: string[] = []
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i]
    const result = results[i]
    let body: string
    if (result.status === 'fulfilled' && result.value) {
      body = result.value
    } else {
      if (result.status === 'rejected' && options.logger) {
        options.logger.debug(
          `resolveOneAttachment failed for ${attachment.file_id ?? attachment.filename}: ${result.reason}`,
        )
      }
      body = fallback(attachment)
    }
    lines.push(
      buildUserContextWrapper('attached', body, {
        file_id: attachment.file_id,
        filename: attachment.filename ?? options.defaultFilename ?? '附件',
        stale_after_turn: options.turnId,
      }),
    )
  }

  return lines.join('\n\n')
}

/**
 * 两端 `fallbackAttachmentText` 完全一致的实现——UI 上"附件 resolve 失败"时的
 * 占位文本。带 mime 时形如 `[附件: foo.pdf (application/pdf)]`，不带 mime 时
 * `[附件: foo.pdf]`。
 */
export function formatFallbackAttachmentText(
  attachment: Pick<AttachmentDescriptor, 'filename' | 'mime_type'>,
): string {
  const name = attachment.filename || 'file'
  if (attachment.mime_type) {
    return `[附件: ${name} (${attachment.mime_type})]`
  }
  return `[附件: ${name}]`
}
