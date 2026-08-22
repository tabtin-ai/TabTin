/**
 * FR-08 — fuzzy tool name matching: Levenshtein + alias table.
 *
 * Locks in:
 *   1. Pure Levenshtein behaviour (incl. early-exit shortcuts).
 *   2. `findToolWithSuggestions` returns 0/1/many candidates within threshold.
 *   3. Alias table covers ≥ 5 common LLM hallucinations and always
 *      ranks above raw distance hits.
 *   4. The orchestration unknown-branch attaches `did_you_mean` to the
 *      synthesized tool error result, so the model gets actionable
 *      feedback within one turn.
 */

import { describe, it, expect } from 'vitest';
import {
  ToolRegistry,
  levenshteinDistance,
  listToolAliases,
} from '../src/engine/tooling/tool-system.js';
import { runTools } from '../src/engine/tooling/tool-orchestration.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import { createMockPermissionHandler } from './test-utils.js';

function makeTool(name: string, isReadOnly = true): Tool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: {},
    isReadOnly,
    execute: async () => ({ content: 'unused' }),
  };
}

// ─── Levenshtein basics ─────────────────────────────────────────────

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('execute_command', 'execute_command')).toBe(0);
  });

  it('returns string length for empty input', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('counts a single substitution', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  it('counts inserts and deletes equally', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3); // classic case
  });

  it('handles inputs of different lengths', () => {
    expect(levenshteinDistance('a', 'abcdef')).toBe(5);
  });
});

// ─── findToolWithSuggestions — shape ────────────────────────────────

describe('ToolRegistry.findToolWithSuggestions', () => {
  it('returns the exact tool when name matches', () => {
    const r = new ToolRegistry();
    const executeCommand = makeTool('execute_command');
    r.loadTools({ getTools: () => [executeCommand] });
    const out = r.findToolWithSuggestions('execute_command');
    expect(out.tool).toBe(executeCommand);
    expect(out.suggestions).toEqual([]);
  });

  it('returns Levenshtein candidates within threshold (typo fix)', () => {
    const r = new ToolRegistry();
    r.loadTools({
      getTools: () => [makeTool('execute_command'), makeTool('todo'), makeTool('summarize_context')],
    });
    // 'execute_comand' is distance 1 from 'execute_command'
    const out = r.findToolWithSuggestions('execute_comand');
    expect(out.tool).toBeNull();
    expect(out.suggestions).toContain('execute_command');
  });

  it('returns at most 3 suggestions', () => {
    const r = new ToolRegistry();
    r.loadTools({
      getTools: () => [
        makeTool('test_a'),
        makeTool('test_b'),
        makeTool('test_c'),
        makeTool('test_d'),
        makeTool('test_e'),
      ],
    });
    const out = r.findToolWithSuggestions('test_x');
    expect(out.tool).toBeNull();
    expect(out.suggestions.length).toBeLessThanOrEqual(3);
  });

  it('returns empty suggestions when nothing within threshold', () => {
    const r = new ToolRegistry();
    r.loadTools({ getTools: () => [makeTool('execute_command')] });
    const out = r.findToolWithSuggestions('completely_unrelated_long_name');
    expect(out.tool).toBeNull();
    expect(out.suggestions).toEqual([]);
  });

  it('alias table promotes intent over raw distance', () => {
    const r = new ToolRegistry();
    r.loadTools({
      getTools: () => [makeTool('run_terminal_command'), makeTool('cash'), makeTool('mash')],
    });
    // 'shell' has distance ≥ 4 from any of those, but the alias table
    // explicitly maps `shell` → `run_terminal_command`. Must rank first.
    const out = r.findToolWithSuggestions('shell');
    expect(out.tool).toBeNull();
    expect(out.suggestions[0]).toBe('run_terminal_command');
  });

  it('skips alias suggestion when the alias target is not registered', () => {
    const r = new ToolRegistry();
    // 'shell' alias target is `run_terminal_command`. Don't register it.
    r.loadTools({ getTools: () => [makeTool('todo'), makeTool('grep')] });
    const out = r.findToolWithSuggestions('shell');
    // No alias hit; fall back to whatever Levenshtein finds (or empty).
    expect(out.suggestions).not.toContain('run_terminal_command');
  });

  it('lookup is case-insensitive for aliases', () => {
    const r = new ToolRegistry();
    r.loadTools({ getTools: () => [makeTool('run_terminal_command')] });
    const out = r.findToolWithSuggestions('SHELL');
    expect(out.suggestions).toContain('run_terminal_command');
  });
});

// ─── alias table contents (≥ 5 common hallucinations) ──────────────

