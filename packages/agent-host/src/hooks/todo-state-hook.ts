/**
 * Todo State Hook —— 每轮 iteration 注入当前活跃待办快照。
 *
 * **归属（ Phase 1）**：本 hook 原名 `buildTodoStateInjectorHook`，住在
 * `@tabtin/agent-runtime` 的 `capability/injectors/todo-state-injector.ts`。因它依赖
 * `@tabtin/agent-modes` + `@tabtin/agent-prompt`，随「引擎零业务依赖」重构迁到宿主
 * `@tabtin/agent-host/hooks`。行为逐字节一致，仅换归属与工厂名
 * （`buildTodoStateInjectorHook` → `buildTodoStateHook`）。
 *
 * 仅 agent mode；有未收尾批时把全量合并态写入 `<context type="active-todos">`。
 * per-iteration：每轮 filter 掉上一轮的注入块 + 重插单块，messages 里始终只有一块
 * 最新快照，不堆积。
 *
 * **注入位置**：贴在**最后一次 `todo` 的 tool_result 之后**（按时序，
 * 与 Agent 工作流对齐）。窗口内没有 `todo`（被上下文截断）时回落到当前 user
 * turn 附近。
 *
 * **会话级持久锚（方案 A，）**：活跃 todo 批次缓存在闭包里（runtime 跨轮复用
 * → 闭包即会话级），每轮以缓存为种子回放 `todo`——抵抗上下文窗口截断丢消息。
 */

import type { AgentModeName } from '@tabtin/agent-modes'
import {
  buildActiveTodosSection,
  buildUserContextWrapper,
} from '@tabtin/agent-prompt'
import type { Message, EngineHooks, IterationHookContext } from '@tabtin/agent-runtime/engine'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  findLastRealUserIndex,
} from '@tabtin/agent-runtime/engine'
import {
  deriveActiveTodoBatch,
  type TodoSessionAnchor,
} from '@tabtin/agent-runtime'
import { removeTaggedBlock, upsertTaggedBlock } from './message-inject.js'

export interface TodoStateHookOptions {
  getAgentMode: () => AgentModeName | undefined
  /**
   * 与 `createCoreTools({ todoSessionAnchor })` 共用的会话锚。
   * 缺省时 hook 自建闭包盒子（单测 / 未接线宿主仍可用；execute 则拿不到锚）。
   */
  sessionAnchor?: TodoSessionAnchor
}

const TODO_STATE_MARKER = INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION
const CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION
const MEMORY_MARKER = INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION

/** 取 assistant 消息里所有 `todo` tool_use 的 id（非 assistant / 无则空）。 */
function todoWriteToolUseIds(msg: Message): string[] {
  if (msg.role !== 'assistant' || typeof msg.content === 'string') return []
  const ids: string[] = []
  for (const block of msg.content) {
    if (block.type === 'tool_use' && block.name === 'todo') ids.push(block.id)
  }
  return ids
}

/** 该 user 消息是否携带 `ids` 中任一 tool_use 的 tool_result。 */
function carriesTodoResult(msg: Message, ids: ReadonlySet<string>): boolean {
  if (msg.role !== 'user' || typeof msg.content === 'string') return false
  return msg.content.some(
    (block) => block.type === 'tool_result' && ids.has(block.tool_use_id),
  )
}

/**
 * 时序插入点：最后一次 `todo` 的 tool_result 之后（返回插入 index）。窗口内无
 * `todo` → 返回 null，交由调用方回落到当前 user turn 附近。
 *
 * **关键约束**：锚点取 tool_result 而非 tool_use 本身——绝不能把注入消息插进
 * `todo` 的 tool_use 与其 tool_result 之间，否则破坏 API 的配对。
 */
function findChronoInsertIndex(messages: readonly Message[]): number | null {
  let lastWriteIdx = -1
  let lastWriteIds: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const ids = todoWriteToolUseIds(messages[i]!)
    if (ids.length > 0) {
      lastWriteIdx = i
      lastWriteIds = ids
    }
  }
  if (lastWriteIdx < 0) return null

  const idSet = new Set(lastWriteIds)
  for (let j = lastWriteIdx + 1; j < messages.length; j++) {
    if (carriesTodoResult(messages[j]!, idSet)) return j + 1
  }
  // tool_result 尚未落入 messages——真实运行下工具相位必在下轮前补齐，此处仅为
  // 边界兜底：退回 todo 之后。
  return lastWriteIdx + 1
}

/**
 * 回落插入点（窗口内无 todo，通常来自上下文截断）：贴当前 user turn 尾部——
 * 有 context/memory 注入则跟其后，否则插到最后一条真实用户消息之前；连真用户消息都
 * 没有 → 末尾。对齐 memory hook。
 */
function findFallbackInsertIndex(filtered: readonly Message[]): number {
  const ctxIdx = filtered.findIndex((m) => hasInternalMarker(m, CONTEXT_MARKER))
  if (ctxIdx >= 0) {
    let insertAt = ctxIdx + 1
    if (
      insertAt < filtered.length &&
      hasInternalMarker(filtered[insertAt]!, MEMORY_MARKER)
    ) {
      insertAt += 1
    }
    return insertAt
  }
  const userIdx = findLastRealUserIndex(filtered)
  if (userIdx < 0) return filtered.length
  return userIdx
}

/**
 * 构造 todo-state hook —— per-iteration 单块注入。仅 agent mode；有未收尾
 * 批次时把全量合并态写入 `<context type="active-todos">`。
 *  - 非 agent mode：清掉旧块 + 结束（shouldClearStale 语义）；
 *  - batch 为空 / settled → 不注入，写回 filtered（撤旧块）；settled 前仍更新会话级锚；
 *  - 会话级锚 `anchorTodos` 落在闭包（runtime 跨轮复用实例 → 会话级）；
 *  - 插位 = 时序锚 ?? 回落锚。
 */
export function buildTodoStateHook(options: TodoStateHookOptions): EngineHooks {
  // 会话级持久锚：与 createCoreTools 共用盒子时活到 Space 切换 / reload；
  // 否则退化为 hook 私有闭包（行为与接线前一致，但 execute 读不到锚）。
  const anchor: TodoSessionAnchor =
    options.sessionAnchor ?? { current: null }

  return {
    async beforeIteration(ctx: IterationHookContext): Promise<void> {
      const state = ctx.state

      // 非 agent mode：清掉自己的旧块后结束（per-iteration 的 off 语义）。
      if ((options.getAgentMode() ?? 'agent') !== 'agent') {
        state.messages = removeTaggedBlock(state.messages, TODO_STATE_MARKER)
        return
      }

      const filtered = removeTaggedBlock(state.messages, TODO_STATE_MARKER)

      const batch = deriveActiveTodoBatch(filtered, anchor.current ?? undefined)
      if (!batch) {
        // 从未建过 todo（且无锚）——无待办可注入，写回 filtered（撤可能残留的旧块）。
        state.messages = filtered
        return
      }
      // 更新会话级锚（含 completed/cancelled 的最新状态）——即便随后的轮次被截断
      // 丢掉 todo，锚仍保留全量批次与进度。
      anchor.current = batch.todos
      if (batch.settled) {
        state.messages = filtered
        return
      }

      const content = buildUserContextWrapper(
        'active-todos',
        buildActiveTodosSection({ todos: batch.todos }),
      )
      state.messages = upsertTaggedBlock(state.messages, {
        marker: TODO_STATE_MARKER,
        content: [{ type: 'text', text: content }],
        position: (f) => findChronoInsertIndex(f) ?? findFallbackInsertIndex(f),
      })
    },
  }
}
