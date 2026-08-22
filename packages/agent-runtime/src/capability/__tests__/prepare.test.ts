/**
 * 装配函数测试 —— 对应 M1 §6.4。**Charter 特别点名**：
 *   "两个 Capability 的 hooks.beforeIteration 按 caps 列表顺序执行"
 *
 * 验证：
 *   - composeCapabilityHooks 顺序保证（Charter DoD）
 *   - composeCapabilityHooks 空数组不抛错
 *   - prepareAgentTools 合并 / 冲突 / name 校验
 *
 * 阶段 2 (2026-05-20) 清理：删除 prepareAgentInstructions / prepareAgentSampling
 * 两整组测试（函数已物理下线，0 production caller）。
 */

import { describe, expect, it } from 'vitest';
import type {
  Tool,
} from '../../engine/contracts/tools.js';
import type {
  EngineState,
} from '../../engine/contracts/kernel.js';
import {
  composeCapabilityHooks,
  prepareAgentTools,
} from '../prepare.js';
import {
  CapabilityToolNameError,
  CapabilityToolsConflictError,
} from '../errors.js';
import type { Capability } from '../capability.js';
import {
  FakeBadToolNameCap,
  FakeConflictingCap,
  FakeFileSystemCap,
  FakeNoOpCap,
  FakeShellCap,
  makeIterationCtx,
  makeRecorder,
  makeRunCtx,
  makeToolCtx,
} from './fixtures/fake-capabilities.js';

// ─── composeCapabilityHooks ─────────────────────────────────────────

describe('composeCapabilityHooks', () => {
  it('两个 Capability 的 beforeIteration 按 caps 列表顺序执行（Charter DoD）', async () => {
    const recorder = makeRecorder();
    const fs = new FakeFileSystemCap(recorder);
    const sh = new FakeShellCap(recorder);

    const merged = composeCapabilityHooks([fs, sh]);
    const fakeState = {} as EngineState;
    await merged.beforeIteration?.(makeIterationCtx(fakeState, 1));
    await merged.beforeIteration?.(makeIterationCtx(fakeState, 2));

    // beforeIteration 应按 fs → sh 顺序，每个 iteration 独立
    expect(recorder.calls).toEqual([
      { cap: 'filesystem', hook: 'beforeIteration', iteration: 1 },
      { cap: 'shell', hook: 'beforeIteration', iteration: 1 },
      { cap: 'filesystem', hook: 'beforeIteration', iteration: 2 },
      { cap: 'shell', hook: 'beforeIteration', iteration: 2 },
    ]);
  });

  it('beforeRun / afterRun / afterIteration / beforeTool / afterTool 全 6 hook 都 compose', async () => {
    const calls: string[] = [];
    const cap1: Capability = {
      type: 'c1',
      category: 'core',
      hooks: () => ({
        beforeRun: async () => {
          calls.push('c1.beforeRun');
        },
        afterRun: async () => {
          calls.push('c1.afterRun');
        },
        beforeIteration: async () => {
          calls.push('c1.beforeIteration');
        },
        afterIteration: async () => {
          calls.push('c1.afterIteration');
        },
        beforeTool: async () => {
          calls.push('c1.beforeTool');
        },
        afterTool: async () => {
          calls.push('c1.afterTool');
        },
      }),
    };
    const cap2: Capability = {
      type: 'c2',
      category: 'core',
      hooks: () => ({
        beforeRun: async () => {
          calls.push('c2.beforeRun');
        },
      }),
    };

    const merged = composeCapabilityHooks([cap1, cap2]);
    const fakeState = {} as EngineState;
    const fakeTool = {} as Tool;
    const fakeResult = { content: '' };

    await merged.beforeRun?.(makeRunCtx(fakeState));
    await merged.afterRun?.(makeRunCtx(fakeState));
    await merged.beforeIteration?.(makeIterationCtx(fakeState, 1));
    await merged.afterIteration?.(makeIterationCtx(fakeState, 1));
    await merged.beforeTool?.(makeToolCtx(fakeState, fakeTool, {}));
    await merged.afterTool?.(makeToolCtx(fakeState, fakeTool, {}, fakeResult));

    expect(calls).toEqual([
      'c1.beforeRun',
      'c2.beforeRun',
      'c1.afterRun',
      'c1.beforeIteration',
      'c1.afterIteration',
      'c1.beforeTool',
      'c1.afterTool',
    ]);
  });

  it('空 caps 数组返回 EngineHooks（不抛错）', async () => {
    const merged = composeCapabilityHooks([]);
    expect(merged).toBeTruthy();
    // 调用各 hook 不抛错
    const fakeState = {} as EngineState;
    await merged.beforeRun?.(makeRunCtx(fakeState));
    await merged.afterRun?.(makeRunCtx(fakeState));
    await merged.beforeIteration?.(makeIterationCtx(fakeState, 0));
  });

  it('hooks() 返回 null —— 该 cap 不进合并链', async () => {
    const calls: string[] = [];
    const noopCap: Capability = {
      type: 'noop',
      category: 'governance',
      hooks: () => null,
    };
    const realCap: Capability = {
      type: 'real',
      category: 'core',
      hooks: () => ({
        beforeRun: async () => {
          calls.push('real');
        },
      }),
    };
    const merged = composeCapabilityHooks([noopCap, realCap]);
    await merged.beforeRun?.(makeRunCtx({} as EngineState));
    expect(calls).toEqual(['real']);
  });

  it('hook 函数被正确传递 —— 调用方可在外层包 try/catch', async () => {
    const cap: Capability = {
      type: 'thrower',
      category: 'core',
      hooks: () => ({
        beforeRun: async () => {
          throw new Error('boom');
        },
      }),
    };
    const merged = composeCapabilityHooks([cap]);
    await expect(merged.beforeRun?.(makeRunCtx({} as EngineState))).rejects.toThrow('boom');
  });
});