describe('FR-08 — curated alias table', () => {
  it('covers at least 5 common LLM-hallucinated tool names', () => {
    const aliases = listToolAliases();
    // Spot-check for the most frequent failure cases the spec calls out.
    //
    // 退役 FC 名不保留 alias；这里仅覆盖仍属于自然语言/常见意图的
    // canonical 建议，例如 shell/terminal → execute_command。
    const required = [
      ['shell', 'run_terminal_command'],
      ['terminal', 'run_terminal_command'],
      ['run_command', 'run_terminal_command'],
      ['cat', 'run_terminal_command'],
      ['file_edit', 'edit_file'],
      ['google_search', 'web_search'],
    ];
    for (const [alias, target] of required) {
      expect(aliases[alias], `expected alias '${alias}' → '${target}'`).toBe(target);
    }
    expect(Object.keys(aliases).length).toBeGreaterThanOrEqual(15);
  });

  it('does not preserve aliases for retired FC names', () => {
    const aliases = listToolAliases();
    for (const retired of ['bash', 'web_fetch', 'read_file', 'write_file', 'delete_file']) {
      expect(aliases[retired], `retired alias '${retired}' should not exist`).toBeUndefined();
    }
  });

  // 2026-05-10 R1 复核回滚（W5-LL-plan-alias）：plan 别名钉死映射决策。
  // 完整决策 rationale 见 packages/agent-runtime/src/engine/tool-system.ts
  // 中 'plan' alias 上方注释——独立 code-validator 复核反证 honest-fail
  // 论证不成立（plan_create 仅 plan/study 模式注册，agent 模式调 plan
  // 重定向到 plan_create 会触发 dead end），保留旧映射 plan → todo。
  // 防止未来再有人按"语义对齐"误改向 plan_create。
  it('plan alias maps to todo (R1 复核回滚 — agent 模式 dead end 防御)', () => {
    const aliases = listToolAliases();
    expect(aliases['plan']).toBe('todo');
    // 防漂移：plan_create 不应作为 plan 的 alias 目标（架构升级前回滚）
    expect(aliases['plan']).not.toBe('plan_create');
  });
});

// ─── Integration with runTools (unknown branch) ─────────────────────

async function drain(
  gen: AsyncGenerator<StreamEvent, unknown[]>,
): Promise<{ events: StreamEvent[]; results: unknown[] }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, results: next.value as unknown[] };
}

