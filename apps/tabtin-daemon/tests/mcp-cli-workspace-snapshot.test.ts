/**
 * 路径权限治理 Wave 4：Daemon mcp-server / cli-server 接通 v3 workspaceSnapshot。
 *
 * 跟 action-bridge-workspace-snapshot 同模式 —— 用源码字符串 +
 * checkDaemonPathAccess 模拟，避免实例化整个 server。
 *
 * 钉死：
 *   - mcp-server 装配接受 getWorkspaceSnapshot 闭包；file/search/read_lints
 *     三类路径都走 checkDaemonPathAccess 而非 checkHardlinePath 散点
 *   - cli-server 暴露 setCLIWorkspaceSnapshotResolver；evaluateCLIPolicy
 *     调 checkDaemonPathAccess 替代 checkHardlinePath
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { checkDaemonPathAccess } from '../src/application/security/path-access.js';
import type { WorkspaceSnapshot } from '@tabtin/security-policy';

const MCP_SRC = fs.readFileSync(
  path.resolve(__dirname, '../src/application/mcp/mcp-tool-application.ts'),
  'utf-8',
) + fs.readFileSync(
  path.resolve(__dirname, '../src/application/mcp/security.ts'),
  'utf-8',
) + fs.readFileSync(
  path.resolve(__dirname, '../src/application/mcp/contracts.ts'),
  'utf-8',
);
const CLI_SRC = fs.readFileSync(
  path.resolve(__dirname, '../src/transport/cli/cli-server.ts'),
  'utf-8',
);
const DAEMON_SRC = fs.readFileSync(
  path.resolve(__dirname, '../src/bootstrap/daemon.ts'),
  'utf-8',
);

function makeSnapshot(allowedPaths: string[]): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: '/tmp',
      tabcodeProjects: [...allowedPaths],
      tabfolderDirs: [],
      attachedFiles: [],
    },
    allowedPaths: [...allowedPaths],
    allowedFiles: [],
    spaceSessionId: 'session',
  };
}

describe('TabTinMcpServer — Wave 4 装配契约', () => {
  it('McpServerConfig 引入 getWorkspaceSnapshot 字段', () => {
    expect(MCP_SRC).toMatch(/getWorkspaceSnapshot\?\:/);
    expect(MCP_SRC).toMatch(/WorkspaceSnapshot/);
  });

  it('file/search/read_lints 路径检查走 checkDaemonPathAccess（不再用 checkHardlinePath 散点）', () => {
    expect(MCP_SRC).toContain('checkDaemonPathAccess');
    // 不应再有"在工具入口直接调 checkHardlinePath 做散点路径检查"
    expect(MCP_SRC).not.toMatch(/checkHardlinePath\(\s*filePath/);
    expect(MCP_SRC).not.toMatch(/checkHardlinePath\(\s*sp/);
    expect(MCP_SRC).not.toMatch(/checkHardlinePath\(\s*p,\s*'file'\)/);
  });

  it('P0-1 修复：旧 PATH_SANDBOX_ACTIONS hardcoded boundary 已彻底删除', () => {
    // 旧 boundary 用 wsNorm + tabtinNorm 双前缀 startsWith 检查
    expect(MCP_SRC).not.toMatch(/wsNorm.*tabtinNorm/);
    expect(MCP_SRC).not.toMatch(/PATH_SANDBOX_ACTIONS\.has\(toolName\)\s*&&\s*this\.config\.workspaceRoot/);
    // PATH_SANDBOX_ACTIONS 集合本身也删了
    expect(MCP_SRC).not.toMatch(/const PATH_SANDBOX_ACTIONS = new Set/);
  });

  it('P0-1 修复：read_file 显式纳入 collectPaths（不再因 FILE_POLICY_ACTIONS 不含而 bypass）', () => {
    expect(MCP_SRC).toMatch(/FILE_ACTIONS\.has\(toolName\)\s*\|\|\s*toolName === 'read_file'/);
  });

  it('P0-1 修复：~/.tabtin 加入 fallbackRoots（合并旧 boundary 的"恒定可访问"语义）', () => {
    expect(MCP_SRC).toContain('getHomeTabtinPath()');
  });

  it('调 getWorkspaceSnapshot 闭包派生 snapshot + workspaceRoot 兜底', () => {
    expect(MCP_SRC).toContain('this.options.getWorkspaceSnapshot?.()');
    expect(MCP_SRC).toContain('this.options.workspaceRoot');
  });

  it('daemon.ts 装配 mcp-server 时注入 getWorkspaceSnapshot 闭包（P1-5 后走显式 findAnyActiveWorkspaceSnapshot）', () => {
    expect(DAEMON_SRC).toContain('getWorkspaceSnapshot:');
    expect(DAEMON_SRC).toContain('this.localAgentHost?.findAnyActiveWorkspaceSnapshot()');
  });
});

describe('cli-server — Wave 4 装配契约', () => {
  it('通过 CliRequestContext 消费 workspace snapshot resolver', () => {
    expect(CLI_SRC).toContain('resolveWorkspaceSnapshot()');
    expect(CLI_SRC).not.toContain('cliWorkspaceSnapshotResolver = resolver');
  });

  it('evaluateCLIPolicy 走 checkDaemonPathAccess（不再用 checkHardlinePath）', () => {
    expect(CLI_SRC).toContain('checkDaemonPathAccess');
    expect(CLI_SRC).not.toMatch(/checkHardlinePath\(filePath/);
  });

  it('snapshot 缺失时 fallback 到 process.cwd()', () => {
    expect(CLI_SRC).toContain('process.cwd()');
    expect(CLI_SRC).toMatch(/fallbackRoots:\s*\[process\.cwd\(\)\]/);
  });

  it('daemon.ts 通过 requestContext 注入 snapshot resolver', () => {
    expect(DAEMON_SRC).toMatch(/requestContext:\s*\{[\s\S]{0,300}?workspaceSnapshotResolver:[\s\S]{0,200}?findAnyActiveWorkspaceSnapshot/);
  });
});

describe('mcp-server / cli-server 路径判定行为模拟', () => {
  // ── MCP server file/search/read_lints 模拟 ──
  function simulateMcpAccess(
    paths: string[],
    action: 'read' | 'write',
    snapshot: WorkspaceSnapshot | null,
    workspaceRoot?: string,
  ): { allowed: boolean; reason?: string } {
    const opts = {
      snapshot,
      fallbackRoots: workspaceRoot ? [workspaceRoot] : [],
    };
    for (const p of paths) {
      const access = checkDaemonPathAccess(p, action, opts);
      if (!access.allowed) return { allowed: false, reason: access.reason?.message };
    }
    return { allowed: true };
  }

  it('MCP file 工具：snapshot 命中放行', () => {
    const snap = makeSnapshot(['/proj/a']);
    const r = simulateMcpAccess(['/proj/a/src/x.ts'], 'write', snap);
    expect(r.allowed).toBe(true);
  });

  it('MCP search 多目录：任一 outside_workspace → deny（AND 严格）', () => {
    const snap = makeSnapshot(['/proj/a']);
    const r = simulateMcpAccess(
      ['/proj/a/src', '/proj/b/src'],
      'read',
      snap,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('TabFolder');
  });

  it('MCP read_lints 多文件：所有命中 → allowed', () => {
    const snap = makeSnapshot(['/proj/a']);
    const r = simulateMcpAccess(
      ['/proj/a/x.ts', '/proj/a/y.ts'],
      'read',
      snap,
    );
    expect(r.allowed).toBe(true);
  });

  it('MCP snapshot 缺失走 workspaceRoot 兜底', () => {
    const r = simulateMcpAccess(['/sandbox/file.ts'], 'write', null, '/sandbox');
    expect(r.allowed).toBe(true);
  });

  it('MCP 红线在 snapshot 命中之前执行', () => {
    const snap = makeSnapshot(['/']);
    const r = simulateMcpAccess(['/etc/passwd'], 'write', snap);
    expect(r.allowed).toBe(false);
  });

  // ── CLI server 模拟（write 语义 + cwd fallback）──
  it('CLI server snapshot 缺失走 cwd 兜底', () => {
    const cwd = process.cwd();
    const inProj = `${cwd}/scripts/foo.sh`;
    const access = checkDaemonPathAccess(inProj, 'write', {
      snapshot: null,
      fallbackRoots: [cwd],
    });
    expect(access.allowed).toBe(true);
  });

  it('CLI server snapshot 命中后 short-circuit 放行', () => {
    const snap = makeSnapshot(['/Users/x/proj']);
    const access = checkDaemonPathAccess('/Users/x/proj/file.ts', 'write', {
      snapshot: snap,
      fallbackRoots: [process.cwd()],
    });
    expect(access.allowed).toBe(true);
  });
});
