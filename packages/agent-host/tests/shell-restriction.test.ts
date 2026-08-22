/**
 * 受限 shell / 不可信输出的 TabTin 业务判定测试。
 *
 * 这些断言从 agent-runtime 的 tool-output-sanitizer / restricted-shell-allowlist
 * 测试迁来——判定逻辑随源码迁到宿主，覆盖也随之落在这里。
 */
import { describe, it, expect } from 'vitest'
import {
  isUntrustedShellCommand,
  RESTRICTED_READONLY_VERBS,
  RESTRICTED_BROWSER_NAV_ALLOWLIST,
} from '../src/capabilities/shell-restriction.js'

describe('FR-09 /  — isUntrustedShellCommand', () => {
  it('matches tabtin fetch and tabtin browser subcommands', () => {
    expect(isUntrustedShellCommand('tabtin fetch https://example.com')).toBe(true)
    expect(isUntrustedShellCommand('tabtin browser markdown --tab-id t1')).toBe(true)
    expect(isUntrustedShellCommand('tabtin browser extract --url https://x')).toBe(true)
    expect(isUntrustedShellCommand('tabtin browser tab list --format json')).toBe(true)
  })

  it('matches pipeline / cd / env prefixes conservatively', () => {
    expect(isUntrustedShellCommand('tabtin fetch https://x.com | jq .')).toBe(true)
    expect(isUntrustedShellCommand('cd /tmp && tabtin fetch https://x.com')).toBe(true)
    expect(isUntrustedShellCommand('FOO=bar tabtin fetch https://x.com')).toBe(true)
  })

  it('does not match unrelated shell commands or bare mentions', () => {
    expect(isUntrustedShellCommand('ls -la')).toBe(false)
    expect(isUntrustedShellCommand('curl -sf https://example.com')).toBe(false)
    expect(isUntrustedShellCommand('tabtin doc list --format json')).toBe(false)
    expect(isUntrustedShellCommand('echo tabtin fetch https://example.com')).toBe(false)
  })
})

describe('restricted readonly verb table (host-injected)', () => {
  it('contains generic read verbs and TabTin CLI readonly subcommands', () => {
    for (const verb of ['list', 'get', 'read', 'query', 'records', 'glance', 'print']) {
      expect(RESTRICTED_READONLY_VERBS.has(verb)).toBe(true)
    }
  })

  it('does not contain write verbs (e.g. eval)', () => {
    expect(RESTRICTED_READONLY_VERBS.has('eval')).toBe(false)
  })
})

describe('Restricted-mode browser nav allowlist (host-injected)', () => {
  it('only allows navigation subcommands', () => {
    expect(RESTRICTED_BROWSER_NAV_ALLOWLIST.has('open')).toBe(true)
    expect(RESTRICTED_BROWSER_NAV_ALLOWLIST.has('nav')).toBe(true)
    expect(RESTRICTED_BROWSER_NAV_ALLOWLIST.has('tab switch')).toBe(true)
    expect(RESTRICTED_BROWSER_NAV_ALLOWLIST.has('eval')).toBe(false)
  })
})
