import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { EMPTY_CONTENT_BLOCKS } from './messageBubbleModelTypes'

export interface ResolveMessageContentBlocksInput {
  isUser: boolean
  contentBlocksOverride?: ContentBlockEntry[]
  /**
   * 时间线 partial 段：正文只认列表下发的 `contentBlocksOverride`（含空），
   * 不回落 runtime 全量（防串块），也不读 props.message.blocks（memo 不比 blocks）。
   */
  isPartialSegment: boolean
  runtimeBlocks: ContentBlockEntry[]
  /**
   * `#8846`：props 上的 `message.blocks`。仅当 store 侧 `runtimeBlocks` 为空时回落——
   * 子代理详情选用 runtime 本地归档（未写入父 `messagesBySessionId`）时必须能渲染；
   * live 路径仍优先 store（`#7794`，避免 memo 不比 blocks 时读到过期 props）。
   */
  messageBlocks?: ContentBlockEntry[]
}

function hasEntries(blocks: ContentBlockEntry[] | undefined): blocks is ContentBlockEntry[] {
  return Array.isArray(blocks) && blocks.length > 0
}

/**
 * 解析助手气泡要用的 ContentBlockEntry[]。
 *
 * 优先级：
 * - partial：只认 override（列表物化切片；空也停，不回落 runtime / message.blocks）
 * - 非 partial：非空 override → runtimeBlocks（Zustand）→ message.blocks（归档冷读）
 *
 * 不读 content_blocks_json。非空 store blocks 时不读 props.blocks。
 */
export function resolveMessageContentBlocks(
  input: ResolveMessageContentBlocksInput,
): ContentBlockEntry[] {
  if (input.isUser) return [...EMPTY_CONTENT_BLOCKS]
  if (input.isPartialSegment) {
    return hasEntries(input.contentBlocksOverride)
      ? input.contentBlocksOverride
      : [...EMPTY_CONTENT_BLOCKS]
  }
  if (hasEntries(input.contentBlocksOverride)) return input.contentBlocksOverride
  if (input.runtimeBlocks.length > 0) return input.runtimeBlocks
  if (hasEntries(input.messageBlocks)) return input.messageBlocks
  return [...EMPTY_CONTENT_BLOCKS]
}

export function shouldHideEntireMessageBubble(input: {
  isSkillInjection: boolean
  hideAnchoredPushNotification: boolean
  isEnvironmentContext: boolean
  isHitlInteraction: boolean
  isEmptyInterruptedAssistant?: boolean
  isContinuationTrigger?: boolean
}): boolean {
  return input.isSkillInjection
    || input.hideAnchoredPushNotification
    || input.isEnvironmentContext
    || input.isHitlInteraction
    || input.isEmptyInterruptedAssistant === true
    || input.isContinuationTrigger === true
}
