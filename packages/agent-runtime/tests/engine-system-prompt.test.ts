/**
 * FR-19 回归：验证 `QueryParams.systemPrompt` / `EngineConfig.systemPrompt`
 * 类型扩展后对 `string | SystemBlock[]` 的完整处理链路。
 *
 * 关键验收：
 *   1. string 原生形态向后兼容（不破坏现有调用）
 *   2. SystemBlock[] 原封不动透传到 `LLMRequest.system`（透传不变；cache 断点由 Proxy 的
 *      applyExplicitCache 按 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 自动分配，不靠 SystemBlock 携带）
 *   3. 运行时注入（condense / convergence hint）不破坏原始形态
 */
import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  SystemBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import {
  SYSTEM_SECTION_NAMES,
} from '../src/engine/contracts/wire-protocol.js';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../src/engine/contracts/model-llm.js';

function createCapturingProvider(
  captured: LLMRequest[],
  chunks: LLMResponseChunk[] = [
    { type: 'text_delta', text: 'done' },
    { type: 'stop', stopReason: 'end_turn' },
  ],
): LLMProvider {
  return {
    async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
      captured.push(request);
      for (const c of chunks) yield c;
    },
  };
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _ of gen) {
    void _;
  }
}

function makeConfig(extra: Partial<EngineConfig>): EngineConfig {
  return {
    provider: extra.provider!,
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'sp-test' },
    model: 'test-model',
    ...extra,
  };
}

describe('query – systemPrompt type extension (FR-19)', () => {
  it('passes a plain string systemPrompt through unchanged', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const rt = createRuntime(
      makeConfig({ provider, systemPrompt: 'You are a strict assistant.' }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(captured).toHaveLength(1);
    const sys = captured[0].system as string;
    expect(sys).toContain('You are a strict assistant.');
  });

  it('prefers QueryParams.systemPrompt over EngineConfig.systemPrompt (per-query override)', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const rt = createRuntime(
      makeConfig({ provider, systemPrompt: 'default' }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi', systemPrompt: 'override' }));

    const sys = captured[0].system as string;
    expect(sys).toContain('override');
  });

  it('passes a SystemBlock[] systemPrompt through unchanged', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'shared static section' },
      { type: 'text', text: 'dynamic user persona' },
    ];
    const rt = createRuntime(
      makeConfig({ provider, systemPrompt: blocks }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(captured).toHaveLength(1);
    const capturedSys = captured[0].system as SystemBlock[];
    expect(Array.isArray(capturedSys)).toBe(true);
    expect(capturedSys[0]).toEqual(blocks[0]);
    expect(capturedSys[1]).toEqual(blocks[1]);
    // Boundary block may or may not be appended depending on dynamic injection
  });

  it('accepts SystemBlock[] via QueryParams.systemPrompt (overrides string config)', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'base' },
      { type: 'text', text: 'override-segment' },
    ];
    const rt = createRuntime(
      makeConfig({ provider, systemPrompt: 'config-default-string' }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi', systemPrompt: blocks }));

    const capturedSys = captured[0].system as SystemBlock[];
    expect(capturedSys[0]).toEqual(blocks[0]);
    expect(capturedSys[1]).toEqual(blocks[1]);
  });

  it('treats undefined systemPrompt as no system message (backward compatible)', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const rt = createRuntime(makeConfig({ provider }));
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(captured[0].system).toBeUndefined();
  });
});

/**
 * Runtime-generated injections (convergence hint / condense reminder) must
 * preserve the original shape of systemPrompt — string stays string,
 * SystemBlock[] stays SystemBlock[]. Cache-control semantics are documented
 * in `appendSystemInstruction` inside query.ts.
 */
