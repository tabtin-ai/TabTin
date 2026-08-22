import { describe, expect, it } from 'vitest'
import {
  evaluateLocalFilePolicy,
  evaluateLocalTerminalPolicy,
  getInteractiveTerminalPolicySupportError,
  normalizeTerminalExecutionPolicy,
} from '@tabtin/terminal-core'

describe('LocalSandboxPolicy', () => {
  it('在 server policy 放宽 relaxed_rules 时允许对应命令通过本地校验', () => {
    const withoutRelaxed = evaluateLocalTerminalPolicy('curl -X POST https://example.com', {
      route: 'regular',
    })
    expect(withoutRelaxed.blocked).toBe(true)

    const withRelaxed = evaluateLocalTerminalPolicy('curl -X POST https://example.com', {
      route: 'regular',
      relaxed_rules: ['curl-mutating'],
    })
    expect(withRelaxed.blocked).toBe(false)
    expect(withRelaxed.approvalRequired).toBe(true)
    // ：relaxed 放行的高危命令属本机安全底线，auto 档不得旁路（仅 full_access）。
    expect(withRelaxed.securityFloor).toBe(true)
  })

  it('#5520：安全底线审批带 securityFloor 标记，普通 confirm 不带', () => {
    // file_delete 固定底线
    const deleteDecision = evaluateLocalFilePolicy('file_delete', '/tmp/whatever.txt')
    expect(deleteDecision.approvalRequired).toBe(true)
    expect(deleteDecision.securityFloor).toBe(true)

    // 敏感文件写入（.env / .ssh）固定底线
    const envWrite = evaluateLocalFilePolicy('file_write', '/repo/.env.production')
    expect(envWrite.approvalRequired).toBe(true)
    expect(envWrite.securityFloor).toBe(true)

    const sshWrite = evaluateLocalFilePolicy('file_edit', '/Users/me/.ssh/config')
    expect(sshWrite.approvalRequired).toBe(true)
    expect(sshWrite.securityFloor).toBe(true)

    // server policy 要求的普通 confirm：approvalRequired 但**不带** securityFloor
    const serverConfirm = evaluateLocalFilePolicy('file_write', '/repo/src/index.ts', {
      route: 'regular',
      approval_required: true,
    })
    expect(serverConfirm.approvalRequired).toBe(true)
    expect(serverConfirm.securityFloor).toBeUndefined()

    const termServerConfirm = evaluateLocalTerminalPolicy('ls -la', {
      route: 'regular',
      approval_required: true,
    })
    expect(termServerConfirm.approvalRequired).toBe(true)
    expect(termServerConfirm.securityFloor).toBeUndefined()
  })

  it('对当前 Electron PTY 无法兑现的 sandbox policy 给出显式错误', () => {
    const sandboxError = getInteractiveTerminalPolicySupportError(
      normalizeTerminalExecutionPolicy({
        route: 'sandbox',
        sandbox_level: 'complete',
      }),
    )
    expect(sandboxError).toContain('does not support sandboxed terminal execution')

    const networkError = getInteractiveTerminalPolicySupportError(
      normalizeTerminalExecutionPolicy({
        route: 'regular',
        network_mode: 'blocked',
      }),
    )
    expect(networkError).toContain('cannot enforce network-restricted terminal policy')
  })
})
