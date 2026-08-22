/**
 * E1 / 宪法 v0.1 §3.5——compact 路径 prompts 的快照测试。
 *
 * 锁定文本：改 prompt 必跑测试 + review snapshot diff。这是引擎内部 prompt 的
 * "git 友好版 review"：snapshot 改动出现在 PR diff 中，强制 reviewer 看清楚
 * "动了哪一段"。
 *
 * 覆盖：
 *   - COMPACT_SYSTEM_PROMPT / COMPACT_USER_PROMPT
 *   - INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE / INCREMENTAL_COMPACT_USER_INSTRUCTION
 *   - JUDGE_SYSTEM_PROMPT
 *   - buildIncrementalCompactSystemPrompt（动态拼接：含/不含 originalSystemPrompt）
 *   - buildJudgeUserPrompt（动态拼接：含/不含 NEW_MESSAGES）
 *   - buildCompactedSummaryWrapper（含/不含 transcriptPath）
 *   - buildRestoredFileContext（mixed read/modified）
 *   - SUMMARIZE_CONTEXT_TOOL（ToolParam 形态）
 *   - 极短常量（CONTINUING_ACK / UNDERSTOOD_ACK / TIME_BASED_MC_CLEARED_MESSAGE 等）
 */

import { describe, it, expect } from 'vitest';
import {
  COMPACT_SYSTEM_PROMPT,
  COMPACT_USER_PROMPT,
  INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE,
  INCREMENTAL_COMPACT_USER_INSTRUCTION,
  JUDGE_SYSTEM_PROMPT,
  buildIncrementalCompactSystemPrompt,
  buildJudgeUserPrompt,
  buildCompactedSummaryWrapper,
  buildRestoredFileContext,
  // W3 (2026-05-10): `buildArchiveHint` and `SUMMARIZE_CONTEXT_TOOL` removed
  // from the prompts barrel along with the deleted modules they came from.
  CONTINUING_ACK,
  UNDERSTOOD_ACK,
  TIME_BASED_MC_CLEARED_MESSAGE,
  CHUNK_TOO_LARGE_MARKER,
  CONTEXT_TRUNCATED_PLACEHOLDER,
  RECENT_CONVERSATION_MARKER,
  SUMMARY_HEADER_MARKER,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../index.js';
import type {
  Message,
} from '../../engine/contracts/conversation.js';

describe('compact prompts — full snapshot', () => {
  it('COMPACT_SYSTEM_PROMPT', () => {
    expect(COMPACT_SYSTEM_PROMPT).toMatchInlineSnapshot(`
      "你是一个对话摘要器。请为给定的对话生成一份详细、结构化的摘要，
      重点保留那些对于不丢失上下文、继续推进工作至关重要的信息。

      关键：你的摘要将替换原始消息。任何未包含在摘要中的信息，
      都会从活动上下文中永久丢失。
      请力求详尽——宁可多写，也不要漏写。

      只回复摘要正文本身。不要调用任何工具。"
    `);
  });

  it('COMPACT_USER_PROMPT', () => {
    expect(COMPACT_USER_PROMPT).toMatchInlineSnapshot(`
      "请总结目前为止的对话。你的摘要必须包含以下所有部分：

      1. **用户请求**：每一条明确的用户请求及其当前状态（待处理 / 进行中 / 已完成）
      2. **关键决策**：重要的技术决策、其理由，以及考虑过的替代方案
      3. **文件与代码**：查看 / 修改 / 创建过的所有文件，附关键代码片段
         - 包含确切的文件路径以及改了什么
         - 对修改过的文件：改了什么、为什么改
      4. **工具结果**：重要的工具输出、错误信息和搜索结果
      5. **错误与修复**：遇到的问题、定位到的根因，以及如何解决
      6. **当前状态**：本次摘要之前正在进行的工作
      7. **后续步骤**：用户明确要求的待办任务（一条都不要漏）
      8. **活动文件状态**：所有正在处理的文件的当前状态（已读 / 已改 / 已建）
      9. **重要上下文**：发现的任何领域知识、约束或约定

      重要：
      - 保留确切的文件路径、函数名、变量名和错误信息
      - 保留继续工作所需的代码片段
      - 不要把具体细节泛化成模糊的陈述
      - 不要调用任何工具。只回复摘要正文本身。"
    `);
  });

  it('INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE', () => {
    expect(INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE).toMatchInlineSnapshot(`
      "你是一个增量式对话摘要器。

      你会拿到一份已有的 PRIOR_SUMMARY（已校验，不要改动其中的事实）。
      随后你会看到在 PRIOR_SUMMARY 生成之后发生的若干对话轮次（NEW_MESSAGES）。
      你的任务是产出一份更新后的摘要，要求：
        - 保留 PRIOR_SUMMARY 中的每一处具体细节（文件路径、错误信息、
          决策、待办任务、代码片段、设置）。
        - 把 NEW_MESSAGES 中的每一条新事实 / 决策 / 文件变更 / 错误都并入。
        - 保持 PRIOR_SUMMARY 使用的同样九段结构。
        - 不要丢失 PRIOR_SUMMARY 中的信息，即使 NEW_MESSAGES 没有再次提到。
        - 不要编造既不在 PRIOR_SUMMARY 也不在 NEW_MESSAGES 中的事实。

      只回复更新后的摘要正文本身。不要调用任何工具。

      === PRIOR_SUMMARY（请保留下方每一处细节）===
      {{PRIOR_SUMMARY}}
      === END PRIOR_SUMMARY ==="
    `);
  });

  it('INCREMENTAL_COMPACT_USER_INSTRUCTION', () => {
    expect(INCREMENTAL_COMPACT_USER_INSTRUCTION).toMatchInlineSnapshot(`
      "本行以上是 NEW_MESSAGES，即在你 system prompt 中的 PRIOR_SUMMARY
      生成之后发生的对话。

      现在请产出更新后的摘要。摘要必须覆盖以下所有部分：

      1. **用户请求**：每一条明确的用户请求及其当前状态（待处理 / 进行中 / 已完成）
      2. **关键决策**：重要的技术决策、其理由，以及考虑过的替代方案
      3. **文件与代码**：查看 / 修改 / 创建过的所有文件，附关键代码片段
      4. **工具结果**：重要的工具输出、错误信息和搜索结果
      5. **错误与修复**：遇到的问题、定位到的根因，以及如何解决
      6. **当前状态**：本次摘要之前正在进行的工作
      7. **后续步骤**：用户明确要求的待办任务（一条都不要漏）
      8. **活动文件状态**：所有正在处理的文件的当前状态（已读 / 已改 / 已建）
      9. **重要上下文**：发现的任何领域知识、约束或约定

      硬性约束：
      - PRIOR_SUMMARY 的内容是 ground truth。你必须把每一处具体细节都带过来。
      - 不要把具体的路径 / 错误 / 代码泛化成模糊的陈述。
      - 不要调用任何工具。只回复更新后的摘要正文本身。"
    `);
  });

  it('JUDGE_SYSTEM_PROMPT', () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatchInlineSnapshot(`
      "你正在评估一次增量式对话摘要更新的质量。

      你会在 user 消息里收到三个输入：
        1. PRIOR_SUMMARY —— 之前的完整对话摘要（已校验）。
        2. NEW_MESSAGES —— 在 prior summary 生成之后发生的对话轮次。
        3. UPDATED_SUMMARY —— 由 #1 + #2 产出的候选增量摘要。

      请按 0.0–1.0 的区间打分：
        - 1.0 = UPDATED_SUMMARY 保留了 PRIOR_SUMMARY 中的每一条具体事实 / 文件 / 决策 / 待办任务，
                并且并入了 NEW_MESSAGES 中的每一条关键事实。
        - 0.7 = 保留了大部分事实，但丢了 1-2 处次要细节，无编造。
        - 0.4 = 丢失了若干重要细节，或引入了幻觉事实。
        - 0.0 = 严重损坏——缺失核心上下文或编造信息。

      只回复一个 JSON 对象。不要散文。不要 markdown 代码围栏。
      Schema：{"score": <0.0-1.0 float>, "reason": "<一句话理由>"}"
    `);
  });
});

