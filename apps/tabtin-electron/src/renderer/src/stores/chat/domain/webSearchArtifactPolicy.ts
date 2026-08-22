import type { ChatMessage } from '@tabtin/chat-client'

interface BlockLike {
  type?: unknown
  kind?: unknown
  summary?: unknown
}

export function isLegacyWebSearchResultsBlock(block: BlockLike): boolean {
  return (block.type === 'tabtin_rich_content' || block.type === 'rich_content')
    && block.kind === 'search_results'
    && typeof block.summary === 'string'
    && /^web_search\s*:/i.test(block.summary)
}

export function shouldHideLegacyWebSearchArtifactMessage(message: ChatMessage): boolean {
  if (message.message_kind !== 'tool_artifact' || message.content.trim() !== '') return false
  const entries = message.blocks
  return Array.isArray(entries)
    && entries.length > 0
    && entries.every(entry => isLegacyWebSearchResultsBlock(entry.block))
}
