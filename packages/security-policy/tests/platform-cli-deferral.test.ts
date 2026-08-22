import { describe, expect, it } from 'vitest'

import { detectPlatformManagedTabtinCli } from '../src/platform-cli-deferral.js'
import { judge } from '../src/judge.js'
import type {
  ApprovalMemoLookupResult,
  EffectivePolicy,
  JudgeTool,
  MemoStore,
  WorkspaceSnapshot,
} from '../src/types-v3.js'

class NullMemoStore implements MemoStore {
  get generation(): number { return 0 }
  lookup(): ApprovalMemoLookupResult | null { return null }
  async putAlways(): Promise<void> {}
  async revoke(): Promise<void> {}
  async maybeRefetch(): Promise<boolean> { return false }
  async bootstrap(): Promise<void> {}
  replaceAll(): void {}
}

function makeWorkspace(allowed: string[]): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: allowed[0] ?? '',
      tabcodeProjects: allowed.slice(1),
      tabfolderDirs: [],
      attachedFiles: [],
    },
    allowedPaths: allowed,
    allowedFiles: [],
    spaceSessionId: 'sess',
  }
}

function makePolicy(): EffectivePolicy {
  return {
    approvalMode: 'always_ask',
    workspace: makeWorkspace(['/Users/demo/ws']),
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  }
}

const shellTool: JudgeTool = {
  name: 'run_terminal_command',
  policyActionKind: 'shell',
  extractPath: (input) => (input as { cwd?: string })?.cwd,
  extractSubcmd: (input) => {
    const cmd = (input as { command?: string })?.command ?? ''
    return cmd.split(/\s+/)[0] ?? ''
  },
  isWriteOp: () => true,
}

describe('detectPlatformManagedTabtinCli', () => {
  it('recognizes browser / desktop surfaces', () => {
    expect(detectPlatformManagedTabtinCli('tabtin browser eval "1+1"'))
      .toEqual({ surface: 'browser' })
    expect(detectPlatformManagedTabtinCli('FOO=1 tabtin desktop click'))
      .toEqual({ surface: 'desktop' })
  })

  it('rejects non-platform or unsafe shell composition', () => {
    expect(detectPlatformManagedTabtinCli('tabtin table list')).toBeNull()
    expect(detectPlatformManagedTabtinCli('ls -la')).toBeNull()
    expect(detectPlatformManagedTabtinCli('tabtin browser eval | rm -rf /')).toBeNull()
  })
})

describe('judge platform gate deferral ', () => {
  it('defers workspace_out ask for tabtin browser shell to platform gate', () => {
    const decision = judge({
      tool: shellTool,
      input: {
        command: 'tabtin browser eval "document.title"',
        cwd: '/tmp/outside',
      },
      effectivePolicy: makePolicy(),
      memoStore: new NullMemoStore(),
      homeDir: '/Users/demo',
    })
    expect(decision).toEqual({
      behavior: 'allow',
      reason: { type: 'platform_gate_deferred', surface: 'browser' },
    })
  })

  it('still asks for ordinary shell outside workspace', () => {
    const decision = judge({
      tool: shellTool,
      input: {
        command: 'ls -la',
        cwd: '/tmp/outside',
      },
      effectivePolicy: makePolicy(),
      memoStore: new NullMemoStore(),
      homeDir: '/Users/demo',
    })
    expect(decision.behavior).toBe('ask')
    expect(decision.reason.type).toBe('workspace_out')
  })

  it('does not defer sensitive_in_ask for platform CLI touching workspace .env', () => {
    const decision = judge({
      tool: shellTool,
      input: {
        command: 'tabtin browser eval /Users/demo/ws/.env',
        cwd: '/Users/demo/ws',
      },
      effectivePolicy: makePolicy(),
      memoStore: new NullMemoStore(),
      homeDir: '/Users/demo',
    })
    expect(decision.behavior).toBe('ask')
    expect(decision.reason.type).toBe('sensitive_in_ask')
  })

  it('does not defer sensitive_out_deny for platform CLI writing outside .ssh', () => {
    const decision = judge({
      tool: shellTool,
      input: {
        command: 'tabtin browser eval /Users/demo/.ssh/id_rsa',
        cwd: '/Users/demo/ws',
      },
      effectivePolicy: makePolicy(),
      memoStore: new NullMemoStore(),
      homeDir: '/Users/demo',
    })
    expect(decision.behavior).toBe('deny')
    expect(decision.reason.type).toBe('sensitive_out_deny')
  })
})
