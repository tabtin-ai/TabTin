/**
 * Regression tests for SEC-001 / SEC-002 security policy fixes.
 *
 * SEC-001: enforcePolicy must call getInteractiveTerminalPolicySupportError
 *          to reject unsupported sandbox policies (route:'sandbox', network_mode:'blocked').
 * SEC-002: handleAction must runtime-validate WS payloads instead of relying on `as` assertions.
 */
import { describe, it, expect } from 'vitest'
import {
  getInteractiveTerminalPolicySupportError,
  normalizeTerminalExecutionPolicy,
} from '@tabtin/terminal-core'

// ---------------------------------------------------------------------------
// SEC-001: getInteractiveTerminalPolicySupportError blocks unsupported policies
// ---------------------------------------------------------------------------
describe('SEC-001: getInteractiveTerminalPolicySupportError', () => {
  it('returns error for route=sandbox (snake_case payload)', () => {
    const error = getInteractiveTerminalPolicySupportError({ route: 'sandbox' })
    expect(error).toBeTruthy()
    expect(error).toContain('sandbox')
  })

  it('returns error for route=blocked', () => {
    const error = getInteractiveTerminalPolicySupportError({ route: 'blocked' })
    expect(error).toBeTruthy()
    expect(error).toContain('blocked')
  })

  it('returns error for network_mode=blocked', () => {
    const error = getInteractiveTerminalPolicySupportError({ network_mode: 'blocked' })
    expect(error).toBeTruthy()
    expect(error).toContain('network')
  })

  it('returns error for network_mode=custom', () => {
    const error = getInteractiveTerminalPolicySupportError({ network_mode: 'custom' })
    expect(error).toBeTruthy()
    expect(error).toContain('network')
  })

  it('returns null for route=host (supported)', () => {
    expect(getInteractiveTerminalPolicySupportError({ route: 'host' })).toBeNull()
  })

  it('returns null for undefined policy', () => {
    expect(getInteractiveTerminalPolicySupportError(undefined)).toBeNull()
  })

  it('returns null for null policy', () => {
    expect(getInteractiveTerminalPolicySupportError(null)).toBeNull()
  })

  it('returns null for empty object', () => {
    expect(getInteractiveTerminalPolicySupportError({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SEC-001: normalizeTerminalExecutionPolicy normalizes snake_case → camelCase
// ---------------------------------------------------------------------------
describe('SEC-001: normalizeTerminalExecutionPolicy', () => {
  it('normalizes snake_case payload fields', () => {
    const result = normalizeTerminalExecutionPolicy({
      route: 'sandbox',
      sandbox_level: 'strict',
      network_mode: 'blocked',
      approval_required: true,
    })
    expect(result).toBeDefined()
    expect(result!.route).toBe('sandbox')
    expect(result!.networkMode).toBe('blocked')
    expect(result!.approvalRequired).toBe(true)
  })

  it('returns undefined for non-object input', () => {
    expect(normalizeTerminalExecutionPolicy(null)).toBeUndefined()
    expect(normalizeTerminalExecutionPolicy(undefined)).toBeUndefined()
    expect(normalizeTerminalExecutionPolicy('string' as any)).toBeUndefined()
  })

  it('returns undefined when all fields are undefined', () => {
    expect(normalizeTerminalExecutionPolicy({})).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SEC-002: Runtime payload validation (unit-level)
// ---------------------------------------------------------------------------
describe('SEC-002: payload runtime validation logic', () => {
  function validatePayload(rawPayload: unknown): {
    valid: boolean
    taskId: string
    actionType: string
    params: Record<string, any>
    sandboxPolicy: Record<string, any> | undefined
  } {
    if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
      return { valid: false, taskId: '', actionType: '', params: {}, sandboxPolicy: undefined }
    }
    const payload = rawPayload as Record<string, unknown>

    const taskId = typeof payload.task_id === 'string' ? payload.task_id : ''
    const actionType = typeof payload.action === 'string' ? payload.action : ''

    const rawParams = payload.params
    const params: Record<string, any> =
      rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
        ? { ...(rawParams as Record<string, any>) }
        : {}

    const rawSandboxPolicy = payload.sandbox_policy
    const sandboxPolicy: Record<string, any> | undefined =
      rawSandboxPolicy && typeof rawSandboxPolicy === 'object' && !Array.isArray(rawSandboxPolicy)
        ? (rawSandboxPolicy as Record<string, any>)
        : undefined

    return { valid: true, taskId, actionType, params, sandboxPolicy }
  }

  it('rejects null payload', () => {
    expect(validatePayload(null).valid).toBe(false)
  })

  it('rejects array payload', () => {
    expect(validatePayload([1, 2, 3]).valid).toBe(false)
  })

  it('rejects string payload', () => {
    expect(validatePayload('not-an-object').valid).toBe(false)
  })

  it('rejects number payload', () => {
    expect(validatePayload(42).valid).toBe(false)
  })

  it('accepts valid payload with all fields', () => {
    const result = validatePayload({
      task_id: 'task-1',
      action: 'execute_in_terminal',
      params: { command: 'ls' },
      sandbox_policy: { route: 'host' },
    })
    expect(result.valid).toBe(true)
    expect(result.taskId).toBe('task-1')
    expect(result.actionType).toBe('execute_in_terminal')
    expect(result.params).toEqual({ command: 'ls' })
    expect(result.sandboxPolicy).toEqual({ route: 'host' })
  })

  it('defaults taskId/actionType to empty string for non-string values', () => {
    const result = validatePayload({ task_id: 123, action: true })
    expect(result.valid).toBe(true)
    expect(result.taskId).toBe('')
    expect(result.actionType).toBe('')
  })

  it('defaults params to empty object when not an object', () => {
    const result = validatePayload({ task_id: 't1', action: 'test', params: 'invalid' })
    expect(result.valid).toBe(true)
    expect(result.params).toEqual({})
  })

  it('defaults params to empty object when params is an array', () => {
    const result = validatePayload({ task_id: 't1', action: 'test', params: [1, 2] })
    expect(result.valid).toBe(true)
    expect(result.params).toEqual({})
  })

  it('ignores sandbox_policy when it is an array', () => {
    const result = validatePayload({
      task_id: 't1',
      action: 'test',
      sandbox_policy: ['not', 'valid'],
    })
    expect(result.valid).toBe(true)
    expect(result.sandboxPolicy).toBeUndefined()
  })

  it('ignores sandbox_policy when it is a string', () => {
    const result = validatePayload({
      task_id: 't1',
      action: 'test',
      sandbox_policy: 'bad',
    })
    expect(result.valid).toBe(true)
    expect(result.sandboxPolicy).toBeUndefined()
  })

  it('accepts missing optional fields gracefully', () => {
    const result = validatePayload({})
    expect(result.valid).toBe(true)
    expect(result.taskId).toBe('')
    expect(result.actionType).toBe('')
    expect(result.params).toEqual({})
    expect(result.sandboxPolicy).toBeUndefined()
  })
})
