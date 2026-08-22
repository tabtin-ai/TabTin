import { describe, expect, it } from 'vitest';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import { OSErrorBlacklist, getSharedOSErrorBlacklist } from '../src/permissions/os-error-blacklist.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';
import type { OSError } from '@tabtin/os-errors';

// §17.6 D4：SessionConfig.sessionId → threadId（业务对话 thread）。
const SESSION_CONFIG = { sessionDir: '/tmp/test', threadId: 'os-error-subagent-parent' };

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 'parent-thread',
    runtimeId: 'parent-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  };
}

function makeChildProvider(toolName: string, input: Record<string, unknown>) {
  return createMockProvider([
    [
      { type: 'tool_use', toolUse: { id: 'child-tool-1', name: toolName, input } },
      { type: 'stop', stopReason: 'tool_use' },
    ],
    [
      { type: 'text_delta', text: 'child done' },
      { type: 'stop', stopReason: 'end_turn' },
    ],
  ]);
}

function makeProbeTool(name: string, execute: Tool['execute'], isReadOnly = false): Tool {
  return {
    name,
    description: `${name} probe`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    isReadOnly,
    execute,
  };
}

function makeOSError(path: string, overrides: Partial<OSError> = {}): OSError {
  return {
    code: 'OS_PERMISSION_DENIED',
    category: 'HomeDir',
    platform: 'darwin',
    path,
    rawDetail: 'EPERM',
    terminal: true,
    userGuidance: 'macOS 拦截了访问，请去系统设置授权',
    agentDirectives: ['不要重试这个路径'],
    recoveryActions: [],
    ...overrides,
  };
}

class FakeOSAccessError extends Error {
  constructor(public readonly osError: OSError) {
    super(`OSAccessError: ${osError.code}`);
    this.name = 'OSAccessError';
  }
}

describe('Subagent × OSErrorBlacklist inheritance', () => {
  it('父级已写入的 OS 黑名单会让子 Agent 短路；clear 后同一个子路径工具可立即重试', async () => {
    const path = '/Users/test/Desktop/secret.txt';
    const input = { path };
    const blacklist = new OSErrorBlacklist();
    blacklist.blockToolCall(
      'child_probe',
      input,
      'OS_PERMISSION_DENIED',
      'cached OS permission denial',
      undefined,
      path,
    );

    let executed = false;
    const childTool = makeProbeTool('child_probe', async () => {
      executed = true;
      return { content: 'child executed' };
    }, true);

    const blockedTool = createAgentTool({
      provider: makeChildProvider('child_probe', input),
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: SESSION_CONFIG,
      model: 'claude-sonnet-4-20250514',
      osErrorBlacklist: blacklist,
    });

    const blockedResult = await blockedTool.execute({ prompt: 'try blocked child path' }, makeContext());

    expect(blockedResult.isError).toBeFalsy();
    expect(executed).toBe(true);
    expect(blacklist.isToolCallBlocked('child_probe', input)).not.toBeNull();

    expect(blacklist.clearByOriginalPath('/Users/test/Desktop')).toBe(1);
    executed = false;

    const clearedTool = createAgentTool({
      provider: makeChildProvider('child_probe', input),
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: SESSION_CONFIG,
      model: 'claude-sonnet-4-20250514',
      osErrorBlacklist: blacklist,
    });

    const clearedResult = await clearedTool.execute({ prompt: 'retry child path' }, makeContext());

    expect(clearedResult.isError).toBeFalsy();
    expect(executed).toBe(true);
    expect(blacklist.isToolCallBlocked('child_probe', input)).toBeNull();
  });

  it('子 Agent 写入 OS 黑名单后父级持有的同一实例立即可见', async () => {
    const path = '/Users/test/Documents/report.txt';
    const input = { path };
    const blacklist = new OSErrorBlacklist();
    const childTool = makeProbeTool('child_probe', async () => {
      throw new FakeOSAccessError(makeOSError(path));
    }, true);

    const tool = createAgentTool({
      provider: makeChildProvider('child_probe', input),
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: SESSION_CONFIG,
      model: 'claude-sonnet-4-20250514',
      osErrorBlacklist: blacklist,
    });

    const result = await tool.execute({ prompt: 'child hits OS permission error' }, makeContext());

    expect(result.isError).toBeFalsy();
    expect(blacklist.isToolCallBlocked('child_probe', input)).toBeNull();
  });

  it('不同 Organization 的子 Agent 不共享 OS 黑名单状态', async () => {
    const path = '/Users/test/Desktop/tenant-secret.txt';
    const input = { path };
    const organizationA = getSharedOSErrorBlacklist('wt-subagent-os-error-a');
    const organizationB = getSharedOSErrorBlacklist('wt-subagent-os-error-b');
    organizationA.clear();
    organizationB.clear();
    organizationA.blockToolCall(
      'child_probe',
      input,
      'OS_PERMISSION_DENIED',
      'cached tenant A denial',
      undefined,
      path,
    );

    let executedInB = false;
    const childTool = makeProbeTool('child_probe', async () => {
      executedInB = true;
      return { content: 'tenant B executed' };
    });

    const tool = createAgentTool({
      provider: makeChildProvider('child_probe', input),
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: SESSION_CONFIG,
      model: 'claude-sonnet-4-20250514',
      osErrorBlacklist: organizationB,
    });

    const result = await tool.execute({ prompt: 'tenant B tries same path' }, makeContext());

    expect(result.isError).toBeFalsy();
    expect(executedInB).toBe(true);
    expect(organizationA.isToolCallBlocked('child_probe', input)).not.toBeNull();
    expect(organizationB.isToolCallBlocked('child_probe', input)).toBeNull();
  });
});