describe('runTools — unknown tool name with did_you_mean', () => {
  function ctx() {
    return {
      threadId: 'tid',
      runtimeId: 'sid',
      messages: [],
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
    };
  }

  it('attaches did_you_mean for typo of a registered tool', async () => {
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [makeTool('execute_command', false), makeTool('todo')] });

    const block: ToolUseBlock = { type: 'tool_use', id: 'b1', name: 'execute_comand', input: {} };
    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [block],
      registry,
      context: ctx(),
      permissionHandler: createMockPermissionHandler(),
    });
    const { events, results } = await drain(
      gen as AsyncGenerator<StreamEvent, unknown[]>,
    );
    const r = results[0] as { result: { content: string; isError: boolean } };
    expect(r.result.content).toContain('<tool_use_error>');
    expect(r.result.content).toContain('kind: unknown_tool');
    expect(r.result.content).toContain('Did you mean: execute_command');
    // Stream event also carries did_you_mean for UI badges.
    // W2 silent-bypass 修复：tool 生命周期事件改走 system_notice（白名单元事件），
    // 仍保留 phase / did_you_mean / 等附加字段——查找方式从 type='agent.stream.tool'
    // 改为 type='agent.stream.system_notice'，phase 字段位置不变。
    const errorEv = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).phase === 'error',
    );
    expect((errorEv?.payload as Record<string, unknown>)?.did_you_mean).toEqual(
      expect.arrayContaining(['execute_command']),
    );
  });

  it('attaches did_you_mean from alias table on common hallucination', async () => {
    const registry = new ToolRegistry();
    // W2.3：注册新 canonical `run_terminal_command`。
    registry.loadTools({ getTools: () => [makeTool('run_terminal_command', false)] });

    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'b1',
      name: 'shell', // alias → run_terminal_command
      input: { command: 'ls' },
    };
    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [block],
      registry,
      context: ctx(),
      permissionHandler: createMockPermissionHandler(),
    });
    const { results } = await drain(gen as AsyncGenerator<StreamEvent, unknown[]>);
    const content = (results[0] as { result: { content: string } }).result.content;
    expect(content).toContain('kind: unknown_tool');
    expect(content).toContain('Did you mean: run_terminal_command');
  });

  // LLM 调旧名（ask_question / ask_choice / request_approval，后者随  下架）
  // 走 unknown 分支时**按 input 形态智能推断**真实工具：
  // 含 fields → ask_form / 默认 → ask_user。
  // 大小写变体（`Ask_Choice` / `ASK_QUESTION` 等）必须 normalize 后命中 LEGACY 引导分支。
  // 注意：ask_form 是真存在的工具，LLM 直接调它会走真实 execute 路径而**不**走
  // unknown——不在本测试范围。
  it('redirects legacy ask_question / ask_choice / request_approval to recommended tool by input shape (含大小写变体)', async () => {
    const registry = new ToolRegistry();
    registry.loadTools({
      getTools: () => [
        makeTool('ask_user', true),
        makeTool('ask_form', true),
      ],
    });

    // 旧名 + 大小写变体（真存在的 ask_form 不在 legacy 列表）
    const legacyNames = [
      'ask_question', 'ask_choice', 'request_approval',
      'Ask_Choice', 'ASK_QUESTION',
    ];
    for (const legacyName of legacyNames) {
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: 'b1',
        name: legacyName,
        // 含 fields → 智能推断为 ask_form
        input: {
          title: 'Fill params',
          fields: [{ key: 'name', label: 'Name', placeholder: 'Project name' }],
        },
      };
      const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [block],
        registry,
        context: ctx(),
        permissionHandler: createMockPermissionHandler(),
      });
      const { events, results } = await drain(gen as AsyncGenerator<StreamEvent, unknown[]>);
      const content = (results[0] as { result: { content: string } }).result.content;
      expect(content).toContain(legacyName);
      // 智能推断引导到 ask_form（含 fields 数组）
      expect(content).toContain('ask_form');
      expect(content).toContain('Based on your input shape');
      // W2 silent-bypass 修复：tool 生命周期事件改走 system_notice（白名单元事件）——
      // makeToolLifecycleNotice() 真实 emit type 见 tool-orchestration.ts:2032。
      const errorEv = events.find(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).phase === 'error',
      );
      expect((errorEv?.payload as Record<string, unknown>)?.did_you_mean).toEqual(['ask_form']);
    }
  });

  it('falls back to generic hint when no candidate within threshold', async () => {
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [makeTool('execute_command')] });

    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'b1',
      name: 'a_completely_unrelated_tool_name',
      input: {},
    };
    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [block],
      registry,
      context: ctx(),
      permissionHandler: createMockPermissionHandler(),
    });
    const { results } = await drain(gen as AsyncGenerator<StreamEvent, unknown[]>);
    const content = (results[0] as { result: { content: string } }).result.content;
    expect(content).not.toContain('Did you mean');
    expect(content).toContain('tabtin commands');
  });

  it('still flags isError=true so query.ts treats it as a tool failure', async () => {
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [makeTool('execute_command')] });

    const block: ToolUseBlock = { type: 'tool_use', id: 'b1', name: 'execute_comand', input: {} };
    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [block],
      registry,
      context: ctx(),
      permissionHandler: createMockPermissionHandler(),
    });
    const { results } = await drain(gen as AsyncGenerator<StreamEvent, unknown[]>);
    expect((results[0] as { result: { isError: boolean } }).result.isError).toBe(true);
  });
});

// ─── Self-correction simulation ─────────────────────────────────────

describe('FR-08 — Agent can self-correct with did_you_mean', () => {
  it('simulates a 2-turn fix: bad name → suggestion → retry succeeds', async () => {
    const registry = new ToolRegistry();
    let executeCalled = false;
    // ShellCap canonical 工具名 `run_terminal_command`。
    const tool: Tool = {
      name: 'run_terminal_command',
      description: 'shell',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      isReadOnly: false,
      async execute() {
        executeCalled = true;
        return { content: 'ok' };
      },
    };
    registry.loadTools({ getTools: () => [tool] });

    // Turn 1: model uses wrong name.
    const turn1: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls' } };
    const gen1 = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [turn1],
      registry,
      context: {
        threadId: 'tid',
        runtimeId: 'sid',
        messages: [],
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
      },
      permissionHandler: createMockPermissionHandler(),
    });
    const { results: r1 } = await drain(gen1 as AsyncGenerator<StreamEvent, unknown[]>);
    const content1 = (r1[0] as { result: { content: string } }).result.content;
    expect(content1).toContain('Did you mean: run_terminal_command');
    expect(executeCalled).toBe(false);

    // Simulate the model seeing did_you_mean and retrying with the correct name.
    const turn2: ToolUseBlock = { type: 'tool_use', id: 't2', name: 'run_terminal_command', input: { command: 'ls' } };
    const gen2 = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [turn2],
      registry,
      context: {
        threadId: 'tid',
        runtimeId: 'sid',
        messages: [],
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
      },
      permissionHandler: createMockPermissionHandler(),
    });
    const { results: r2 } = await drain(gen2 as AsyncGenerator<StreamEvent, unknown[]>);
    expect((r2[0] as { result: { content: string; isError?: boolean } }).result.isError).not.toBe(true);
    expect(executeCalled).toBe(true);
  });
});
