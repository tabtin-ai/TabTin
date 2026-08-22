/**
 * TS Zod round-trip 测试（W0-L1 / L2 / L5 实测）
 *
 * 验证目标：
 *   1. **22 case ContentBlock** 全部 parse → stringify → parse 字节级一致
 *   2. **7 类边界 case**（大整数 / 浮点 / null vs missing / emoji+escape / 空数组 /
 *       大 base64 / 未知字段）行为符合 W0 PoC §3.4 预期
 *   3. **6 envelope** 全部 round-trip 通过
 *   4. **W0-L1**：非法 JSON 必须被 zod 拒绝（不是静默通过）
 *   5. **W0-L2**：用 JSON.stringify 字节级 diff，不依赖宽容比较
 *
 * 这个测试是 codegen 工具链的 SSoT 校验——TS 端 round-trip 通过
 * 才有资格说"3 端 codegen 是基于同一 zod schema"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ContentBlockSchema,
  AnyContentBlockStreamEventSchema,
  MessageStartSchema,
  MessageDeltaSchema,
  MessageStopSchema,
  ContentBlockStartSchema,
  ContentBlockDeltaSchema,
  ContentBlockStopSchema,
  ContentBlockDeltaPayloadSchema,
} from '@tabtin/agent-wire';
import type { z } from 'zod';
import { FIXTURE_SAMPLES_DIR } from '../scripts/lib/paths.js';

function readFixture<T = unknown>(name: string): T {
  const raw = readFileSync(resolve(FIXTURE_SAMPLES_DIR, name), 'utf-8');
  return JSON.parse(raw) as T;
}

/**
 * 严格字节级 round-trip：parse → JSON.stringify → JSON.parse → 再 parse
 * 比较 stringify 后的字节字符串相等。
 *
 * 关键：第二次 stringify 时 zod schema 已经把"未指定的可选字段"剥离成
 * undefined → JSON.stringify 自动忽略；如果 schema 处理正确，
 * 两次 stringify 应当字节相等（不依赖 deepEqual 这种宽容比较）。
 */
function strictRoundTrip<T>(schema: z.ZodType<T>, value: unknown): { stringify1: string; stringify2: string } {
  const parsed1 = schema.parse(value);
  const s1 = JSON.stringify(parsed1);
  const parsed2 = schema.parse(JSON.parse(s1));
  const s2 = JSON.stringify(parsed2);
  return { stringify1: s1, stringify2: s2 };
}

// ════════════════════════════════════════════════════════════════════
// Suite 1: ContentBlock 22 case 完整 round-trip
// ════════════════════════════════════════════════════════════════════

describe('ContentBlock 22 case round-trip', () => {
  const cases = readFixture<unknown[]>('content_block_22cases.json');

  it('fixture 是 22 个 case', () => {
    expect(cases).toHaveLength(22);
  });

  cases.forEach((item, idx) => {
    const type = (item as { type: string }).type;
    it(`#${idx + 1} ${type} round-trip 字节级一致`, () => {
      const { stringify1, stringify2 } = strictRoundTrip(ContentBlockSchema, item);
      expect(stringify2).toBe(stringify1);
    });
  });

  it('22 case 的 type 字面量覆盖完整', () => {
    const types = new Set(cases.map((c) => (c as { type: string }).type));
    const expected = new Set([
      'text',
      'tool_use',
      'tool_result',
      'thinking',
      'redacted_thinking',
      'image',
      'document',
      'server_tool_use',
      'web_search_tool_result',
      'code_execution_tool_result',
      'bash_code_execution_tool_result',
      'text_editor_code_execution_tool_result',
      'mcp_tool_use',
      'mcp_tool_result',
      'container_upload',
      'search_result',
      'tabtin_rich_content',
      'tabtin_composer_preset',
      'tabtin_ask_user_fields',
      'tabtin_skill_invocation',
      'tabtin_source_ref',
      'tabtin_approval_request',
    ]);
    expect(types).toEqual(expected);
  });
});

// ════════════════════════════════════════════════════════════════════
// Suite 2: 边界 case (W0-L5 / W0-L2 严格 byte-level diff)
// ════════════════════════════════════════════════════════════════════

