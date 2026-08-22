/**
 * Prompt resource bundle (TS side, for Local ReAct engine).
 *
 * 与 Django 端 `apps/services/llm/scenes/bundled/` 下的 SCENE.md / system.md
 * 体系互补——本目录下的 .ts 常量 / builder 服务于 agent-runtime 引擎内部 prompt
 * （compact / engine / capability 三大类），Django 端 SCENE bundle 服务于
 * 平台 LLM 调用主路径（17 个 chat 业务 + 1 vision scene）。
 *
 * 设计目标见宪法 v0.1 §3：
 *   - 同文档 §3.3 必须 inline 在 .ts 的硬条件
 *   - 同文档 §3.5 快照测试纪律
 */

// ─── engine/ —— 主循环 prompts ───────────────────────────────────────
//
// 历史 dead export 清理记录：
//   - 2026-05-14: ENGINE_IDENTITY_PROMPT / SYSTEM_IDENTITY_PROMPT 删除
//     （身份段由 `@tabtin/agent-prompt::buildIdentitySection` 提供）
//   - 阶段 2.1 (2026-05-20): ENGINE_EXECUTION_PROMPT / SYSTEM_PERSISTENCE_PROMPT /
//     ENGINE_SAFETY_PROMPT / SYSTEM_SAFETY_PROMPT 删除（替代物：
//     `@tabtin/agent-prompt::SECTION_EXECUTION` / `SECTION_SAFETY` 中文版）
//   - 阶段 2.1 (2026-05-20): PROACTIVE_REPORT_RULES 删除（hook 注入路径
//     从未接通，0 production caller）
export {
  buildBudgetWarnNoticeContent,
  buildBudgetWarnSystemInjection,
  buildBudgetGraceNoticeContent,
  buildBudgetGraceSystemInjection,
  buildBudgetTerminateNoticeContent,
  buildBudgetGraceToolBlockedNoticeContent,
} from './engine/budget-notices.js';
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './engine/dynamic-boundary.js';

// ─── compact/ —— 压缩链路 prompts ────────────────────────────────────
export { COMPACT_SYSTEM_PROMPT } from './compact/system.js';
export { COMPACT_USER_PROMPT } from './compact/user.js';
export {
  INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE,
  buildIncrementalCompactSystemPrompt,
} from './compact/incremental-system.js';
export { INCREMENTAL_COMPACT_USER_INSTRUCTION } from './compact/incremental-user.js';
export { JUDGE_SYSTEM_PROMPT } from './compact/judge-system.js';
export { buildJudgeUserPrompt } from './compact/judge-user.js';
// W3 (2026-05-10): `auto-condense.ts` (TRIGGER_MARKER /
// SUMMARIZE_TRIGGER_PROMPT / WAIT_REMINDER_PROMPT / FORCE_CONDENSE_PROMPT)
// and `summarize-tool-spec.ts` (SUMMARIZE_CONTEXT_TOOL) deleted alongside
// the `summarize_context` tool. Runtime-driven `auto-compact` (LLM summary
// in `compact/auto-compact.ts`) replaces the LLM-driven self-condensation
// loop — we no longer ask the model to condense its own context.
export { CONTINUING_ACK, UNDERSTOOD_ACK } from './compact/inline-acks.js';
export {
  RECENT_CONVERSATION_MARKER,
  SUMMARY_HEADER_MARKER,
  buildCompactedSummaryWrapper,
} from './compact/wrapper.js';
export { CHUNK_TOO_LARGE_MARKER } from './compact/fallbacks.js';
export {
  buildRestoredFileContext,
  type RestoredFileEntry,
} from './compact/file-restore.js';
export { CONTEXT_TRUNCATED_PLACEHOLDER } from './compact/truncation-placeholder.js';
export { TIME_BASED_MC_CLEARED_MESSAGE } from './compact/time-based-cleared.js';
// W3 (2026-05-10): `archive-hint.ts` deleted along with `retrieve_tool_result`.
// Truncation banners now embed the absolute file path inline (see
// `tool-orchestration.ts::enforceToolOutputBudget`) and direct the LLM at
// `read_file`, not at a removed retrieve tool.

// ─── capability/ —— governance 文案 ──────────────────────────────────
export {
  CONVERGENCE_HINT_WARNING,
  CONVERGENCE_HINT_ERROR,
} from './capability/convergence-hints.js';
// ：MEDIA_IMAGE_CLI_INSTRUCTION 是 CliCap 独占的平台文生图指令，
// 已随 CliCap 迁出 core（宿主平台 Cap 层）。
