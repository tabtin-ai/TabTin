/**
 *  Wave2：agent 工具 message_agent_id 路径（不 spawn）。
 */

import { describe, it, expect } from 'vitest';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import { SubagentManager } from '../src/session/subagent-manager.js';
import { shouldAccumulateForkFinalText } from '../src/subagent/fork-query.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';
import type { ToolContext } from '../src/engine/contracts/tools.js';
import type { Message } from '../src/engine/contracts/conversation.js';

const CHILD_ID = 'child-midflight-aaaaaaaa';

function makeContext(): ToolContext {
  return {
    threadId: 'parent-thread-midflight',
    runtimeId: 'runtime-midflight',
    agentRunId: 'run-midflight',
    toolUseId: 'tu-midflight',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    emitStreamEvent: () => undefined,
  };
}

describe('#9155 agent-tool message_agent_id', () => {
  it('active 子 + 非空 prompt → inject ok', async () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-thread-midflight' });
    mgr.registerRun(CHILD_ID, new AbortController(), { state: 'active' });
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: {
        sessionDir: '/tmp/agent-tool-midflight',
        threadId: 'parent-thread-midflight',
      },
      model: 'sonnet',
      systemPrompt: 'parent',
      subagentManager: mgr,
    });

    const result = await tool.execute(
      { message_agent_id: CHILD_ID, prompt: ' 改查 B 方案 ' },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('投递指引');
    expect(mgr.drainPendingUserMessages(CHILD_ID)).toEqual(['改查 B 方案']);
  });

  it('与 interrupt 互斥', async () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-thread-midflight' });
    mgr.registerRun(CHILD_ID, new AbortController(), { state: 'active' });
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: {
        sessionDir: '/tmp/agent-tool-midflight',
        threadId: 'parent-thread-midflight',
      },
      model: 'sonnet',
      systemPrompt: 'parent',
      subagentManager: mgr,
    });

    const result = await tool.execute(
      { message_agent_id: CHILD_ID, prompt: 'hi', interrupt: true },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('不能与');
    expect(mgr.drainPendingUserMessages(CHILD_ID)).toEqual([]);
  });

  it('无 subagentManager → no manager', async () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: {
        sessionDir: '/tmp/agent-tool-midflight',
        threadId: 'parent-thread-midflight',
      },
      model: 'sonnet',
      systemPrompt: 'parent',
    });

    const result = await tool.execute(
      { message_agent_id: CHILD_ID, prompt: 'hi' },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('no manager');
  });
});

describe('#9155 shouldAccumulateForkFinalText', () => {
  it('跳过 user/system，保留 assistant / 缺省', () => {
    expect(shouldAccumulateForkFinalText('user')).toBe(false);
    expect(shouldAccumulateForkFinalText('system')).toBe(false);
    expect(shouldAccumulateForkFinalText('assistant')).toBe(true);
    expect(shouldAccumulateForkFinalText(undefined)).toBe(true);
  });
});
