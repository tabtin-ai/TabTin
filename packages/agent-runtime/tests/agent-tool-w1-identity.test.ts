/**
 * W1（身份延续，2026-05-30）：子 Agent 完成/失败时把 childId 回传给主 Agent
 * （tool_result content 末尾追加 `[子 Agent ID: xxx]`）的回归测试。
 *
 * W1 是 W2 resume / W3 interrupt / W4a 后台查询的**硬前置**——主 Agent 必须先能
 * 从 tool_result 里拿到稳定的子 Agent id，后续才能引用它。
 *
 * 关键不变量：
 *   1. 成功路径 content 末尾带 `[子 Agent ID: <childId>]`，且 childId 与
 *      SUBAGENT_COMPLETED.subagent_run_id 一致（主 Agent 拿到的是真实 id）。
 *   2. 长 summary 触发 microCompactSubagentSummary 截断后，childId 仍**完整在末尾**
 *      （append 发生在压缩之后，不会被头尾截断吞掉）——这是 W1 的核心风险点。
 *   3. 失败路径 content 也带 `[子 Agent ID: <childId>]`（== SUBAGENT_FAILED.subagent_run_id），
 *      让主 Agent 知道是「哪个」子 Agent 出错、可据此 resume 重试。
 */

import { describe, it, expect } from 'vitest';
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
} from '../src/engine/contracts/model-llm.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';

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

/** 匹配 W1 追加在末尾的 `\n\n[子 Agent ID: <uuid>]`，捕获 uuid。 */
const AGENT_ID_RE = /\n\n\[子 Agent ID: ([0-9a-f-]+)\]$/;

describe('W1: 子 Agent 回传 childId 给主 Agent', () => {
  it('成功 → content 末尾带 [子 Agent ID]，且 == SUBAGENT_COMPLETED.subagent_run_id', async () => {
    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: providerWithFinalText('Result: 任务完成'),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-w1', threadId: 'sess-w1-ok' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'do task' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBeFalsy();
    const completed = events.find((e) => e.type === StreamEvents.SUBAGENT_COMPLETED);
    expect(completed, '应发 SUBAGENT_COMPLETED').toBeTruthy();
    const childId = (completed!.payload as { subagent_run_id?: string }).subagent_run_id;
    expect(childId, 'COMPLETED 带 subagent_run_id').toBeTruthy();

    // M2（review 守门）：append 只进 LLM tool_result，不污染前端卡片数据源——
    // COMPLETED.summary 必须干净（不含 id）。钉死「append 在 COMPLETED emit 之后」的顺序不变量。
    expect(String((completed!.payload as { summary?: string }).summary)).not.toMatch(/子 Agent ID/);

    const content = String(result.content);
    // 主体摘要仍在
    expect(content).toContain('Result: 任务完成');
    // 末尾带真实 childId（== COMPLETED 事件里的 id），主 Agent 据此可引用该子 Agent
    const m = content.match(AGENT_ID_RE);
    expect(m, 'content 末尾应匹配 [子 Agent ID: <uuid>]').toBeTruthy();
    expect(m![1]).toBe(childId);
    expect(result.presentation).toEqual({
      kind: 'subagent_result',
      data: { subagent_run_id: childId, status: 'completed' },
    });
  });

  it('长 summary microCompact 截断后，childId 仍完整在末尾（不被吞）', async () => {
    // CJK 放大后默认阈值 ~15k → 夹具需更长才触发头尾截断。
    // 避开  流式文本复读护栏：旧版 `NOISE_`.repeat 会 text_loop_terminated。
    const longSummary =
      'HEAD_MARKER: 调研开始\n' +
      Array.from(
        { length: 500 },
        (_, i) => `调研笔记 ${i}: 本节审查了模块边界与错误传播，结论待汇总。`,
      ).join('\n') +
      '\nTAIL_MARKER: Result done';

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: providerWithFinalText(longSummary),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-w1', threadId: 'sess-w1-long' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'big task' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBeFalsy();
    const childId = (
      events.find((e) => e.type === StreamEvents.SUBAGENT_COMPLETED)!.payload as {
        subagent_run_id?: string;
      }
    ).subagent_run_id;

    const content = String(result.content);
    // microCompact 确实触发了截断（省略占位文案）
    expect(content).toContain('省略');
    // 关键：childId 完整在末尾，未被压缩头尾截断吞掉（append 在压缩之后）
    const m = content.match(AGENT_ID_RE);
    expect(m, '截断后 content 末尾仍应有完整 [子 Agent ID: <uuid>]').toBeTruthy();
    expect(m![1]).toBe(childId);
  });

  it('失败 → content 也带 [子 Agent ID]，且 == SUBAGENT_FAILED.subagent_run_id', async () => {
    const failingProvider: LLMProvider = {
      async *createStream() {
        yield { type: 'text_delta' as const, text: 'partial' };
        throw new Error('boom upstream');
      },
    };

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: failingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test-w1', threadId: 'sess-w1-fail' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'will fail' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    expect(result.isError).toBe(true);
    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed, '应发 SUBAGENT_FAILED').toBeTruthy();
    const childId = (failed!.payload as { subagent_run_id?: string }).subagent_run_id;
    expect(childId).toBeTruthy();

    const content = String(result.content);
    const m = content.match(AGENT_ID_RE);
    expect(m, '失败 content 末尾也应带 [子 Agent ID: <uuid>]').toBeTruthy();
    expect(m![1]).toBe(childId);
    expect(result.presentation).toEqual({
      kind: 'subagent_result',
      data: { subagent_run_id: childId, status: 'failed' },
    });
  });
});
