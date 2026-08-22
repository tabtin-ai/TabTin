/**
 * TDS-004 / TDS-006 / TDS-007 regression tests
 *
 * TDS-007: OS sandbox degraded → sandboxRestricted must NOT be set
 * TDS-006: resolveRelaxedRules returns unknowns for upstream reporting
 * TDS-004: OS sandbox degradation produces structured warnings in ExecuteResult
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveRelaxedRules } from '../src/allowlist'

// Mock platform sandbox — control isAvailable() per test
const mockIsAvailable = vi.fn().mockResolvedValue(false)
const mockBuildSpawnArgs = vi.fn()
vi.mock('../src/platform', () => ({
  createPlatformSandbox: vi.fn(() => ({
    platform: 'linux',
    isAvailable: mockIsAvailable,
    buildSpawnArgs: mockBuildSpawnArgs,
  })),
}))

// Mock SandboxManager as a class constructor
vi.mock('../src/sandboxManager', () => {
  class MockSandboxManager {
    async ensureSandbox() {
      return {
        sandboxDir: '/tmp/test-sandbox',
        projectDir: '/tmp',
        tmpDir: '/tmp/test-sandbox-tmp',
      }
    }
  }
  return {
    SandboxManager: MockSandboxManager,
    isSymlinkWithinRoot: vi.fn().mockReturnValue(true),
  }
})

// ---------------------------------------------------------------------------
// TDS-007: sandboxRestricted should not fire when OS sandbox is degraded
// ---------------------------------------------------------------------------
describe('TDS-007: isSandboxRestrictionError skipped when OS sandbox degraded', () => {
  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(false)
  })

  it('degraded sandbox does not mark sandboxRestricted even with permission denied in stderr', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor')

    const executor = new CommandExecutor({
      workspaceRoot: '/tmp',
      sandboxRoot: '/tmp/tds007-sandbox',
    })

    const result = await executor.execute({
      command: 'echo "permission denied" >&2 && exit 1',
      mode: 'sandbox',
      sandboxLevel: 'filesystem',
      timeoutMs: 5000,
      threadId: 'tds007-test',
    })

    expect(result.osSandboxDegraded).toBe(true)
    expect(result.osSandbox).toBe(false)
    expect(result.sandboxRestricted).toBeUndefined()
  })

  it('degraded sandbox does not mark sandboxRestricted for network errors', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor')

    const executor = new CommandExecutor({
      workspaceRoot: '/tmp',
      sandboxRoot: '/tmp/tds007-sandbox-net',
    })

    const result = await executor.execute({
      command: 'echo "network is unreachable" >&2 && exit 1',
      mode: 'sandbox',
      sandboxLevel: 'complete',
      timeoutMs: 5000,
      threadId: 'tds007-net',
    })

    expect(result.osSandboxDegraded).toBe(true)
    expect(result.sandboxRestricted).toBeUndefined()
  })
})

describe('TDS-007: sandboxRestricted fires when OS sandbox is active', () => {
  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true)
    mockBuildSpawnArgs.mockImplementation(({ command, cwd, env }: any) => ({
      file: '/bin/sh',
      args: ['-c', command],
      options: { cwd, shell: false, env },
    }))
  })

  it('active OS sandbox marks sandboxRestricted for permission denied', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor')

    const executor = new CommandExecutor({
      workspaceRoot: '/tmp',
      sandboxRoot: '/tmp/tds007-active-sandbox',
    })

    const result = await executor.execute({
      command: 'echo "permission denied" >&2 && exit 1',
      mode: 'sandbox',
      sandboxLevel: 'filesystem',
      timeoutMs: 5000,
      threadId: 'tds007-active',
    })

    expect(result.osSandbox).toBe(true)
    expect(result.osSandboxDegraded).toBe(false)
    expect(result.sandboxRestricted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// TDS-006: resolveRelaxedRules returns unknowns for upstream reporting
// ---------------------------------------------------------------------------
describe('TDS-006: resolveRelaxedRules exposes unknowns', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    warnSpy.mockClear()
  })

  it('returns unknowns array alongside resolved rules', () => {
    const { rules, unknowns } = resolveRelaxedRules(['curl-mutating', 'nonexistent-rule'])
    expect(rules.length).toBeGreaterThan(0)
    expect(unknowns).toEqual(['nonexistent-rule'])
  })

  it('all unknowns produces empty rules and full unknowns list', () => {
    const { rules, unknowns } = resolveRelaxedRules(['alpha', 'beta'])
    expect(rules).toEqual([])
    expect(unknowns).toEqual(['alpha', 'beta'])
  })

  it('no unknowns when all rules are known', () => {
    const { rules, unknowns } = resolveRelaxedRules(['curl-mutating'])
    expect(rules.length).toBeGreaterThan(0)
    expect(unknowns).toEqual([])
  })

  it('empty input produces empty output', () => {
    const { rules, unknowns } = resolveRelaxedRules([])
    expect(rules).toEqual([])
    expect(unknowns).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TDS-004: OS sandbox degradation produces warnings in ExecuteResult
// ---------------------------------------------------------------------------
describe('TDS-004: sandbox degradation generates structured warnings', () => {
  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(false)
  })

  it('degraded execution includes degradation warning in result', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor')

    const executor = new CommandExecutor({
      workspaceRoot: '/tmp',
      sandboxRoot: '/tmp/tds004-sandbox',
    })

    const result = await executor.execute({
      command: 'echo hello',
      mode: 'sandbox',
      sandboxLevel: 'filesystem',
      timeoutMs: 5000,
      threadId: 'tds004-test',
    })

    expect(result.osSandboxDegraded).toBe(true)
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings!.some(w => w.toLowerCase().includes('sandbox degraded'))).toBe(true)
    expect(result.warnings!.some(w => w.includes('without OS-level sandbox protection'))).toBe(true)
  })

  it('non-sandbox mode has no degradation warning', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor')

    const executor = new CommandExecutor({
      workspaceRoot: '/tmp',
    })

    const result = await executor.execute({
      command: 'echo hello',
      mode: 'regular',
      timeoutMs: 5000,
    })

    const hasDegradationWarning = result.warnings?.some(
      w => w.toLowerCase().includes('sandbox degraded'),
    )
    expect(hasDegradationWarning).toBeFalsy()
  })

  it('unknown relaxed rules produce warning in result', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CommandExecutor } = await import('../src/commandExecutor')
    const executor = new CommandExecutor({
      workspaceRoot: '/tmp',
    })

    const result = await executor.execute({
      command: 'echo test',
      mode: 'regular',
      timeoutMs: 5000,
      policyOverrides: {
        relaxedRules: ['nonexistent-rule-xyz'],
      },
    })

    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some(w => w.includes('nonexistent-rule-xyz'))).toBe(true)
    expect(result.warnings!.some(w => w.includes('Unknown relaxed_rules ignored'))).toBe(true)
    warnSpy.mockRestore()
  })
})
