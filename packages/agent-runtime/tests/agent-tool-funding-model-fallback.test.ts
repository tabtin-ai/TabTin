import { describe, expect, it } from 'vitest';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import {
  FALLBACK_MODEL_CAPABILITIES,
  type LLMProvider,
  type ModelCatalogEntry,
} from '../src/engine/contracts/model-llm.js';
import type { LLMRequest } from '../src/engine/contracts/model-llm.js';
import type { ToolContext } from '../src/engine/contracts/tools.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';

function makeContext(): ToolContext {
  return {
    threadId: 'funding-thread',
    runtimeId: 'funding-runtime',
    toolUseId: 'funding-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
  } as ToolContext;
}

function catalogEntry(
  id: string,
  usageHint: string,
  providerScope: ModelCatalogEntry['providerScope'] = 'global',
): ModelCatalogEntry {
  return {
    id,
    displayName: id,
    usageHint,
    providerScope,
    capabilities: {
      ...FALLBACK_MODEL_CAPABILITIES,
      contextWindowTokens: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 4096,
    },
  };
}

describe('agent tool child model funding fallback', () => {
  it('余额预检挡住请求模型时，同价 fallback 按 catalog 到父模型的稳定顺序选择', async () => {
    const requested = catalogEntry('model-expensive', '强/贵');
    const highCost = catalogEntry('model-high-cost', '便宜/快');
    const lowCost = catalogEntry('model-low-cost', '强/贵');
    const seenModels: string[] = [];
    const fundingCalls: Array<{ modelId: string; estimatedTokens: number }> = [];
    const provider: LLMProvider = {
      async *createStream(req: LLMRequest) {
        seenModels.push(req.model);
        yield { type: 'text_delta' as const, text: `used ${req.model}` };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/tabtin-agent-tool-funding', threadId: 'funding-fallback' },
      model: 'parent-model',
      modelCatalog: [requested, highCost, lowCost],
      previewChildModelFunding: async ({ modelId, estimatedTokens }) => {
        fundingCalls.push({ modelId, estimatedTokens });
        if (modelId === requested.id) {
          return {
            allowed: false,
            message: '组织钱包余额不足，请充值后重试。',
            requiredCredits: '12.5',
          };
        }
        // lowCost 与父模型同价时，保留候选顺序中先出现的 catalog 模型。
        return {
          allowed: true,
          requiredCredits: modelId === highCost.id ? '5.0' : '0.5',
        };
      },
    });

    const result = await tool.execute(
      { prompt: '做一个调研任务', model: requested.id },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual([lowCost.id]);
    expect(fundingCalls.map((call) => call.modelId)).toEqual([
      requested.id,
      highCost.id,
      lowCost.id,
      'parent-model',
    ]);
    expect(fundingCalls.every((call) => call.estimatedTokens > 0)).toBe(true);
    expect(String(result.content)).toContain(`已自动改用「${lowCost.id}」`);
    expect(String(result.content)).toContain('组织钱包余额不足');
  });

  it('父模型未精确命中目录但预估费用更低时仍可作为 fallback', async () => {
    const requested = catalogEntry('model-expensive', '强/贵');
    const catalogFallback = catalogEntry('model-catalog-fallback', '便宜/快');
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(req: LLMRequest) {
        seenModels.push(req.model);
        yield { type: 'text_delta' as const, text: `used ${req.model}` };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/tabtin-agent-tool-funding', threadId: 'funding-parent' },
      model: 'parent-model-with-version-suffix',
      modelCatalog: [requested, catalogFallback],
      previewChildModelFunding: async ({ modelId }) => {
        if (modelId === requested.id) {
          return { allowed: false, requiredCredits: '12.5' };
        }
        return {
          allowed: true,
          requiredCredits: modelId === catalogFallback.id ? '0.5' : '0.25',
        };
      },
    });

    const result = await tool.execute(
      { prompt: '做一个调研任务', model: requested.id },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual(['parent-model-with-version-suffix']);
    expect(String(result.content)).toContain('已自动改用「parent-model-with-version-suffix」');
  });

  it('请求 BYOK 子模型时不走组织钱包资金预检', async () => {
    const byok = catalogEntry('model-byok', 'BYOK', 'user');
    const seenModels: string[] = [];
    const provider: LLMProvider = {
      async *createStream(req: LLMRequest) {
        seenModels.push(req.model);
        yield { type: 'text_delta' as const, text: `used ${req.model}` };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/tabtin-agent-tool-funding', threadId: 'funding-byok' },
      model: 'parent-model',
      modelCatalog: [byok],
      previewChildModelFunding: async () => {
        throw new Error('BYOK should not call organization funding precheck');
      },
    });

    const result = await tool.execute(
      { prompt: '做一个调研任务', model: byok.id },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(seenModels).toEqual([byok.id]);
  });

  it('资金预检全部挡住时不启动子 Agent', async () => {
    const requested = catalogEntry('model-expensive', '强/贵');
    const cheap = catalogEntry('model-cheap', '便宜/快');
    const providerCalls: string[] = [];
    const provider: LLMProvider = {
      async *createStream(req: LLMRequest) {
        providerCalls.push(req.model);
        yield { type: 'text_delta' as const, text: 'should not run' };
      },
    };

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/tabtin-agent-tool-funding', threadId: 'funding-blocked' },
      model: 'parent-model',
      modelCatalog: [requested, cheap],
      previewChildModelFunding: async ({ modelId }) => ({
        allowed: false,
        message: `${modelId} 余额不足`,
        requiredCredits: '1.0',
      }),
    });

    const result = await tool.execute(
      { prompt: '做一个调研任务', model: requested.id },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(providerCalls).toEqual([]);
    expect(String(result.content)).toContain('子 Agent 未启动');
    expect(String(result.content)).toContain('资金预检均未通过');
  });

  it('fixed 策略资金预检未通过时不改用 catalog 或父模型', async () => {
    const requested = catalogEntry('model-expensive', '强/贵');
    const cheap = catalogEntry('model-cheap', '便宜/快');
    const providerCalls: string[] = [];
    const fundingCalls: string[] = [];
    const provider: LLMProvider = {
      async *createStream(req: LLMRequest) {
        providerCalls.push(req.model);
        yield { type: 'text_delta' as const, text: 'should not run' };
      },
    };

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/tabtin-agent-tool-funding', threadId: 'funding-fixed-blocked' },
      model: 'parent-model',
      modelCatalog: [requested, cheap],
      subagentModelPolicy: { mode: 'fixed', modelId: requested.id },
      previewChildModelFunding: async ({ modelId }) => {
        fundingCalls.push(modelId);
        return {
          allowed: false,
          message: '组织钱包余额不足，请充值后重试。',
          requiredCredits: '12.5',
        };
      },
    });

    const result = await tool.execute(
      { prompt: '做一个调研任务' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(providerCalls).toEqual([]);
    expect(fundingCalls).toEqual([requested.id]);
    expect(String(result.content)).toContain('子 Agent 未启动');
    expect(String(result.content)).toContain(requested.id);
    expect(String(result.content)).not.toContain(cheap.id);
    expect(String(result.content)).not.toContain('parent-model');
  });
});
