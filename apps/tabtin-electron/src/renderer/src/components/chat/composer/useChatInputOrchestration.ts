import type { ChatInputProps, ChatInputChromeProps } from './chatInputTypes'
import { buildChatInputChromeProps } from './buildChatInputChromeProps'
import { useChatInputOrchestrationCore } from './useChatInputOrchestrationCore'

export function useChatInputOrchestration(props: ChatInputProps): ChatInputChromeProps {
  return buildChatInputChromeProps(useChatInputOrchestrationCore(props))
}
