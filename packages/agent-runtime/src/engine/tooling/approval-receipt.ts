/**
 * Approval Receipt — 给「批准 / 自动放行」补上与「拒绝」对称的上下文回执。
 *
 * 背景：审批结果进 LLM 上下文的路径原本不对称——
 *   - 拒绝：`denyAskItem` 把 `User denied tool 'xxx'.` 作为 tool_result 喂回 LLM；
 *   - 批准：allow 分支只是执行工具，LLM 只看到工具输出，**没有「已获批准」信号**；
 *   - memo「始终允许」自动放行更隐形：judge 阶段就判 allow，连审批都不弹。
 *
 * 本模块产出一条简短回执，前置到被批准工具的 tool_result 内容里，让 Agent 明确
 * 「这个动作是用户批准 / 按用户既有授权自动放行的」。回执用 `<approval_note>`
 * 包裹（与 deny 的 `<tool_use_error>` 同类：告诉模型这是运行时元信号而非工具输出）。
 * 文案用英文，与 runtime 其它面向 LLM 的权限 meta 文案（deny / subagent 指引）一致。
 *
 * 刻意不覆盖「权限模式 full_access 等常规自动放行」——那是配置态而非一次审批事件，
 * 逐条标注只会污染上下文（详见  方案「刻意不做」）。
 */

import type { ContentBlock } from '../contracts/conversation.js';
import type { ToolResult } from '../contracts/tools.js';

/**
 * 审批回执来源：
 *   - `user_approval`：用户当场在审批面板点了「允许」。
 *   - `memo`：命中用户此前「始终允许」记忆，judge 阶段自动放行。
 */
export type ApprovalReceipt = { source: 'user_approval' } | { source: 'memo' };

/**
 * 构造回执文案。`toolName` 来自 registry（安全标识符），不含 XML 标签闭合风险。
 */
export function buildApprovalReceiptText(toolName: string, receipt: ApprovalReceipt): string {
  const note = receipt.source === 'memo'
    ? `Tool '${toolName}' was auto-approved by the user's standing "always allow" rule.`
    : `User approved tool '${toolName}'.`;
  return `<approval_note>\n${note}\n</approval_note>`;
}

/**
 * 把回执前置到 tool_result 内容。同时处理 `content` 与 `llmContextContent`
 * （`summarizeToolOutput` 优先取 `llmContextContent` 喂 LLM，只改 `content`
 * 在 shell slim 路径会丢回执），两者都是短前缀，不触发截断旁路。
 */
export function prependApprovalReceiptToResult(result: ToolResult, receiptText: string): ToolResult {
  return {
    ...result,
    content: prependToContent(result.content, receiptText),
    ...(result.llmContextContent !== undefined
      ? { llmContextContent: prependToContent(result.llmContextContent, receiptText) }
      : {}),
  };
}

function prependToContent(
  content: string | ContentBlock[],
  receiptText: string,
): string | ContentBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? `${receiptText}\n\n${content}` : receiptText;
  }
  return [{ type: 'text', text: receiptText }, ...content];
}