describe('query – systemPrompt injection path (FR-19)', () => {
  it('appends runtime injection to a string systemPrompt with "\\n\\n" separator', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const rt = createRuntime(
      makeConfig({
        provider,
        systemPrompt: 'base prompt',
        hooks: {
          beforeModel: async (ctx) => {
            ctx.appendSystemSection(
              SYSTEM_SECTION_NAMES.convergence_hint,
              'converge now',
              'token-budget',
            );
          },
        },
      }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));
    const sys = captured[0].system as string;
    expect(sys).toContain('base prompt');
    expect(sys).toContain('__DYNAMIC_BOUNDARY__');
    expect(sys).toContain('converge now');
    const boundaryIdx = sys.indexOf('__DYNAMIC_BOUNDARY__');
    const convergeIdx = sys.indexOf('converge now');
    expect(boundaryIdx).toBeLessThan(convergeIdx);
  });

  it('appends runtime injection as a new SystemBlock (preserving earlier blocks unchanged)', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const blocks: SystemBlock[] = [
      { type: 'text', text: 'stable prefix A' },
      { type: 'text', text: 'stable prefix B' },
    ];
    const rt = createRuntime(
      makeConfig({
        provider,
        systemPrompt: blocks,
        hooks: {
          beforeModel: async (ctx) => {
            ctx.appendSystemSection(
              SYSTEM_SECTION_NAMES.convergence_hint,
              'converge now',
              'token-budget',
            );
          },
        },
      }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    const captureSystem = captured[0].system as SystemBlock[];
    expect(Array.isArray(captureSystem)).toBe(true);
    // 2 original + boundary block + convergence hint
    expect(captureSystem).toHaveLength(4);
    expect(captureSystem[0]).toEqual({ type: 'text', text: 'stable prefix A' });
    expect(captureSystem[1]).toEqual({
      type: 'text',
      text: 'stable prefix B',
    });
    expect(captureSystem[2].text).toContain('__DYNAMIC_BOUNDARY__');
    // Phase 1 · Debug Observability: section marker wraps the dynamic content
    // 阶段 1.5 治理（2026-05-20）：SYSTEM_SECTION_NAMES.convergence value 对齐
    // SECTION_REGISTRY id 'convergence_hint'，section marker 也同步更新。
    expect(captureSystem[3].text).toContain('<!-- section:convergence_hint source:token-budget -->');
    expect(captureSystem[3].text).toContain('converge now');
    expect(captureSystem[3].text).toContain('<!-- /section:convergence_hint -->');
  });

  it('does not mutate the original SystemBlock[] passed in by the caller (no side-effects)', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const blocks: SystemBlock[] = [{ type: 'text', text: 'original' }];
    const rt = createRuntime(
      makeConfig({
        provider,
        systemPrompt: blocks,
        hooks: {
          beforeModel: async (ctx) => {
            ctx.appendSystemSection(SYSTEM_SECTION_NAMES.convergence_hint, 'x', 'token-budget');
          },
        },
      }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: 'original' });
  });
});

/**
 * M12（本地 Skill 模块 Wave A · ARCH-0 修复）回归：
 * `state.__skillsHint` 必须被合并进 `effectiveSystemPrompt` 并最终出现在
 * LLM 收到的 `request.system` 里。
 *
 * 这条修复是北极星场景 A/B 的前提——v2 以前 `skills-and-notes.ts`
 * middleware 写 `state.systemPrompt`，但 `effectiveSystemPrompt` 以
 * `systemPromptRaw` 为底、不合并 `state.systemPrompt`，导致 LLM 永远看
 * 不到 `<skills>` 段。ARCH-0 修法：middleware 改写 `__skillsHint`，
 * query.ts 在 `__convergenceHint` 之后追加合并——本测试与 `__convergenceHint`
 * 现有测试同构，确保新路径同样真实进到 LLM 请求。
 *
 * 阶段 2.2 (2026-05-20) 清理：删除 __notesHint 相关测试（字段 + 写入者 +
 * 合并代码全部物理下线，C.2 历史死路径彻底清空）。
 */
