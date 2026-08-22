/**
 * P3 · runtime prompt 段语言纪律审计（阶段 5 全中文化回归保护）
 *
 * **填补的缺口**：`@tabtin/agent-prompt` 的 `audit.test.ts` P3 只覆盖 base prompt
 * 段（18 个 RENDERERS），`tool-description-audit.test.ts` P3 只覆盖工具 description
 * （32 个）。compact 链路 / convergence / 兜底等 **runtime 渲染的 prompt 段**
 * 此前没有任何 detectLanguage 渲染校验（agent-prompt audit:118-120 自承"由
 * agent-runtime audit 覆盖（暂未实装）"）。
 *
 * 本文件实装该覆盖：把这些段的渲染文本喂给 `checkLanguageDiscipline`，校验实际
 * 语言与 `SECTION_REGISTRY[id].language` 一致。阶段 5 把它们中文化后，若有人改回
 * 英文（descriptor 仍标 zh）或反向漂移，本 audit 立即 CI 红——给中文化上回归锁。
 *
 * **覆盖范围**：26 个段——直接 import 的 export 常量 + 入参为基础类型的 builder
 * + 通过 export 渲染函数取真实输出（`buildForkedMessages` 渲染整条 fork directive，
 * 覆盖 `BOILERPLATE_ZH` + directive template）。
 * **未纳入本 audit 的中文段及其回归现状**（如实记录，不夸大覆盖）：
 *   - `run_observations`（`formatRunObservationInjection` 私有）/ `continuation_user`
 *     （query.ts:3952 内联）—— 渲染路径深埋 runQuery，无独立 detectLanguage 锁，
 *     靠 P1/P4 descriptor 字段校验 + 人工 review；
 *   - `lsp_diagnostics`（`formatDiagnosticsSummary` 私有）—— 由
 *     `lsp-diagnostic-injector.test.ts` 的中文断言覆盖；
 *   - `skills_listing` / `context_pruning_*` placeholder —— 分别由
 *     `skills-fetcher-http.test.ts` / `history.test.ts` 的中文断言覆盖。
 */

import { describe, it, expect } from 'vitest';
import { REGISTRY_ENTRIES, checkLanguageDiscipline } from '@tabtin/prompt-contract';
import type { SectionDescriptor } from '@tabtin/prompt-contract';

import { COMPACT_SYSTEM_PROMPT } from '../compact/system.js';
import { COMPACT_USER_PROMPT } from '../compact/user.js';
import {
  INCREMENTAL_COMPACT_USER_INSTRUCTION,
} from '../compact/incremental-user.js';
import { buildIncrementalCompactSystemPrompt } from '../compact/incremental-system.js';
import { JUDGE_SYSTEM_PROMPT } from '../compact/judge-system.js';
import { buildJudgeUserPrompt } from '../compact/judge-user.js';
import { CONTINUING_ACK, UNDERSTOOD_ACK } from '../compact/inline-acks.js';
import { buildCompactedSummaryWrapper, RECENT_CONVERSATION_MARKER } from '../compact/wrapper.js';
import {
  CHUNK_TOO_LARGE_MARKER,
  buildPrunePlaceholder,
  buildEmergencyLayeredPruneSummary,
  EMERGENCY_HARD_TRIM_FALLBACK,
  SOFT_TRIM_FALLBACK,
} from '../compact/fallbacks.js';
import { buildRestoredFileContext } from '../compact/file-restore.js';
import { CONTEXT_TRUNCATED_PLACEHOLDER } from '../compact/truncation-placeholder.js';
import { TIME_BASED_MC_CLEARED_MESSAGE } from '../compact/time-based-cleared.js';
import { CONVERGENCE_HINT_WARNING, CONVERGENCE_HINT_ERROR } from '../capability/convergence-hints.js';
import {
  buildBudgetWarnSystemInjection,
  buildBudgetGraceSystemInjection,
} from '../engine/budget-notices.js';
import { FORK_PLACEHOLDER_RESULT, buildForkedMessages } from '../../subagent/fork-query.js';
import { buildToolFailureNudgeSystemInjection } from '../../engine/guards/tool-failure-tracker.js';
import { buildToolRepetitionNudgeSystemInjection } from '../../engine/guards/tool-repetition-tracker.js';
import { buildPersistMeta } from '../../engine/tooling/tool-orchestration.js';
import type { IterationBudgetEvaluation } from '../../engine/guards/iteration-budget.js';

const byId = new Map<string, SectionDescriptor>(REGISTRY_ENTRIES.map((e) => [e.id, e]));

// ── fixtures：让入参为复杂对象的 builder 能渲染出真实文本 ──
const warnEval: IterationBudgetEvaluation = {
  stage: 'warn',
  trigger: 'token',
  iteration: { current: 10, max: 30, percent: 0.33 },
  token: { current: 85_000, max: 100_000, percent: 0.85 },
} as IterationBudgetEvaluation;

