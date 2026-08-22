/**
 * 子 Agent 模型自由度（Phase 3 + Phase 4）回归测试。
 *
 * Phase 3（子能力按子模型解析，不继承父）：
 *   - `resolveModelCapabilitiesFromCatalog` 按 childModel 取目录里的真实窗口，
 *     小窗口子模型不会拿到父的大窗口（PRD G4 / R5：不以父大窗口跑崩）。
 *   - 端到端：派一个用小窗口模型的子 Agent，子 EngineConfig 的
 *     contextWindowTokens == 子模型窗口（而非父）。
 *
 * Phase 4（放开模型选择）：
 *   - 命中目录（id / alias）→ 用规范 id；命不中 → 确定性降级到父 + tool_result
 *     中文提示（R8）。
 *   - 目录菜单渲染含 id + 语义标签。
 */

import { describe, it, expect } from 'vitest';
import {
  findCatalogEntry,
  isInactiveOrMissingModelErrorType,
  isValidModelRef,
  resolveModelCapabilitiesFromCatalog,
  resolveChildModelFromCatalog,
  renderModelCatalogMenu,
} from '../src/subagent/model-catalog.js';
import {
  FALLBACK_MODEL_CAPABILITIES,
} from '../src/engine/contracts/model-llm.js';
import type {
  ModelCapabilities,
  ModelCatalogEntry,
} from '../src/engine/contracts/model-llm.js';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import {
  AgentError,
} from '../src/engine/contracts/kernel.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';
import { SubagentManager } from '../src/session/subagent-manager.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';

function caps(over: Partial<ModelCapabilities>): ModelCapabilities {
  return { ...FALLBACK_MODEL_CAPABILITIES, ...over };
}

// 父模型大窗口 200k，子模型小窗口 16k——验证「不继承父大窗口」。
const BIG = caps({ contextWindowTokens: 200_000, maxOutputTokens: 64_000 });
const SMALL = caps({ contextWindowTokens: 16_000, maxOutputTokens: 4_000 });

const CATALOG: ModelCatalogEntry[] = [
  {
    id: 'claude-opus-parent',
    displayName: 'Opus（父）',
    aliases: ['opus'],
    capabilities: BIG,
    usageHint: '强/贵',
    providerScope: 'global',
  },
  {
    id: 'qwen-flash-small',
    displayName: 'Qwen Flash',
    aliases: ['flash', 'cheap'],
    capabilities: SMALL,
    usageHint: '便宜/快',
    providerScope: 'global',
  },
  {
    id: 'glm-byok',
    capabilities: caps({ contextWindowTokens: 128_000, supportsVision: true }),
    usageHint: '均衡',
    providerScope: 'user',
  },
];

describe('#462 · isValidModelRef 模型引用契约', () => {
  it('接受 DB UUID（大小写不敏感、含两端空白 trim）', () => {
    expect(isValidModelRef('edafd1a5-d5de-4f3a-8391-331ae76e5acd')).toBe(true);
    expect(isValidModelRef('EDAFD1A5-D5DE-4F3A-8391-331AE76E5ACD')).toBe(true);
    expect(isValidModelRef('  edafd1a5-d5de-4f3a-8391-331ae76e5acd  ')).toBe(true);
  });

  it('接受 declared:<provider>:<model> 静态声明引用', () => {
    expect(isValidModelRef('declared:moonshot:kimi-k2.6')).toBe(true);
  });

  it('拒绝裸 model_name（根因：透给 proxy 会"模型不存在或未激活"）', () => {
    expect(isValidModelRef('kimi-k2.6')).toBe(false);
    expect(isValidModelRef('moonshot/kimi-k2.6')).toBe(false);
    expect(isValidModelRef('gpt-4o')).toBe(false);
  });

  it('拒绝空 / 非字符串', () => {
    expect(isValidModelRef('')).toBe(false);
    expect(isValidModelRef('   ')).toBe(false);
    expect(isValidModelRef(undefined)).toBe(false);
    expect(isValidModelRef(null)).toBe(false);
    expect(isValidModelRef(123)).toBe(false);
  });

  it('catalog entry 以 UUID 为 id、model_name 作 alias 时，按 UUID 与按名都能命中', () => {
    // 模拟修复后的 catalog 构造：id=DB UUID，aliases=[model_name]，displayName 人类可读。
    const uuid = 'edafd1a5-d5de-4f3a-8391-331ae76e5acd';
    const catalog: ModelCatalogEntry[] = [
      {
        id: uuid,
        aliases: ['kimi-k2.6'],
        displayName: 'Kimi K2.6',
        capabilities: caps({ contextWindowTokens: 262_144 }),
      },
    ];
    // 选中模型（UUID）→ 命中 → 拿到真实 256k 窗口（不回落 FALLBACK 32k → 顺带修  同类）。
    expect(findCatalogEntry(catalog, uuid)?.id).toBe(uuid);
    expect(resolveModelCapabilitiesFromCatalog(catalog, uuid)?.contextWindowTokens).toBe(262_144);
    // 人类按 model_name / display_name 引用仍命中同一条（alias / displayName 匹配）。
    expect(findCatalogEntry(catalog, 'kimi-k2.6')?.id).toBe(uuid);
    expect(findCatalogEntry(catalog, 'Kimi K2.6')?.id).toBe(uuid);
  });
});

