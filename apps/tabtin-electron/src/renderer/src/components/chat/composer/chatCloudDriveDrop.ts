/**
 *  方案 A：识别云盘拖入 Agent 对话的「预期不支持」载荷。
 * - 云盘 Collection 文件夹：故意不进 composer
 * - 云盘资源移动 MIME 但无 chat context：无法作为上下文引用
 */

import {
  COLLECTION_FOLDER_MIME,
  COLLECTION_ITEM_MIME,
} from '@/components/context-space/hooks/collectionMime'

export type CloudDriveChatDropKind =
  | 'chat_context'
  | 'cloud_folder'
  | 'cloud_item_without_context'
  | 'other'

export function classifyCloudDriveChatDrop(
  types: readonly string[],
  hasValidChatContext: boolean,
): CloudDriveChatDropKind {
  if (hasValidChatContext) return 'chat_context'
  if (types.includes(COLLECTION_FOLDER_MIME)) return 'cloud_folder'
  // 云盘资源移动 MIME 在，但未写出有效 chat context（未声明 attachToChat 等）
  if (types.includes(COLLECTION_ITEM_MIME)) return 'cloud_item_without_context'
  return 'other'
}
