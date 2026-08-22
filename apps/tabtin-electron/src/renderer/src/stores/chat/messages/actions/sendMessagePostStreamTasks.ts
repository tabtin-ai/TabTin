/**
 * sendMessage 异步尾巴 —— 流结束后跑的 fire-and-forget 缓存 / checkpoint。
 *
 * 历史背景：原本写在 `sendMessageAction.ts` 的 `onDone` 末尾的 IIFE
 * `;(async () => {...})()`，与同步收尾（removeStreamingSession / telemetry /
 * updateSessionMessages）混在一起。流终态根治时把它显式提取成独立函数：
 *   - **同步收尾**（`onDone` 主体）依旧 inline 在 callback 里，确保 UI 状态立刻更新
 *   - **异步尾巴**（本文件）作为 fire-and-forget 单独跑，调用方不 await
 *
 * 标题生成已迁出本文件：首条 user 落库走 `message_persisted` /
 * `message_committed` 即时路径，`lifecycle.end` / `selectSession` 作兜底，
 * 不再挂在 post-stream 尾巴上。
 *
 * 参考 `support/electron/ipc-stream-invariant.md` §"异步尾巴"段。
 */

import type { ChatMessage, ChatSession } from '@tabtin/chat-client'
import { createLogger } from '@/utils/logger'
import { cacheMessages } from '../messageCache'

const log = createLogger('SendMessage:PostStream')

// 2026-05-04 重构后：原先此处有 `findOrBuildSession` + `PersistableSession`
// 两个给 `persistConversationTranscript` 准备的 helper；选项 A 决议下镜像
// jsonl 已删除，这两个 helper 变成 dead code 一并移除。Agent 的 silent memory
// 现在直接读主 archive（`{platformDataRoot}/{wt}/spaces/{sp}/conversations/
// sessions/*.jsonl`），宿主 SessionStorage 原路径写入，无需 renderer 再搭一
// 套副本。

/**
 * 异步尾巴依赖参数 —— 全部由 sendMessageAction 的 closure 透传。
 *
 * 设计取向：参数化所有外部依赖（不直接 import store），让本函数纯业务逻辑、
 * 易测试、易追溯。每个字段都是 reducer 状态或外部能力 hook。
 */
export interface PostStreamTasksDeps {
  /** 当前 session id（onDone 时已确定）。 */
  sessionId: string
  /** AI 消息 ID（可能是 temp- 或 server_id；ACK 之前是 temp-）。 */
  aiMessageId: string
  /** 是否已通过 message_persisted ACK 拿到 assistant server_id（决定 checkpoint 路径）。 */
  aiServerIdResolved: boolean
  /** 本轮是否需要建 checkpoint（lifecycle.end 时由 lifecycleHandler 标记）。 */
  pendingCheckpointForRun: boolean
  /** Space ID（建 checkpoint 时透传）。 */
  capturedSpaceId: string | undefined
  /** Checkpoint baseline tree-hash 的 Promise（在 sendMessage 入口启动）。 */
  checkpointBaselinePromise: Promise<string | undefined> | undefined

  /** 拿当前 store 状态（同 useChatStore.getState）。 */
  get: () => {
    messagesBySessionId: Record<string, ChatMessage[]>
    sessions: ChatSession[]
    createCheckpoint: (
      sessionId: string,
      messageId: string,
      stateHint: number | undefined,
      opts: { spaceId?: string; baselineHash?: string; kind?: 'agent_turn_done' | 'error_compensation' },
    ) => Promise<unknown>
  }

  /** 拉服务端最新消息（用作 server_id 兜底）。 */
  syncSessionMessagesFromServer: () => Promise<void>
}

/**
 * 异步尾巴主体 —— fire-and-forget。
 *
 * 调用方写法：
 *   void runPostStreamTasks(deps)
 *
 * **不要** `await` 这个函数 —— 它代表"流已结束、UI 已更新，剩下的持久化 /
 * checkpoint 在后台慢慢跑就行"。await 会把它的耗时阻塞在 sendMessage 入口，
 * 与历史 onDone IIFE 行为不一致。
 */
export async function runPostStreamTasks(deps: PostStreamTasksDeps): Promise<void> {
  const {
    sessionId,
    aiMessageId,
    aiServerIdResolved,
    pendingCheckpointForRun,
    capturedSpaceId,
    checkpointBaselinePromise,
    get,
    syncSessionMessagesFromServer,
  } = deps

  // ── 缓存消息 ──
  //
  // 2026-05-04 重构后：原先此处还会写一份 `conversations/*.jsonl` 镜像到
  // sandbox 下供 Agent 读（`persistConversationTranscript`），选项 A 决议下
  // 已删除——Agent 的 silent memory 改为直接读主 archive
  // （`{platformDataRoot}/{wt}/spaces/{sp}/conversations/sessions/*.jsonl`），
  // 无需双写。
  const msgsToCache = get().messagesBySessionId[sessionId] ?? []
  cacheMessages(sessionId, msgsToCache).catch(() => undefined)

  // ── checkpoint 兜底 ──
  // 主路径（ACK 已到）→ 直接用 aiMessageId 建 checkpoint
  // 兜底路径（ACK 未到）→ 拉服务端取 last assistant id
  if (pendingCheckpointForRun) {
    if (aiServerIdResolved) {
      const resolvedMsgId = aiMessageId
      if (resolvedMsgId && !resolvedMsgId.startsWith('temp-')) {
        const currentMessages = get().messagesBySessionId[sessionId]
        const stateHint = currentMessages ? currentMessages.length : undefined
        try {
          const checkpointBaselineHash = await checkpointBaselinePromise
          await get().createCheckpoint(sessionId, resolvedMsgId, stateHint, {
            spaceId: capturedSpaceId,
            baselineHash: checkpointBaselineHash,
          })
        } catch (err) {
          log.warn('Local checkpoint creation failed:', err)
        }
      }
    } else {
      log.warn('[M2.5] AI server_id not yet received from relay ACK, falling back to server sync')
      try {
        await syncSessionMessagesFromServer()
        const syncedMsgs = get().messagesBySessionId[sessionId] ?? []
        const lastAi = [...syncedMsgs].reverse().find((m) => m.role === 'assistant')
        if (lastAi && !lastAi.id.startsWith('temp-')) {
          const checkpointBaselineHash = await checkpointBaselinePromise
          await get().createCheckpoint(sessionId, lastAi.id, syncedMsgs.length, {
            spaceId: capturedSpaceId,
            baselineHash: checkpointBaselineHash,
          })
        }
      } catch (err) {
        log.warn('Fallback server sync for checkpoint failed:', err)
      }
    }
  }
}
