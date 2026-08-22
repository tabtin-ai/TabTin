/**
 * W2a：`/code/mkdir` `/code/mv` `/code/rename` 路由 regression。
 *
 * 覆盖：
 *   - TOOL_MAP 正确映射到 action-tool 名（mkdir / move_file，rename 是 mv 的别名）
 *   - `workspaceRootForCode` 绑定被实际消费——body 未显式传 `_workspace_root`
 *     时补注入；body 已显式传时不覆盖
 *   - 未知路由的错误提示包含新命令
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServerResponse } from 'node:http';

import {
  configureCLIRoutes,
  type CodeWorktreeAgentContext,
  type CodeWorktreeController,
} from '../host-bindings.js';
import { handleCodeRoute } from './code.js';

interface RecordedCall {
  task_id: string;
  type: string;
  params: any;
  thread_id: string;
}

function setupBindings(opts: {
  workspaceRoot?: string | null;
  workspaceRootResolver?: (
    context?: CodeWorktreeAgentContext,
  ) => string | null;
  worktreeController?: CodeWorktreeController | null;
} = {}) {
  const calls: RecordedCall[] = [];
  configureCLIRoutes({
    djangoRequest: (async () => ({ ok: false, status: 500, error: 'unused' })) as any,
    getSpaceId: () => null,
    getActionExecutor: () => async (action: RecordedCall) => {
      calls.push(action);
      return { success: true, data: { ok: true } };
    },
    workspaceRootForCode: opts.workspaceRootResolver ?? (() => opts.workspaceRoot ?? null),
    getCodeWorktreeController: () => opts.worktreeController ?? null,
  });
  return calls;
}

function fakeSendJSON() {
  const responses: Array<{ status: number; data: any }> = [];
  const sendJSON = (_res: ServerResponse, status: number, data: any) => {
    responses.push({ status, data });
  };
  return { sendJSON, responses };
}

describe('/code/mkdir', () => {
  it('派发到 action-tool "mkdir"，并补注入 _workspace_root', async () => {
    const calls = setupBindings({ workspaceRoot: '/tmp/ws-root' });
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute('/code/mkdir', 'POST', { path: 'newdir' }, {} as ServerResponse, sendJSON);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'mkdir');
    assert.equal(calls[0].params.path, 'newdir');
    assert.equal(calls[0].params._workspace_root, '/tmp/ws-root');
    assert.equal(responses[0].status, 200);
  });

  it('body 已显式传 _workspace_root 时不覆盖', async () => {
    const calls = setupBindings({ workspaceRoot: '/tmp/ws-root' });
    const { sendJSON } = fakeSendJSON();

    await handleCodeRoute(
      '/code/mkdir',
      'POST',
      { path: 'newdir', _workspace_root: '/explicit/root' },
      {} as ServerResponse,
      sendJSON,
    );

    assert.equal(calls[0].params._workspace_root, '/explicit/root');
  });

  it('workspaceRootForCode 未配置（返回 null）时不注入字段', async () => {
    const calls = setupBindings({ workspaceRoot: null });
    const { sendJSON } = fakeSendJSON();

    await handleCodeRoute('/code/mkdir', 'POST', { path: 'newdir' }, {} as ServerResponse, sendJSON);

    assert.equal('_workspace_root' in calls[0].params, false);
  });

  it('Agent 请求按可信 run 注入会话代码根，并剥离内部上下文', async () => {
    let resolvedContext: unknown;
    const calls = setupBindings({
      workspaceRootResolver: (context) => {
        resolvedContext = context;
        return '/repo/session-worktree';
      },
    });
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute(
      '/code/mkdir',
      'POST',
      {
        path: 'src/new-dir',
        _workspace_root: '/repo/body-forged-root',
        _agent_context: {
          session_id: 'session-1',
          run_id: 'run-1',
          tool_use_id: 'tool-1',
        },
      },
      {} as ServerResponse,
      sendJSON,
    );

    assert.deepEqual(resolvedContext, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolUseId: 'tool-1',
    });
    assert.deepEqual(calls[0].params, {
      path: 'src/new-dir',
      _workspace_root: '/repo/session-worktree',
    });
    assert.equal(calls[0].thread_id, 'session-1');
    assert.equal(responses[0].status, 200);
  });

  it('Agent run 无法解析会话根时 fail-closed', async () => {
    const calls = setupBindings({ workspaceRootResolver: () => null });
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute(
      '/code/mkdir',
      'POST',
      {
        path: 'src/new-dir',
        _agent_context: {
          session_id: 'session-1',
          run_id: 'run-missing',
          tool_use_id: 'tool-1',
        },
      },
      {} as ServerResponse,
      sendJSON,
    );

    assert.equal(calls.length, 0);
    assert.equal(responses[0].status, 403);
    assert.match(JSON.stringify(responses[0].data), /UNTRUSTED_AGENT_RUN/);
  });
});

describe('/code/worktree/*', () => {
  it('缺少可信 Agent 上下文时拒绝，不调用 controller', async () => {
    let calls = 0;
    const controller: CodeWorktreeController = {
      current: async () => { calls += 1; return { ok: true, data: {} }; },
      list: async () => { calls += 1; return { ok: true, data: {} }; },
      switch: async () => { calls += 1; return { ok: true, data: {} }; },
      create: async () => { calls += 1; return { ok: true, data: {} }; },
    };
    setupBindings({ worktreeController: controller });
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute(
      '/code/worktree/switch',
      'POST',
      { path: '/tmp/wt' },
      {} as ServerResponse,
      sendJSON,
    );

    assert.equal(calls, 0);
    assert.equal(responses[0].status, 403);
    assert.match(JSON.stringify(responses[0].data), /AGENT_CONTEXT_REQUIRED/);
  });

  it('把可信上下文与 switch 输入传给 controller', async () => {
    let received: unknown;
    const controller: CodeWorktreeController = {
      current: async () => ({ ok: true, data: {} }),
      list: async () => ({ ok: true, data: {} }),
      switch: async (context, input) => {
        received = { context, input };
        return { ok: true, data: { scheduled: true } };
      },
      create: async () => ({ ok: true, data: {} }),
    };
    setupBindings({ worktreeController: controller });
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute(
      '/code/worktree/switch',
      'POST',
      {
        path: '/tmp/wt',
        _agent_context: {
          session_id: 'session-1',
          run_id: 'run-1',
          tool_use_id: 'tool-1',
        },
      },
      {} as ServerResponse,
      sendJSON,
    );

    assert.deepEqual(received, {
      context: { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      input: {
        path: '/tmp/wt',
        _agent_context: {
          session_id: 'session-1',
          run_id: 'run-1',
          tool_use_id: 'tool-1',
        },
      },
    });
    assert.equal(responses[0].status, 200);
  });

  it('controller 未注入时返回 503', async () => {
    setupBindings();
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute(
      '/code/worktree/current',
      'POST',
      {
        _agent_context: {
          session_id: 'session-1',
          run_id: 'run-1',
          tool_use_id: 'tool-1',
        },
      },
      {} as ServerResponse,
      sendJSON,
    );

    assert.equal(responses[0].status, 503);
  });
});

describe('/code/mv 与 /code/rename', () => {
  it('/code/mv 派发到 action-tool "move_file"', async () => {
    const calls = setupBindings({ workspaceRoot: '/tmp/ws-root' });
    const { sendJSON } = fakeSendJSON();

    await handleCodeRoute(
      '/code/mv',
      'POST',
      { from: 'a.txt', to: 'b.txt' },
      {} as ServerResponse,
      sendJSON,
    );

    assert.equal(calls[0].type, 'move_file');
    assert.equal(calls[0].params.from, 'a.txt');
    assert.equal(calls[0].params.to, 'b.txt');
  });

  it('/code/rename 也派发到同一个 action-tool "move_file"（mv 的别名）', async () => {
    const calls = setupBindings({ workspaceRoot: '/tmp/ws-root' });
    const { sendJSON } = fakeSendJSON();

    await handleCodeRoute(
      '/code/rename',
      'POST',
      { from: 'a.txt', to: 'b.txt' },
      {} as ServerResponse,
      sendJSON,
    );

    assert.equal(calls[0].type, 'move_file');
  });
});

describe('/code/search', () => {
  it('语义代码搜索已退役，不调用 action executor', async () => {
    const calls = setupBindings({ workspaceRoot: '/tmp/ws-root' });
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute(
      '/code/search',
      'POST',
      { query: 'how does authentication work?' },
      {} as ServerResponse,
      sendJSON,
    );

    assert.equal(calls.length, 0);
    assert.equal(responses[0].status, 410);
    assert.match(JSON.stringify(responses[0].data), /FEATURE_RETIRED/);
    assert.match(JSON.stringify(responses[0].data), /code\/grep/);
    assert.match(JSON.stringify(responses[0].data), /code\/glob/);
  });
});

describe('未知 /code 路由', () => {
  it('404 且提示包含新命令 mkdir/mv/rename', async () => {
    setupBindings();
    const { sendJSON, responses } = fakeSendJSON();

    await handleCodeRoute('/code/unknown-sub', 'POST', {}, {} as ServerResponse, sendJSON);

    assert.equal(responses[0].status, 404);
    const suggestions = JSON.stringify(responses[0].data);
    assert.match(suggestions, /\/code\/mkdir/);
    assert.match(suggestions, /\/code\/mv/);
    assert.match(suggestions, /\/code\/rename/);
  });
});
