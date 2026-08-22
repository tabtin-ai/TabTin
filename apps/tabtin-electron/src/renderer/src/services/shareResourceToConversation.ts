/**
 * shareResourceToConversation — 把一个 TabData 表 / TabDoc 文档作为资源卡片
 * 发进指定私信会话（TC-5）。两个入口（输入框资源按钮 / 资源右键分享）共用。
 *
 * 走普通 message_type=TEXT + metadata.card；后端 _validate_card_metadata 会
 * 校验资源存在 + organization 一致 + 发送者权限并回填真实名（失败抛错 → store
 * 已做乐观回滚 + toast）。卡片是「指针」不授权（见设计文档）。
 */

import { useIMStore } from '@/stores/useIMStore'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import {
  type ImResourceCardRef,
  formatResourceCardContent,
  buildResourceCardMetadata,
} from '@/lib/imResourceCard'

export async function shareResourceToConversation(
  convId: string,
  ref: ImResourceCardRef,
  options?: { clientRequestId?: string },
): Promise<boolean> {
  return useIMStore.getState().sendMessage({
    convId,
    content: formatResourceCardContent(ref),
    messageType: MESSAGE_TYPE_TEXT,
    metadata: buildResourceCardMetadata(ref) as Record<string, unknown>,
    ...(options?.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
  })
}