describe('query – skills hint injection (M12 ARCH-0)', () => {
  it('appends state.__skillsHint to effectiveSystemPrompt exactly once', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const rt = createRuntime(
      makeConfig({
        provider,
        systemPrompt: 'base prompt',
        hooks: {
          beforeModel: async (ctx) => {
            ctx.appendSystemSection(
              SYSTEM_SECTION_NAMES.skills_listing,
              '<skills>\n- user:code-style-check — Check code style.\n</skills>',
              'skills-and-notes',
            );
          },
        },
      }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(captured).toHaveLength(1);
    expect(typeof captured[0].system).toBe('string');
    const system = captured[0].system as string;
    expect(system).toContain('base prompt');
    expect(system).toContain('<skills>');
    expect(system).toContain('user:code-style-check — Check code style.');
    expect(system).toContain('</skills>');
  });

  // 阶段 2.2 (2026-05-20) 清理：删除 __notesHint 注入测试
  // （字段 + 写入者 + 合并代码已物理下线）

  it('skips hint injection when both fields are undefined', async () => {
    const captured: LLMRequest[] = [];
    const provider = createCapturingProvider(captured);
    const rt = createRuntime(
      makeConfig({
        provider,
        systemPrompt: 'base prompt',
      }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));
    const sys = captured[0].system as string;
    expect(sys).toContain('base prompt');
    expect(sys).not.toContain('<skills>');
    expect(sys).not.toContain('<session_notes>');
  });

});

/**
 *  有意移除：业务身份（spaceId / organizationId / workspaceScopeKey）已从
 * EngineConfig / QueryParams / EngineState / ToolContext 核心契约剥离。runtime
 * 只保留不透明 loop id；业务 id 由 host 装配期烘焙进 Cap / 工具闭包 deps，不再
 * 经黑板或 hook ctx 流动。
 *
 * 原 M11「QueryParams → EngineState.__spaceId → ToolContext」透传用例因此过时——
 * 不是回归。本块改为锁定「核心契约不再承载业务 id」的不变量，防止误把字段加回。
 */
describe('query – spaceId / organizationId 已从核心契约移除 ', () => {
  it('EngineState 黑板不再暴露 __spaceId / __organizationId', async () => {
    const seenKeys: string[][] = [];

    const rt = createRuntime(
      makeConfig({
        provider: createCapturingProvider([]),
        hooks: {
          beforeIteration: async (ctx) => {
            seenKeys.push(Object.keys(ctx.state).filter((k) =>
              k === '__spaceId' || k === '__organizationId' || k === 'spaceId' || k === 'organizationId',
            ));
          },
        },
      }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(seenKeys.length).toBeGreaterThan(0);
    expect(seenKeys[0]).toEqual([]);
  });

  it('ToolContext 不再携带 spaceId / organizationId 字段', async () => {
    const seenFromTool: Array<Record<string, unknown>> = [];

    const probeTool: Tool = {
      name: 'probe_ctx',
      description: 'Probe ToolContext identity fields — test only',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_input, context) {
        seenFromTool.push({
          hasSpaceId: Object.prototype.hasOwnProperty.call(context, 'spaceId'),
          hasOrganizationId: Object.prototype.hasOwnProperty.call(context, 'organizationId'),
          spaceId: (context as { spaceId?: string }).spaceId,
          organizationId: (context as { organizationId?: string }).organizationId,
        });
        return { content: 'probed' };
      },
    };

    const providerWithTool: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        void request;
        if ((providerWithTool as { _n?: number })._n) {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'stop', stopReason: 'end_turn' };
          return;
        }
        (providerWithTool as { _n?: number })._n = 1;
        yield {
          type: 'tool_use',
          toolUse: { id: 'tu-1', name: 'probe_ctx', input: {} },
        };
        yield { type: 'stop', stopReason: 'tool_use' };
      },
    };

    const rt = createRuntime(
      makeConfig({
        provider: providerWithTool,
        tools: { getTools: () => [probeTool] },
      }),
    );
    await drain(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    expect(seenFromTool.length).toBeGreaterThan(0);
    expect(seenFromTool[0].hasSpaceId).toBe(false);
    expect(seenFromTool[0].hasOrganizationId).toBe(false);
    expect(seenFromTool[0].spaceId).toBeUndefined();
    expect(seenFromTool[0].organizationId).toBeUndefined();
  });
});
