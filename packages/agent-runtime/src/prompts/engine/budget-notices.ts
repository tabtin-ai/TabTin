/**
 * Engine 主循环——iteration / token budget warn / grace / terminate 阶段的
 * 用户面通知文案 + LLM system 注入文案 builder（共 5 个）。
 *
 * SSoT 由本文件持有。来源为旧 `engine/iteration-budget.ts:328-466`
 * 内嵌的 5 个 builder：
 *   - `buildBudgetWarnNoticeContent`        → warn 阶段用户面 SystemNoticeEvent.content（中文）
 *   - `buildBudgetWarnSystemInjection`      → warn 阶段 LLM system prompt 注入（中文）
 *   - `buildBudgetGraceNoticeContent`       → grace 阶段用户面通知（中文，含"本轮为最后一轮"措辞）
 *   - `buildBudgetGraceSystemInjection`     → grace 阶段 LLM system prompt 注入（中文 + 强力"不要"）
 *   - `buildBudgetTerminateNoticeContent`   → terminate 直接路径用户面通知（中文，与 grace 区分）
 *   - `buildBudgetGraceToolBlockedNoticeContent` → grace 期 LLM 仍 tool_use 的中文用户提示
 *
 * 按宪法 v0.1 §3.1（"动态 builder 函数"+"含中英文混排"硬条件）资源化。
 *
 * **语言纪律**（宪法 §3.6，2026-05-20 决策 4 修订为全中文化）：
 * - 用户面 SystemNoticeEvent.content 中文（直接给用户看）；
 * - LLM system prompt 注入 中文（原"必须英文"惯例已由决策 4 推翻）；
 * - 由本文件 snapshot 测试 + 注册表 P3 语言审计锁定边界。
 */

type IterationBudgetTrigger = 'iteration' | 'token';

interface IterationBudgetChannelEval {
  current: number;
  max: number;
  percent: number;
}

interface IterationBudgetEvaluation {
  stage: 'normal' | 'warn' | 'grace' | 'terminate';
  trigger: IterationBudgetTrigger | null;
  iteration: IterationBudgetChannelEval;
  token: IterationBudgetChannelEval;
}

const TRIGGER_LABEL: Record<IterationBudgetTrigger, string> = {
  iteration: '对话轮数',
  token: 'Token 用量',
};

function formatChannelUsage(
  trigger: IterationBudgetTrigger,
  channel: IterationBudgetChannelEval,
): string {
  if (trigger === 'iteration') {
    return `${Math.floor(channel.current)} / ${Math.floor(channel.max)} 轮`;
  }
  return `${Math.floor(channel.current).toLocaleString('en-US')} / ${Math.floor(channel.max).toLocaleString('en-US')} tokens`;
}

/**
 * warn 阶段——发给用户看的 SystemNoticeEvent.content（中文）。
 *
 * 短、客观；不报错语气，因为这只是预警。
 */
export function buildBudgetWarnNoticeContent(
  evaluation: IterationBudgetEvaluation,
): string {
  if (evaluation.stage !== 'warn' || evaluation.trigger === null) {
    return '';
  }
  const label = TRIGGER_LABEL[evaluation.trigger];
  const channel =
    evaluation.trigger === 'iteration' ? evaluation.iteration : evaluation.token;
  const percent = Math.round(channel.percent * 100);
  return (
    `${label}已达 ${percent}%（${formatChannelUsage(evaluation.trigger, channel)}）。` +
    'Agent 已收到提示开始收口，请准备查看本轮总结。'
  );
}

/**
 * warn 阶段——注入到 LLM 的 system prompt 段（中文）。
 *
 * 简洁明确：剩余预算紧张、考虑收口（与 doom-loop hint / convergence
 * reminder 同一惯例；决策 4 全中文化前为英文）。
 */
export function buildBudgetWarnSystemInjection(
  evaluation: IterationBudgetEvaluation,
): string {
  if (evaluation.stage !== 'warn' || evaluation.trigger === null) {
    return '';
  }
  const channel =
    evaluation.trigger === 'iteration' ? evaluation.iteration : evaluation.token;
  const percent = Math.round(channel.percent * 100);
  const triggerLabel =
    evaluation.trigger === 'iteration' ? '对话轮数' : 'Token 用量';
  return (
    `[系统 / 预算预警] 本次运行你已使用可用${triggerLabel}的 ${percent}%。` +
    '请开始收口：优先总结当前进展、完成手头正在进行的任务、' +
    '给出简洁的最终答复，而不是分支进入新的探索。'
  );
}

