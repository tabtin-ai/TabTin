/**
 * TS-18 设备路径修复：从 `agent.prompt.forward` envelope 派生「双 id 模型」
 * 里的 relay session id 的纯函数。
 *
 * 抽到独立文件的目的（同 `workspace-snapshot-decode.ts`）：让 vitest 单测能
 * import 此函数验证派生行为，**而无须**把整个 `ElectronAgentHost.ts` 拉起来
 * （后者顶层 import 会传递地把 NotificationService / electron-log transports /
 * cli-server 等一大堆 main-process side effect 拉进来）。
 *
 * **与 Daemon `resolveRelaySessionId` 必须严格对齐**（`daemon.ts:1611-1617`）：
 * 跨宿主行为分歧会让「同一条 wire envelope 在 Electron forward 路径用错 id
 * 做 relay、在 Daemon forward 路径用对」成为隐藏 bug。
 *
 */

/**
 * The dual-key identity every host lifecycle operation is keyed on.
 *
 */
export interface ConversationLifecycleIdentity {
  /** Stable business conversation key used by the FIFO run queue. */
  conversationId: string
  sessionId: string
}

const RELAY_SESSION_PREFIX = 'chat-session-'

/**
 * 从 envelope 顶层 `thread_id` 派生 relay 用的真实 ChatSession UUID。
 *
 * - `chat-session-<uuid>` → `<uuid>`
 * - 不带前缀 / 空 / 非字符串 → `undefined`（调用方回落到 sessionId=task_id，
 *   与历史行为兼容；也覆盖 IPC 路径无 thread_id 的场景）
 */
export function deriveRelaySessionId(threadId: string | undefined | null): string | undefined {
  if (typeof threadId !== 'string') return undefined
  if (threadId.startsWith(RELAY_SESSION_PREFIX) && threadId.length > RELAY_SESSION_PREFIX.length) {
    return threadId.slice(RELAY_SESSION_PREFIX.length)
  }
  return undefined
}