// ─── prepareAgentTools ──────────────────────────────────────────────

describe('prepareAgentTools', () => {
  it('两个 Capability tools 合并（无冲突）', () => {
    const fs = new FakeFileSystemCap();
    const sh = new FakeShellCap();
    const { tools, schemaCache } = prepareAgentTools([fs, sh]);
    expect(tools.map((t) => t.name)).toEqual([
      'list_directory',
      'mkdir',
      'exec_command',
    ]);
    expect(schemaCache.size).toBe(3);
    expect(schemaCache.get('filesystem:list_directory')?.name).toBe('list_directory');
    expect(schemaCache.get('shell:exec_command')?.input_schema).toBeTruthy();
  });

  it('cap 顺序决定 tools 顺序（prompt cache 友好）', () => {
    const fs = new FakeFileSystemCap();
    const sh = new FakeShellCap();
    const r1 = prepareAgentTools([fs, sh]);
    const r2 = prepareAgentTools([sh, fs]);
    expect(r1.tools.map((t) => t.name)).toEqual([
      'list_directory',
      'mkdir',
      'exec_command',
    ]);
    expect(r2.tools.map((t) => t.name)).toEqual([
      'exec_command',
      'list_directory',
      'mkdir',
    ]);
  });

  it('两 Capability 同 name tool 抛 CapabilityToolsConflictError', () => {
    const fs = new FakeFileSystemCap();
    const conflict = new FakeConflictingCap();
    try {
      prepareAgentTools([fs, conflict]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityToolsConflictError);
      const e = err as CapabilityToolsConflictError;
      expect(e.toolName).toBe('list_directory');
      expect(e.firstCapType).toBe('filesystem');
      expect(e.secondCapType).toBe('conflict');
    }
  });

  it('同 cap 内重复 name tool 抛 CapabilityToolsConflictError', () => {
    const cap: Capability = {
      type: 'dup-internal',
      category: 'core',
      tools: () => [
        {
          name: 'same',
          description: 'a',
          inputSchema: {},
          isReadOnly: true,
          execute: async () => ({ content: '' }),
        },
        {
          name: 'same',
          description: 'b',
          inputSchema: {},
          isReadOnly: true,
          execute: async () => ({ content: '' }),
        },
      ],
    };
    expect(() => prepareAgentTools([cap])).toThrow(CapabilityToolsConflictError);
  });

  it('tool name 不合 ^[a-zA-Z0-9_-]{1,64}$ 抛 CapabilityToolNameError', () => {
    const badNames = [
      '', // 空串
      'has space',
      'has.dot',
      'has/slash',
      'has@at',
      'a'.repeat(65), // 65 字符
      '中文',
    ];
    for (const bad of badNames) {
      const cap = new FakeBadToolNameCap(bad);
      expect(() => prepareAgentTools([cap])).toThrow(CapabilityToolNameError);
    }
  });

  it('tool name 边界合法 —— 1 char / 64 char / 含 _ 和 -', () => {
    const okNames = ['a', 'a'.repeat(64), 'tab-data__list_rows', 'A_b-9'];
    for (const ok of okNames) {
      const cap = new FakeBadToolNameCap(ok);
      expect(() => prepareAgentTools([cap])).not.toThrow();
    }
  });

  it('cap 不实现 tools() —— 安全跳过', () => {
    const noop = new FakeNoOpCap();
    const fs = new FakeFileSystemCap();
    const { tools } = prepareAgentTools([noop, fs]);
    expect(tools.length).toBe(2);
  });

  it('空 caps 数组 —— 返回空 tools / 空 cache', () => {
    const { tools, schemaCache } = prepareAgentTools([]);
    expect(tools).toEqual([]);
    expect(schemaCache.size).toBe(0);
  });
});

// ─── prepareAgentInstructions / prepareAgentSampling: 阶段 2 已下线，测试同步删除 ──
