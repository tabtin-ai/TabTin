/**
 * 路径权限治理 Wave 4 (P1-5 修复)：DaemonAgentHost 双接口单测。
 *
 * 钉死契约：
 *   - findWorkspaceSnapshotForSpace(spaceId) 严格 spaceId 匹配 → 未命中
 *     fail-closed 返回 null（不再 fallback 到任意 session）
 *   - findAnyActiveWorkspaceSnapshot() 任意活跃 session（dogfood 单 session
 *     模式专用，MCP/CLI 入口不带 spaceId 时的显式兜底）
 *   - session 存在但 workspaceSnapshot=null → 跳过找下一条
 *
 * Wave 3 已经在 Electron 端把 union 改成 spaceId 路由修过 L14；本测试钉
 * 住 Daemon 端不能再倒回去（multi-Space 越权防御）。
 */
import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '@tabtin/security-policy';
import { DaemonAgentHost } from '../src/application/agent/daemon-agent-host.js';

interface HostStateLike {
  spaceId?: string;
  workspaceSnapshot: WorkspaceSnapshot | null;
}

interface FindHarness {
  sessions: Map<string, HostStateLike>;
  findWorkspaceSnapshotForSpace: (spaceId: string) => WorkspaceSnapshot | null;
  findAnyActiveWorkspaceSnapshot: () => WorkspaceSnapshot | null;
}

function createHarness(): FindHarness {
  const harness = Object.create(DaemonAgentHost.prototype) as FindHarness;
  Object.defineProperty(harness, 'sessions', {
    value: new Map<string, HostStateLike>(),
    writable: true,
    configurable: true,
  });
  return harness;
}

function makeSnapshot(allowedPaths: string[], spaceSessionId: string): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: '/tmp',
      tabcodeProjects: [...allowedPaths],
      tabfolderDirs: [],
      attachedFiles: [],
    },
    allowedPaths: [...allowedPaths],
    allowedFiles: [],
    spaceSessionId,
  };
}

describe('findWorkspaceSnapshotForSpace — P1-5 严格 spaceId 匹配', () => {
  it('精确命中 → 返回该 snapshot', () => {
    const h = createHarness();
    const snapA = makeSnapshot(['/proj/a'], 'session-a');
    const snapB = makeSnapshot(['/proj/b'], 'session-b');
    h.sessions.set('session-a', { spaceId: 'space-a', workspaceSnapshot: snapA });
    h.sessions.set('session-b', { spaceId: 'space-b', workspaceSnapshot: snapB });
    expect(h.findWorkspaceSnapshotForSpace('space-a')).toBe(snapA);
    expect(h.findWorkspaceSnapshotForSpace('space-b')).toBe(snapB);
  });

  it('P1-5 修复：spaceId 给定但未命中 → null（不再 fallback 到任一 session）', () => {
    const h = createHarness();
    const snap = makeSnapshot(['/proj/x'], 'session-x');
    h.sessions.set('session-x', { spaceId: 'space-x', workspaceSnapshot: snap });
    // multi-Space 越权防御：space-c 未命中 → null，不退化为 space-x 的 snapshot
    expect(h.findWorkspaceSnapshotForSpace('space-not-here')).toBeNull();
  });

  it('空字符串 / 未传 spaceId → null（防御）', () => {
    const h = createHarness();
    const snap = makeSnapshot(['/proj/x'], 'session-x');
    h.sessions.set('session-x', { spaceId: 'space-x', workspaceSnapshot: snap });
    expect(h.findWorkspaceSnapshotForSpace('')).toBeNull();
  });

  it('session.workspaceSnapshot=null → null', () => {
    const h = createHarness();
    h.sessions.set('session-empty', { spaceId: 'space-x', workspaceSnapshot: null });
    expect(h.findWorkspaceSnapshotForSpace('space-x')).toBeNull();
  });
});

describe('findAnyActiveWorkspaceSnapshot — dogfood 单 session 模式', () => {
  it('返回任意活跃 session 的 snapshot', () => {
    const h = createHarness();
    const snap = makeSnapshot(['/proj/y'], 'session-y');
    h.sessions.set('session-y', { spaceId: 'space-y', workspaceSnapshot: snap });
    expect(h.findAnyActiveWorkspaceSnapshot()).toBe(snap);
  });

  it('无活跃 session → null', () => {
    const h = createHarness();
    expect(h.findAnyActiveWorkspaceSnapshot()).toBeNull();
  });

  it('snapshot=null 的 session 被跳过', () => {
    const h = createHarness();
    h.sessions.set('session-empty', { spaceId: 'space-x', workspaceSnapshot: null });
    const snap = makeSnapshot(['/proj/z'], 'session-z');
    h.sessions.set('session-z', { spaceId: 'space-z', workspaceSnapshot: snap });
    expect(h.findAnyActiveWorkspaceSnapshot()).toBe(snap);
  });
});
