/**
 * 硬截断路径——「当前任务状态」锚段 builder（ 钉锚截断）。
 *
 * SSoT 由本文件持有（宪法 v0.1 §3.1 "动态 builder 函数"硬条件）。
 *
 * 用途：hardTrim / truncateHead 等**无摘要**的截断出口会把创建 todo 的
 * `todo` 连同早期消息一起删掉，Agent 丢失任务状态后漂移（live 取证见
 * ）。截断前从完整消息回放出活跃待办合并态 + active plan 指针，
 * 拼成本段钉进截断告示——删的是消息，不删任务真相。
 *
 * 与 `task-continuity.ts`（压缩摘要路径的连续性段）的差异：
 *   - 本段展示**全量合并态**（含已完成项）——截断后没有摘要兜底，进度只能
 *     靠本段自证；task-continuity 只列未完成项（进度由摘要正文承载）。
 *   - 明确**不含首条用户指令原文**（2026-07-15 拍板）：任务是活的，首条指令
 *     可能已被后续修正覆盖；当前任务状态（todo 合并态）才是真相。
 */

import type {
  TaskContinuityPlan,
  TaskContinuityTodo,
} from './task-continuity.js';

const TRUNCATION_TASK_STATE_HEADER = '[当前任务状态——截断前的进度快照，继续按此推进]';

function statusMark(status: string): string {
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'in_progress') return '进行中';
  if (status === 'paused') return '已暂停';
  return '待办';
}

/**
 * 拼「当前任务状态」锚段。todos 与 plan 至少一个非空才输出；否则返回空字符串
 * （调用方短路——短会话无锚可钉时保持原有裸截断告示）。
 */
export function buildTruncationTaskStateSection(input: {
  todos?: TaskContinuityTodo[];
  plan?: TaskContinuityPlan | null;
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
    lines.push('待办清单（全量状态）：');
    for (const todo of todos) {
      lines.push(`- [${statusMark(todo.status)}] ${todo.content}`);
    }
  }

  if (lines.length === 0) return '';
  return `${TRUNCATION_TASK_STATE_HEADER}\n${lines.join('\n')}`;
}
