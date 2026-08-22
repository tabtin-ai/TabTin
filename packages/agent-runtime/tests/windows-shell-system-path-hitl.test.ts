import { describe, expect, it, vi } from 'vitest';
import type {
  EffectivePolicy,
  MemoStore,
  WorkspaceSnapshot,
} from '@tabtin/security-policy';
import { createInterruptAdapter } from '../src/permissions/interrupt-adapter.js';
import { ToolRegistry } from '../src/engine/tooling/tool-system.js';
import { runTools } from '../src/engine/tooling/tool-orchestration.js';
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';
import type { ToolUseBlock } from '../src/engine/contracts/conversation.js';
import type { Tool, ToolContext } from '../src/engine/contracts/tools.js';
import { createMockPermissionHandler } from './test-utils.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';

function makeWorkspace(): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: '/ws',
      workingDir: '/ws',
      sessionApprovedPaths: [],
      attachedFiles: [],
    },
    allowedPaths: ['/ws'],
    allowedFiles: [],
    spaceSessionId: 'win-shell-hitl',
  };
}

function makePolicy(
  approvalMode: EffectivePolicy['approvalMode'] = 'auto',
): EffectivePolicy {
  return {
    approvalMode,
    workspace: makeWorkspace(),
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

function makeMemoStore(): MemoStore {
  return {
    generation: 0,
    lookup: () => null,
    putAlways: async () => undefined,
    putThread: () => undefined,
    revoke: async () => undefined,
    maybeRefetch: async () => false,
    bootstrap: async () => undefined,
    replaceAll: () => undefined,
  };
}

function makeContext(): ToolContext {
  return {
    threadId: 'thread-win-shell-hitl',
    runtimeId: 'runtime-win-shell-hitl',
    agentRunId: 'run-win-shell-hitl',
    toolUseId: 'tool-use-win-shell-hitl',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: '/ws',
    workspaceSnapshot: makeWorkspace(),
  };
}

async function drain(
  generator: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<ToolExecutionResult[]> {
  let next = await generator.next();
  while (!next.done) next = await generator.next();
  return next.value;
}

describe('#7685 Windows system path → runtime HITL', () => {
  it.each(['always_ask', 'auto'] as const)(
    '%s 档把 PowerShell 系统路径删除送入审批通道，拒绝后不执行',
    async (approvalMode) => {
    const execute = vi.fn(async () => ({ content: 'should-not-run' }));
    const tool: Tool = {
      name: 'run_terminal_command',
      description: 'test shell tool',
      inputSchema: { type: 'object', additionalProperties: true },
      isReadOnly: false,
      policyActionKind: 'shell',
      isWriteOp: () => true,
      extractPolicyParams: (input: unknown) => ({
        command: (input as { command?: string }).command,
      }),
      execute,
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    const requestApprovalsBatch = vi.fn(async (request: {
      actionRequests: Array<{
        requestId: string;
        toolCallId: string;
        reason: { type: string };
      }>;
    }) => ({
      decisions: request.actionRequests.map((action) => ({
        requestId: action.requestId,
        toolCallId: action.toolCallId,
        outcome: 'deny' as const,
      })),
    }));

    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'tu-win-system-delete',
      name: 'run_terminal_command',
      input: {
        command: 'Remove-Item -Recurse -Force $env:WINDIR\\System32\\test.dll',
      },
    };

    const results = await drain(runTools({
      toolUseBlocks: [block],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
        agentMode: 'agent',
        sessionId: 'runtime-win-shell-hitl',
        toolRiskPolicy: createTestToolRiskPolicyPort({
          buildEffectivePolicy: () => makePolicy(approvalMode),
          memoStore: makeMemoStore(),
        }),
        interrupt: createInterruptAdapter({
          threadId: 'thread-win-shell-hitl',
          userInteractiveChannel: { requestApprovalsBatch },
        }),
        outputScan: false,
      },
    }));

    expect(requestApprovalsBatch).toHaveBeenCalledTimes(1);
    const approvalRequest = requestApprovalsBatch.mock.calls[0]![0];
    expect(approvalRequest.actionRequests).toHaveLength(1);
    expect(approvalRequest.actionRequests[0]!.reason.type).toBe('policy_risk_ask');
    expect(execute).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    },
  );
});
