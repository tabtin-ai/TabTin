/**
 *
 * 验证：
 *   1. `MessageKindSchema` 三档字面量严格 enum——任何其他字符串拒收
 *   2. `MessageStartSchema` 必填 `message_kind`，缺失字段直接 parse fail
 *   3. `MessageStartSchema` 9 个 role × message_kind 组合里：
 *      - 6 个合法（llm × 3 / tool_artifact × 2 / error_envelope × 1）round-trip 通过
 *      - 3 个非法（tool_artifact × system / error_envelope × user / error_envelope × system）fail
 *   4. `AnyContentBlockStreamEventSchema` 走 union 解析路径时也跑 superRefine 兜底
 *      （discriminator 优化 + 协议契约两不误）
 *
 * 一旦本契约破坏：
 *   - daemon emit 漏标 `message_kind` 会 silent 通过 wire schema，下游 5 端各种 silent regress
 *   - 非法 role × message_kind 组合（譬如 `error_envelope × user`）通过校验会让历史 / UI 渲染错位
 */

import { describe, expect, it } from 'vitest';
import {
  AnyContentBlockStreamEventSchema,
  MessageKindSchema,
  MessageStartSchema,
  type MessageKind,
} from '@tabtin/agent-wire';

const baseEnvelope = {
  protocol_version: 'v2' as const,
  min_compatible_version: 'v2' as const,
  trace_id: 'trace_abc',
  _seq: 0,
  thread_id: 'thread_xyz',
  event_type: 'agent.stream.message_start' as const,
  message_id: 'msg_test_01',
  model_id: 'claude-sonnet-4-7',
  model_name: 'Claude Sonnet 4.7',
  started_at: '2026-05-17T22:00:00Z',
  run_id: 'run_abc',
};

describe('MessageKindSchema — 字面量严格 enum', () => {
  it.each([
    'llm',
    'tool_artifact',
    'error_envelope',
    'environment_context',
    'agent_profile_context',
    'system_prompt_context',
  ] as const)(
    '合法值 %s 通过',
    (value) => {
      expect(MessageKindSchema.parse(value)).toBe(value);
    },
  );

  it.each(['LLM', 'tool-artifact', 'error', 'system', '', ' llm', 'llm '])(
    '非法值 %s fail（防"近义词漂移"）',
    (value) => {
      expect(() => MessageKindSchema.parse(value)).toThrow();
    },
  );

  it('非字符串值 fail', () => {
    expect(() => MessageKindSchema.parse(null)).toThrow();
    expect(() => MessageKindSchema.parse(undefined)).toThrow();
    expect(() => MessageKindSchema.parse(123)).toThrow();
    expect(() => MessageKindSchema.parse({})).toThrow();
    expect(() => MessageKindSchema.parse([])).toThrow();
  });
});

describe('MessageStartSchema — message_kind 必填', () => {
  it('缺 message_kind 字段直接 parse fail（防 silent regress）', () => {
    const { ...payloadWithoutKind } = { ...baseEnvelope, role: 'assistant' as const };
    expect(() => MessageStartSchema.parse(payloadWithoutKind)).toThrow();
  });

  it('明确传 message_kind=undefined 也 fail（required 不接受 undefined）', () => {
    expect(() =>
      MessageStartSchema.parse({
        ...baseEnvelope,
        role: 'assistant',
        message_kind: undefined,
      }),
    ).toThrow();
  });

  it('message_kind 拼错（譬如 "error_envelop"）fail', () => {
    expect(() =>
      MessageStartSchema.parse({
        ...baseEnvelope,
        role: 'assistant',
        message_kind: 'error_envelop',
      }),
    ).toThrow();
  });
});

