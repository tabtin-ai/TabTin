/**
 * supersededRuns —— 被中断 / 顶替的 run 的 run_id denylist 登记。
 *
 * ## 为什么需要
 *
 * 用户中断（停止 / 插队 / 停止并重新生成）时，`abortStream(AndWait)` 只给主进程
 * runtime 发 abort 信号，本地 runtime 的旧流要等 generator 异步 unwind 才真正终止——
 * 期间旧流仍会吐 `message_start` / `content_block_*` 尾部事件。这些事件经
 * **`streamMessageHandler`（IPC + relay→WS 两路共享入口）→ contentBlockHandler**
 * 直接写 store：新建 assistant 气泡、灌内容。而时间线按 block 的 `arrival_seq`
 * （daemon 单调微秒时钟）排序，旧流尾部 block 的 `arrival_seq` 是中断之后的时刻 →
 * 排到最底部，落在更新的用户消息之后。表现为「中断后旧输出仍冒出来，且没排在它
 * 响应的用户消息后面」。
 *
 * 历史上曾用 `localRunRegistry` 只 gate `sendMessageAction` 自己的回调
 * （onChunk 遗留单槽 / onDone / onError 的 session 副作用），**没盖住 contentBlockHandler
 * 这条真正的渲染写入路径**；且 IPC 与 WS 两路都会喂 contentBlockHandler，只 gate IPC
 * 回调会从 WS 副本漏过去。该 registry 已删除，现以 run_id denylist 统一拦截。
 *
 * ## 修法
 *
 * 按 **daemon run_id** 建 per-session denylist：中断时把「当前正在流式那条 run 的
 * run_id」登记为 superseded；`streamMessageHandler` 在处理 content-block 事件前，若
 * `event.run_id ∈ denylist[session]` 就丢弃。新流是**不同 run_id**，照常通过——于是
 * 旧流尾部被两路一致地拦掉，新流立即渲染，「停得干净」与「插队即时」同时成立。
 *
 * run_id 全局唯一（wire `MessageStartSchema.run_id` 必填），同一 run 的多轮 LLM
 * 迭代共享同一 run_id，故不会误伤正常多轮。
 *
 * ## 内存
 *
 * 旧流尾部事件在中断后几秒内到齐，TTL 过后自动失效；会话清理时整段清掉。
 */

/** run_id 登记的存活时长——旧流尾部 unwind 通常秒级完成，给足冗余。 */
const TTL_MS = 60_000

/** sessionId → (run_id → 登记时刻)。 */
const supersededBySession = new Map<string, Map<string, number>>()

function pruneExpired(runIds: Map<string, number>, now: number): void {
  for (const [runId, ts] of runIds) {
    if (now - ts >= TTL_MS) runIds.delete(runId)
  }
}

/** 中断 / 顶替时登记：该 session 的这条 run_id 之后的尾部事件一律丢弃。 */
export function markRunSuperseded(sessionId: string, runId: string): void {
  if (!sessionId || !runId) return
  const now = Date.now()
  let runIds = supersededBySession.get(sessionId)
  if (!runIds) {
    runIds = new Map<string, number>()
    supersededBySession.set(sessionId, runIds)
  }
  runIds.set(runId, now)
  pruneExpired(runIds, now)
}

/** 该 run_id 是否已被作废（在 TTL 内登记过）。 */
export function isRunSuperseded(sessionId: string, runId: string): boolean {
  if (!sessionId || !runId) return false
  const runIds = supersededBySession.get(sessionId)
  if (!runIds) return false
  const ts = runIds.get(runId)
  if (ts === undefined) return false
  if (Date.now() - ts >= TTL_MS) {
    runIds.delete(runId)
    return false
  }
  return true
}

/** 会话清理 / 切走时清掉整段登记，避免内存堆积。 */
export function clearSupersededRuns(sessionId: string): void {
  supersededBySession.delete(sessionId)
}

/** 登录 / 登出 / 切组织：清全部登记。 */
export function clearAllSupersededRuns(): void {
  supersededBySession.clear()
}

/** Test-only：清空全部登记。 */
export function __resetSupersededRunsForTest(): void {
  clearAllSupersededRuns()
}
