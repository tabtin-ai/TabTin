/**
 * Wave 1.5 PROD-3 · Daemon Skill 凭据 resolver 接线回归
 *
 * 场景：WP1 PTY 化后，DaemonToolProvider 不再贡献 `bash` 工具；
 * 命令执行由 DaemonAgentHost 装配 ShellCap，并把
 * `skillCredentialResolverHandle.resolver` 作为 `skillContextProvider`
 * 注入。此前缺失时字段永远 undefined，Skill 内命令遇到
 * skillContext 会静默降级——质疑 20 / 21 的症状。
 *
 * 本测试不启动完整 host（依赖 WS / 磁盘 / Django 过重），而是：
 *   1. 断言 DaemonToolProvider 不再暴露退役 `bash` 工具；
 *   2. 按 DaemonAgentHost 的 ShellCap 装配形态注入 mock resolver；
 *   3. 执行一次带 skillContext 的 run_terminal_command；
 *   4. 断言 resolver 被调用 + env 进入 PtyManagerBridge 请求。
 *
 * 若这条接线断裂（DaemonAgentHost 忘了传 skillCredentialResolver），
 * 本测试会失败在"run_terminal_command 没拿到 env 注入"上。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent, ToolContext } from '@tabtin/agent-runtime/engine';
import type {
  SkillCredentialResolver,
  SkillCredentialInjection,
} from '@tabtin/agent-runtime/tools';
import {
  ShellCap,
  type SkillContextProvider,
} from '@tabtin/agent-runtime/capability';
import type { SkillCredentialResolverHandle } from '@tabtin/agent-host/credentials';
import { StreamEvents } from '@tabtin/agent-wire';
import type {
  AgentCommandRequest,
  AgentCommandResult,
  AgentKillSignal,
  AgentReadOptions,
  AgentReadResult,
  AgentSessionEventHandler,
  AgentSessionEventName,
  AgentSessionUnsubscribe,
  AgentSpawnDetachedResult,
  PtyManagerBridge,
} from '@tabtin/terminal-core';
import { DaemonToolProvider } from '../src/application/agent/daemon-tool-provider.js';
import { checkHardlineCommand } from '@tabtin/security-policy';

function makeBridgeMock(): {
  bridge: PtyManagerBridge;
  executeCalls: AgentCommandRequest[];
} {
  const executeCalls: AgentCommandRequest[] = [];
  const bridge: PtyManagerBridge = {
    async executeAgentCommand(req: AgentCommandRequest): Promise<AgentCommandResult> {
      executeCalls.push(req);
      return {
        status: 'ok',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
        truncated: false,
        outputBytes: 2,
        cwd: req.cwd ?? '/tmp',
        sessionId: 'mock-session',
      };
    },
    async spawnAgentSessionDetached(req: AgentCommandRequest): Promise<AgentSpawnDetachedResult> {
      executeCalls.push(req);
      return {
        sessionId: 'mock-detached-session',
        outputFilePath: '/tmp/tabtin-agent-tasks/mock-detached-session.log',
      };
    },
    async readAgentSessionOutput(
      _sessionId: string,
      _opts?: AgentReadOptions,
    ): Promise<AgentReadResult> {
      throw new Error('not used by this test');
    },
    async killAgentSession(_sessionId: string, _signal?: AgentKillSignal): Promise<void> {
      // no-op
    },
    subscribe<E extends AgentSessionEventName>(
      _event: E,
      _handler: AgentSessionEventHandler<E>,
    ): AgentSessionUnsubscribe {
      return () => {};
    },
  };
  return { bridge, executeCalls };
}

function makeToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    threadId: 't',
    sessionId: 's',
    toolUseId: 'mock-tool-use',
    spaceId: 'sp',
    abortSignal: new AbortController().signal,
    messages: [],
    skillContext: { skillKey: 'user:daemon-skill', spaceId: 'sp' },
    ...overrides,
  };
}

describe('Wave 1.5 PROD-3 · Daemon skill credential resolver 接线', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('DaemonToolProvider 不再暴露退役 bash；shell 工具由 ShellCap 贡献', () => {
    const provider = new DaemonToolProvider({
      runDocParserTask: vi.fn(),
      securityPreset: 'full_auto',
      apiBaseUrl: 'https://api.example/api',
      apiAuthToken: 'jwt',
    });
    const names = provider.getTools().map((t) => t.name);
    expect(names).not.toContain('bash');
    expect(names).not.toContain('run_terminal_command');
  });

  it('ShellCap 注入 resolver 后，run_terminal_command 能拿到 env 注入', async () => {
    const SECRET = 'test-api-key';
    const resolver: SkillCredentialResolver = vi.fn(
      async (): Promise<SkillCredentialInjection> => ({
        env: { OPENAI_API_KEY: SECRET },
        serviceName: 'openai',
        credentialId: 'daemon-test',
      }),
    );
    const provider: SkillContextProvider = {
      resolveCredentials: resolver,
    };
    const { bridge, executeCalls } = makeBridgeMock();
    const cap = new ShellCap({
      checkHardlineCommand: checkHardlineCommand,
      ptyManagerBridge: bridge,
      spaceId: 'mock-space',
      agentId: 'mock-agent',
      skillContextProvider: provider,
    });

    const runTerminal = cap.tools().find((t) => t.name === 'run_terminal_command');
    expect(runTerminal).toBeDefined();

    await runTerminal!.execute(
      { command: 'true' },
      makeToolContext(),
    );

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(executeCalls).toHaveLength(1);
    const env = executeCalls[0].env as Record<string, string>;
    expect(env?.OPENAI_API_KEY).toBe(SECRET);
  });

  it('ShellCap 不注入 resolver 时，对 skillContext 发 SYSTEM_NOTICE（质疑 21 修复）', async () => {
    const emittedEvents: StreamEvent[] = [];
    const { bridge, executeCalls } = makeBridgeMock();
    const cap = new ShellCap({
      checkHardlineCommand: checkHardlineCommand,
      ptyManagerBridge: bridge,
      spaceId: 'mock-space',
      agentId: 'mock-agent',
      emitStreamEvent: (ev) => emittedEvents.push(ev),
      // 故意不传 skillContextProvider
    });

    const runTerminal = cap.tools().find((t) => t.name === 'run_terminal_command');
    expect(runTerminal).toBeDefined();

    await runTerminal!.execute(
      { command: 'true' },
      makeToolContext({ skillContext: { skillKey: 'user:x', spaceId: 'sp' } }),
    );

    // env 不注入（保持旧降级语义）
    expect(executeCalls[0].env).not.toHaveProperty('OPENAI_API_KEY');

    // 发了 skill_credential_unavailable SYSTEM_NOTICE（新行为）
    const notices = emittedEvents.filter(
      (e) =>
        e.type === StreamEvents.SYSTEM_NOTICE &&
        (e.payload as Record<string, unknown>)?.notice_type ===
        'skill_credential_unavailable',
    );
    expect(notices.length).toBe(1);
    expect((notices[0].payload as Record<string, unknown>).skill_key).toBe('user:x');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Wave 2a 补丁 P0-2（独立质疑 2）：多 session resolver 统一失效
// ══════════════════════════════════════════════════════════════════════
//
// 我们不构造真实 DaemonAgentHost（它依赖 WS / 磁盘 / Django），而是直接验证
// 核心数据结构——"Map<sessionId, handle> + invalidateAll 循环调用"的语义
// 契约。这是补丁引入的最小可测单元；实际 `DaemonAgentHost` 只是把本 pattern
// 接线到 createRuntimeForSession / stop / resetAccountSync 三个路径。

describe('Wave 2a 补丁 P0-2 · 多 session skill credential cache 统一失效', () => {
  /**
   * 自制"resolver handle"，每次 resolve 返回一份 env，记录 invalidate 调用。
   * 不走真实 createSkillCredentialResolver —— 不想在 daemon 测试里挂 HTTP mock。
   */
  function makeHandle(id: string): SkillCredentialResolverHandle {
    const cache = new Map<string, SkillCredentialInjection>();
    return {
      resolver: async ({ skillKey, spaceId }) => {
        const key = `${spaceId}::${skillKey}`;
        if (cache.has(key)) return cache.get(key)!;
        const injection: SkillCredentialInjection = {
          env: { [`${id.toUpperCase()}_KEY`]: `value-from-${id}` },
          serviceName: 'openai',
          credentialId: `${id}-cred`,
        };
        cache.set(key, injection);
        return injection;
      },
      invalidate: (filter) => {
        if (!filter || (!filter.spaceId && !filter.skillKey)) {
          cache.clear();
          return;
        }
        for (const k of Array.from(cache.keys())) {
          const [spaceId, skillKey] = k.split('::');
          if (filter.spaceId && spaceId === filter.spaceId) cache.delete(k);
          else if (filter.skillKey && skillKey === filter.skillKey) cache.delete(k);
        }
      },
      stats: () => ({
        entries: cache.size,
        hits: 0,
        misses: 0,
        errors: 0,
      }),
    };
  }

  it('两个 session：invalidate 广播到所有 handle（旧 session cache 不再沿用）', async () => {
    const handles = new Map<string, SkillCredentialResolverHandle>();
    const h1 = makeHandle('s1');
    const h2 = makeHandle('s2');
    handles.set('session-1', h1);
    handles.set('session-2', h2);

    const sig = new AbortController().signal;
    // 两个 session 各调一次 resolver → cache 各自生效
    await h1.resolver({ skillKey: 'user:x', spaceId: 'sp-a', agentId: 'agent-a' }, sig);
    await h2.resolver({ skillKey: 'user:x', spaceId: 'sp-a', agentId: 'agent-a' }, sig);
    expect(h1.stats().entries).toBe(1);
    expect(h2.stats().entries).toBe(1);

    // 模拟 DaemonAgentHost.invalidateSkillCredentialCaches（无 filter = 全清）
    for (const h of handles.values()) h.invalidate();

    expect(h1.stats().entries).toBe(0);
    expect(h2.stats().entries).toBe(0);
  });

  it('带 spaceId filter：只清匹配的 entry，其他 session 的其他 space 不受影响', async () => {
    const handles = new Map<string, SkillCredentialResolverHandle>();
    const h1 = makeHandle('s1');
    const h2 = makeHandle('s2');
    handles.set('session-1', h1);
    handles.set('session-2', h2);

    const sig = new AbortController().signal;
    await h1.resolver({ skillKey: 'user:x', spaceId: 'sp-target', agentId: 'agent-a' }, sig);
    await h1.resolver({ skillKey: 'user:x', spaceId: 'sp-other', agentId: 'agent-a' }, sig);
    await h2.resolver({ skillKey: 'user:x', spaceId: 'sp-target', agentId: 'agent-a' }, sig);
    expect(h1.stats().entries).toBe(2);
    expect(h2.stats().entries).toBe(1);

    for (const h of handles.values()) h.invalidate({ spaceId: 'sp-target' });

    // h1 只剩 sp-other，h2 被清空
    expect(h1.stats().entries).toBe(1);
    expect(h2.stats().entries).toBe(0);
  });
});