describe('Phase 3 · findCatalogEntry / 能力按子模型解析', () => {
  it('按 id / alias / displayName 命中（大小写不敏感）', () => {
    expect(findCatalogEntry(CATALOG, 'qwen-flash-small')?.id).toBe('qwen-flash-small');
    expect(findCatalogEntry(CATALOG, 'FLASH')?.id).toBe('qwen-flash-small');
    expect(findCatalogEntry(CATALOG, 'Qwen Flash')?.id).toBe('qwen-flash-small');
    expect(findCatalogEntry(CATALOG, 'nope')).toBeUndefined();
  });

  it('小窗口子模型解析出自己的窗口，不是父大窗口（R5）', () => {
    const c = resolveModelCapabilitiesFromCatalog(CATALOG, 'qwen-flash-small');
    expect(c).toBeDefined();
    expect(c?.contextWindowTokens).toBe(16_000);
    expect(c?.maxOutputTokens).toBe(4_000);
    // 不等于父大窗口
    expect(c?.contextWindowTokens).not.toBe(200_000);
  });

  it('目录命不中 → undefined（交调用方回落父值，不再保守 FALLBACK）', () => {
    // P1-1 修复：命不中不再吐 FALLBACK，返回 undefined → agent-tool 的 `?? config.X`
    // 才能真正回落父值（否则长产出被截断 / 丢 prompt-cache / 丢视觉）。
    expect(resolveModelCapabilitiesFromCatalog(CATALOG, 'unknown-model')).toBeUndefined();
  });

  it('无目录 → undefined', () => {
    expect(resolveModelCapabilitiesFromCatalog(undefined, 'anything')).toBeUndefined();
  });
});

describe('Phase 4 · resolveChildModelFromCatalog', () => {
  it('无显式 requested → 缺省跟父（capabilities undefined → 回落父值，不降级）', () => {
    const r = resolveChildModelFromCatalog({ catalog: CATALOG, parentModel: 'claude-opus-parent' });
    expect(r.model).toBe('claude-opus-parent');
    // P1-1：缺省跟父不再按 parentModel 查目录，capabilities 返回 undefined，
    // 让调用方回落父 EngineConfig 的真实 caps（config.X）。
    expect(r.capabilities).toBeUndefined();
    expect(r.downgrade).toBeUndefined();
  });

  it('命中目录（alias）→ 规范 id + 目录能力，无降级', () => {
    const r = resolveChildModelFromCatalog({ catalog: CATALOG, requested: 'flash', parentModel: 'claude-opus-parent' });
    expect(r.model).toBe('qwen-flash-small');
    expect(r.capabilities?.contextWindowTokens).toBe(16_000);
    expect(r.downgrade).toBeUndefined();
  });

  it('命不中 → 确定性降级到父 + 带 downgrade（R8）+ capabilities undefined（回落父值）', () => {
    const r = resolveChildModelFromCatalog({ catalog: CATALOG, requested: 'gpt-5-ultra', parentModel: 'claude-opus-parent' });
    expect(r.model).toBe('claude-opus-parent');
    expect(r.capabilities).toBeUndefined();
    expect(r.downgrade).toEqual({ requested: 'gpt-5-ultra', resolved: 'claude-opus-parent' });
  });

  it('命不中但 userDefault 命中 → 降级到 userDefault（capabilities 仍 undefined）', () => {
    const r = resolveChildModelFromCatalog({
      catalog: CATALOG,
      requested: 'gpt-5-ultra',
      parentModel: 'claude-opus-parent',
      userDefault: 'qwen-flash-small',
    });
    expect(r.model).toBe('qwen-flash-small');
    expect(r.capabilities).toBeUndefined();
    expect(r.downgrade?.resolved).toBe('qwen-flash-small');
  });
});

