/**
 * build-policy.test.ts — buildPolicyFromAgentConfigV2 纯函数单测
 */

import { describe, it, expect } from 'vitest';
import {
  buildPolicyFromAgentConfigV2,
  deriveApprovalMode,
  resolveApprovalGrant,
} from '../src/build-policy';
import type { AgentConfigV3, WorkspaceSnapshot } from '../src/types-v3';

function makeWs(): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: '/Users/me/sandbox',
      workingDir: '/Users/me/dev/proj',
      sessionApprovedPaths: [],
      attachedFiles: [],
    },
    allowedPaths: ['/Users/me/sandbox', '/Users/me/dev/proj'],
    allowedFiles: [],
    spaceSessionId: 'session-1',
  };
}

function baseConfig(): AgentConfigV3 {
  return {
    schema_version: 3,
    runtime_plane: 'local',
    security: { allow_yolo_mode: false },
  };
}

describe('buildPolicyFromAgentConfigV2', () => {
  it('默认值：approvalMode=always_ask / executionLimits 空', () => {
    const p = buildPolicyFromAgentConfigV2(baseConfig(), makeWs());
    expect(p.approvalMode).toBe('always_ask');
    expect(p.executionLimits).toEqual({});
    expect(p.memo.generation).toBe(0);
    expect(Object.keys(p.memo.entries)).toHaveLength(0);
    expect(p.planModeGuardActive).toBe(false);
  });

  it('Workspace grant 是唯一权限源，旧会话 requested 不再压低权限', () => {
    const cfg = baseConfig();
    cfg.security.approval_grant = 'full_access';
    expect(
      buildPolicyFromAgentConfigV2(cfg, makeWs(), {
        requestedApprovalMode: 'always_ask',
        requestedAgentMode: 'agent',
      }).approvalMode,
    ).toBe('full_access');
  });

  it('execution_limits 数字字段透传', () => {
    const cfg = baseConfig();
    cfg.capabilities = {
      overrides: {
        cost: { execution_limits: { max_iterations_per_run: 100, max_credits_per_run: 50 } },
      },
    };
    const p = buildPolicyFromAgentConfigV2(cfg, makeWs());
    expect(p.executionLimits.max_iterations_per_run).toBe(100);
    expect(p.executionLimits.max_credits_per_run).toBe(50);
  });

  it('execution_limits string 形式 max_credits 转 number', () => {
    const cfg = baseConfig();
    cfg.capabilities = {
      overrides: { cost: { execution_limits: { max_credits_per_run: '25.5' } } },
    };
    expect(buildPolicyFromAgentConfigV2(cfg, makeWs()).executionLimits.max_credits_per_run).toBe(25.5);
  });

  it('execution_limits 非法值（负数 / 非数）被忽略', () => {
    const cfg = baseConfig();
    cfg.capabilities = {
      overrides: {
        cost: {
          execution_limits: {
            max_iterations_per_run: -1,
            max_credits_per_run: 'not-a-number',
          },
        },
      },
    };
    const limits = buildPolicyFromAgentConfigV2(cfg, makeWs()).executionLimits;
    expect(limits.max_iterations_per_run).toBeUndefined();
    expect(limits.max_credits_per_run).toBeUndefined();
  });

  it('approval_memo 透传 generation + entries', () => {
    const cfg = baseConfig();
    cfg.approval_memo = {
      version: 2,
      generation: 42,
      entries: {
        'run_terminal_command::rm:workspace-internal': {
          decision: 'allow',
          created_at: '2026-05-02T00:00:00Z',
          updated_at: '2026-05-02T00:00:00Z',
          approver_user_id: 'u-1',
          scope_description: '工作区内 rm',
        },
      },
    };
    const p = buildPolicyFromAgentConfigV2(cfg, makeWs());
    expect(p.memo.generation).toBe(42);
    expect(p.memo.entries['run_terminal_command::rm:workspace-internal']?.decision).toBe('allow');
  });

  it('opts.planModeGuardActive 透传', () => {
    const p = buildPolicyFromAgentConfigV2(baseConfig(), makeWs(), { planModeGuardActive: true });
    expect(p.planModeGuardActive).toBe(true);
  });

  it('workspace 引用透传（不深拷）', () => {
    const ws = makeWs();
    const p = buildPolicyFromAgentConfigV2(baseConfig(), ws);
    expect(p.workspace).toBe(ws);
  });

  it('参数校验：config 非 object 抛错', () => {
    expect(() =>
      buildPolicyFromAgentConfigV2(null as unknown as AgentConfigV3, makeWs()),
    ).toThrow(/config/);
    expect(() =>
      buildPolicyFromAgentConfigV2(baseConfig(), null as unknown as WorkspaceSnapshot),
    ).toThrow(/workspace/);
  });

  it('纯函数：相同输入产出 deepEqual 输出', () => {
    const cfg = baseConfig();
    const ws = makeWs();
    const p1 = buildPolicyFromAgentConfigV2(cfg, ws);
    const p2 = buildPolicyFromAgentConfigV2(cfg, ws);
    expect(p1).toEqual(p2);
  });
});

