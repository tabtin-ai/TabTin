/**
 * 路径权限治理 Wave 4 / W7 B6：Daemon 三家入口共享 path-access helper 单测。
 *
 * 钉死 Wave 4 §断层 5 修复后的核心契约：
 *   1. snapshot 命中 allowedPaths → workspace boundary 放行
 *   2. snapshot 缺失 → fallback root 放行；都 miss 则拒绝
 *   3. alreadyJudged=true → 跳过 boundary，但红线 + 敏感路径仍执行
 *      （helper 字段保留作合法 caller 接口；W7 后跨进程 caller 都不传）
 *   4. 红线优先级最高（无论 snapshot / alreadyJudged）
 *   5. 敏感路径 deny 类型在 inWorkspace=false 时直接拒（与 Electron path-access-checker 同语义）
 *   6. 多 spaceId 场景的 resolver 闭包行为正确
 *
 * **W7 / B6 移除**：原 7) `extractAlreadyJudged` 永远 false 的死封装函数已
 * 删除（D3 反例）；handleAction 入口 strip wire `_already_judged` 是唯一
 * 防御点，三家 caller 不再读取也不再透传此字段。
 */
import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '@tabtin/security-policy';
import {
  checkDaemonPathAccess,
  type WorkspaceSnapshotResolver,
} from '../src/application/security/path-access.js';

const HOME = process.env.HOME || '/Users/test';

function makeSnapshot(allowedPaths: string[]): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: '/tmp/sandbox',
      tabcodeProjects: [...allowedPaths],
      tabfolderDirs: [],
      attachedFiles: [],
    },
    allowedPaths: [...allowedPaths],
    allowedFiles: [],
    spaceSessionId: 'test-session',
  };
}

describe('checkDaemonPathAccess — workspace boundary', () => {
  it('snapshot.allowedPaths 命中前缀子树 → allowed', () => {
    const snapshot = makeSnapshot(['/Users/x/proj']);
    const res = checkDaemonPathAccess('/Users/x/proj/src/app.ts', 'write', { snapshot });
    expect(res.allowed).toBe(true);
  });

  it('snapshot.allowedPaths 完全匹配 → allowed', () => {
    const snapshot = makeSnapshot(['/Users/x/proj']);
    const res = checkDaemonPathAccess('/Users/x/proj', 'read', { snapshot });
    expect(res.allowed).toBe(true);
  });

  it('snapshot 不命中 → outside_workspace deny + actionable 文案', () => {
    const snapshot = makeSnapshot(['/Users/x/proj']);
    const res = checkDaemonPathAccess('/Users/y/other/file.txt', 'write', { snapshot });
    expect(res.allowed).toBe(false);
    expect(res.reason?.reasonCode).toBe('outside_workspace');
    expect(res.reason?.message).toContain('TabFolder');
    expect(res.reason?.message).toContain('Super Permissions');
  });

  it('snapshot 缺失走 fallbackRoots → 命中即放行', () => {
    const res = checkDaemonPathAccess('/Users/sandbox/file.ts', 'write', {
      snapshot: null,
      fallbackRoots: ['/Users/sandbox'],
    });
    expect(res.allowed).toBe(true);
  });

  it('snapshot 缺失且 fallbackRoots 不命中 → outside_workspace deny', () => {
    const res = checkDaemonPathAccess('/Users/elsewhere/file.ts', 'write', {
      snapshot: null,
      fallbackRoots: ['/Users/sandbox'],
    });
    expect(res.allowed).toBe(false);
    expect(res.reason?.reasonCode).toBe('outside_workspace');
  });

  it('snapshot 缺失且无 fallback → outside_workspace deny', () => {
    const res = checkDaemonPathAccess('/Users/x/file.ts', 'read', { snapshot: null });
    expect(res.allowed).toBe(false);
    expect(res.reason?.reasonCode).toBe('outside_workspace');
  });

  it('空 / 非字符串路径 → invalid_path deny（fail-closed）', () => {
    const r1 = checkDaemonPathAccess('', 'read', { snapshot: null });
    expect(r1.allowed).toBe(false);
    expect(r1.reason?.reasonCode).toBe('invalid_path');
    const r2 = checkDaemonPathAccess(undefined as unknown as string, 'read', { snapshot: null });
    expect(r2.allowed).toBe(false);
    expect(r2.reason?.reasonCode).toBe('invalid_path');
  });
});

