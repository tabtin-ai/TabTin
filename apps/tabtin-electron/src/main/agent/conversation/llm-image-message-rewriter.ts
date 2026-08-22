import type { Message } from '@tabtin/agent-runtime'
import { isAgentReachableMediaUrl } from '../../../shared/llm-image-url.js'

export async function rewriteUnreachableImageUrlsInMessages(
  messages: Message[],
  resolveUrl: (url: string) => Promise<string>,
  onFailure?: (url: string, error: unknown) => void,
): Promise<Message[]> {
  const resolvedUrls = new Map<string, Promise<string>>()
  const resolveOnce = (url: string): Promise<string> => {
    const existing = resolvedUrls.get(url)
    if (existing) return existing
    const pending = resolveUrl(url)
    resolvedUrls.set(url, pending)
    return pending
  }

  const rewritten = await Promise.all(messages.map(async (message): Promise<Message | null> => {
    if (!Array.isArray(message.content)) return message

    const blocks = await Promise.all(message.content.map(async (block) => {
      if (
        block.type !== 'image'
        || block.source.type !== 'url'
        || isAgentReachableMediaUrl(block.source.url)
      ) {
        return block
      }

      const url = block.source.url
      try {
        return {
          ...block,
          source: { type: 'url' as const, url: await resolveOnce(url) },
        }
      } catch (error) {
        onFailure?.(url, error)
        return null
      }
    }))

    const availableBlocks = blocks.filter((block): block is NonNullable<typeof block> => block !== null)
    if (availableBlocks.length === 0) return null
    return { ...message, content: availableBlocks }
  }))

  return rewritten.filter((message): message is Message => message !== null)
}
