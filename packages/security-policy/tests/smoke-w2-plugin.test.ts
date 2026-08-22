/**
 * smoke-w2-plugin.test.ts — W2 实施 Agent 真实使用方式冒烟
 *
 * 模拟 W2 启动时的代码：
 *   import {
 *     judge,
 *     buildPolicyFromAgentConfigV2,
 *     normalize,
 *     buildApprovalKey,
 *     lookupMemo,
 *   } from '@tabtin/security-policy';
 *
 * 走完：构造 EffectivePolicy → 实现 MemoStore → 多场景判决 → 拼装 memo 写入 → 再判决命中 memo
 *
 * 所有调用必须**零封装零修改**，直接用 SP 包导出的 API。
 */

import { describe, it, expect } from 'vitest';
import {
  judge,
  buildPolicyFromAgentConfigV2,
  normalize,
  buildApprovalKey,
  lookupMemo,
  type AgentConfigV3,
  type WorkspaceSnapshot,
  type MemoStore,
  type ApprovalMemoEntry,
  type ApprovalMemoLookupResult,
  type JudgeTool,
} from '../src/index';

// ── W2 风格的最小 MemoStore 实现 ───────────────────────────────────
class SimpleMemoStore implements MemoStore {
  private entries: Record<string, ApprovalMemoEntry> = {};
  private _gen = 0;
  get generation(): number { return this._gen; }
  lookup(p: { toolName: string; subcmd: string; input: unknown; inWorkspace: boolean }): ApprovalMemoLookupResult | null {
    return lookupMemo(this.entries, p);
  }
  async putAlways(key: string, e: ApprovalMemoEntry): Promise<void> {
    this.entries[key] = e;
    this._gen += 1;
  }
  async revoke(key: string): Promise<void> {
    delete this.entries[key];
    this._gen += 1;
  }
  async maybeRefetch(g: number): Promise<boolean> {
    if (g <= this._gen) return false;
    this._gen = g;
    return true;
  }
  async bootstrap(): Promise<void> {}
  replaceAll(e: Record<string, ApprovalMemoEntry>, g: number): void {
    this.entries = { ...e };
    this._gen = g;
  }
  /** 测试辅助 */
  __debug(): Record<string, ApprovalMemoEntry> {
    return { ...this.entries };
  }
}

// ── W2 风格的最小 Tool 定义 ───────────────────────────────────────
const execCmdTool: JudgeTool = {
  name: 'run_terminal_command',
  policyActionKind: 'shell',
  extractPath: (input) => (input as { cwd?: string })?.cwd,
  extractSubcmd: (input) => {
    const cmd = (input as { command?: string })?.command ?? '';
    return cmd.split(/\s+/)[0]?.replace(/[^a-zA-Z0-9_.-]/g, '') || '_';
  },
  isWriteOp: () => true,
};

const readFileTool: JudgeTool = {
  name: 'read_file',
  policyActionKind: 'file',
  extractPath: (input) => (input as { path?: string })?.path,
  extractSubcmd: () => 'read',
  isWriteOp: () => false,
};

describe('W2 plug-in 冒烟：完整使用流程', () => {
  it('完整链路：build policy → judge → ask → put memo → judge again → allow', async () => {
    const workspace: WorkspaceSnapshot = {
      sources: {
        sandbox: '/Users/me/sandbox',
        tabcodeProjects: ['/Users/me/dev/proj'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['/Users/me/sandbox', '/Users/me/dev/proj'],
      allowedFiles: [],
      spaceSessionId: 'sess-1',
    };

    const config: AgentConfigV3 = {
      schema_version: 3,
      runtime_plane: 'local',
      security: { allow_yolo_mode: false },
    };

    // 1. W2 调 buildPolicyFromAgentConfigV2 派生 EffectivePolicy
    const effectivePolicy = buildPolicyFromAgentConfigV2(config, workspace);
    expect(effectivePolicy.approvalMode).toBe('always_ask');

    // 2. W2 装配 MemoStore（自己 implement，用 SP 提供的 lookupMemo helper）
    const memoStore = new SimpleMemoStore();

    // 3. W2 调 judge 第一次（工作区外的命令 → ask）
    const d1 = judge({
      tool: execCmdTool,
      input: { command: 'npm install', cwd: '/tmp/random_' + Date.now() },
      effectivePolicy,
      memoStore,
    });
    expect(d1.behavior).toBe('ask');
    expect(d1.approvalKey).toBeDefined();

    // 4. W2 模拟用户点"一直允许 / 工作区外 npm install" → 写 memo
    const wildKey = buildApprovalKey('run_terminal_command', 'npm', {}, false, {
      kind: 'shell',
      scope: 'wildcard',
    });
    await memoStore.putAlways(wildKey, {
      decision: 'allow',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      approver_user_id: 'u-1',
      scope_description: '允许任意 npm install',
    });

    // 5. W2 调 judge 第二次（同样 input → 命中 memo allow）
    const d2 = judge({
      tool: execCmdTool,
      input: { command: 'npm install', cwd: '/tmp/random_' + Date.now() },
      effectivePolicy,
      memoStore,
    });
    expect(d2.behavior).toBe('allow');
    expect(d2.reason.type).toBe('memo_allow');

    // 6. W2 验证 normalize 路径
    const r = normalize('/Users/me/dev/proj');
    expect(typeof r.path).toBe('string');
  });

  it('零封装：所有 import 都从 @tabtin/security-policy 入口直接拿', () => {
    expect(typeof judge).toBe('function');
    expect(typeof buildPolicyFromAgentConfigV2).toBe('function');
    expect(typeof normalize).toBe('function');
    expect(typeof buildApprovalKey).toBe('function');
    expect(typeof lookupMemo).toBe('function');
  });
});