describe('checkDaemonPathAccess — alreadyJudged 跳过 boundary', () => {
  it('alreadyJudged=true + 工作区外路径 → allowed（信任 v3 judge）', () => {
    const snapshot = makeSnapshot(['/Users/x/proj']);
    const res = checkDaemonPathAccess('/Users/y/elsewhere/file.txt', 'write', {
      snapshot,
      alreadyJudged: true,
    });
    expect(res.allowed).toBe(true);
  });

  it('alreadyJudged=true + 红线路径 → 仍 deny（红线最高优先级）', () => {
    const snapshot = makeSnapshot(['/Users/x/proj']);
    const res = checkDaemonPathAccess('/etc/passwd', 'write', {
      snapshot,
      alreadyJudged: true,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason?.reasonCode).toBe('hardline');
  });
});

describe('checkDaemonPathAccess — 红线优先级', () => {
  it('红线在 snapshot 命中之前执行', () => {
    const snapshot = makeSnapshot(['/']);
    const res = checkDaemonPathAccess('/etc/passwd', 'write', { snapshot });
    expect(res.allowed).toBe(false);
    expect(res.reason?.reasonCode).toBe('hardline');
  });

  it('红线在 alreadyJudged 跳过 boundary 之前执行', () => {
    const res = checkDaemonPathAccess('/etc/passwd', 'write', {
      snapshot: null,
      alreadyJudged: true,
      fallbackRoots: ['/etc'],
    });
    expect(res.allowed).toBe(false);
    expect(res.reason?.reasonCode).toBe('hardline');
  });
});

describe('checkDaemonPathAccess — 敏感路径四态', () => {
  it('inWorkspace=false 写敏感路径 → sensitive_out_deny', () => {
    const sshKey = `${HOME}/.ssh/id_rsa`;
    const res = checkDaemonPathAccess(sshKey, 'write', {
      snapshot: null,
      fallbackRoots: ['/somewhere/else'],
    });
    expect(res.allowed).toBe(false);
    // 红线或敏感都可能命中，重点是 deny
    expect(['hardline', 'sensitive']).toContain(res.reason?.reasonCode);
  });
});

describe('checkDaemonPathAccess — alreadyJudged 字段语义（caller 决定是否传）', () => {
  it('options.alreadyJudged 直传 true 仍可跳过 boundary（caller 责任，红线先于跳过）', () => {
    // 注：checkDaemonPathAccess 的 alreadyJudged 参数仍然被尊重 —— 跳过
    // boundary 是 caller 的合法功能。W7 / B6 之后 daemon 三家入口 caller
    // 都不传此字段（W4 P1-3 防御已下沉到 handleAction 入口的 strip 步骤），
    // 但 helper 自身 API 保留以备未来 trusted judge_decision 子结构接入。
    const snapshot = makeSnapshot(['/proj/a']);
    const access = checkDaemonPathAccess('/elsewhere/file.txt', 'write', {
      snapshot,
      alreadyJudged: true,
    });
    expect(access.allowed).toBe(true);
  });

  it('caller 不传 alreadyJudged → boundary 跑完整流程，工作区外路径 deny', () => {
    // W7 / B6 后 daemon 三家入口标准调用模式：不传 alreadyJudged，等价于 false。
    // 即便恶意客户端塞 wire `_already_judged: true`，handleAction 已 strip，
    // 三家入口也不再读取此字段。
    const snapshot = makeSnapshot(['/proj/a']);
    const access = checkDaemonPathAccess('/elsewhere/file.txt', 'write', {
      snapshot,
    });
    // boundary 跑 → outside_workspace deny
    expect(access.allowed).toBe(false);
    expect(access.reason?.reasonCode).toBe('outside_workspace');
  });
});

describe('WorkspaceSnapshotResolver 闭包语义', () => {
  it('多 spaceId 场景闭包按需返回不同 snapshot', () => {
    const snapshotA = makeSnapshot(['/proj/a']);
    const snapshotB = makeSnapshot(['/proj/b']);
    const resolver: WorkspaceSnapshotResolver = (spaceId) => {
      if (spaceId === 'space-a') return snapshotA;
      if (spaceId === 'space-b') return snapshotB;
      return null;
    };
    const r1 = checkDaemonPathAccess('/proj/a/file.ts', 'write', {
      snapshot: resolver('space-a'),
    });
    const r2 = checkDaemonPathAccess('/proj/a/file.ts', 'write', {
      snapshot: resolver('space-b'),
    });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
    const r3 = checkDaemonPathAccess('/proj/b/file.ts', 'write', {
      snapshot: resolver('space-b'),
    });
    expect(r3.allowed).toBe(true);
  });
});