/**
 * grace 阶段——发给用户看的 SystemNoticeEvent.content（中文）。
 *
 * 关键沟通点（H3-A 真实用户视角 Review 修订）：
 * - 明确说"本轮为最后一轮"，避免用户以为现在就有总结；
 * - 提示"Agent 应在回复中列出未完成任务"，缓解"任务没干完就结束"焦虑；
 * - 不用"禁用工具调用"这种工程术语，改"不再调用工具，仅输出文字总结"。
 */
export function buildBudgetGraceNoticeContent(
  evaluation: IterationBudgetEvaluation,
): string {
  if (evaluation.stage !== 'grace' || evaluation.trigger === null) {
    return '';
  }
  const label = TRIGGER_LABEL[evaluation.trigger];
  const channel =
    evaluation.trigger === 'iteration' ? evaluation.iteration : evaluation.token;
  const percent = Math.round(channel.percent * 100);
  return (
    `${label}已达 ${percent}%（${formatChannelUsage(evaluation.trigger, channel)}）。` +
    '本轮为最后一轮：Agent 不再调用工具，仅基于当前进展输出文字总结，并应列出仍需继续的任务，' +
    '请等待本轮回复完成后查看。'
  );
}

/**
 * terminate 直接路径（跳过 grace）——发给用户看的 SystemNoticeEvent.content（中文）。
 *
 * **不要**复用 `buildBudgetGraceNoticeContent`：grace 文案承诺"Agent 将给出最终总结"，
 * 但 terminate 直接路径下根本不调 LLM、`DONE.content` 为空——承诺与结果矛盾会被
 * 用户感知为系统 bug（H3-A 三视角 Review P1 共识）。
 *
 * 这条文案承担两个职责：
 * 1. 明确"本轮没有再调用模型"——告诉用户"达上限了，但没有新输出"
 * 2. 引导用户看上方既有结果 / 新开会话——给出明确下一步动作
 */
export function buildBudgetTerminateNoticeContent(
  evaluation: IterationBudgetEvaluation,
): string {
  if (evaluation.stage !== 'terminate' || evaluation.trigger === null) {
    return '';
  }
  const label = TRIGGER_LABEL[evaluation.trigger];
  const channel =
    evaluation.trigger === 'iteration' ? evaluation.iteration : evaluation.token;
  const percent = Math.round(channel.percent * 100);
  return (
    `${label}已达 ${percent}%（${formatChannelUsage(evaluation.trigger, channel)}）。` +
    '本次对话已达上限，本轮未再调用模型；请查看上方既有结果，' +
    '或基于现有进展新开一段会话继续。'
  );
}

/**
 * grace 期 LLM 仍尝试 tool_use 时——发给用户看的中文提示。
 *
 * 三视角 Review（用户/产品/技术）共识 P1：原英文 notice 让用户"以为系统 bug"。
 * 中文化 + 解释清楚"为什么这是预期行为而非异常"。
 */
export function buildBudgetGraceToolBlockedNoticeContent(
  toolCount: number,
): string {
  return (
    `本轮为最后一轮（已禁用工具），但模型仍尝试调用 ${toolCount} 个工具——` +
    `已忽略，仅以文字回复为准。如发现总结不完整，可在新对话中继续。`
  );
}

/**
 * grace 阶段——注入到 LLM 的 system prompt 段（中文）。
 *
 * D3 决策：**完全禁止所有工具调用**（包括 present_to_user，灰度后视情放开）。
 * 强力措辞 + 重复"不要"——弱模型在 grace 期对工具的"惯性"很难遏制，
 * 多次重申才能压住（决策 4 全中文化前为英文）。
 */
export function buildBudgetGraceSystemInjection(
  evaluation: IterationBudgetEvaluation,
): string {
  if (evaluation.stage !== 'grace' || evaluation.trigger === null) {
    return '';
  }
  const channel =
    evaluation.trigger === 'iteration' ? evaluation.iteration : evaluation.token;
  const percent = Math.round(channel.percent * 100);
  const triggerLabel =
    evaluation.trigger === 'iteration' ? '对话轮数' : 'Token 用量';
  return (
    `[系统 / 预算宽限轮] 你已使用可用${triggerLabel}的 ${percent}%。` +
    '这是本次运行的最后一轮。工具已被禁用——不要尝试调用任何工具。' +
    '请立即基于你已知的信息给出简洁的最终答复：总结进展、列出仍需用户确认的开放问题，然后收尾。本轮回复后运行即终止。'
  );
}
