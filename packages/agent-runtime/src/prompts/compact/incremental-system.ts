/**
 * Compact 路径——增量摘要的 system prompt 模板 + 拼接函数。
 *
 * SSoT 由本文件持有。来源为旧 `compact/incremental-prompt.ts:33-52, 85-105`
 * 的 `INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE` + `buildIncrementalCompactSystemPrompt`；
 * 按宪法 v0.1 §3.1 资源化。
 *
 * 设计要点（来自原 docstring）：
 * - 模板把 `{{PRIOR_SUMMARY}}` 嵌入 system，避免 LLM 把 prior 当作"用户最新指令"；
 * - 当作 system 输入时，主流 provider（Anthropic/OpenAI/Bedrock）按 system 优先级处理；
 * - `originalSystemPrompt` 为空时省略 reference 段，让 prompt 更紧凑。
 */
export const INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE = [
  '你是一个增量式对话摘要器。',
  '',
  '你会拿到一份已有的 PRIOR_SUMMARY（已校验，不要改动其中的事实）。',
  '随后你会看到在 PRIOR_SUMMARY 生成之后发生的若干对话轮次（NEW_MESSAGES）。',
  '你的任务是产出一份更新后的摘要，要求：',
  '  - 保留 PRIOR_SUMMARY 中的每一处具体细节（文件路径、错误信息、',
  '    决策、待办任务、代码片段、设置）。',
  '  - 把 NEW_MESSAGES 中的每一条新事实 / 决策 / 文件变更 / 错误都并入。',
  '  - 保持 PRIOR_SUMMARY 使用的同样九段结构。',
  '  - 不要丢失 PRIOR_SUMMARY 中的信息，即使 NEW_MESSAGES 没有再次提到。',
  '  - 不要编造既不在 PRIOR_SUMMARY 也不在 NEW_MESSAGES 中的事实。',
  '',
  '只回复更新后的摘要正文本身。不要调用任何工具。',
  '',
  '=== PRIOR_SUMMARY（请保留下方每一处细节）===',
  '{{PRIOR_SUMMARY}}',
  '=== END PRIOR_SUMMARY ===',
].join('\n');

/**
 * 拼接增量 system prompt——把 PRIOR_SUMMARY 嵌入模板。
 *
 * `originalSystemPrompt` 是引擎当前会话的原 system（用户 persona / custom_rules
 * 等）；为避免污染 PRIOR_SUMMARY 的"事实约束"语义，原 system 以"参考"身份附在
 * 模板末尾，告诉 judge / summarizer "这是会话原本的角色设定，仅供理解"。
 *
 * 当 `originalSystemPrompt` 为空时省略附录段，让 prompt 更紧凑。
 */
export function buildIncrementalCompactSystemPrompt(
  priorSummary: string,
  originalSystemPrompt: string,
): string {
  const base = INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE.replace(
    '{{PRIOR_SUMMARY}}',
    priorSummary,
  );

  if (!originalSystemPrompt || originalSystemPrompt.trim().length === 0) {
    return base;
  }

  return [
    base,
    '',
    '--- 原始对话 system prompt（仅供参考）---',
    originalSystemPrompt,
    '--- 原始 system prompt 结束 ---',
  ].join('\n');
}