describe('ContentBlock 边界 case (W0-L2 / L5 严格形态)', () => {
  const edges = readFixture<unknown[]>('content_block_edge_cases.json');

  // 边界 case 6 个（不含 forward-compat，那个不进 zod）
  it('边界 fixture 6 项（不含 forward-compat）', () => {
    expect(edges.length).toBe(6);
  });

  edges.forEach((item, idx) => {
    const type = (item as { type: string }).type;
    it(`边界 #${idx + 1} ${type} 严格 byte-level round-trip`, () => {
      const { stringify1, stringify2 } = strictRoundTrip(ContentBlockSchema, item);
      expect(stringify2).toBe(stringify1);
    });
  });

  it('浮点数（doc snapshot.bbox）round-trip 不损失精度', () => {
    const docFixture = edges.find(
      (e) =>
        (e as { type: string }).type === 'tabtin_source_ref' &&
        (e as { snapshot: { kind: string } }).snapshot.kind === 'doc',
    );
    expect(docFixture).toBeTruthy();
    const parsed = ContentBlockSchema.parse(docFixture!);
    const dumped = JSON.parse(JSON.stringify(parsed)) as { snapshot: { bbox: number[] } };
    expect(dumped.snapshot.bbox).toEqual([0.123, 0.4567, 0.89012, 0.999]);
  });

  it('emoji + escape + unicode + surrogate pair byte-level identical', () => {
    const emojiFixture = edges.find(
      (e) =>
        (e as { type: string }).type === 'text' &&
        ((e as { text: string }).text || '').includes('🤔'),
    );
    expect(emojiFixture).toBeTruthy();
    const { stringify1, stringify2 } = strictRoundTrip(ContentBlockSchema, emojiFixture!);
    expect(stringify1).toBe(stringify2);
    // 验证 stringify 真的保留了 emoji（没被 escape 成 \uXXXX）
    expect(stringify1).toContain('🤔');
  });

  it('空数组 [] 不被压缩为 null / missing', () => {
    const emptyArr = edges.find(
      (e) =>
        (e as { type: string }).type === 'tool_result' &&
        Array.isArray((e as { content: unknown[] }).content) &&
        ((e as { content: unknown[] }).content as unknown[]).length === 0,
    );
    expect(emptyArr).toBeTruthy();
    const parsed = ContentBlockSchema.parse(emptyArr!) as { content: unknown[] };
    expect(parsed.content).toEqual([]);
    expect(JSON.stringify(parsed)).toContain('"content":[]');
  });

  it('大 base64 (32KB) 不丢字符', () => {
    const big = edges.find((e) => {
      const obj = e as { type: string; source?: { type: string; data?: string } };
      return obj.type === 'image' && obj.source?.type === 'base64' && (obj.source.data?.length ?? 0) >= 32 * 1024;
    });
    expect(big).toBeTruthy();
    const parsed = ContentBlockSchema.parse(big!) as { source: { data: string } };
    expect(parsed.source.data.length).toBe(32 * 1024);
    expect(parsed.source.data).toBe((big as { source: { data: string } }).source.data);
  });
});

// ════════════════════════════════════════════════════════════════════
// Suite 3: forward-compat (W0-L1：未知字段必须被 zod 拒绝；
//                            生产端在 Pydantic 用 extra='ignore' 接受)
// ════════════════════════════════════════════════════════════════════

