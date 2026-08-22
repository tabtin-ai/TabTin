/**
 * Agent Mode 注入到 system prompt 的额外段落。
 *
 * SSoT 是 `src/agent-modes/prompts/*.md` —— 修改 prompt 只需编辑 .md 文件，
 * build 时由 `scripts/gen-prompt-sections.mjs` 生成 `prompt-content.generated.ts`。
 *
 * 设计参考：
 *   - Plan Mode 提示（强约束 + 单一退出工具）
 *   - Django `apps/services/agent_engine/prompts/base/agent_mode.py` 中的中文段落（保持双语风格）
 *
 * 文案风格：
 *   - 用 XML <agent_mode> 包裹，与 Django 端一致；前端 PromptInspector 可直接抓取。
 *   - 对模型给出强约束 + 工具白名单 + 退出条件三件套。
 *   - 中英文双语：中文做主旨陈述，英文做硬约束（兼顾英文模型的指令理解能力）。
 *
 * Plan / Study 模式使用 `plan_create / plan_update_todos` 二件套创建或修订
 * 结构化方案；`plan_exit` 已移除。执行权不在模型手里，而是由用户点击
 * chat 内的 PlanProposalCard「执行」按钮触发后续执行链路。
 */

import {
  PROMPT_PLAN,
  PROMPT_ASK,
  PROMPT_STUDY,
  PROMPT_GROUP,
} from './prompt-content.generated.js';

export const SECTION_AGENT_MODE_PLAN = PROMPT_PLAN;

export const SECTION_AGENT_MODE_ASK = PROMPT_ASK;

export const SECTION_AGENT_MODE_STUDY = PROMPT_STUDY;

export const SECTION_AGENT_MODE_GROUP = PROMPT_GROUP;

/**
 * 'agent' 模式不注入额外段，保持现有行为完全不变（回归测试基线）。
 * 任何想给 'agent' 模式新增的"默认行为"都应当走 buildExecutionSection / buildSafetySection
 * 等通用 section，而不是塞到 <agent_mode> 里 —— 否则会污染对其它 mode 的回归判断。
 */
export const SECTION_AGENT_MODE_AGENT: string | null = null;

/**
 * PR1 (2026-05-18)：Yolo 模式 prompt section 默认 null（同 agent）。
 * yolo 与 agent 在工具集与 prompt 注入上等价，差异仅体现在 authorizationPreset='full_auto'，
 * 由 daemon sandbox_policy 派生 / electron judge.ts step3 消费。如果未来产品要单独提示 LLM
 * "你现在在 yolo 模式"，再起 yolo.md（同时更新 gen-prompt-sections.mjs MODES 数组）。
 */
export const SECTION_AGENT_MODE_YOLO: string | null = null;

export const AGENT_MODE_PROMPT_SECTIONS: Readonly<
  Record<'ask' | 'agent' | 'plan' | 'study' | 'yolo' | 'group', string | null>
> = {
  ask: SECTION_AGENT_MODE_ASK,
  agent: SECTION_AGENT_MODE_AGENT,
  plan: SECTION_AGENT_MODE_PLAN,
  study: SECTION_AGENT_MODE_STUDY,
  yolo: SECTION_AGENT_MODE_YOLO,
  group: SECTION_AGENT_MODE_GROUP,
};