describe('compact builders — boundary checks', () => {
  it('buildIncrementalCompactSystemPrompt without original system prompt', () => {
    const out = buildIncrementalCompactSystemPrompt('PRIOR TEXT', '');
    expect(out).toContain('=== PRIOR_SUMMARY（请保留下方每一处细节）===');
    expect(out).toContain('PRIOR TEXT');
    expect(out).not.toContain('原始对话 system prompt');
  });

  it('buildIncrementalCompactSystemPrompt with original system prompt', () => {
    const out = buildIncrementalCompactSystemPrompt(
      'PRIOR',
      'You are TabTin Agent.',
    );
    expect(out).toContain('PRIOR');
    expect(out).toContain('--- 原始对话 system prompt（仅供参考）---');
    expect(out).toContain('You are TabTin Agent.');
    expect(out).toContain('--- 原始 system prompt 结束 ---');
  });

  it('buildJudgeUserPrompt with empty addedMessages', () => {
    const out = buildJudgeUserPrompt('PRIOR', 'NEW SUM', []);
    expect(out).toContain('=== PRIOR_SUMMARY ===');
    expect(out).toContain('PRIOR');
    expect(out).toContain('=== END PRIOR_SUMMARY ===');
    expect(out).toContain('=== NEW_MESSAGES（自 prior summary 之后）===');
    expect(out).toContain('(无新消息)');
    expect(out).toContain('=== END NEW_MESSAGES ===');
    expect(out).toContain('=== UPDATED_SUMMARY（待评估的候选）===');
    expect(out).toContain('NEW SUM');
    expect(out).toContain('=== END UPDATED_SUMMARY ===');
    expect(out).toContain(
      '请按评分标准为 UPDATED_SUMMARY 打分。只回复那一个 JSON 对象。',
    );
  });

  it('buildJudgeUserPrompt with messages preview', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Help me debug the login flow.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Sure, will check.' }] },
    ];
    const out = buildJudgeUserPrompt('PRIOR', 'NEW', messages);
    expect(out).toContain('user: Help me debug the login flow.');
    expect(out).toContain('assistant: Sure, will check.');
  });

  it('buildCompactedSummaryWrapper without transcriptPath', () => {
    const out = buildCompactedSummaryWrapper('SUMMARY TEXT');
    expect(out).toMatchInlineSnapshot(`
      "[对话摘要]

      SUMMARY TEXT

      [摘要结束]

      [最近对话如下]"
    `);
  });

  it('buildCompactedSummaryWrapper with transcriptPath', () => {
    const out = buildCompactedSummaryWrapper('SUMMARY', '/tmp/session.jsonl');
    expect(out).toContain('[对话摘要]');
    expect(out).toContain('SUMMARY');
    expect(out).toContain('[摘要结束]');
    expect(out).toContain('完整对话记录：/tmp/session.jsonl');
    expect(out).toContain('[最近对话如下]');
    expect(out.endsWith('[最近对话如下]')).toBe(true);
  });

  it('buildRestoredFileContext for mixed read / modified', () => {
    const out = buildRestoredFileContext([
      { path: 'src/a.ts', action: 'modified', content: 'export const a = 1;' },
      { path: 'src/b.ts', action: 'read', content: 'export const b = 2;' },
    ]);
    expect(out).toMatchInlineSnapshot(`
      "

      ---

      [已恢复的文件上下文——这些文件当时正在处理]

      [modified: src/a.ts]
      \`\`\`
      export const a = 1;
      \`\`\`

      [read: src/b.ts]
      \`\`\`
      export const b = 2;
      \`\`\`"
    `);
  });

  it('buildRestoredFileContext returns empty string for empty input', () => {
    expect(buildRestoredFileContext([])).toBe('');
  });

  // W1（压缩路径简化）：buildToolResultSummary 测试已删除——
  // 该 helper 是已删除的 session memory 自创模块的私用工具，模块整体
  // 删除时 helper 一并移除（C1 §2.4）。
});

