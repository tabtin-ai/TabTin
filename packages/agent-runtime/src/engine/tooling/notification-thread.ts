import type { ToolContext } from '../contracts/tools.js';

/**
 * 后台完成通知的 drain 路由键。
 *
 * 子 Agent 的 `threadId` 必须继续跟父业务对话（ CLI / tab scope），
 * 但 `drainSubagentNotifications` 按 `childId`（`assistantSubagentRunId`）出队。
 * 通知入队必须用后者，否则会唤醒主 Agent。
 */
export function resolveToolNotificationThreadId(
  context: Pick<ToolContext, 'threadId' | 'assistantSubagentRunId'>,
): string {
  const childId = context.assistantSubagentRunId?.trim();
  return childId || context.threadId;
}