describe('Phase 4 · renderModelCatalogMenu', () => {
  it('空目录 → 空串（不渲染清单，兼容旧 host）', () => {
    expect(renderModelCatalogMenu(undefined)).toBe('');
    expect(renderModelCatalogMenu([])).toBe('');
  });

  it('非空 → 含 id / 语义标签 / 视觉 / BYOK 标记', () => {
    const menu = renderModelCatalogMenu(CATALOG);
    expect(menu).toContain('可用模型清单');
    expect(menu).toContain('qwen-flash-small');
    expect(menu).toContain('便宜/快');
    expect(menu).toContain('视觉'); // glm-byok supportsVision
    expect(menu).toContain('BYOK'); // glm-byok providerScope=user
  });
});

describe('#9729 回归 · 目录命中但运行时模型不可用', () => {
  it('只识别唯一结构化模型缺失错误码，不用展示文案推断', () => {
    expect(isInactiveOrMissingModelErrorType('model_not_found')).toBe(true);
    expect(isInactiveOrMissingModelErrorType('billing_insufficient_credits')).toBe(false);
    expect(isInactiveOrMissingModelErrorType('rate_limit_exceeded')).toBe(false);
    expect(isInactiveOrMissingModelErrorType('模型 "kimi" 不存在或未激活。请刷新页面或换 model。')).toBe(false);
    expect(isInactiveOrMissingModelErrorType(undefined)).toBe(false);
  });
});

// ─── 端到端：createAgentTool 真消费目录 ───────────────────────────────

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  } as ToolContext;
}

