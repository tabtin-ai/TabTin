/**
 *  · P0 修复：HITL 挂起前的 assistant partial persist 契约测试。
 *
 * 覆盖：
 * - assistantMessageId 缺失 → no-op + warn（旧宿主兼容）
 * - messages 末尾非 assistant / 是 string → no-op + warn
 * - assistant 无 tool_use → no-op（没 pairing 风险）
 * - 有 tool_use → 发 PersistMessageEvent（partial=true, stopReason='tool_use', 同 messageId）
 * - subagentRunId 透传（fork 场景 renderer 分片规则不错位）
 *
 * 和 `hitl-persist.test.ts`（既有 HITL transcript 落库形态锁定）互不重叠：
 * 那个测 `HitlInteractionEvent` 的 message_id / message_kind / metadata.hitl；
 * 本文件测 `persistCurrentAssistantForHitlResume` 的 emit 契约。
 */

import { describe, expect, it, vi } from 'vitest';
import { StreamEvents } from '@tabtin/agent-wire';
import {
  persistCurrentAssistantForHitlResume,
  requireAgentRunId,
} from '../src/permissions/hitl-persist.js';
import { bridgeUserInteractiveToLocalPermissionHandler } from '../src/permissions/user-interactive-bridge.js';
import type { EnginePermissionHandler } from '../src/engine/contracts/hitl.js';
import type { Message } from '../src/engine/contracts/conversation.js';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';

function makeAssistantMessageWithToolUse(toolUseId = 'tuid-1'): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me ask you something' },
      { type: 'tool_use', id: toolUseId, name: 'ask_user', input: { questions: [] } },
    ],
  };
}

describe('persistCurrentAssistantForHitlResume（P0 修复契约）', () => {
  it('emitStreamEvent 缺席 → no-op（return false）', () => {
    const ok = persistCurrentAssistantForHitlResume({
      emitStreamEvent: undefined,
      messages: [makeAssistantMessageWithToolUse()],
      assistantMessageId: 'msg-1',
      agentRunId: 'run-partial',
    });
    expect(ok).toBe(false);
  });

  it('assistantMessageId 缺席 → no-op + warn（旧宿主 / 测试 stub 兼容路径）', () => {
    const events: StreamEvent[] = [];
    const warnings: string[] = [];
    const ok = persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [makeAssistantMessageWithToolUse()],
      assistantMessageId: undefined,
      onLog: (l, m) => l === 'warn' && warnings.push(m),
    });
    expect(ok).toBe(false);
    expect(events).toHaveLength(0);
    expect(warnings.some(w => w.includes('assistantMessageId missing'))).toBe(true);
  });

  it('messages 末尾非 assistant → no-op + warn（不该发生但要 fail-loud）', () => {
    const events: StreamEvent[] = [];
    const warnings: string[] = [];
    const ok = persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [{ role: 'user', content: 'hi' }],
      assistantMessageId: 'msg-1',
      onLog: (l, m) => l === 'warn' && warnings.push(m),
      agentRunId: 'run-partial',
    });
    expect(ok).toBe(false);
    expect(events).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('assistant 无 tool_use → no-op（没 pairing 风险，不用抢先落库）', () => {
    const events: StreamEvent[] = [];
    const ok = persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'no tool use here' }] }],
      assistantMessageId: 'msg-1',
      agentRunId: 'run-partial',
    });
    expect(ok).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('有 tool_use → emit PersistMessageEvent(partial=true, stopReason=tool_use, 同 messageId)', () => {
    const events: StreamEvent[] = [];
    const ok = persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [makeAssistantMessageWithToolUse('tuid-abc')],
      assistantMessageId: 'msg-42',
      agentRunId: 'run-partial',
    });
    expect(ok).toBe(true);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe(StreamEvents.PERSIST_MESSAGE);
    const p = ev.payload as Record<string, unknown>;
    expect(p.message_id).toBe('msg-42');
    expect(p.role).toBe('assistant');
    expect(p.message_kind).toBe('llm');
    expect(p.stop_reason).toBe('tool_use');
    expect(p.partial).toBe(true);
    const blocks = p.blocks_json as Array<{ type: string; id?: string; name?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[1]!.type).toBe('tool_use');
    expect(blocks[1]!.id).toBe('tuid-abc');
    expect(p.agent_run_id).toBe('run-partial');
  });

  it('subagentRunId 透传（fork 子 Agent 场景 renderer 分片规则一致）', () => {
    const events: StreamEvent[] = [];
    persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [makeAssistantMessageWithToolUse()],
      assistantMessageId: 'msg-child',
      agentRunId: 'run-partial',
      subagentRunId: 'subagent-run-123',
    });
    expect(events).toHaveLength(1);
    const p = events[0]!.payload as Record<string, unknown>;
    expect(p.subagent_run_id).toBe('subagent-run-123');
  });

  it('重复调用 emit 两条同 messageId（idempotent upsert，final co-locate persist 覆盖）', () => {
    const events: StreamEvent[] = [];
    const msg = makeAssistantMessageWithToolUse();
    persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [msg],
      assistantMessageId: 'msg-idem',
      agentRunId: 'run-partial',
    });
    persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [msg],
      assistantMessageId: 'msg-idem',
      agentRunId: 'run-partial',
    });
    expect(events).toHaveLength(2);
    for (const ev of events) {
      const p = ev.payload as Record<string, unknown>;
      expect(p.message_id).toBe('msg-idem');
      expect(p.partial).toBe(true);
    }
  });

  it('agentRunId 为空串 → no-op + warn（禁止写出空 ChatMessage.agent_run_id）', () => {
    const events: StreamEvent[] = [];
    const warnings: string[] = [];
    const ok = persistCurrentAssistantForHitlResume({
      emitStreamEvent: (e) => events.push(e),
      messages: [makeAssistantMessageWithToolUse()],
      assistantMessageId: 'msg-1',
      agentRunId: '   ',
      onLog: (l, m) => l === 'warn' && warnings.push(m),
    });
    expect(ok).toBe(false);
    expect(events).toHaveLength(0);
    expect(warnings.some((w) => w.includes('agentRunId missing'))).toBe(true);
  });
});

