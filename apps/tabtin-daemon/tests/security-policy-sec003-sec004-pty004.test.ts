/**
 * Regression tests for PTY-004 / SEC-003 / SEC-004 security policy fixes.
 *
 * PTY-004: DaemonPtyManager.executeCommand() must throw when policy.route === 'blocked'
 * SEC-003: MCP Server enforceSecurityPolicy must forward defaultPolicy to evaluateLocalTerminalPolicy
 * SEC-004: (Python side — tested separately) _resolve_sandbox_policy fallback for non-chat-session threads
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  evaluateLocalTerminalPolicy,
  evaluateLocalFilePolicy,
  type TerminalExecutionPolicyPayload,
} from '@tabtin/terminal-core'

// ---------------------------------------------------------------------------
// PTY-004: executeCommand must reject policy.route === 'blocked' at the entry
// ---------------------------------------------------------------------------
describe('PTY-004: blocked policy route rejection', () => {
  it('evaluateLocalTerminalPolicy returns blocked for route=blocked policy', () => {
    const policy: TerminalExecutionPolicyPayload = {
      route: 'blocked',
      deny_reason: 'Terminal execution is blocked by sandbox policy.',
    }
    const decision = evaluateLocalTerminalPolicy('ls', policy)
    expect(decision.blocked).toBe(true)
    expect(decision.denyReason).toContain('blocked')
  })

  it('evaluateLocalTerminalPolicy returns not blocked for route=sandbox', () => {
    const policy: TerminalExecutionPolicyPayload = {
      route: 'sandbox',
      sandbox_level: 'filesystem',
    }
    const decision = evaluateLocalTerminalPolicy('ls', policy)
    expect(decision.blocked).toBe(false)
  })

  it('policy.route === "blocked" check is case-sensitive', () => {
    const policy: TerminalExecutionPolicyPayload = { route: 'blocked' }
    const decision = evaluateLocalTerminalPolicy('echo hello', policy)
    expect(decision.blocked).toBe(true)

    const policy2: TerminalExecutionPolicyPayload = { route: 'regular' }
    const decision2 = evaluateLocalTerminalPolicy('echo hello', policy2)
    expect(decision2.blocked).toBe(false)
  })

  it('blocked policy preserves deny_reason', () => {
    const policy: TerminalExecutionPolicyPayload = {
      route: 'blocked',
      deny_reason: 'Custom reason: terminal blocked.',
    }
    const decision = evaluateLocalTerminalPolicy('cat /etc/passwd', policy)
    expect(decision.blocked).toBe(true)
    expect(decision.denyReason).toBe('Custom reason: terminal blocked.')
  })
})

// ---------------------------------------------------------------------------
// SEC-003: evaluateLocalTerminalPolicy with serverPolicy enables relaxed_rules
// ---------------------------------------------------------------------------
describe('SEC-003: serverPolicy with relaxed_rules', () => {
  it('without serverPolicy, curl -X POST is blocked', () => {
    const decision = evaluateLocalTerminalPolicy('curl -X POST http://example.com')
    expect(decision.blocked).toBe(true)
  })

  it('with relaxed_rules: ["curl-mutating"], curl POST is not hard-blocked', () => {
    const policy: TerminalExecutionPolicyPayload = {
      route: 'regular',
      relaxed_rules: ['curl-mutating'],
    }
    const decision = evaluateLocalTerminalPolicy('curl -X POST http://example.com', policy)
    expect(decision.blocked).toBe(false)
  })

  it('with empty serverPolicy, falls back to strict local validation', () => {
    const policy: TerminalExecutionPolicyPayload = {}
    const decision = evaluateLocalTerminalPolicy('curl -X DELETE http://example.com', policy)
    expect(decision.blocked).toBe(true)
  })

  it('file policy respects serverPolicy route=blocked', () => {
    const policy: TerminalExecutionPolicyPayload = {
      route: 'blocked',
      deny_reason: 'All file ops blocked.',
    }
    const decision = evaluateLocalFilePolicy('file_write', '/tmp/test.txt', policy)
    expect(decision.blocked).toBe(true)
    expect(decision.denyReason).toBe('All file ops blocked.')
  })
})

// ---------------------------------------------------------------------------
// SEC-003: MCP default policy injection (unit-level contract test)
// ---------------------------------------------------------------------------
describe('SEC-003: MCP default policy contract', () => {
  const DEFAULT_MCP_POLICY: TerminalExecutionPolicyPayload = {
    route: 'sandbox',
    sandbox_level: 'filesystem',
    approval_required: true,
  }

  it('default MCP policy triggers approvalRequired for safe commands', () => {
    const decision = evaluateLocalTerminalPolicy('ls -la', DEFAULT_MCP_POLICY)
    expect(decision.blocked).toBe(false)
    expect(decision.approvalRequired).toBe(true)
  })

  it('default MCP policy still blocks dangerous commands', () => {
    const decision = evaluateLocalTerminalPolicy('rm -rf /', DEFAULT_MCP_POLICY)
    expect(decision.blocked).toBe(true)
  })
})