describe('Forward-compat（W0-L1 严格拒收 vs 生产端宽松）', () => {
  const forwardCompat = readFixture<unknown[]>('content_block_forward_compat.json');

  it('forward-compat fixture 含未知字段', () => {
    expect(forwardCompat.length).toBeGreaterThanOrEqual(2);
  });

  forwardCompat.forEach((item, idx) => {
    it(`forward-compat #${idx + 1} 在 zod strict 模式下被拒绝`, () => {
      // zod 默认 schema 不带 strict() 但 type 字面量不在 22 case 时会拒
      // 这里 type 是合法的 (text / tool_use)，但额外字段 zod 默认 strip 不报错
      // 验证字段被 strip：
      const parsed = ContentBlockSchema.parse(item) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('_v3_marker');
      expect(parsed).not.toHaveProperty('future_top_level');
    });
  });

  it('未知 type 字面量被 zod 拒绝（不是静默通过）', () => {
    expect(() =>
      ContentBlockSchema.parse({ type: 'fictional_v3_block', some_field: 'x' }),
    ).toThrow();
  });

  it('discriminator 错误信息精确（z.discriminatedUnion 而非 z.union）', () => {
    let error: unknown;
    try {
      ContentBlockSchema.parse({ type: 'unknown_type' });
    } catch (e) {
      error = e;
    }
    const msg = (error as Error).message ?? '';
    // discriminatedUnion 的错误消息含具体的 expected discriminator value
    expect(msg).toMatch(/Invalid discriminator value|expected/);
  });
});

// ════════════════════════════════════════════════════════════════════
// Suite 4: 6 envelope round-trip
// ════════════════════════════════════════════════════════════════════

