import { randomUUID } from 'node:crypto'

import { EnvelopeEmitter, type StreamEvent } from '@tabtin/agent-runtime/engine'

import { buildOssFileArtifactBlock } from './oss-file-artifact.js'
import { splitShellCommandSegments } from './shell-command-segments.js'

export type MediaImageArtifactBlock = {
  messageId?: string
  kind: 'image'
  summary: string
  payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  const trimmed = output.trim()
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // 继续尝试从混合终端输出中提取完整 JSON 对象。
  }

  let lastParsed: Record<string, unknown> | null = null
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== '{') continue

    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let index = start; index < trimmed.length; index += 1) {
      const character = trimmed[index]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (character === '\\') {
          escaped = true
        } else if (character === '"') {
          inString = false
        }
        continue
      }
      if (character === '"') {
        inString = true
      } else if (character === '{') {
        depth += 1
      } else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    if (end < 0) continue

    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown
      if (isRecord(parsed)) {
        lastParsed = parsed
        start = end
      }
    } catch {
      // 当前左花括号不是 JSON 起点，继续尝试后续候选。
    }
  }
  return lastParsed
}

function unwrapTerminalOutput(envelope: Record<string, unknown>): Record<string, unknown> {
  // 后台终态把真实 CLI JSON 放在 terminal update 的 stdout 字符串里。
  // 递归解包，让前台和后台完成路径共享一份正式产物投影规则。
  const stdout = typeof envelope.stdout === 'string' ? envelope.stdout : ''
  const nested = stdout ? parseJsonObject(stdout) : null
  return nested ? unwrapTerminalOutput(nested) : envelope
}

export function isMediaImageGenerateCommand(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) return false
  for (const segment of splitShellCommandSegments(command)) {
    const tokens = segment.split(/\s+/).filter(Boolean)
    let index = 0
    while (
      index < tokens.length
      && (/^[A-Z_][A-Z0-9_]*=/.test(tokens[index]!)
        || tokens[index] === 'sudo'
        || tokens[index] === 'exec')
    ) {
      index += 1
    }
    if (tokens[index] === 'cd') continue
    if (
      (tokens[index] === 'tabtin' || tokens[index] === 'tabtin-preprod')
      && tokens[index + 1] === 'media'
      && tokens[index + 2] === 'image'
      && tokens[index + 3] === 'generate'
    ) {
      return true
    }
  }
  return false
}

/**
 * 将 CLI 的 ``stored_files`` 投影为正式图片产物。
 * 临时 ``result_urls`` 没有 FileRecord 身份，永远不会在这里升级为产物。
 */
export function buildMediaImageArtifactBlocks(
  command: string,
  output: string,
  sourceToolUseId: string,
): MediaImageArtifactBlock[] {
  if (!isMediaImageGenerateCommand(command)) return []
  const parsedEnvelope = parseJsonObject(output)
  const envelope = parsedEnvelope ? unwrapTerminalOutput(parsedEnvelope) : null
  if (!envelope) return []
  const data = isRecord(envelope.data) ? envelope.data : envelope
  if (!Array.isArray(data.stored_files)) return []

  const blocks: MediaImageArtifactBlock[] = []
  for (const item of data.stored_files) {
    if (!isRecord(item)) continue
    const fileId = typeof item.file_id === 'string' ? item.file_id.trim() : ''
    const accessUrl = typeof item.access_url === 'string' ? item.access_url.trim() : ''
    const filename = typeof item.file_name === 'string' ? item.file_name.trim() : ''
    const mimeType = typeof item.mime_type === 'string' ? item.mime_type.trim() : ''
    const artifactMessageId = typeof item.artifact_message_id === 'string'
      ? item.artifact_message_id.trim()
      : ''
    if (!fileId || !accessUrl || !filename || !mimeType) continue

    const fileSize = typeof item.file_size === 'number'
      && Number.isInteger(item.file_size)
      && item.file_size >= 0
      ? item.file_size
      : undefined
    const fileBlock = buildOssFileArtifactBlock({
      fileId,
      accessUrl,
      filename,
      mimeType,
      fileType: 'image',
      ...(fileSize !== undefined ? { fileSize } : {}),
    })
    blocks.push({
      ...(artifactMessageId ? { messageId: artifactMessageId } : {}),
      ...fileBlock,
      kind: 'image',
      payload: {
        ...fileBlock.payload,
        source_tool_use_id: sourceToolUseId,
      },
    })
  }
  return blocks
}

/**
 * 为 query 外完成的后台生图命令合成正式工具产物消息。
 * 使用 runtime 的统一 envelope emitter，确保 live、持久化与历史恢复协议一致。
 */
export function buildMediaImageArtifactEvents(args: {
  threadId: string
  command: string
  output: string
  sourceToolUseId: string
  initialSeq?: number
}): StreamEvent[] {
  const blocks = buildMediaImageArtifactBlocks(args.command, args.output, args.sourceToolUseId)
  if (blocks.length === 0) return []

  const emitter = new EnvelopeEmitter({
    traceId: randomUUID(),
    threadId: args.threadId,
    runId: randomUUID(),
    // ``initialSeq`` 表示前一批事件最后使用的序号；Emitter 的首个事件直接
    // 使用传入值，因此这里推进一位，避免终端终态与图片产物发生 _seq 碰撞。
    initialSeq: (args.initialSeq ?? -1) + 1,
  })
  return blocks.flatMap((block) => emitter.emitDetachedMiniMessage({
    role: 'assistant',
    ...(block.messageId ? { messageId: block.messageId } : {}),
    block: {
      type: 'tabtin_rich_content',
      kind: block.kind,
      summary: block.summary,
      payload: block.payload,
    },
  }))
}
