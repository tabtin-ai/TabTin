/**
 * Compact 路径——压缩后任务连续性（当前计划 / 进行中待办）重注入段 builder
 * （ 第二波）。
 *
 * SSoT 由本文件持有（宪法 v0.1 §3.1 "动态 builder 函数"硬条件）。
 *
 * 用途：单次长任务在压缩点恰好是任务中途——摘要可能把"干到哪一步了"写糊。
 * 压缩完成后把 active plan 指针与最近一次待办清单原样注入 summary user
 * message（`RECENT_CONVERSATION_MARKER` 之前），让智能体压缩后不用从摘要里
 * "猜"自己的进度。与文件内容重注入（file-restore.ts）同机制、同插入位置。
 */

const TASK_CONTINUITY_HEADER = '[任务连续性——压缩时正在进行的计划与待办]';

export interface TaskContinuityPlan {
  /** file 载体 = 本地 plan 文件路径；document 载体 = 云文档 id。 */
  kind: 'file' | 'document';
  /** 路径或文档 id。 */
  target: string;
}

export interface TaskContinuityTodo {
  id: string;
  content: string;
  status: string;
}

/**
 * 拼接"任务连续性"段。plan 与 todos 至少一个非空才输出；否则返回空字符串
 * （上游应自行短路）。
 */
export function buildTaskContinuitySection(input: {
  plan?: TaskContinuityPlan | null;
  todos?: TaskContinuityTodo[];
}): string {
  const lines: string[] = [];

  if (input.plan) {
    lines.push(
      input.plan.kind === 'file'
        ? `当前计划文件：${input.plan.target}（继续前请回读确认进度）`
        : `当前计划文档：${input.plan.target}（继续前请回读确认进度）`,
    );
  }

  const todos = input.todos ?? [];
  if (todos.length > 0) {
    lines.push('最近一次待办状态（未完成项）：');
    for (const todo of todos) {
      const mark = todo.status === 'in_progress'
        ? '进行中'
        : todo.status === 'paused'
          ? '已暂停'
          : '待办';
      lines.push(`- [${mark}] ${todo.content}`);
    }
  }

  if (lines.length === 0) return '';
  return `\n\n---\n\n${TASK_CONTINUITY_HEADER}\n${lines.join('\n')}`;
}
