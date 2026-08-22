/**
 * Run Observations Injector Hook —— 每轮 LLM 前把宿主的异步运行观测
 * （浏览器 autofill / 运行时事件等）注入 messages（，Wave 1）。
 *
 * **历史背景**：本行为原内联在 `query.ts` 的 `injectRecentRunObservations`
 * （prepareIteration → injectHostMessages 固定位置）。#3939 策略迁移把它
 * 挂到新一代 `beforeModel` 扩展点，在每次 LLM 调用前注入运行观测。
 *
 * **行为不变**：
 *   1. 每轮 beforeModel 调 `getRecentRunObservations()`（宿主闭包，来自
 *      `EngineConfig.getRecentRunObservations`）
 *   2. 空数组 → 跳过
 *   3. 渲染 `<run_observations>` 块（时间戳 + humanReadable 行 + 决策提示）
 *      push 进 `state.messages`（role=user）
 *   4. 排一条 `run_observation_injected` SYSTEM_NOTICE
 *   5. fetch 抛错 → 排 `run_observation_inject_error` notice，不阻断 iteration
 *
 * **安全硬底线**：本 hook 不做任何脱敏 / 内容审查 —— 由宿主写入点
 * （`recordAgentAutofillObservation` 等）保证 `humanReadable` 已无密码 /
 * `credential_id` 明文。
 */

import type {
  EngineHooks,
  RunObservationInjection,
} from '../contracts/kernel.js';

// ─── 渲染 ────────────────────────────────────────────────────────────

/**
 * 把 host 返回的 RunObservation 列表拼成单条 user message 文本。
 *
 * **格式约定**（自 query.ts 原 `formatRunObservationInjection` 原样迁入）：
 * - `<run_observations>` XML-ish 块包裹（与 `<skills>` 同审美）；
 * - 块内每条 observation 一行 `- [HH:MM:SS] <humanReadable>`；
 * - 末尾附决策提示，让 LLM 真的把它们纳入决策。
 */
export function formatRunObservationInjection(
  observations: RunObservationInjection[],
): string {
  const lines = observations.map((obs) => {
    const ts = new Date(obs.timestamp);
    const hh = String(ts.getHours()).padStart(2, '0');
    const mm = String(ts.getMinutes()).padStart(2, '0');
    const ss = String(ts.getSeconds()).padStart(2, '0');
    return `- [${hh}:${mm}:${ss}] ${obs.humanReadable}`;
  });
  return [
    '<run_observations>',
    '自你上一轮之后，浏览器 / 运行时发生了以下事件：',
    ...lines,
    '',
    '这些观测描述的是发生在你直接工具调用之外的事件。请在下一步动作中将它们纳入考虑（例如：提醒用户某次登录失败、用不同的凭证重试，或退回到手动流程）。',
    '</run_observations>',
  ].join('\n');
}

// ─── Factory ─────────────────────────────────────────────────────────

export interface RunObservationsInjectorOptions {
  /** 宿主回调 —— 缺省时本 hook 空转（与原 config 字段缺省行为一致）。 */
  getRecentRunObservations?: () => Promise<RunObservationInjection[]>;
}

export function buildRunObservationsInjectorHook(
  options: RunObservationsInjectorOptions,
): EngineHooks {
  const { getRecentRunObservations } = options;
  return {
    async beforeModel(ctx): Promise<void> {
      if (!getRecentRunObservations) return;
      try {
        const observations = await getRecentRunObservations();
        if (observations.length === 0) return;
        const text = formatRunObservationInjection(observations);
        ctx.state.messages.push({
          role: 'user',
          content: [{ type: 'text', text }],
        });
        ctx.emitNotice({
          content: `${observations.length} run observation${observations.length > 1 ? 's' : ''} injected into LLM context.`,
          notice_type: 'run_observation_injected',
          severity: 'silent',
          observation_count: observations.length,
          observation_types: observations.map((o) => o.type),
          iteration: ctx.iteration,
        });
      } catch (err) {
        ctx.emitNotice({
          content: `getRecentRunObservations failed: ${String(err)}`,
          notice_type: 'run_observation_inject_error',
          severity: 'silent',
          iteration: ctx.iteration,
        });
      }
    },
  };
}
