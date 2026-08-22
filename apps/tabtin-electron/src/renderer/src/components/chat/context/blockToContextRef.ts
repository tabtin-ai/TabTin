/**
 * blockToContextRef — 把已发送消息 / 草稿恢复时的 context block
 * 反向还原为 ChatInput 用的 `ContextRef`。
 *
 * 编解码实现见 contextRefCodec.ts。
 */

import type { ContextRef } from '../types'
import { BLOCK_TYPE_TO_REF, decodeBlockToContextRef } from './contextRefCodec'

export { BLOCK_TYPE_TO_REF }

export function blockToContextRef(block: Record<string, unknown>): ContextRef | null {
  return decodeBlockToContextRef(block)
}