function providerWithFinalText(text: string): LLMProvider {
  return {
    async *createStream() {
      yield { type: 'text_delta' as const, text };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('Phase 4 端到端 · agent 工具照目录解析子模型', () => {
  it('组织策略为 inherit 时忽略主 Agent 自主填的 model，强制跟随父模型', async () => {
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-policy-inherit' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'inherit' },
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'flash' },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual(['claude-opus-parent']);
  });

  it('多级派发时 inherit 跟随直接父 Agent 的实际模型，而不是根任务模型', async () => {
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-policy-nested-inherit' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'inherit' },
    });

    const result = await tool.execute(
      { prompt: 'nested task', model: 'glm-byok' },
      makeContext({ model: 'qwen-flash-small', subagentDepth: 1 }),
    );

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual(['qwen-flash-small']);
  });

  it('inherit 跟随主 Agent 本轮实时模型，而不是主 Agent 默认模型配置', async () => {
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-policy-live-parent-model' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'inherit' },
    });

    const result = await tool.execute(
      { prompt: 'task' },
      makeContext({ model: 'qwen-flash-small' }),
    );

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual(['qwen-flash-small']);
  });

  it('组织策略为 fixed 时，未指定模型的子 Agent 使用配置模型', async () => {
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-policy-fixed' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'fixed', modelId: 'qwen-flash-small' },
    });

    const result = await tool.execute({ prompt: 'task' }, makeContext());

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual(['qwen-flash-small']);
  });

  it('组织策略为 fixed 时，固定模型不在目录中则 fail closed，不降级到父模型', async () => {
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'should not run' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-policy-fixed-miss' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'fixed', modelId: 'missing-fixed-model' },
    });

    const result = await tool.execute({ prompt: 'task' }, makeContext());

    expect(result.isError).toBe(true);
    expect(seenModels).toEqual([]);
    expect(String(result.content)).toContain('指定模型');
    expect(String(result.content)).toContain('当前不可用');
  });

  it('组织策略为 fixed 但未配置模型时 fail closed，不继承父模型', async () => {
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'should not run' };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-policy-fixed-empty' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'fixed' },
    });

    const result = await tool.execute({ prompt: 'task' }, makeContext());

    expect(result.isError).toBe(true);
    expect(seenModels).toEqual([]);
    expect(String(result.content)).toContain('固定模型策略缺少可用模型');
  });

  it('模板显式模型优先于组织默认子 Agent 策略', async () => {
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-policy-template' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'inherit' },
    });

    const result = await tool.execute(
      { prompt: 'task', template_id: 'template-1', model: 'glm-byok' },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual(['glm-byok']);
  });

  it('子模型与父模型不同时由宿主解析匹配的 Provider', async () => {
    const parentProviderModels: string[] = [];
    const childProviderModels: string[] = [];
    const resolvedModels: string[] = [];
    const parentProvider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        parentProviderModels.push(request.model);
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const childProvider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        childProviderModels.push(request.model);
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider: parentProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-provider-resolution' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'fixed', modelId: 'qwen-flash-small' },
      resolveProviderForModel: async modelId => {
        resolvedModels.push(modelId);
        return childProvider;
      },
    });

    const result = await tool.execute({ prompt: 'task' }, makeContext());

    expect(result.isError).toBeFalsy();
    expect(resolvedModels).toEqual(['qwen-flash-small']);
    expect(parentProviderModels).toEqual([]);
    expect(childProviderModels).toEqual(['qwen-flash-small']);
  });

  it('命中目录的子模型 → tool_result 无降级提示', async () => {
    const tool = createAgentTool({
      provider: providerWithFinalText('done'),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-hit' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'flash' },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).not.toContain('不在当前可用模型清单中');
  });

  it('清单外的子模型 → 确定性降级 + tool_result 中文提示（R8）', async () => {
    const tool = createAgentTool({
      provider: providerWithFinalText('done'),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-miss' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'gpt-5-ultra' },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    const content = String(result.content);
    expect(content).toContain('不在当前可用模型清单中');
    expect(content).toContain('已自动改用');
    expect(content).toContain('claude-opus-parent');
  });

  it('#9729：清单内子模型运行时不可用 → 通知 host 后改用父模型重试', async () => {
    const seenModels: string[] = [];
    const events: StreamEvent[] = [];
    const refreshRequests: Array<{
      modelId: string;
      errorType: string;
      message?: string;
    }> = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        if (request.model === 'qwen-flash-small') {
          throw new AgentError(
            '模型 "qwen-flash-small" 不存在或未激活。请刷新页面或换 model。',
            'LLM_ERROR',
            {
              statusCode: 404,
              details: { error_type: 'model_not_found' },
            },
          );
        }
        yield { type: 'text_delta' as const, text: 'fallback parent done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-runtime-miss' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      onModelRuntimeFailure: failure => refreshRequests.push(failure),
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'flash' },
      makeContext({ emitStreamEvent: event => events.push(event) }),
    );

    expect(result.isError, String(result.content)).toBeFalsy();
    expect(seenModels).toEqual(['qwen-flash-small', 'claude-opus-parent']);
    expect(refreshRequests).toHaveLength(1);
    expect(refreshRequests[0]?.modelId).toBe('qwen-flash-small');
    expect(refreshRequests[0]?.errorType).toBe('model_not_found');
    const content = String(result.content);
    expect(content).toContain('当前不可用或未激活');
    expect(content).toContain('claude-opus-parent');
    expect(content).toContain('fallback parent done');

    const failedEvents = events.filter(event => event.type === StreamEvents.SUBAGENT_FAILED);
    expect(failedEvents).toHaveLength(0);
    const statusEvents = events.filter(event =>
      event.type === StreamEvents.SUBAGENT_STARTED ||
      event.type === StreamEvents.SUBAGENT_COMPLETED ||
      event.type === StreamEvents.SUBAGENT_FAILED);
    const runIds = new Set(statusEvents.map(event => event.payload?.subagent_run_id));
    expect(runIds.size).toBe(1);
    const completed = events.find(event => event.type === StreamEvents.SUBAGENT_COMPLETED);
    expect(completed?.payload?.subagent_run_id).toBe(result.presentation?.data?.subagent_run_id);
  });

  it('#9729：fixed 策略子模型运行时不可用 → 通知 host 但不改用父模型重试', async () => {
    const seenModels: string[] = [];
    const events: StreamEvent[] = [];
    const refreshRequests: Array<{
      modelId: string;
      errorType: string;
      message?: string;
    }> = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        throw new AgentError(
          '模型 "qwen-flash-small" 不存在或未激活。请刷新页面或换 model。',
          'LLM_ERROR',
          {
            statusCode: 404,
            details: { error_type: 'model_not_found' },
          },
        );
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-runtime-fixed-miss' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      subagentModelPolicy: { mode: 'fixed', modelId: 'qwen-flash-small' },
      onModelRuntimeFailure: failure => refreshRequests.push(failure),
    });

    const result = await tool.execute(
      { prompt: 'task' },
      makeContext({ emitStreamEvent: event => events.push(event) }),
    );

    expect(result.isError).toBeTruthy();
    expect(seenModels).toEqual(['qwen-flash-small']);
    expect(refreshRequests).toHaveLength(1);
    expect(refreshRequests[0]?.modelId).toBe('qwen-flash-small');
    expect(refreshRequests[0]?.errorType).toBe('model_not_found');
    expect(events.some(event => event.type === StreamEvents.SUBAGENT_FAILED)).toBe(true);
  });

  it('#9729：后台子模型运行时不可用 → 不重试但仍通知 host 刷新目录', async () => {
    const seenModels: string[] = [];
    const events: StreamEvent[] = [];
    const refreshRequests: Array<{
      modelId: string;
      errorType: string;
      message?: string;
    }> = [];
    const budgetTracker = new BudgetTracker();
    const manager = new SubagentManager({
      parentThreadId: 'sess-runtime-bg-miss',
      spaceId: 'space-1',
      budgetTracker,
      enqueueNotification: () => {},
    });
    manager.rebindLiveDeps({ budgetTracker });
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        throw new AgentError(
          '模型 "qwen-flash-small" 不存在或未激活。请刷新页面或换 model。',
          'LLM_ERROR',
          {
            statusCode: 404,
            details: { error_type: 'model_not_found' },
          },
        );
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-runtime-bg-miss' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      budgetTracker,
      subagentManager: manager,
      onModelRuntimeFailure: failure => refreshRequests.push(failure),
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'flash', background: true },
      makeContext({ emitStreamEvent: event => events.push(event) }),
    );

    expect(result.isError, String(result.content)).toBeFalsy();
    expect(String(result.content)).toContain('已在后台启动');
    await waitFor(() => refreshRequests.length === 1);
    expect(seenModels).toEqual(['qwen-flash-small']);
    expect(refreshRequests[0]?.modelId).toBe('qwen-flash-small');
    expect(refreshRequests[0]?.errorType).toBe('model_not_found');
    expect(events.some(event => event.type === StreamEvents.SUBAGENT_FAILED)).toBe(true);
  });

  it('#9729：只有展示文案、没有结构化错误码时不刷新目录也不重试', async () => {
    const seenModels: string[] = [];
    const refreshRequests: Array<{
      modelId: string;
      errorType: string;
      message?: string;
    }> = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        throw new AgentError(
          '模型 "qwen-flash-small" 不存在或未激活。请刷新页面或换 model。',
          'LLM_ERROR',
          {
            statusCode: 404,
            details: { user_message: '模型 "qwen-flash-small" 不存在或未激活。请刷新页面或换 model。' },
          },
        );
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-runtime-message-only' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      onModelRuntimeFailure: failure => refreshRequests.push(failure),
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'flash' },
      makeContext(),
    );

    expect(result.isError).toBeTruthy();
    expect(seenModels).toEqual(['qwen-flash-small']);
    expect(refreshRequests).toHaveLength(0);
  });

  it('#9729：非 error_type 字段即使值为 model_not_found 也不刷新目录', async () => {
    const seenModels: string[] = [];
    const refreshRequests: Array<{
      modelId: string;
      errorType: string;
      message?: string;
    }> = [];
    const provider: LLMProvider = {
      async *createStream(request: LLMRequest): AsyncIterable<LLMResponseChunk> {
        seenModels.push(request.model);
        throw new AgentError(
          'model unavailable',
          'LLM_ERROR',
          {
            statusCode: 404,
            details: { errorType: 'model_not_found' },
          },
        );
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-runtime-wrong-code-field' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
      onModelRuntimeFailure: failure => refreshRequests.push(failure),
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'flash' },
      makeContext(),
    );

    expect(result.isError).toBeTruthy();
    expect(seenModels).toEqual(['qwen-flash-small']);
    expect(refreshRequests).toHaveLength(0);
  });

  it('agent 工具 description 注入了可用模型清单（Phase 4 菜单）', () => {
    const tool = createAgentTool({
      provider: providerWithFinalText('done'),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-desc' },
      model: 'claude-opus-parent',
      modelCatalog: CATALOG,
    });
    expect(tool.description).toContain('可用模型清单');
    expect(tool.description).toContain('qwen-flash-small');
  });

  it('Phase 3 端到端：子 Agent 用小窗口模型 → LLM 请求 maxTokens 跟随子模型（不继承父）', async () => {
    // 宿主级解析：catalog 里小模型窗口 16k / 输出上限 4k。
    expect(resolveModelCapabilitiesFromCatalog(CATALOG, 'qwen-flash-small')?.maxOutputTokens).toBe(4_000);

    // 捕获子 runtime 真正发给 provider 的请求。query.ts 用
    // `resolveMaxTokensForRequest(config.maxOutputTokens)` 算 maxTokens——
    // 子 EngineConfig.maxOutputTokens 由 agent-tool 按子模型从目录解析（Phase 3）。
    // 父是 opus（64k 上限）；若子误继承父，maxTokens 会是 64000 而非 4000。
    const seen: Array<number | undefined> = [];
    const capturingProvider: LLMProvider = {
      async *createStream(request: { maxTokens?: number }) {
        seen.push(request.maxTokens);
        yield { type: 'text_delta' as const, text: 'small-model done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider: capturingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-small' },
      model: 'claude-opus-parent',
      // 父能力：大窗口 / 64k 输出（W1b fix 注入的父值）。
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      modelCapabilities: BIG,
      modelCatalog: CATALOG,
    });

    const result = await tool.execute(
      { prompt: 'task', model: 'qwen-flash-small' },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    // 子 runtime 发出的请求 maxTokens == 子模型 4k（不是父 64k）→ 证明按子模型解析。
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(4_000);
  });
});