describe('MessageStartSchema — superRefine 校验 role × message_kind 组合', () => {
  // 合法组合
  const legalCombos: Array<{ kind: MessageKind; role: 'assistant' | 'user' | 'system' }> = [
    { kind: 'llm', role: 'assistant' },
    { kind: 'llm', role: 'user' },
    { kind: 'llm', role: 'system' },
    { kind: 'tool_artifact', role: 'assistant' },
    { kind: 'tool_artifact', role: 'user' },
    { kind: 'error_envelope', role: 'assistant' },
    { kind: 'environment_context', role: 'user' },
    { kind: 'agent_profile_context', role: 'user' },
    { kind: 'system_prompt_context', role: 'user' },
  ];

  it.each(legalCombos)(
    '合法组合 message_kind=$kind × role=$role round-trip 通过',
    ({ kind, role }) => {
      const parsed = MessageStartSchema.parse({
        ...baseEnvelope,
        role,
        message_kind: kind,
      });
      expect(parsed.message_kind).toBe(kind);
      expect(parsed.role).toBe(role);
    },
  );

  // 非法组合
  const illegalCombos: Array<{ kind: MessageKind; role: 'assistant' | 'user' | 'system' }> = [
    { kind: 'tool_artifact', role: 'system' },
    { kind: 'error_envelope', role: 'user' },
    { kind: 'error_envelope', role: 'system' },
    { kind: 'environment_context', role: 'assistant' },
    { kind: 'agent_profile_context', role: 'assistant' },
    { kind: 'agent_profile_context', role: 'system' },
    { kind: 'system_prompt_context', role: 'assistant' },
    { kind: 'system_prompt_context', role: 'system' },
  ];

  it.each(illegalCombos)(
    '非法组合 message_kind=$kind × role=$role 必须 fail（含明确 allowed roles 错误文案）',
    ({ kind, role }) => {
      const result = MessageStartSchema.safeParse({
        ...baseEnvelope,
        role,
        message_kind: kind,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        // 错误信息应该明确说"illegal role=X for message_kind=Y; allowed roles: [...]"
        // 让 reviewer / 5 端 consumer 一眼看懂
        const messages = result.error.issues.map((i) => i.message).join(' | ');
        expect(messages).toMatch(/illegal role=/);
        expect(messages).toContain(`role=${role}`);
        expect(messages).toContain(`message_kind=${kind}`);
        expect(messages).toContain('allowed roles:');
      }
    },
  );
});

describe('AnyContentBlockStreamEventSchema — union 解析也跑 superRefine 兜底', () => {
  // 关键不变量：消费方走 AnyContentBlockStreamEventSchema 解析整个 stream 时，
  // role × message_kind 非法组合也必须 fail，不能因为走 discriminatedUnion
  // 优化路径就绕过 superRefine。
  it('union 解析合法 message_start 事件通过', () => {
    const parsed = AnyContentBlockStreamEventSchema.parse({
      ...baseEnvelope,
      role: 'assistant',
      message_kind: 'llm',
    });
    expect(parsed.event_type).toBe('agent.stream.message_start');
    if (parsed.event_type === 'agent.stream.message_start') {
      expect(parsed.message_kind).toBe('llm');
    }
  });

  it('union 解析非法组合 error_envelope × user 必须 fail（不能 silent 绕过 superRefine）', () => {
    expect(() =>
      AnyContentBlockStreamEventSchema.parse({
        ...baseEnvelope,
        role: 'user',
        message_kind: 'error_envelope',
      }),
    ).toThrow();
  });

  it('union 解析非法组合 tool_artifact × system 必须 fail', () => {
    expect(() =>
      AnyContentBlockStreamEventSchema.parse({
        ...baseEnvelope,
        role: 'system',
        message_kind: 'tool_artifact',
      }),
    ).toThrow();
  });

  it('union 解析其他 event_type（譬如 message_stop）不受 message_kind superRefine 影响', () => {
    // message_kind 校验只应在 event_type=='agent.stream.message_start' 时触发；
    // 其他 envelope 解析时不应该因为不存在 message_kind 字段而 fail。
    expect(() =>
      AnyContentBlockStreamEventSchema.parse({
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 'trace_abc',
        _seq: 100,
        thread_id: 'thread_xyz',
        event_type: 'agent.stream.message_stop',
        message_id: 'msg_test_01',
      }),
    ).not.toThrow();
  });
});

describe('MessageStartSchema — synthetic 字段已从 schema 定义移除（payload 含此字段被 silent strip）', () => {
  it('payload 含 synthetic 字段时通过（zod 默认 strip extras），parsed 输出不含 synthetic key', () => {
    // zod 默认行为是 strip extras（不是 strict mode：strict mode 会拒收额外字段）。
    // 协议层已删 synthetic 字段定义——万一未来某条历史 daemon 路径残留 synthetic
    // 字段，至少不会破坏 parse；但 parsed 对象上不应该再有 synthetic key——
    // 业务代码即使想消费也拿不到，强制走 message_kind 字段。
    //
    // 取舍说明（详见 PRD §6.3 / harness 总控 "v1.1 决策反转"）：本可加 `.strict()`
    // 让含 synthetic 字段的 payload 直接 fail，避免老 daemon 残留路径 silent
    // 通过；但 zod strict 也会拒收**所有**未来上游加的新字段（与 Pydantic
    // `extra='ignore'` forward-compat 设计冲突），所以 wire 层选 strip 默认。
    const parsed = MessageStartSchema.parse({
      ...baseEnvelope,
      role: 'assistant',
      message_kind: 'llm',
      // @ts-expect-error 字段已从 schema 移除，TS 编译期不允许
      synthetic: true,
    });
    expect(parsed).not.toHaveProperty('synthetic');
  });
});
