import type { ContentBlock, Message } from '@tabtin/agent-runtime'
import { formatGenericAttachmentResourceText } from '@tabtin/agent-host/delivery'

function projectFileBlock(block: ContentBlock): ContentBlock {
  if (block.type === 'file' || block.type === 'image' || block.type === 'video') {
    return {
      type: 'text',
      text: formatGenericAttachmentResourceText(block),
    }
  }
  if (block.type === 'document') {
    return {
      type: 'text',
      text: formatGenericAttachmentResourceText({
        file_id: block.file_id,
        filename: block.title,
        mime_type: block.mime_type,
      }),
    }
  }
  return block
}

/**
 * 对话附件只以 Agent 资源引用进入模型上下文，避免当前轮或历史轮自动发送二进制。
 */
export function projectHistoricalFileBlocksAsResources(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map(projectFileBlock),
    }
  })
}