// ─── P1-1 回归：无目录 / 命不中 → 回落父值（不再误降 FALLBACK） ─────────────
//
// 修前 bug：resolveChildModelFromCatalog 永远返回非空 capabilities（命不中走
// FALLBACK），导致 agent-tool 的 `?? config.X`（父值兜底）永不触发 → 无目录 /
// 旧 host / 父非精确命中时，子「缺省跟父」也拿 FALLBACK（maxOutputTokens 跌 8192、
// 丢 prompt-cache、丢视觉）。修后命不中返回 undefined，让父值真正回落。

describe('P1-1 回归 · 无目录 / 命不中 → undefined（回落父值）', () => {
  it('无目录 + 缺省跟父 → capabilities undefined', () => {
    const r = resolveChildModelFromCatalog({ parentModel: 'claude-sonnet-20260101' });
    expect(r.model).toBe('claude-sonnet-20260101');
    expect(r.capabilities).toBeUndefined();
    expect(r.downgrade).toBeUndefined();
  });

  it('有目录但父模型非精确命中（带日期后缀）+ 缺省跟父 → capabilities undefined', () => {
    // 复刻生产场景：Daemon 父走前缀匹配命中 `claude-opus-parent-20260530`，子
    // 「缺省跟父」走 findCatalogEntry 精确匹配不中 → 必须回 undefined 回落父值，
    // 而不是按命不中吐 FALLBACK。
    const r = resolveChildModelFromCatalog({
      catalog: CATALOG,
      parentModel: 'claude-opus-parent-20260530',
    });
    expect(r.model).toBe('claude-opus-parent-20260530');
    expect(r.capabilities).toBeUndefined();
    expect(r.downgrade).toBeUndefined();
  });

  it('端到端：无目录 + 缺省跟父 → 子 maxTokens == 父值（不是 FALLBACK 8192）', async () => {
    // 父输出上限 64k（< MAX_SAFE 128k，不被裁剪），无 modelCatalog、不填 model（缺省跟父）。
    // 修前：childCapabilities=FALLBACK → 子 maxOutputTokens=8192 → 请求 maxTokens=8192。
    // 修后：childCapabilities=undefined → 回落 config.maxOutputTokens=64000。
    expect(FALLBACK_MODEL_CAPABILITIES.maxOutputTokens).toBe(8_192);
    const PARENT_MAX_OUTPUT = 64_000;

    const seen: Array<number | undefined> = [];
    const capturingProvider: LLMProvider = {
      async *createStream(request: { maxTokens?: number }) {
        seen.push(request.maxTokens);
        yield { type: 'text_delta' as const, text: 'follow-parent done' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider: capturingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-catalog', threadId: 'sess-nocatalog' },
      model: 'claude-opus-parent-20260530',
      // 父能力：64k 输出上限（宿主注入的父值）。
      contextWindowTokens: 200_000,
      maxOutputTokens: PARENT_MAX_OUTPUT,
      modelCapabilities: BIG,
      // 关键：不注入 modelCatalog（旧 host / 无目录场景）。
    });

    const result = await tool.execute(
      { prompt: 'task' }, // 不填 model → 缺省跟父
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThan(0);
    // 回落父值 64000，而非误降 FALLBACK 8192。
    expect(seen[0]).toBe(PARENT_MAX_OUTPUT);
    expect(seen[0]).not.toBe(FALLBACK_MODEL_CAPABILITIES.maxOutputTokens);
  });
});
