/**
 * Prompt cache 显式断点策略测试（PRD §5.5.2 / 阶段 7.4）
 *
 * applyExplicitCache 的 4 断点 + cacheType 门控此前 0 覆盖。本文件锁定：
 *   - cacheType explicit/undefined → 加断点；implicit/none → 完全不加
 *   - BP1 tools 末项 / BP2 system 静态段末尾 / BP3 system 动态段末尾
 *   - BP4 最后一条 user：仅在 messages token 估算 >= 1024 时加（CJK-aware）
 *   - 中文与英文同字符数下 BP4 门控结果不同 —— token 口径相对旧字符口径的价值
 */

import { describe, it, expect } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  FALLBACK_MODEL_CAPABILITIES,
} from '../src/engine/contracts/model-llm.js';
import type {
  SystemBlock,
  ToolParam,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMRequest,
  ModelCapabilities,
} from '../src/engine/contracts/model-llm.js';

interface BodyShape {
  system?: string | Array<{ type: string; text: string; cache_control?: unknown }>;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ cache_control?: unknown }>;
}

function makeProvider(
  cacheType: ModelCapabilities['cacheType'] | undefined,
  overrides: Partial<ModelCapabilities> = {},
): TabTinProxyProvider {
  return new TabTinProxyProvider({
    proxyUrl: 'http://localhost:0/llm/proxy',
    deviceToken: 'tok',
    agentId: 'ag',
    threadId: 'ss',
    maxRetries: 0,
    modelCapabilities:
      cacheType === undefined
        ? undefined
        : { ...FALLBACK_MODEL_CAPABILITIES, cacheType, ...overrides },
  });
}

function buildBody(provider: TabTinProxyProvider, request: LLMRequest): BodyShape {
  const build = (
    provider as unknown as { buildRequestBody: (r: LLMRequest) => BodyShape }
  ).buildRequestBody.bind(provider);
  return build(request);
}

const SYSTEM_BLOCKS: SystemBlock[] = [
  { type: 'text', text: 'STATIC persona / rules / safety' },
  { type: 'text', text: `${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}DYNAMIC context injection` },
];

const TOOLS: ToolParam[] = [
  { name: 'demo_tool_a', description: 'read', input_schema: { type: 'object' } },
  { name: 'demo_tool_b', description: 'write', input_schema: { type: 'object' } },
];

function baseRequest(overrides: Partial<LLMRequest>): LLMRequest {
  return {
    model: 'claude-test',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 32,
    system: SYSTEM_BLOCKS,
    tools: TOOLS,
    ...overrides,
  } as LLMRequest;
}

function systemCacheCount(body: BodyShape): number {
  if (!Array.isArray(body.system)) return 0;
  return body.system.filter((b) => b.cache_control).length;
}

function lastToolHasCache(body: BodyShape): boolean {
  if (!body.tools?.length) return false;
  return Boolean(body.tools[body.tools.length - 1].cache_control);
}

function lastUserHasCache(body: BodyShape): boolean {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i].role === 'user') {
      const c = body.messages[i].content;
      if (!Array.isArray(c)) return false;
      return c.some(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          'cache_control' in p &&
          Boolean((p as Record<string, unknown>).cache_control),
      );
    }
  }
  return false;
}

describe('applyExplicitCache — cacheType 门控', () => {
  it('cacheType=explicit：tools(BP1) + system(BP2/BP3) 断点都加', () => {
    const body = buildBody(makeProvider('explicit'), baseRequest({}));
    expect(lastToolHasCache(body)).toBe(true);
    expect(systemCacheCount(body)).toBe(2);
  });

  it('cacheType=undefined（老宿主未传能力）：回退到 explicit', () => {
    const body = buildBody(makeProvider(undefined), baseRequest({}));
    expect(lastToolHasCache(body)).toBe(true);
    expect(systemCacheCount(body)).toBe(2);
  });

  it('cacheType=implicit：完全不加 cache_control（靠前缀稳定）', () => {
    const body = buildBody(
      makeProvider('implicit'),
      baseRequest({ messages: [{ role: 'user', content: 'a'.repeat(5000) }] }),
    );
    expect(lastToolHasCache(body)).toBe(false);
    expect(systemCacheCount(body)).toBe(0);
    expect(lastUserHasCache(body)).toBe(false);
  });

  it('cacheType=none：完全不加 cache_control', () => {
    const body = buildBody(
      makeProvider('none'),
      baseRequest({ messages: [{ role: 'user', content: 'a'.repeat(5000) }] }),
    );
    expect(lastToolHasCache(body)).toBe(false);
    expect(systemCacheCount(body)).toBe(0);
    expect(lastUserHasCache(body)).toBe(false);
  });
});

describe('applyExplicitCache — BP2/BP3 boundary 定位', () => {
  it('BP2 落在 boundary 前一块、BP3 落在 system 末块', () => {
    const body = buildBody(makeProvider('explicit'), baseRequest({}));
    expect(Array.isArray(body.system)).toBe(true);
    const sys = body.system as Array<{ cache_control?: unknown }>;
    expect(sys[0].cache_control).toBeTruthy(); // BP2 静态段末尾（boundary 前一块）
    expect(sys[1].cache_control).toBeTruthy(); // BP3 动态段末尾（system 末块）
  });
});

