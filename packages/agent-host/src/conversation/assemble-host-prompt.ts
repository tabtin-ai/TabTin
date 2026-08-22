/**
 * Host 侧发送前拼装：用户原文 → quoted → composer preset → @ 引用。
 *
 * Electron / Daemon 共用；token、API base、fetch 全部由调用方注入，
 * 不依赖任何宿主 TokenManager / 全局 API_BASE_URL。
 */

import { buildUserContextWrapper } from '@tabtin/agent-runtime/engine/user-context-wrapper'
import { joinApiPath } from '@tabtin/agent-runtime/tools'
import { resolveComposerPresetPrompt } from './composer-preset-prompt.js'

const CONTEXT_REF_TYPES = new Set([
  'table', 'table_selection', 'document', 'doc_selection', 'field',
  'code_file', 'code_selection', 'web_selection', 'web_annotation',
  'webpage', 'memo', 'whiteboard',
  'phone_device', 'desktop_device', 'terminal_session',
  'slide', 'video', 'site', 'folder',
  'tracker', 'agenda_event',
  'plan',
  'file',
])

const FETCH_TIMEOUT_MS = 15_000

export type HostReplyToContext = {
  messageId: string
  preview?: { role?: string; author?: string; text?: string }
}

export type HostPromptLogger = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export type ResolveHostContextBlocksOptions = {
  apiBaseUrl: string
  getAccessToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
  organizationId?: string | null
}

/**
 * 去掉气泡正文 `type===text` 块，保留 webpage / preset / mcp 等作为 Host prompt context。
 * forward 路径用 `userMessageBlocks` 派生 contextBlocks 时走此过滤。
 */
export function filterHostPromptContextBlocks(
  blocks: Array<Record<string, unknown>> | undefined | null,
): Array<Record<string, unknown>> | undefined {
  if (!blocks?.length) return undefined
  const filtered = blocks.filter((block) => {
    if (!block || typeof block !== 'object') return false
    return block.type !== 'text'
  })
  return filtered.length > 0 ? filtered : undefined
}

function isMcpFocusBlock(block: Record<string, unknown>): boolean {
  return block.type === 'mcp_server'
    && typeof block.connection_id === 'string'
    && block.connection_id.trim().length > 0
}

/** MCP focus 文案本地确定性生成（非 API 双读）。 */
export function renderMcpFocusContext(blocks: Array<Record<string, unknown>>): string {
  const focused = blocks.filter(isMcpFocusBlock)
  if (focused.length === 0) return ''

  const lines = focused.map((block) => {
    const connectionId = (block.connection_id as string).trim()
    const serverName = typeof block.server_name === 'string' && block.server_name.trim()
      ? block.server_name.trim()
      : connectionId
    return `- server_name=${JSON.stringify(serverName)}, connection_id=${JSON.stringify(connectionId)}`
  })

  return [
    '## 本轮 MCP focus',
    ...lines,
    '用户为本轮明确选择了以上 MCP server 作为重点能力。',
    '优先使用其中与任务相关的 MCP tool；其他已启用 MCP 仍然可用，不要把 focus 当作硬白名单。',
  ].join('\n')
}

function joinContextParts(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join('\n\n---\n\n')
}

/**
 * 调 Django `/chat/resolve-context`；仅权威结果。失败 / 无 token → 空串（MCP focus 除外）。
 * apiBaseUrl / getAccessToken 必填注入。
 */
export async function resolveHostContextBlocks(
  blocks: Array<Record<string, unknown>>,
  opts: ResolveHostContextBlocksOptions,
): Promise<string> {
  const refBlocks = blocks.filter(b => CONTEXT_REF_TYPES.has(b.type as string))
  const mcpBlocks = blocks.filter(isMcpFocusBlock)
  if (refBlocks.length === 0 && mcpBlocks.length === 0) return ''
  const mcpFocusText = renderMcpFocusContext(mcpBlocks)
  if (refBlocks.length === 0) return mcpFocusText

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const token = await opts.getAccessToken()
  if (!token) return mcpFocusText

  try {
    const url = joinApiPath(opts.apiBaseUrl, '/chat/resolve-context')
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opts.organizationId ? { 'X-Organization-Id': opts.organizationId } : {}),
      },
      body: JSON.stringify({ blocks: refBlocks }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!resp.ok) return mcpFocusText
    const json = await resp.json() as { data?: { context_text?: string } }
    const resourceText = typeof json?.data?.context_text === 'string'
      ? json.data.context_text
      : ''
    return joinContextParts(resourceText, mcpFocusText)
  } catch {
    return mcpFocusText
  }
}

/**
 * 产品域拼装顺序：用户原文 → quoted-message → composer preset → @/MCP referenced。
 */
export async function assembleHostPromptContext(params: {
  message: string
  replyTo?: HostReplyToContext
  contextBlocks?: Array<Record<string, unknown>>
  staleAfterTurn: string
  log: HostPromptLogger
  resolveContextBlocks?: (blocks: Array<Record<string, unknown>>) => Promise<string>
}): Promise<string> {
  const {
    message,
    replyTo,
    contextBlocks,
    staleAfterTurn,
    log,
    resolveContextBlocks,
  } = params

  let effectiveMessage = message
  const appendPromptContext = (contextText: string): void => {
    if (!contextText.trim()) return
    effectiveMessage = effectiveMessage.trim()
      ? `${effectiveMessage}\n\n${contextText}`
      : contextText
  }

  if (replyTo?.messageId) {
    const preview = replyTo.preview
    const role = typeof preview?.role === 'string' ? preview.role : 'assistant'
    const quotedAuthor = preview?.author
      ? `${preview.author}（${role}）`
      : role
    const quotedText = typeof preview?.text === 'string' ? preview.text : ''
    const quotedBody = `用户引用回复了以下消息：\n${quotedAuthor}: ${quotedText}`
    appendPromptContext(buildUserContextWrapper('quoted-message', quotedBody, {
      stale_after_turn: staleAfterTurn,
    }))
  }

  if (contextBlocks && contextBlocks.length > 0) {
    const composerPresetText = resolveComposerPresetPrompt(contextBlocks)
    if (composerPresetText) {
      appendPromptContext(buildUserContextWrapper('referenced', composerPresetText, {
        stale_after_turn: staleAfterTurn,
      }))
      log.info('[Host] Composer preset 解析成功, context_text length=%d', composerPresetText.length)
    }

    if (resolveContextBlocks) {
      try {
        const contextText = await resolveContextBlocks(contextBlocks)
        if (contextText) {
          appendPromptContext(buildUserContextWrapper('referenced', contextText, {
            stale_after_turn: staleAfterTurn,
          }))
          log.info('[Host] @ 引用解析成功, context_text length=%d', contextText.length)
        } else {
          log.warn('[Host] @ 引用解析结果为空', {
            blockCount: contextBlocks.length,
            blockTypes: contextBlocks.map((block) =>
              typeof block.type === 'string' ? block.type : 'unknown',
            ),
          })
        }
      } catch (resolveErr) {
        log.warn('[Host] @ 引用解析失败 (non-blocking):', resolveErr)
      }
    }
  }

  return effectiveMessage
}