describe('resolveApprovalGrant', () => {
  it('approval_grant 优先于 legacy allow_yolo_mode', () => {
    const cfg = baseConfig();
    cfg.security.approval_grant = 'full_access';
    cfg.security.allow_yolo_mode = false;
    expect(resolveApprovalGrant(cfg)).toBe('full_access');
  });

  it('allow_yolo_mode=true 归一为 auto', () => {
    const cfg = baseConfig();
    cfg.security.allow_yolo_mode = true;
    expect(resolveApprovalGrant(cfg)).toBe('auto');
  });

  it('无授权记录 → always_ask', () => {
    expect(resolveApprovalGrant(baseConfig())).toBe('always_ask');
  });
});

describe('deriveApprovalMode — Workspace 单一权限源 ', () => {
  it('grant=auto → auto', () => {
    const cfg = baseConfig();
    cfg.security.approval_grant = 'auto';
    expect(
      deriveApprovalMode(cfg, { requestedApprovalMode: 'auto', isGroupSpace: false }),
    ).toBe('auto');
  });

  it('旧请求不能越过 Workspace grant', () => {
    expect(
      deriveApprovalMode(baseConfig(), { requestedApprovalMode: 'auto', isGroupSpace: false }),
    ).toBe('always_ask');
  });

  it('group Space 强制 always_ask', () => {
    const cfg = baseConfig();
    cfg.security.approval_grant = 'full_access';
    expect(
      deriveApprovalMode(cfg, { requestedApprovalMode: 'full_access', isGroupSpace: true }),
    ).toBe('always_ask');
  });

  it('legacy allow_yolo_mode=true 仍归一为 Workspace auto grant', () => {
    const cfg = baseConfig();
    cfg.security.allow_yolo_mode = true;
    expect(
      deriveApprovalMode(cfg, { requestedAgentMode: 'yolo', isGroupSpace: false }),
    ).toBe('auto');
  });

  it('旧请求不能把 Workspace auto 抬高或压低', () => {
    const cfg = baseConfig();
    cfg.security.approval_grant = 'auto';
    expect(
      deriveApprovalMode(cfg, { requestedApprovalMode: 'full_access', isGroupSpace: false }),
    ).toBe('auto');
  });

  it('PD-13 闭包契约：仅 mutate grant 影响权限，旧 requested 无效', () => {
    const cfg = baseConfig();
    const ws = makeWs();
    const policyContext = {
      requestedApprovalMode: 'always_ask' as const,
      isGroupSpace: false,
    };
    const buildJudgePolicy = () =>
      buildPolicyFromAgentConfigV2(cfg, ws, {
        requestedApprovalMode: policyContext.requestedApprovalMode,
        isGroupSpace: policyContext.isGroupSpace,
      });

    expect(buildJudgePolicy().approvalMode).toBe('always_ask');

    cfg.security.approval_grant = 'auto';
    expect(buildJudgePolicy().approvalMode).toBe('auto');

    policyContext.requestedApprovalMode = 'auto';
    expect(buildJudgePolicy().approvalMode).toBe('auto');

    policyContext.requestedApprovalMode = 'always_ask';
    expect(buildJudgePolicy().approvalMode).toBe('auto');
  });
});

describe('deriveApprovalMode — unattended（自动化钉 auto）', () => {
  it('无 grant + unattended 仍是 always_ask', () => {
    expect(
      deriveApprovalMode(baseConfig(), {
        requestedApprovalMode: 'auto',
        isGroupSpace: false,
        unattended: true,
      }),
    ).toBe('always_ask');
  });

  it('unattended + requested=full_access → 仍钉 auto（不升到 full_access）', () => {
    const cfg = baseConfig();
    cfg.security.approval_grant = 'full_access';
    expect(
      deriveApprovalMode(cfg, {
        requestedApprovalMode: 'full_access',
        isGroupSpace: false,
        unattended: true,
      }),
    ).toBe('auto');
  });

  it('unattended + group Space → always_ask', () => {
    expect(
      deriveApprovalMode(baseConfig(), {
        requestedApprovalMode: 'auto',
        isGroupSpace: true,
        unattended: true,
      }),
    ).toBe('always_ask');
  });

  it('unattended 缺省 → 仍受 grant 约束', () => {
    expect(
      deriveApprovalMode(baseConfig(), {
        requestedApprovalMode: 'auto',
        isGroupSpace: false,
      }),
    ).toBe('always_ask');
  });
});