describe('applyExplicitCache — BP4 门控（CJK-aware token 阈值）', () => {
  it('短对话（< 1024 token）：不加 BP4', () => {
    const body = buildBody(
      makeProvider('explicit'),
      baseRequest({ messages: [{ role: 'user', content: 'hi there' }] }),
    );
    expect(lastUserHasCache(body)).toBe(false);
  });

  it('长英文对话（> 1024 token）：加 BP4', () => {
    const body = buildBody(
      makeProvider('explicit'),
      baseRequest({ messages: [{ role: 'user', content: 'a'.repeat(5000) }] }), // ≈1667 token
    );
    expect(lastUserHasCache(body)).toBe(true);
  });

  it('CJK 价值：同 1500 字符，中文达阈值加 BP4、英文不达不加', () => {
    const cjkBody = buildBody(
      makeProvider('explicit'),
      baseRequest({ messages: [{ role: 'user', content: '字'.repeat(1500) }] }), // ≈1539 token
    );
    const latinBody = buildBody(
      makeProvider('explicit'),
      baseRequest({ messages: [{ role: 'user', content: 'a'.repeat(1500) }] }), // ≈500 token
    );
    expect(lastUserHasCache(cjkBody)).toBe(true);
    expect(lastUserHasCache(latinBody)).toBe(false);
  });
});

// ── BP4 真实形态补充（review 修复轮）──────────────────────────────────
// 把多模态 / 多轮 / 边界形态 cast 成 LLMRequest['messages']，构造真实 Anthropic-
// 格式输入，验证生产实际路径：convertMessages 会把 tool_result 拆成 role:'tool'
// string 消息、image 转 image_url part；estimateMessagesTokens 据此累加门控。
function msgs(arr: unknown[]): LLMRequest['messages'] {
  return arr as unknown as LLMRequest['messages'];
}

const IMG = (): unknown => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
});

describe('applyExplicitCache — BP4 真实多轮形态（tool_use / tool_result）', () => {
  it('多轮：tool_result token 计入门控、BP4 落最后一条 user', () => {
    const body = buildBody(
      makeProvider('explicit'),
      baseRequest({
        messages: msgs([
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'demo_tool_a', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000) }] },
          { role: 'user', content: 'q2 final' },
        ]),
      }),
    );
    // tool_result(~1667 token)计入 → 过阈值；BP4 落最后一条 user('q2 final')
    expect(lastUserHasCache(body)).toBe(true);
  });

  it('多轮但内容都短：总 token < 1024 不加 BP4（反证 tool 消息确被计入门控）', () => {
    const body = buildBody(
      makeProvider('explicit'),
      baseRequest({
        messages: msgs([
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'demo_tool_a', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'small result' }] },
          { role: 'user', content: 'q2' },
        ]),
      }),
    );
    expect(lastUserHasCache(body)).toBe(false);
  });
});

describe('applyExplicitCache — BP4 多模态 content（image part 计入门控）', () => {
  it('单张图（IMAGE_TOKEN_ESTIMATE=1000 < 1024）不触发 BP4', () => {
    const body = buildBody(
      makeProvider('explicit', { supportsVision: true }),
      baseRequest({ messages: msgs([{ role: 'user', content: [IMG()] }]) }),
    );
    expect(lastUserHasCache(body)).toBe(false);
  });

  it('两张图（2×1000 > 1024）触发 BP4 —— 证明 image part 计入而非计 0', () => {
    const body = buildBody(
      makeProvider('explicit', { supportsVision: true }),
      baseRequest({ messages: msgs([{ role: 'user', content: [IMG(), IMG()] }]) }),
    );
    expect(lastUserHasCache(body)).toBe(true);
  });

  it('text + image 混合：文字 token 与图片 token 都计入', () => {
    const body = buildBody(
      makeProvider('explicit', { supportsVision: true }),
      baseRequest({
        messages: msgs([{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }, IMG()] }]),
      }),
    );
    // ~133(text) + 1000(image) = 1133 > 1024；若 image 计 0 则 133 < 1024 不加
    expect(lastUserHasCache(body)).toBe(true);
  });

  it('非视觉模型：image block 降级为文本，不发送 image_url part', () => {
    const body = buildBody(
      makeProvider('explicit', { supportsVision: false }),
      baseRequest({
        messages: msgs([
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'http://127.0.0.1:6060/local.png' } },
            ],
          },
        ]),
      }),
    );

    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('does not support vision input');
    expect(JSON.stringify(body.messages[0].content)).not.toContain('image_url');
  });

  it('视觉模型遇到本地图片 URL：降级为文本，避免上游抓取 localhost', () => {
    const body = buildBody(
      makeProvider('explicit', { supportsVision: true }),
      baseRequest({
        messages: msgs([
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'http://127.0.0.1:6060/local.png' } },
            ],
          },
        ]),
      }),
    );

    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('cannot access this image URL');
    expect(JSON.stringify(body.messages[0].content)).not.toContain('image_url');
  });

  it('视觉模型遇到公开图片 URL：仍作为 image_url 发送', () => {
    const body = buildBody(
      makeProvider('explicit', { supportsVision: true }),
      baseRequest({
        messages: msgs([
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
            ],
          },
        ]),
      }),
    );

    expect(JSON.stringify(body.messages[0].content)).toContain('image_url');
    expect(JSON.stringify(body.messages[0].content)).toContain('https://example.com/image.png');
  });
});

describe('applyExplicitCache — BP2/BP4 边界场景', () => {
  it('无 user 消息（仅 assistant）：不加 BP4', () => {
    const body = buildBody(
      makeProvider('explicit'),
      baseRequest({ messages: msgs([{ role: 'assistant', content: 'hello there' }]) }),
    );
    expect(lastUserHasCache(body)).toBe(false);
  });

  it('system 无 DYNAMIC_BOUNDARY marker：只加 BP3（末块），不加 BP2', () => {
    const body = buildBody(
      makeProvider('explicit'),
      baseRequest({
        system: [
          { type: 'text', text: '静态段，无 boundary marker' },
          { type: 'text', text: '第二段，仍无 boundary' },
        ],
      }),
    );
    expect(systemCacheCount(body)).toBe(1);
  });
});
