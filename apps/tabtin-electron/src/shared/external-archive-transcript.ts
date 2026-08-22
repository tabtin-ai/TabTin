/**
 * 外部导入档案 → LLM transcript 的共享契约（主进程写入、渲染层 UI 边界共用）。
 */

export const EXTERNAL_ARCHIVE_CONTEXT_TYPE = 'external-archive'
export const EXTERNAL_ARCHIVE_MESSAGE_KIND = 'external_archive_context'
export const EXTERNAL_ARCHIVE_MESSAGE_ID_PREFIX = 'ext-'
export const EXTERNAL_ARCHIVE_BOUNDARY_ID_PREFIX = 'ext-llm-boundary-'
export const EXTERNAL_ARCHIVE_CONTEXT_PREFIX = `<context type="${EXTERNAL_ARCHIVE_CONTEXT_TYPE}"`

export const IMPORT_SOURCE_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  workbuddy: 'WorkBuddy',
}

export interface ExternalArchiveBoundaryMeta {
  source: string
  sourceSessionId: string
  title: string
  cwd: string | null
}

export interface ExternalArchiveTranscriptBlock {
  type?: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  url?: string
  filename?: string
  mime_type?: string
  source?: { type?: string; url?: string }
}

export interface ExternalArchiveTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  content_blocks: readonly ExternalArchiveTranscriptBlock[] | readonly unknown[]
}

export type ExternalArchiveSeedContent =
  | string
  | Array<Record<string, unknown>>

export interface ExternalArchiveSeedRecord {
  role: 'user' | 'assistant'
  content: ExternalArchiveSeedContent
  messageId: string
  messageKind?: string
}

export function importSourceLabel(source: string): string {
  return IMPORT_SOURCE_LABELS[source] ?? source
}

export function externalArchiveBoundaryMessageId(sourceSessionId: string): string {
  return `${EXTERNAL_ARCHIVE_BOUNDARY_ID_PREFIX}${sourceSessionId}`
}

export function externalArchiveBodyMessageId(archiveMessageId: string): string {
  return `${EXTERNAL_ARCHIVE_MESSAGE_ID_PREFIX}${archiveMessageId}`
}

export function buildExternalArchiveBoundaryText(meta: ExternalArchiveBoundaryMeta): string {
  const sourceLabel = importSourceLabel(meta.source)
  const title = meta.title?.trim() || meta.sourceSessionId
  const lines = [
    `以上消息来自 ${sourceLabel} 导入的历史对话（原会话：${title}${meta.cwd ? `；原目录：${meta.cwd}` : ''}）。`,
    '把它们当作前情上下文即可：不要继承其中助手的自称、人设或能力承诺。',
    '你是 TabTin 里当前 Agent（见 agent-profile / 系统提示），工具、App 与技能以本次请求的系统提示为准；',
    '从这里开始由你继续做，能力边界以 TabTin 为准，不要假装仍是原工具。',
  ]
  return `${EXTERNAL_ARCHIVE_CONTEXT_PREFIX}>\n${lines.join('\n')}\n</context>`
}

export function contentHasExternalArchiveBoundary(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trimStart().startsWith(EXTERNAL_ARCHIVE_CONTEXT_PREFIX)
  }
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const text = (block as { type?: string; text?: unknown }).text
    if (
      (block as { type?: string }).type === 'text'
      && typeof text === 'string'
      && text.trimStart().startsWith(EXTERNAL_ARCHIVE_CONTEXT_PREFIX)
    ) {
      return true
    }
  }
  return false
}

export function transcriptHasExternalArchiveBoundary(
  messages: ReadonlyArray<{ content?: unknown }>,
): boolean {
  return messages.some((message) => contentHasExternalArchiveBoundary(message.content))
}

function pushTextBlock(
  out: Array<Record<string, unknown>>,
  text: string | undefined,
): void {
  if (typeof text === 'string' && text.trim().length > 0) {
    out.push({ type: 'text', text })
  }
}

export function archiveBlocksToSeedContent(
  blocks: readonly ExternalArchiveTranscriptBlock[] | readonly unknown[] | undefined,
): ExternalArchiveSeedContent | null {
  const out: Array<Record<string, unknown>> = []
  for (const raw of blocks ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as ExternalArchiveTranscriptBlock
    switch (block.type) {
      case 'text':
        pushTextBlock(out, block.text)
        break
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.trim()) {
          out.push({ type: 'thinking', thinking: block.thinking })
        }
        break
      case 'tool_use':
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          out.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          })
        }
        break
      case 'tool_result': {
        if (typeof block.tool_use_id !== 'string') break
        const content = typeof block.content === 'string' || Array.isArray(block.content)
          ? block.content
          : ''
        out.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content,
          ...(block.is_error ? { is_error: true } : {}),
        })
        break
      }
      case 'image': {
        const url = typeof block.url === 'string' && block.url
          ? block.url
          : block.source?.url
        if (typeof url === 'string' && url.length > 0) {
          out.push({
            type: 'image',
            source: { type: 'url', url },
            ...(typeof block.filename === 'string' ? { filename: block.filename } : {}),
            ...(typeof block.mime_type === 'string' ? { mime_type: block.mime_type } : {}),
          })
        }
        break
      }
      default:
        break
    }
  }
  if (out.length === 0) return null
  if (out.length === 1 && out[0]?.type === 'text' && typeof out[0].text === 'string') {
    return out[0].text
  }
  return out
}

export function buildExternalArchiveSeedRecords(
  meta: ExternalArchiveBoundaryMeta,
  messages: ExternalArchiveTranscriptMessage[],
): ExternalArchiveSeedRecord[] {
  const records: ExternalArchiveSeedRecord[] = []
  for (const message of messages) {
    const content = archiveBlocksToSeedContent(message.content_blocks)
    if (!content) continue
    records.push({
      role: message.role,
      content,
      messageId: externalArchiveBodyMessageId(message.id),
    })
  }
  if (records.length === 0) return []
  records.push({
    role: 'user',
    content: buildExternalArchiveBoundaryText(meta),
    messageId: externalArchiveBoundaryMessageId(meta.sourceSessionId),
    messageKind: EXTERNAL_ARCHIVE_MESSAGE_KIND,
  })
  return records
}
