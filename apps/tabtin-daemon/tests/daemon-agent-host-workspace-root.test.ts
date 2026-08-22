/**
 * FR-13 / W3 / W7a: Daemon 侧 workspaceRoot 桥接与对称性回归。
 *
 * 文件分两段：
 *
 * 1. **Daemon-specific：构造期 normalize + warn**
 *    `DaemonAgentHostDeps.workspaceRoot` 经 `normalizeWorkspaceRoot` 规整后
 *    落入 `this.workspaceRoot`；未配置时 warn 一次（运维首次踩坑的预警）。
 *    这部分测试 Daemon 宿主自身行为（与 SSoT 包无关），保留。
 *
 * 2. **SSoT 行为对称：buildSystemPrompt 注入 workspaceRoot 到 <identity>**
 *    W3-fix（cf80e971 + 886bf6f4）后 system prompt 构造统一到
 *    `@tabtin/agent-prompt`；旧 `host.buildSystemPrompt(tools, options)` 私有
 *    方法不再存在。本节直接测 SSoT 包入口，锁定"Daemon 调 SSoT 时
 *    workspaceRoot 走 identity 段 'Working directory for bash and file tools:'
 *    行"这一契约。`packages/agent-prompt/src/__tests__/builder.test.ts` 也
 *    覆盖类似场景；本文件保留 Daemon 视角集合避免回归（host wrapper 走样能
 *    立刻被发现）。
 */
import { describe, it, expect, vi } from 'vitest';
import { buildSystemPrompt } from '@tabtin/agent-prompt';

import { DaemonAgentHost } from '../src/application/agent/daemon-agent-host.js';
import type { DaemonAgentHostDeps } from '../src/application/agent/daemon-agent-host.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as DaemonAgentHostDeps['logger'];
}

interface TestHostOptions {
  workspaceRoot?: string;
  workspaceConfig?: string;
}

function createTestHost(
  opts: TestHostOptions = {},
): { host: DaemonAgentHost; logger: ReturnType<typeof makeLogger> } {
  const logger = makeLogger();
  const deps: DaemonAgentHostDeps = {
    gateway: {
      relayEvents: vi.fn(),
      getAccessToken: () => 'test-token',
    } as unknown as DaemonAgentHostDeps['gateway'],
    config: {
      organization_id: 'wt-1',
      workspace_root: opts.workspaceConfig ?? '/tmp',
    } as unknown as DaemonAgentHostDeps['config'],
    logger,
    getAccessToken: () => 'test-token',
    getPtyManagerBridge: () => null,
    organizationId: 'wt-1',
    workspaceRoot: opts.workspaceRoot,
    docParser: { runTask: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) },
  };
  return { host: new DaemonAgentHost(deps), logger };
}

// ─── Constructor: workspaceRoot normalization + warn (Daemon 自身行为) ─────

describe('DaemonAgentHost constructor – workspaceRoot normalization (FR-13)', () => {
  it('warns when workspaceRoot is undefined (ops visibility for first-use pitfall)', () => {
    const { logger } = createTestHost({ workspaceRoot: undefined });
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(warnCalls[0][0])).toMatch(/workspace_root/);
    expect(String(warnCalls[0][0])).toMatch(/not configured/i);
  });

  it('logs the resolved path on info when workspaceRoot is set', () => {
    const { logger } = createTestHost({ workspaceRoot: '/srv/data' });
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const found = infoCalls.some((args) => String(args[0]).includes('workspace_root=/srv/data'));
    expect(found).toBe(true);
  });

  it('treats whitespace-only workspaceRoot as unset (goes through normalizeWorkspaceRoot)', () => {
    const { logger } = createTestHost({ workspaceRoot: '   \t  ' });
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(warnCalls[0][0])).toMatch(/workspace_root/);
  });

  it('trims surrounding whitespace from valid paths', () => {
    const { host, logger } = createTestHost({ workspaceRoot: '  /trimmed/path  ' });
    // Constructor 走 `normalizeWorkspaceRoot` 应把 trim 后的值落入 private 字段。
    // 通过 bracket-notation 访问避免对外暴露 public API。
    const stored = (host as unknown as { workspaceRoot?: string }).workspaceRoot;
    expect(stored).toBe('/trimmed/path');
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// ─── SSoT buildSystemPrompt: workspaceRoot 注入 <environment> ───────────
//
// 历史：早期 workspaceRoot 走顶层 config 字段、渲染进 `<identity>` 的英文
// "Working directory for bash and file tools:" 行。2026-05-14 runtime_identity
// 拆分后该契约退役——workspaceRoot 改由 `runtimeIdentity` 携带、渲染进
// `<environment>` 段的中文「工作目录：」行（identity 段不再含路径）。本节同步
// 到现行契约；详尽分支由 `packages/agent-prompt/src/__tests__/builder.test.ts`
// 覆盖，这里保留 Daemon 视角的冒烟回归。

describe('Daemon SSoT buildSystemPrompt – workspaceRoot injection (runtime_identity)', () => {
  function identityWith(workspaceRoot: string) {
    return {
      spaceId: 'space-1',
      organizationId: 'wt-1',
      threadId: 'thread-1',
      workspaceRoot,
      archiveDir: `${workspaceRoot}/.platform-data/archive`,
      toolLogsDir: `${workspaceRoot}/.platform-data/tool-logs`,
    };
  }

  it('keeps the absolute workspace path out of prompt text', () => {
    const out = buildSystemPrompt({ tools: [], runtimeIdentity: identityWith('/srv/data') });
    expect(out).not.toContain('/srv/data');
    expect(out).toContain('<environment>');
  });

  it('does not render legacy cwd labels without shell runtime facts', () => {
    const out = buildSystemPrompt({ tools: [], runtimeIdentity: identityWith('/srv/data') });
    expect(out).not.toContain('工作目录：');
    expect(out).not.toContain('Working directory for bash and file tools:');
  });

  it('omits the <environment> section when no runtimeIdentity', () => {
    const out = buildSystemPrompt({ tools: [] });
    expect(out).not.toMatch(/^<environment>/m);
  });

  it('preserves default identity + customRules + workspace composition', () => {
    const out = buildSystemPrompt({
      tools: [],
      customRules: '只输出结构化 JSON',
      runtimeIdentity: identityWith('/srv/data'),
    });
    // ：identity 不再硬编码 TabTin AI Agent 人设句。
    expect(out).toContain('<identity>');
    expect(out).not.toContain('你是 TabTin AI Agent');
    expect(out).toContain('<custom_rules>');
    expect(out).toContain('只输出结构化 JSON');
    expect(out).not.toContain('/srv/data');
  });
});