const graceEval: IterationBudgetEvaluation = {
  stage: 'grace',
  trigger: 'token',
  iteration: { current: 28, max: 30, percent: 0.93 },
  token: { current: 95_000, max: 100_000, percent: 0.95 },
} as IterationBudgetEvaluation;

// id → 渲染文本。每个 renderer 产出该段注入给 LLM 的真实字符串。
const RENDERERS: Record<string, () => string> = {
  compact_system_prompt: () => COMPACT_SYSTEM_PROMPT,
  compact_user_prompt: () => COMPACT_USER_PROMPT,
  incremental_compact_system_prompt: () =>
    buildIncrementalCompactSystemPrompt('（先前摘要占位文本）', ''),
  incremental_compact_user_instruction: () => INCREMENTAL_COMPACT_USER_INSTRUCTION,
  compact_judge_system_prompt: () => JUDGE_SYSTEM_PROMPT,
  compact_judge_user_prompt_builder: () =>
    buildJudgeUserPrompt('先前摘要正文', '更新后摘要正文', [
      { role: 'user', content: '用户的一条新消息' },
    ]),
  compact_continuing_ack: () => CONTINUING_ACK,
  compact_understood_ack: () => UNDERSTOOD_ACK,
  compact_summary_wrapper: () => buildCompactedSummaryWrapper('摘要正文内容', '/tmp/session.jsonl'),
  compact_chunk_too_large_marker: () => CHUNK_TOO_LARGE_MARKER,
  compact_restored_file_context: () =>
    buildRestoredFileContext([{ path: 'src/a.ts', action: 'modified', content: '内容片段' }]),
  compact_context_truncated_placeholder: () => CONTEXT_TRUNCATED_PLACEHOLDER,
  time_based_microcompact_cleared_message: () => TIME_BASED_MC_CLEARED_MESSAGE,
  auto_compact_emergency_layered_prune_summary: () => buildEmergencyLayeredPruneSummary(1234),
  auto_compact_emergency_hard_trim_fallback: () => EMERGENCY_HARD_TRIM_FALLBACK,
  auto_compact_soft_trim_fallback: () => SOFT_TRIM_FALLBACK,
  layered_prune_placeholder: () => buildPrunePlaceholder('read_file'),
  convergence_hint: () => `${CONVERGENCE_HINT_WARNING}\n${CONVERGENCE_HINT_ERROR}`,
  budget_warn_system: () => buildBudgetWarnSystemInjection(warnEval),
  budget_grace_system: () => buildBudgetGraceSystemInjection(graceEval),
  stall_detection: () =>
    buildToolFailureNudgeSystemInjection({ tool: 'read_file', streak: 3, error_kind: 'os_access_error' } as never),
  repetition_detection: () =>
    buildToolRepetitionNudgeSystemInjection({ tool: 'grep_search', count: 4, windowMs: 30_000 } as never),
  subagent_fork_placeholder_result: () => FORK_PLACEHOLDER_RESULT,
  tool_output_persisted_truncation_banner: () =>
    buildPersistMeta({ kind: 'per-tool', original: 50_000, limit: 8_000, absPath: '/tmp/out.txt' }),
  // review 补：BOILERPLATE_ZH + directive 此前无渲染回归锁。buildForkedMessages 渲染
  // 出整条 fork directive（`<fork-boilerplate>{BOILERPLATE_ZH}</…>` + `你的指令：{task}`）。
  subagent_fork_boilerplate_zh: () => {
    const msgs = buildForkedMessages(
      [{ role: 'user', content: '帮我分析登录流程的鉴权失败' }],
      '调研鉴权模块并报告',
      {},
    );
    const last = msgs[msgs.length - 1]!;
    return typeof last.content === 'string' ? last.content : '';
  },
  subagent_fork_directive_template: () => {
    const msgs = buildForkedMessages(
      [{ role: 'user', content: '帮我改 X 文件' }],
      '执行 Y 任务',
      {},
    );
    const last = msgs[msgs.length - 1]!;
    return typeof last.content === 'string' ? last.content : '';
  },
};

describe('P3 · runtime prompt 段语言纪律（阶段 5 中文化回归保护）', () => {
  it.each(Object.keys(RENDERERS))(
    '%s: detectLanguage 与 descriptor.language 一致',
    (id) => {
      const descriptor = byId.get(id);
      expect(descriptor, `${id} 必须在 REGISTRY_ENTRIES 中登记`).toBeDefined();
      const text = RENDERERS[id]();
      const r = checkLanguageDiscipline(descriptor!, text);
      if (!r.ok) {
        throw new Error(
          `P3 语言纪律违规：${id}\n` +
            `  declared=${r.declared}，detected=${r.detected}\n` +
            `  渲染文本（前 160 字）：${text.slice(0, 160)}\n` +
            `— 治理动作：把该段文案改为符合声明语言（中文），或在 ` +
            `0_active_renderers.md 改 language + reason 后跑 extract_renderers.py。`,
        );
      }
      expect(r.ok).toBe(true);
    },
  );
});
