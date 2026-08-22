/**
 * 平台自产产物：只读免 workspace_out；写仍 ask；reason 用 platform_artifact_allow。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tabtinAgentTasksDir } from '@tabtin/terminal-core';

import { judge } from '../src/judge.js';
import { __clearNormalizeCache } from '../src/path-normalize.js';
import {
  getPlatformArtifactRoots,
  isPlatformArtifactPath,
  isPlatformArtifactReadAllowed,
} from '../src/platform-artifact-paths.js';
import { isShellCommandWriteOp } from '../src/shell-command-side-effect.js';
import type {
  EffectivePolicy,
  JudgeContext,
  JudgeTool,
  MemoStore,
  WorkspaceSnapshot,
  ApprovalMemoLookupResult,
} from '../src/types-v3.js';

class StaticMemoStore implements MemoStore {
  get generation(): number { return 0; }
  lookup(): ApprovalMemoLookupResult | null { return null; }
  async putAlways(): Promise<void> {}
  async revoke(): Promise<void> {}
  async maybeRefetch(): Promise<boolean> { return false; }
  async bootstrap(): Promise<void> {}
  replaceAll(): void {}
}

function makeWorkspace(allowed: string[]): WorkspaceSnapshot {
  const primary = allowed[0] ?? '';
  return {
    sources: {
      sandbox: primary,
      workingDir: primary,
      sessionApprovedPaths: allowed.slice(1),
      attachedFiles: [],
    },
    allowedPaths: allowed,
    allowedFiles: [],
    spaceSessionId: 'sess',
  };
}

function makePolicy(opts?: Partial<EffectivePolicy>): EffectivePolicy {
  return {
    approvalMode: opts?.approvalMode ?? 'always_ask',
    workspace: opts?.workspace ?? makeWorkspace([]),
    memo: opts?.memo ?? { generation: 0, entries: {} },
    executionLimits: opts?.executionLimits ?? {},
    planModeGuardActive: opts?.planModeGuardActive ?? false,
  };
}

const shellTool: JudgeTool = {
  name: 'run_terminal_command',
  policyActionKind: 'shell',
  extractPath: (input) => (input as { cwd?: string })?.cwd,
  extractSubcmd: (input) => {
    const cmd = (input as { command?: string })?.command ?? '';
    return cmd.split(/\s+/)[0] ?? '';
  },
  isWriteOp: (input) => {
    const cmd = (input as { command?: string })?.command ?? '';
    return isShellCommandWriteOp(cmd);
  },
};

const readFileTool: JudgeTool = {
  name: 'read_file',
  policyActionKind: 'file',
  extractPath: (input) => (input as { path?: string; file_path?: string })?.path
    ?? (input as { file_path?: string })?.file_path,
  extractSubcmd: () => 'read',
  isWriteOp: () => false,
};

const writeFileTool: JudgeTool = {
  name: 'write_file',
  policyActionKind: 'file',
  extractPath: (input) => (input as { path?: string; file_path?: string })?.path
    ?? (input as { file_path?: string })?.file_path,
  extractSubcmd: () => 'write',
  isWriteOp: () => true,
};

function ctx(opts: {
  tool: JudgeTool;
  input: Record<string, unknown>;
  policy: EffectivePolicy;
  homeDir?: string;
}): JudgeContext {
  return {
    tool: opts.tool,
    input: opts.input,
    effectivePolicy: opts.policy,
    memoStore: new StaticMemoStore(),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
}

beforeEach(() => __clearNormalizeCache());

describe('platform-artifact-paths helpers', () => {
  it('roots 含 cli-outputs / tabtin-agent-tasks / tabtin-tool-results', () => {
    const home = os.homedir();
    const roots = getPlatformArtifactRoots(home);
    expect(roots).toContain(path.join(home, '.tabtin', 'cli-outputs'));
    expect(roots).toContain(tabtinAgentTasksDir());
    expect(roots).toContain(path.join(os.tmpdir(), 'tabtin-tool-results'));
  });

  it('只读允许 / 写拒绝', () => {
    const home = os.homedir();
    const p = path.join(home, '.tabtin', 'cli-outputs', 'a.json');
    expect(isPlatformArtifactPath(p, home)).toBe(true);
    expect(isPlatformArtifactReadAllowed(p, false, home)).toBe(true);
    expect(isPlatformArtifactReadAllowed(p, true, home)).toBe(false);
  });
});

describe('judge · 平台自产产物只读免审', () => {
  it('shell grep cli-outputs → allow（cwd workspace_in）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
    try {
      const realTmp = fs.realpathSync(tmp);
      const home = os.homedir();
      const spill = path.join(home, '.tabtin', 'cli-outputs', '2026-07-25', 'cli-output-1.json');
      const d = judge(ctx({
        tool: shellTool,
        input: { command: `grep -n keyword ${spill} | head -40`, cwd: realTmp },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(d.behavior).toBe('allow');
      expect(d.reason.type).toBe('workspace_in');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('shell echo > cli-outputs → ask workspace_out（写不放行）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
    try {
      const realTmp = fs.realpathSync(tmp);
      const home = os.homedir();
      const spill = path.join(home, '.tabtin', 'cli-outputs', 'x.json');
      const d = judge(ctx({
        tool: shellTool,
        input: { command: `echo hi > ${spill}`, cwd: realTmp },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(d.behavior).toBe('ask');
      expect(d.reason.type).toBe('workspace_out');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('shell rm cli-outputs → ask workspace_out', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
    try {
      const realTmp = fs.realpathSync(tmp);
      const home = os.homedir();
      const spill = path.join(home, '.tabtin', 'cli-outputs', 'x.json');
      const d = judge(ctx({
        tool: shellTool,
        input: { command: `rm -f ${spill}`, cwd: realTmp },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(d.behavior).toBe('ask');
      expect(d.reason.type).toBe('workspace_out');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('shell grep ~/Desktop → 仍 ask', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
    try {
      const realTmp = fs.realpathSync(tmp);
      const home = os.homedir();
      const outside = path.join(home, 'Desktop', 'secret.txt');
      const d = judge(ctx({
        tool: shellTool,
        input: { command: `grep -n keyword ${outside}`, cwd: realTmp },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(d.behavior).toBe('ask');
      expect(d.reason.type).toBe('workspace_out');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('read_file 平台产物 → platform_artifact_allow；write_file 仍 ask', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
    try {
      const realTmp = fs.realpathSync(tmp);
      const home = os.homedir();
      const spill = path.join(home, '.tabtin', 'cli-outputs', '2026-07-25', 'a.json');
      const readD = judge(ctx({
        tool: readFileTool,
        input: { path: spill },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(readD.behavior).toBe('allow');
      expect(readD.reason.type).toBe('platform_artifact_allow');

      const writeD = judge(ctx({
        tool: writeFileTool,
        input: { path: spill },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(writeD.behavior).toBe('ask');
      expect(writeD.reason.type).toBe('workspace_out');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('shell jq tabtin-tool-results → allow；echo > 仍 ask', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
    try {
      const realTmp = fs.realpathSync(tmp);
      const home = os.homedir();
      const spill = path.join(
        os.tmpdir(),
        'tabtin-tool-results',
        '07630d46-17c9-4edb-8d44-d4c081224260',
        'shell-tu_test-stdout.log',
      );
      const readD = judge(ctx({
        tool: shellTool,
        input: { command: `jq '.data.fields' ${spill}`, cwd: realTmp },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(readD.behavior).toBe('allow');
      expect(readD.reason.type).toBe('workspace_in');

      const writeD = judge(ctx({
        tool: shellTool,
        input: { command: `echo hi > ${spill}`, cwd: realTmp },
        policy: makePolicy({
          approvalMode: 'always_ask',
          workspace: makeWorkspace([realTmp]),
        }),
        homeDir: home,
      }));
      expect(writeD.behavior).toBe('ask');
      expect(writeD.reason.type).toBe('workspace_out');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
