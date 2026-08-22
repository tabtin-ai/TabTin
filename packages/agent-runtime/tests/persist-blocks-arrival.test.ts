/**
 * persist 落库单点盖章：blocks_json 每块带 arrival_seq（冷加载 / reconcile 时序键）。
 */

import { describe, expect, it } from 'vitest';
import {
  PersistMessageEvent,
  stampBlocksArrival,
} from '../src/event/events/persist-events.js';
import type { ContentBlock } from '../src/engine/contracts/conversation.js';

describe('stampBlocksArrival / PersistMessageEvent 块级 arrival_seq', () => {
  it('缺失时用 messageArrivalSeq + index 盖章，已有不覆盖', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'tool_use', id: 'tu1', name: 'todo', input: { action: 'open' } },
      { type: 'text', text: 'c', arrival_seq: 999 } as ContentBlock & { arrival_seq: number },
    ];
    const { blocks: stamped, arrivalSeq } = stampBlocksArrival(blocks, 1000);
    expect(arrivalSeq).toBe(1000);
    expect(stamped[0]?.arrival_seq).toBe(1000);
    expect(stamped[1]?.arrival_seq).toBe(1001);
    expect(stamped[2]?.arrival_seq).toBe(999);
  });

  it('PersistMessageEvent.data 每块都有 arrival_seq，并写出消息级 arrival_seq', () => {
    const event = new PersistMessageEvent({
      messageId: 'msg-1',
      role: 'assistant',
      agentRunId: 'run-1',
      arrivalSeq: 5000,
      blocks: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    const payload = event.toStreamEvent().payload as {
      arrival_seq?: number;
      blocks_json?: Array<{ arrival_seq?: number; type?: string }>;
    };
    expect(payload.arrival_seq).toBe(5000);
    expect(payload.blocks_json).toHaveLength(2);
    expect(payload.blocks_json?.[0]?.arrival_seq).toBe(5000);
    expect(payload.blocks_json?.[1]?.arrival_seq).toBe(5001);
  });

  it('PersistMessageEvent 透传本轮实际 model_id / model_name（ Codex/BYOK）', () => {
    const event = new PersistMessageEvent({
      messageId: 'msg-2',
      role: 'assistant',
      agentRunId: 'run-2',
      arrivalSeq: 1,
      blocks: [{ type: 'text', text: 'hi' }],
      modelId: 'gpt-5.6-sol',
      modelName: 'gpt-5.6-sol',
    });
    const payload = event.toStreamEvent().payload as {
      model_id?: string;
      model_name?: string;
    };
    expect(payload.model_id).toBe('gpt-5.6-sol');
    expect(payload.model_name).toBe('gpt-5.6-sol');
  });

  it('终态错误持久化结构化错误且不要求正文块', () => {
    const errorInfo = {
      error_class: 'LLM_BILLING_ERROR',
      category: 'organization_insufficient_credits',
      suggested_action: 'check_billing',
    };
    const event = new PersistMessageEvent({
      messageId: 'message-error',
      role: 'assistant',
      blocks: [],
      agentRunId: 'run-error',
      stopReason: 'error',
      partial: true,
      errorInfoJson: errorInfo,
    });
    const payload = event.toStreamEvent().payload as {
      blocks_json?: ContentBlock[];
      error_info_json?: Record<string, unknown>;
    };

    expect(payload.blocks_json).toEqual([]);
    expect(payload.error_info_json).toEqual(errorInfo);
  });
});
