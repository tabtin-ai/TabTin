/**
 * proxy-provider — usage 归一化：把 provider 差异统一成「input_tokens 不含 cache」。
 *
 * 背景：Anthropic 的 input_tokens 不含 cache（cache 在顶层字段），OpenAI 的
 * prompt_tokens 已含 cache（cache 在 prompt_tokens_details）。下游一律按
 * input + cache_read + cache_creation 求和还原完整上下文窗口占用（cache 也占窗口）。
 * 为避免 OpenAI 双算，proxy-provider 在归一化时按 cache 字段来源判定并剥离
 * OpenAI 的 input，使两家 provider 输出统一语义。
 */

import { describe, expect, it } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import type {
  ContentBlockEnvelopeHint,
} from '../src/engine/contracts/model-llm.js';

function makeMockSSEResponse(sseText: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  // @ts-expect-error -- mock Response in node 环境足够 proxy-provider 消费
  return new Response(stream, { status: 200 });
}

interface UsageChunk {
  type: 'usage';
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

async function collectUsageChunks(sseText: string): Promise<UsageChunk['usage'][]> {
  const provider = new TabTinProxyProvider({
    apiBaseUrl: 'https://example.com',
    accessTokenProvider: async () => 'fake-token',
  });
  const envelopeState = {
    onEvent: (_hint: ContentBlockEnvelopeHint) => { /* ignore */ },
    blockIndex: -1,
    activeKind: null as 'text' | 'thinking' | 'tool_use' | null,
    activeBlockId: null as string | null,
    anthropicIndex: new Map(),
    openaiToolEmitted: new Map(),
    messageStartEmitted: false,
    messageDeltaEmitted: false,
    messageStopEmitted: false,
  };
  const response = makeMockSSEResponse(sseText);
  const generator = (provider as unknown as {
    parseSSEStream: (resp: Response, state: typeof envelopeState) => AsyncGenerator<unknown>;
  }).parseSSEStream(response, envelopeState);

  const usages: UsageChunk['usage'][] = [];
  for await (const c of generator) {
    if (c && typeof c === 'object' && (c as { type?: string }).type === 'usage') {
      const u = (c as UsageChunk).usage;
      // 跳过 billing 尾帧那种只有 cost 的 usage
      if (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number') {
        usages.push(u);
      }
    }
  }
  return usages;
}

function openaiUsageSSE(usage: Record<string, unknown>): string {
  return [
    `data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":${JSON.stringify(usage)}}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n') + '\n';
}

describe('proxy-provider usage 归一化（input_tokens 不含 cache）', () => {
  it('OpenAI 语义：prompt_tokens 含 cache → 剥离成不含 cache', async () => {
    const usages = await collectUsageChunks(openaiUsageSSE({
      prompt_tokens: 10000,
      completion_tokens: 50,
      total_tokens: 10050,
      prompt_tokens_details: { cached_tokens: 8000 },
    }));
    expect(usages.length).toBeGreaterThan(0);
    const u = usages[0]!;
    // 10000（含 cache）− 8000 = 2000（不含 cache）
    expect(u.input_tokens).toBe(2000);
    expect(u.cache_read_input_tokens).toBe(8000);
    // 下游求和还原完整上下文 = 2000 + 8000 = 10000（= 原 prompt_tokens，不双算）
    expect((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)).toBe(10000);
  });

  it('OpenAI 无 cache 命中：input 不变', async () => {
    const usages = await collectUsageChunks(openaiUsageSSE({
      prompt_tokens: 5000,
      completion_tokens: 20,
      total_tokens: 5020,
    }));
    const u = usages[0]!;
    expect(u.input_tokens).toBe(5000);
    expect(u.cache_read_input_tokens).toBeUndefined();
  });

  it('Anthropic 语义（顶层 cache 字段）：input 已不含 cache，不剥离', async () => {
    // 某些 proxy 把 Anthropic 转 OpenAI-shape，但 cache 仍在顶层字段。
    const usages = await collectUsageChunks(openaiUsageSSE({
      prompt_tokens: 2000,
      completion_tokens: 30,
      total_tokens: 2030,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 500,
    }));
    const u = usages[0]!;
    // 顶层 cache 字段 → 判定为「input 不含 cache」→ 不剥离
    expect(u.input_tokens).toBe(2000);
    expect(u.cache_read_input_tokens).toBe(8000);
    expect(u.cache_creation_input_tokens).toBe(500);
    // 求和 = 2000 + 8000 + 500 = 10500
    expect(
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    ).toBe(10500);
  });

  it('OpenAI cache 超过 prompt（脏数据）：剥离后夹到 0，不出现负数', async () => {
    const usages = await collectUsageChunks(openaiUsageSSE({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 500 },
    }));
    const u = usages[0]!;
    expect(u.input_tokens).toBe(0);
    expect(u.cache_read_input_tokens).toBe(500);
  });
});

// ─── tabtin.billing 尾帧 → cost_usd（ 跨层回归）────────────────
//
// credits 预算闸门（CostCap.max_credits_per_run）依赖 state.creditsCharged 累计，
// 而后者的唯一来源是这条 SSE 尾帧被解析成带 cost_usd 的 usage chunk。若此解析
// 断裂（事件名漂移 / charged 透传丢失），runtime credits 恒 0、上限永不触发。
// 与 Django 侧 test_settle_and_charge...total 一起，端到端护住「计费→预算」链路。

function billingSSE(billing: Record<string, unknown>): string {
  return [
    'event: tabtin.billing',
    `data: ${JSON.stringify(billing)}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n') + '\n';
}

async function collectBillingCostChunks(
  sseText: string,
): Promise<Array<{ cost_usd?: number; charge_status?: string }>> {
  const provider = new TabTinProxyProvider({
    apiBaseUrl: 'https://example.com',
    accessTokenProvider: async () => 'fake-token',
  });
  const envelopeState = {
    onEvent: (_hint: ContentBlockEnvelopeHint) => { /* ignore */ },
    blockIndex: -1,
    activeKind: null as 'text' | 'thinking' | 'tool_use' | null,
    activeBlockId: null as string | null,
    anthropicIndex: new Map(),
    openaiToolEmitted: new Map(),
    messageStartEmitted: false,
    messageDeltaEmitted: false,
    messageStopEmitted: false,
  };
  const response = makeMockSSEResponse(sseText);
  const generator = (provider as unknown as {
    parseSSEStream: (resp: Response, state: typeof envelopeState) => AsyncGenerator<unknown>;
  }).parseSSEStream(response, envelopeState);

  const out: Array<{ cost_usd?: number; charge_status?: string }> = [];
  for await (const c of generator) {
    if (c && typeof c === 'object' && (c as { type?: string }).type === 'usage') {
      const u = (c as { usage: { cost_usd?: number; charge_status?: string } }).usage;
      if (typeof u.cost_usd === 'number') out.push(u);
    }
  }
  return out;
}

describe('proxy-provider — tabtin.billing 尾帧 → cost_usd', () => {
  it('credits_charged>0 → 发出带 cost_usd 的 usage chunk（credits 得以累计）', async () => {
    const chunks = await collectBillingCostChunks(
      billingSSE({ credits_charged: 2.5, charge_status: 'success' }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.cost_usd).toBe(2.5);
    expect(chunks[0]!.charge_status).toBe('success');
  });

  it('credits_charged=0 + charge_status → cost_usd:0（透传 charge_status，不误加 credits）', async () => {
    const chunks = await collectBillingCostChunks(
      billingSSE({ credits_charged: 0, charge_status: 'byok_exempt' }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.cost_usd).toBe(0);
    expect(chunks[0]!.charge_status).toBe('byok_exempt');
  });
});
