/**
 * todo-replay —— 从对话历史回放 `todo` tool_use。
 *
 * 回放语义与 `applyTodoAction` / Electron `deriveTodoTimeline` 一致：
 * open 开表；add/update/remove 改当前 open；close / 自动关封存。
 *
 * 提交边界（ live）：
 * - 仅成功的 todo 计入状态（配对 `tool_result.is_error` 的跳过）
 * - execute 路径排除当前 in-flight `toolUseId`，避免「先 push 再执行」自撞
 */

import type { Message } from '../engine/contracts/conversation.js';
import type { TaskContinuityTodo } from '../prompts/compact/task-continuity.js';
import {
  applyTodoAction,
  replayTodoActions,
  type TodoItem,
  type TodoListState,
} from './todo-state-machine.js';

export type { TaskContinuityTodo };

/**
 * 会话级 todo 锚：hook 注入与工具 execute 共用同一盒子，
 * 抵抗上下文截断后窗口内已无 `todo` 事件时写路径失联。
 */
export type TodoSessionAnchor = { current: TaskContinuityTodo[] | null };

export interface ActiveTodoBatch {
  todos: TaskContinuityTodo[];
  settled: boolean;
}

/** derive / execute 回放选项。 */
export interface DeriveTodoOptions {
  /** 排除这些 tool_use id（通常为当前正在 execute 的调用）。 */
  excludeToolUseIds?: ReadonlySet<string> | readonly string[];
}

function asTaskTodos(items: readonly TodoItem[]): TaskContinuityTodo[] {
  return items.map((t) => ({ id: t.id, content: t.content, status: t.status }));
}

function toExcludeSet(
  exclude?: DeriveTodoOptions['excludeToolUseIds'],
): ReadonlySet<string> {
  if (!exclude) return new Set();
  return exclude instanceof Set ? exclude : new Set(exclude);
}

/** 收集配对失败的 todo tool_use id（任意 role 上的 tool_result）。 */
function collectFailedTodoToolUseIds(messages: readonly Message[]): Set<string> {
  const failed = new Set<string>();
  const todoIds = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === 'todo') {
        todoIds.add(block.id);
      }
    }
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result' || !block.is_error) continue;
      if (todoIds.has(block.tool_use_id)) {
        failed.add(block.tool_use_id);
      }
    }
  }
  return failed;
}

function collectTodoActions(
  messages: readonly Message[],
  options?: DeriveTodoOptions,
): Array<{ input: unknown }> {
  const failed = collectFailedTodoToolUseIds(messages);
  const exclude = toExcludeSet(options?.excludeToolUseIds);
  const actions: Array<{ input: unknown }> = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || block.name !== 'todo') continue;
      if (exclude.has(block.id) || failed.has(block.id)) continue;
      actions.push({ input: block.input });
    }
  }
  return actions;
}

/**
 * 重放全部 assistant `todo` 调用，返回当前 open 批；无 open 时：
 * - 从未建过 → null
 * - 最后一批已 close → `{ settled: true, todos: 关闭快照 }`（供锚更新；hook 不注入）
 */
export function deriveActiveTodoBatch(
  messages: readonly Message[],
  seedTodos?: readonly TaskContinuityTodo[],
  options?: DeriveTodoOptions,
): ActiveTodoBatch | null {
  const actions = collectTodoActions(messages, options);
  const seedOpen =
    seedTodos && seedTodos.length > 0
      ? (seedTodos.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status as TodoItem['status'],
        })) as TodoItem[])
      : null;

  // ：仅当窗口内已无任何 todo 事件时用会话锚作种子；否则以消息重放为准，
  // 避免「种子当 open + 历史再 open」导致动作被跳过。
  const { state, lastClosedSnapshot } = replayTodoActions(
    actions,
    actions.length === 0 ? seedOpen : null,
  );

  if (state.open) {
    return { todos: asTaskTodos(state.open), settled: false };
  }
  if (lastClosedSnapshot && lastClosedSnapshot.length > 0) {
    return { todos: asTaskTodos(lastClosedSnapshot), settled: true };
  }
  if (actions.length === 0 && seedOpen) {
    const settled = seedOpen.every(
      (t) => t.status === 'completed' || t.status === 'cancelled',
    );
    return { todos: asTaskTodos(seedOpen), settled };
  }
  return null;
}

/** 当前 open 列表（未关闭）；无则 null。供工具 execute 校验。 */
export function deriveOpenTodoList(
  messages: readonly Message[],
  seedTodos?: readonly TaskContinuityTodo[],
  options?: DeriveTodoOptions,
): TodoListState {
  const batch = deriveActiveTodoBatch(messages, seedTodos, options);
  if (!batch || batch.settled) return { open: null };
  return {
    open: batch.todos.map((t) => ({
      id: t.id,
      content: t.content,
      status: t.status as TodoItem['status'],
    })),
  };
}

/** 最后一批里仍未最终完成的项（compact 任务连续性）。paused 仍是未完成。 */
export function extractLatestUnfinishedTodos(messages: readonly Message[]): TaskContinuityTodo[] {
  const batch = deriveActiveTodoBatch(messages);
  if (!batch || batch.settled) return [];
  return batch.todos.filter(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'paused',
  );
}

/** end_turn gate 专用：只催 Agent 当前还能主动推进的项，paused 表示先释放本轮。 */
export function extractLatestActionableTodos(messages: readonly Message[]): TaskContinuityTodo[] {
  const batch = deriveActiveTodoBatch(messages);
  if (!batch || batch.settled) return [];
  // paused 是当前 run 的显式暂停信号。后续 pending 项仍留在任务连续性里，
  // 但不能越过尚未解除的阻塞项继续催模型执行或逼迫它 close 整份清单。
  if (batch.todos.some((todo) => todo.status === 'paused')) return [];
  return batch.todos.filter(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  );
}

/**
 * 当前活跃批里那条 `in_progress` todo 的 content。
 */
export function extractInProgressTodo(messages: readonly Message[]): string {
  const batch = deriveActiveTodoBatch(messages);
  if (!batch || batch.settled) return '';
  const current = batch.todos.find((todo) => todo.status === 'in_progress');
  return current?.content.trim() ?? '';
}

/** 供测试 / 调试：直接对状态应用一次 action。 */
export { applyTodoAction };
