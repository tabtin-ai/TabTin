/**
 * contentBlocksBridge —— runtime 流式引擎 ↔ messages 层内容块存储的桥（ 阶段 6）。
 *
 * 彻底迁移后，内容块的**已提交存储**落在 messages 层 `ChatMessage.blocks`（单一 SSoT）。
 * runtime 引擎仍持有 pending / seq / watchdog / LRU 逻辑，但：
 *   - flush 时把合并好的块经 `commit` 用 Zustand 不可变更新写入 `message.blocks`；
 *   - CRUD 读「已提交块」经 `read` 回到 messages 层；
 *   - evict / LRU trim 经 `clearSession` / `clearMessages` 清 messages 层。
 *
 * 为什么用注入桥而非 static import：runtime store 与 messages store 存在 import 环，
 * 本模块只有 `import type`（编译期擦除），运行期零依赖、必然最先求值，两侧任意加载
 * 顺序都安全。`messageBlocks.ts` 模块加载时 `setContentBlocksBridge` 注入实现。
 */

import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'

export interface ContentBlocksBridge {
  /** 提交某消息的完整块数组（Zustand 不可变更新 message.blocks）。 */
  commit: (sessionId: string, messageId: string, entries: ContentBlockEntry[]) => void
  /** 读某消息的已提交块（引擎 pending-first 回退用）；无则 undefined。 */
  read: (sessionId: string, messageId: string) => ContentBlockEntry[] | undefined
  /** 清某 session 的全部已提交块（evict 用）。 */
  clearSession: (sessionId: string) => void
  /** 清某 session 下指定消息的已提交块（LRU trim 用）。 */
  clearMessages: (sessionId: string, messageIds: Iterable<string>) => void
}

let _bridge: ContentBlocksBridge | null = null

export function setContentBlocksBridge(bridge: ContentBlocksBridge | null): void {
  _bridge = bridge
}

export function getContentBlocksBridge(): ContentBlocksBridge | null {
  return _bridge
}