// W3 (2026-05-10): `describe('buildArchiveHint …')` block deleted along
// with the `archive-hint.ts` module. The truncation banner now lives inline
// in `tool-orchestration.ts::enforceToolOutputBudget` (`buildPersistMeta`)
// because the only message it builds is consumed in one place; pulling it
// into a prompts module added an indirection that hid the deleted
// `retrieve_tool_result` coupling. Replacement coverage lives in
// `tests/engine-enforce-budget-fence.test.ts`.

describe('compact short constants', () => {
  it('CONTINUING_ACK is short and stable', () => {
    expect(CONTINUING_ACK).toBe('继续。');
    expect(CONTINUING_ACK.length).toBeLessThan(100);
  });

  it('UNDERSTOOD_ACK is short and stable', () => {
    expect(UNDERSTOOD_ACK).toBe('明白，从最近的上下文继续。');
    expect(UNDERSTOOD_ACK.length).toBeLessThan(100);
  });

  it('TIME_BASED_MC_CLEARED_MESSAGE 中文化后稳定（被 PLACEHOLDER_PATTERNS 正则 + === 幂等判定引用）', () => {
    expect(TIME_BASED_MC_CLEARED_MESSAGE).toBe('[旧工具结果内容已清除]');
  });

  it('CHUNK_TOO_LARGE_MARKER is stable', () => {
    expect(CHUNK_TOO_LARGE_MARKER).toBe('[区块过大无法摘要，已裁剪]');
  });

  it('CONTEXT_TRUNCATED_PLACEHOLDER preserves leading/trailing newlines', () => {
    expect(CONTEXT_TRUNCATED_PLACEHOLDER).toBe(
      '\n\n... [内容因上下文预算已截断] ...\n\n',
    );
  });

  it('RECENT_CONVERSATION_MARKER stable for splice logic', () => {
    expect(RECENT_CONVERSATION_MARKER).toBe('\n\n[最近对话如下]');
  });

  it('SUMMARY_HEADER_MARKER is stable', () => {
    expect(SUMMARY_HEADER_MARKER).toBe('[对话摘要]');
  });

  it('SYSTEM_PROMPT_DYNAMIC_BOUNDARY HTML comment with newlines', () => {
    expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe(
      '\n<!-- __DYNAMIC_BOUNDARY__ -->\n',
    );
  });
});

// W3 (2026-05-10): `describe('SUMMARIZE_CONTEXT_TOOL ToolParam')` block
// deleted along with the `summarize-tool-spec.ts` module — the auto-condense
// machinery that asked the LLM to call `summarize_context` was removed
// (auto-compact in `compact/auto-compact.ts`
// covers the same pressure thresholds without an LLM-driven loop).