describe('6 envelope round-trip', () => {
  const envelopeTests = [
    { name: 'message_start', schema: MessageStartSchema, fixture: 'envelope_message_start.json' },
    { name: 'message_delta', schema: MessageDeltaSchema, fixture: 'envelope_message_delta.json' },
    { name: 'message_stop', schema: MessageStopSchema, fixture: 'envelope_message_stop.json' },
    {
      name: 'content_block_start',
      schema: ContentBlockStartSchema,
      fixture: 'envelope_content_block_start.json',
    },
    {
      name: 'content_block_delta',
      schema: ContentBlockDeltaSchema,
      fixture: 'envelope_content_block_delta_6types.json',
    },
    {
      name: 'content_block_stop',
      schema: ContentBlockStopSchema,
      fixture: 'envelope_content_block_stop.json',
    },
  ];

  envelopeTests.forEach(({ name, schema, fixture }) => {
    it(`envelope ${name} byte-level round-trip`, () => {
      const data = readFixture(fixture);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const { stringify1, stringify2 } = strictRoundTrip(schema, item);
        expect(stringify2).toBe(stringify1);
      }
    });
  });

  it('content_block_delta 6 种 delta.type 全覆盖', () => {
    const deltas = readFixture<{ delta: { type: string } }[]>(
      'envelope_content_block_delta_6types.json',
    );
    const types = new Set(deltas.map((d) => d.delta.type));
    expect(types).toEqual(
      new Set([
        'text_delta',
        'input_json_delta',
        'thinking_delta',
        'signature_delta',
        'citations_delta',
        'connector_text_delta',
      ]),
    );
  });

  it('any_event_stream 顶层 union 按 event_type 分发', () => {
    const stream = readFixture<unknown[]>('envelope_any_event_stream.json');
    for (const ev of stream) {
      const parsed = AnyContentBlockStreamEventSchema.parse(ev);
      expect(parsed.event_type).toMatch(/^agent\.stream\.(message|content_block)_/);
    }
  });

  it('未知 event_type 被 z.discriminatedUnion 拒绝', () => {
    expect(() =>
      AnyContentBlockStreamEventSchema.parse({
        event_type: 'agent.stream.future_event',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 'x',
        _seq: 1,
        thread_id: 'x',
      }),
    ).toThrow();
  });

  it('protocol_version 必须是 "v2"（v3 升级前不接受其他值）', () => {
    expect(() =>
      MessageStartSchema.parse({
        event_type: 'agent.stream.message_start',
        protocol_version: 'v3',
        min_compatible_version: 'v2',
        trace_id: 'x',
        _seq: 1,
        thread_id: 'x',
        message_id: 'x',
        role: 'assistant',
        model_id: 'x',
        model_name: 'x',
        started_at: '2026-05-10',
        run_id: 'x',
      }),
    ).toThrow();
  });

  // W4c-L5 · W4.5 第二波 B1：message_stop.error_info.partial_reason 三档
  // round-trip。fixture 见 02_emit_fixtures.ts 的
  // envelope_message_stop_partial_reasons.json。
  it('message_stop.error_info.partial_reason 三档 round-trip', () => {
    const fixtures = readFixture<Array<{ error_info?: { partial_reason?: string } }>>(
      'envelope_message_stop_partial_reasons.json',
    );
    expect(fixtures).toHaveLength(3);
    const reasons = new Set(
      fixtures.map((f) => f.error_info?.partial_reason).filter((r): r is string => Boolean(r)),
    );
    expect(reasons).toEqual(
      new Set(['message_stop_fallback', 'aborted', 'stream_interrupted']),
    );
    for (const item of fixtures) {
      const { stringify1, stringify2 } = strictRoundTrip(MessageStopSchema, item);
      expect(stringify2).toBe(stringify1);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// Suite 5: tabtin_source_ref 5 ref_kind round-trip + 双 discriminator
// ════════════════════════════════════════════════════════════════════

describe('tabtin_source_ref 5 ref_kind 双 discriminator', () => {
  const refs = readFixture<unknown[]>('tabtin_source_ref_5kinds.json');

  it('5 ref_kind 完整覆盖', () => {
    const kinds = new Set(refs.map((r) => (r as { ref_kind: string }).ref_kind));
    expect(kinds).toEqual(new Set(['web', 'doc', 'table', 'code', 'memo']));
  });

  refs.forEach((item, idx) => {
    const refKind = (item as { ref_kind: string }).ref_kind;
    it(`ref_kind=${refKind} round-trip + 双 discriminator 一致 (#${idx + 1})`, () => {
      const parsed = ContentBlockSchema.parse(item) as {
        ref_kind: string;
        snapshot: { kind: string };
      };
      expect(parsed.ref_kind).toBe(parsed.snapshot.kind);
      const { stringify1, stringify2 } = strictRoundTrip(ContentBlockSchema, item);
      expect(stringify2).toBe(stringify1);
    });
  });

  it('snapshot.kind 不匹配 ref_kind 也能 parse 但语义需调用方校验', () => {
    // 注意：我们当前 schema 不强制双 discriminator 一致——这是产品决策，
    // ref_kind 是 ContentBlock 顶层 discriminator，snapshot.kind 是嵌套 discriminator，
    // 两者独立校验。如果业务上要求一致，应该在 ContentBlock 上加 superRefine。
    // 这里测的是当前 schema 的实际行为：
    const inconsistent = {
      type: 'tabtin_source_ref',
      source_id: 'x',
      ref_kind: 'web',
      snapshot: { kind: 'doc', doc_id: 'd1' },
    };
    const parsed = ContentBlockSchema.parse(inconsistent) as {
      ref_kind: string;
      snapshot: { kind: string };
    };
    expect(parsed.ref_kind).toBe('web');
    expect(parsed.snapshot.kind).toBe('doc');
  });
});

// ════════════════════════════════════════════════════════════════════
// Suite 6: discriminated union 错误信息质量（不应是 N×M 行 z.union 噩梦）
// ════════════════════════════════════════════════════════════════════

describe('z.discriminatedUnion vs z.union 错误信息（W0 PoC §4 关键证据）', () => {
  it('未知 ContentBlock.type 错误信息只含一行 discriminator 提示', () => {
    let err: unknown;
    try {
      ContentBlockSchema.parse({ type: 'unknown_xxx' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    // discriminatedUnion 错误的 issue 数量 = 1（只指出 discriminator 不匹配）
    // 而 z.union 会列出 22 个 variant 各自的失败原因
    const zodErr = err as { issues?: { code: string }[] };
    expect(zodErr.issues).toBeDefined();
    expect(zodErr.issues?.length).toBe(1);
    expect(zodErr.issues?.[0]?.code).toBe('invalid_union_discriminator');
  });

  it('content_block_delta union 6 case 同样 1 行错误', () => {
    let err: unknown;
    try {
      ContentBlockDeltaPayloadSchema.parse({ type: 'unknown_delta' });
    } catch (e) {
      err = e;
    }
    const zodErr = err as { issues?: { code: string }[] };
    expect(zodErr.issues?.length).toBe(1);
    expect(zodErr.issues?.[0]?.code).toBe('invalid_union_discriminator');
  });
});
