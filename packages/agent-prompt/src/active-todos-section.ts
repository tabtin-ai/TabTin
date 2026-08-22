/**
 * 每轮注入 LLM 的活跃待办快照段。
 *
 * 与 compact 路径的 `buildTaskContinuitySection` 分工：后者只在压缩后注入
 * **未完成项**；本 builder 在每轮 iteration 列出**全批合并态**（含 completed）。
 */

export interface ActiveTodoItem {
  id: string;
  content: string;
  status: string;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'cancelled':
      return '已取消';
    default:
      return '待办';
  }
}

/**
 * 拼接活跃待办段正文（不含 `<context>` 外壳——由 hook 套 `buildUserContextWrapper`）。
 */
export function buildActiveTodosSection(input: { todos: ActiveTodoItem[] }): string {
  const countable = input.todos.filter(t => t.status !== 'cancelled');
  const done = countable.filter(t => t.status === 'completed').length;
  const total = countable.length;

  const lines: string[] = [`当前待办进度：${done}/${total}`];
  for (const todo of input.todos) {
    lines.push(`- [${statusLabel(todo.status)}] ${todo.content}`);
  }
  lines.push('');
  lines.push(
    '用 todo(action="update") 更新未完成项；遇到等待用户、授权、登录或外部系统时，把当前项标为 paused 并说明恢复条件，然后结束本轮且不要 close 清单；解除阻塞后再恢复推进到 completed。',
  );
  lines.push(
    '全部完成后会自动关闭列表；明确放弃才用 todo(action="close")。新计划须先关闭再 open。',
  );
  return lines.join('\n');
}

/** end_turn gate：列出未完成项，要求立即 todo 收尾。 */
export function buildTodoCompletionNudgeBody(
  unfinished: readonly ActiveTodoItem[],
): string {
  const lines: string[] = [
    '你尚未用 todo 收尾可继续推进的待办项。不要先写总结或说「完成了」。',
    '请立即调用 todo(action="update") 更新下列项；如果被用户授权、登录、输入或外部状态阻塞，把对应项标为 paused 并在 content 里写明恢复条件：',
  ];
  for (const todo of unfinished) {
    const mark = todo.status === 'in_progress'
      ? '进行中'
      : todo.status === 'paused'
        ? '已暂停'
        : '待办';
    lines.push(`- id="${todo.id}" [${mark}] ${todo.content}`);
  }
  lines.push('');
  lines.push('可推进项要更新为 completed；确实被阻塞的项可标为 paused 结束本轮，但解除阻塞后仍必须恢复并完成。');
  return lines.join('\n');
}