describe('requireAgentRunId / bridge fail-closed ', () => {
  it('requireAgentRunId 拒绝空串 / 空白', () => {
    expect(requireAgentRunId('run-1', 't')).toBe('run-1');
    expect(() => requireAgentRunId('', 't')).toThrow(/missing at t/);
    expect(() => requireAgentRunId('  ', 't')).toThrow(/missing at t/);
    expect(() => requireAgentRunId(undefined, 't')).toThrow(/missing at t/);
  });

  it('bridge 缺 agentRunId 时 throw，不把空串传给 handler', async () => {
    const calls: Array<{ agentRunId: string }> = [];
    const handler: EnginePermissionHandler = {
      requestPermissionsBatch: async (req) => {
        calls.push({ agentRunId: req.agentRunId });
        return req.requests.map((r) => ({
          toolCallId: r.toolCallId ?? r.tool.name,
          decision: 'deny' as const,
        }));
      },
    };
    const channel = bridgeUserInteractiveToLocalPermissionHandler(handler, {
      getThreadId: () => 'thread-1',
    });
    await expect(
      channel.requestApprovalsBatch({
        batchId: 'b1',
        sessionId: 's1',
        threadId: 'thread-1',
        actionRequests: [{
          requestId: 'r1',
          toolCallId: 'tc1',
          tool: {
            name: 'shell',
            description: 't',
            inputSchema: { type: 'object' },
            execute: async () => ({ content: '' }),
          },
          toolInput: {},
          reason: { type: 'user_interactive', scope: 'once' },
          allowedScopes: ['once'],
          allowedOutcomes: ['allow', 'deny'],
          riskLevel: 'medium',
        }],
        runtimeMode: 'interactive',
        agentRunId: '',
      }),
    ).rejects.toThrow(/missing at UserInteractiveBridge/);
    expect(calls).toHaveLength(0);
  });
});
