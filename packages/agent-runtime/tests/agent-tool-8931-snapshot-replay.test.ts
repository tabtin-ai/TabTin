/**
 *  现场回放：Codex BYOK 快照里真实的 agent 入参。
 * 修前会返回「wait_agent_ids 至少需要…」+ subagent_wait error；
 * 修后应正常 spawn。
 */
import { describe, it, expect } from 'vitest';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import { SubagentManager } from '../src/session/subagent-manager.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import {
  NotificationQueue,
  buildSubagentCompletionEnvelope,
} from '@tabtin/terminal-core';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type { LLMResponseChunk } from '../src/engine/contracts/model-llm.js';
import type { Message } from '../src/engine/contracts/conversation.js';

/** llm-snapshot-12a5297c-…-iter11.json msg10 / msg13 / msg15 */
const SNAPSHOT_CALLS = [
  {
    name: 'msg10 wait_agent_ids:[]',
    input: {
      prompt:
        '在当前 TabTin 仓库中做只读架构勘察。重点：根目录结构、apps/、packages/。',
      description: '勘察整体架构',
      role: '系统架构分析员',
      template_id: '',
      model: '84dbb395-dc3c-4f6c-ad64-2594ab7395a2',
      tool_domains: [
        'glob_search',
        'read_file',
        'grep_search',
        'run_terminal_command',
      ],
      readonly: true,
      resume_agent_id: '',
      background: false,
      interrupt: false,
      check_agent_id: '',
      wait_agent_ids: [] as string[],
      explanation: '隔离消化仓库勘察的中间材料。',
    },
  },
  {
    name: 'msg13 wait_agent_ids:[""]',
    input: {
      prompt: '在当前 TabTin 仓库中做只读架构勘察。',
      description: '勘察整体架构',
      role: '系统架构分析员',
      template_id: '',
      model: '84dbb395-dc3c-4f6c-ad64-2594ab7395a2',
      tool_domains: ['glob_search', 'read_file'],
      readonly: true,
      resume_agent_id: '',
      background: false,
      interrupt: false,
      check_agent_id: '',
      wait_agent_ids: [''],
      explanation: '隔离消化仓库勘察的中间材料。',
    },
  },
  {
    name: 'msg15 wait_agent_ids:[] again',
    input: {
      prompt: '在当前 TabTin 仓库中做只读架构勘察。',
      description: '勘察整体架构',
      readonly: true,
      background: false,
      wait_agent_ids: [] as string[],
      check_agent_id: '',
      resume_agent_id: '',
    },
  },
] as const;

function makeHangingProvider() {
  let resolveHang!: () => void;
  const hang = new Promise<void>((resolve) => {
    resolveHang = resolve;
  });
  const provider = {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      await hang;
      yield { type: 'text_delta' as const, text: 'ok summary' };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return { provider, release: () => resolveHang() };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('#8931 snapshot replay: Codex empty wait_agent_ids', () => {
  for (const call of SNAPSHOT_CALLS) {
    it(call.name, async () => {
      const threadId = `replay-${call.name.replace(/\W+/g, '-')}`;
      const queue = new NotificationQueue({
        clock: () => 1,
        setInterval: () => 'h',
        clearInterval: () => {},
        log: () => {},
      });
      const budgetTracker = new BudgetTracker();
      const manager = new SubagentManager({
        parentThreadId: threadId,
        spaceId: 'space-1',
        budgetTracker,
        enqueueNotification: (info) =>
          queue.enqueue(
            buildSubagentCompletionEnvelope(info, {
              spaceId: 'space-1',
              threadId,
            }),
          ),
      });
      manager.rebindLiveDeps({ budgetTracker });
      const { provider, release } = makeHangingProvider();

      const tool = createAgentTool({
        provider: provider as Parameters<typeof createAgentTool>[0]['provider'],
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: {
          sessionDir: `/tmp/8931-replay-${threadId}`,
          threadId,
        },
        model: 'claude-sonnet-4-20250514',
        budgetTracker,
        subagentManager: manager,
      });

      // background:true 只为加速：断言「没被 wait 短路」即可
      const input = { ...call.input, background: true };
      const earlyPresentation = tool.resolvePresentation?.(input);
      const result = await tool.execute(input, {
        threadId,
        runtimeId: 'rt-replay',
        toolUseId: 'toolu_replay',
        abortSignal: new AbortController().signal,
        messages: [] as Message[],
        emitStreamEvent: () => {},
      });

      // 修前症状：content 含「wait_agent_ids 至少需要…」、presentation status=error
      expect(String(result.content)).not.toContain('wait_agent_ids 至少需要');
      expect(result.isError).toBeFalsy();
      expect(String(result.content)).toContain('已在后台启动');
      expect(earlyPresentation).toBeUndefined();
      expect(result.presentation?.kind).not.toBe('subagent_wait');

      release();
      await tick();
    });
  }
});
