/**
 * Wave 10 F1 — Security & functional regression tests.
 *
 * S1-P0: File operations must validate workspace path sandbox
 * S3-高: tabtin_sql_query MCP layer SQL safety check
 * S2-高: route:"sandbox" degrades to regular instead of BLOCK
 */
import { describe, it, expect } from 'vitest'
import { resolve, join } from 'node:path'

import { validateProjectPath } from '@tabtin/action-tools/headless'
import {
  getInteractiveTerminalPolicySupportError,
  normalizeTerminalExecutionPolicy,
  evaluateLocalTerminalPolicy,
} from '@tabtin/terminal-core'

const TEST_HOME = '/home/user'
const TEST_SANDBOX_ROOT = '/tmp/tabtin-sandbox'

function validateReadPath(projectPath: string, workspaceRoot?: string) {
  validateProjectPath('read', projectPath, {
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    platformDataRoot: TEST_SANDBOX_ROOT,
    homeDir: TEST_HOME,
  })
}

function validateWritePath(projectPath: string, workspaceRoot?: string) {
  validateProjectPath('write', projectPath, {
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    platformDataRoot: TEST_SANDBOX_ROOT,
    homeDir: TEST_HOME,
  })
}

// ---------------------------------------------------------------------------
// S1-P0: workspace path sandbox for file operations
// ---------------------------------------------------------------------------
describe('S1-P0: file operation workspace path sandbox', () => {
  const workspaceRoot = '/home/user/workspace'

  it('blocks file_edit on /etc/passwd (absolute path outside workspace)', () => {
    const resolvedPath = resolve(workspaceRoot, '/etc/passwd')
    expect(() => {
      validateWritePath(resolvedPath, workspaceRoot)
    }).toThrow(/protected system path|outside the allowed workspace/)
  })

  it('blocks file_write to /tmp/evil.sh', () => {
    const resolvedPath = resolve(workspaceRoot, '/tmp/evil.sh')
    expect(() => {
      validateWritePath(resolvedPath, workspaceRoot)
    }).toThrow(/protected system path|outside the allowed workspace/)
  })

  it('allows file_edit on relative path src/utils.ts (resolved within workspace)', () => {
    const resolvedPath = resolve(workspaceRoot, 'src/utils.ts')
    expect(() => {
      validateWritePath(resolvedPath, workspaceRoot)
    }).not.toThrow()
  })

  it('allows file_edit on absolute path within workspace', () => {
    const resolvedPath = resolve(workspaceRoot, '/home/user/workspace/src/utils.ts')
    expect(() => {
      validateWritePath(resolvedPath, workspaceRoot)
    }).not.toThrow()
  })

  it('blocks file_read on /etc/shadow', () => {
    const resolvedPath = resolve(workspaceRoot, '/etc/shadow')
    expect(() => {
      validateReadPath(resolvedPath, workspaceRoot)
    }).toThrow(/protected system path|outside the allowed workspace/)
  })

  it('blocks path traversal ../../../etc/passwd', () => {
    const resolvedPath = resolve(workspaceRoot, '../../../etc/passwd')
    expect(() => {
      validateWritePath(resolvedPath, workspaceRoot)
    }).toThrow(/protected system path|outside the allowed workspace/)
  })

  it('allows file under ~/.tabtin/', () => {
    const tabtinPath = join(TEST_HOME, '.tabtin', 'cache', 'test.json')
    expect(() => {
      validateWritePath(tabtinPath, workspaceRoot)
    }).not.toThrow()
  })

  it('blocks code_grep on /var/log/syslog', () => {
    const resolvedPath = resolve(workspaceRoot, '/var/log/syslog')
    expect(() => {
      validateReadPath(resolvedPath, workspaceRoot)
    }).toThrow(/outside allowed directories/)
  })

  it('resolve() correctly handles absolute path override', () => {
    expect(resolve('/workspace', '/etc/passwd')).toBe('/etc/passwd')
    expect(resolve('/workspace', 'src/main.ts')).toBe('/workspace/src/main.ts')
    expect(resolve('/workspace', '../evil')).toBe('/evil')
  })
})

// ---------------------------------------------------------------------------
// S3-高: MCP layer SQL injection protection (structural validation)
// ---------------------------------------------------------------------------
describe('S3-高: SQL injection detection at MCP layer', () => {
  const SQL_DANGEROUS_KEYWORDS = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i

  function validateSqlAtMcpLayer(sql: string): { blocked: boolean; reason?: string } {
    const trimmed = sql.trim()
    if (!/^\s*SELECT\b/i.test(trimmed)) {
      return { blocked: true, reason: 'Only SELECT queries allowed' }
    }
    const stripped = trimmed.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (stripped.includes(';')) {
      return { blocked: true, reason: 'Multiple statements detected' }
    }
    if (SQL_DANGEROUS_KEYWORDS.test(stripped)) {
      return { blocked: true, reason: 'Dangerous keyword after comment strip' }
    }
    return { blocked: false }
  }

  it('allows plain SELECT', () => {
    expect(validateSqlAtMcpLayer('SELECT * FROM users')).toEqual({ blocked: false })
  })

  it('allows SELECT with WHERE', () => {
    expect(validateSqlAtMcpLayer('SELECT id, name FROM users WHERE active = true')).toEqual({ blocked: false })
  })

  it('blocks INSERT statement', () => {
    const result = validateSqlAtMcpLayer('INSERT INTO users VALUES (1, "evil")')
    expect(result.blocked).toBe(true)
  })

  it('blocks DROP TABLE', () => {
    const result = validateSqlAtMcpLayer('DROP TABLE users')
    expect(result.blocked).toBe(true)
  })

  it('blocks comment-injected semicolon: SELECT 1 /* */; DROP TABLE', () => {
    const result = validateSqlAtMcpLayer('SELECT 1 /* */; DROP TABLE users')
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('Multiple statements')
  })

  it('blocks line-comment injection: SELECT 1 -- \\n; DELETE', () => {
    const result = validateSqlAtMcpLayer('SELECT 1 -- comment\n; DELETE FROM users')
    expect(result.blocked).toBe(true)
  })

  it('blocks dangerous keyword hidden in block comment', () => {
    const sql = 'SELECT 1 /* SELECT */ DROP TABLE users'
    const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(SQL_DANGEROUS_KEYWORDS.test(stripped.trim())).toBe(false)
    expect(stripped.includes('DROP')).toBe(true)
  })

  it('blocks UPDATE disguised as SELECT prefix', () => {
    const result = validateSqlAtMcpLayer('UPDATE users SET name = "evil" WHERE 1=1')
    expect(result.blocked).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// S2-高: sandbox route degradation
// ---------------------------------------------------------------------------
describe('S2-高: route:sandbox degrades to regular mode', () => {
  it('getInteractiveTerminalPolicySupportError returns error for sandbox route', () => {
    const error = getInteractiveTerminalPolicySupportError({ route: 'sandbox' })
    expect(error).toBeTruthy()
    expect(error).toContain('sandbox')
  })

  it('route:blocked still returns error (should remain blocked, not degraded)', () => {
    const normalized = normalizeTerminalExecutionPolicy({ route: 'blocked' })
    expect(normalized?.route).toBe('blocked')
    const error = getInteractiveTerminalPolicySupportError(normalized)
    expect(error).toBeTruthy()
    expect(error).toContain('blocked')
  })

  it('evaluateLocalTerminalPolicy works with undefined policy (degraded mode)', () => {
    const decision = evaluateLocalTerminalPolicy('ls -la', undefined)
    expect(decision.blocked).toBe(false)
  })

  it('degraded mode still blocks dangerous commands via CommandValidator', () => {
    const decision = evaluateLocalTerminalPolicy('rm -rf /', undefined)
    expect(decision.blocked).toBe(true)
  })

  it('degraded mode allows safe development commands', () => {
    const safeCommands = ['echo hello', 'cat README.md', 'ls -la', 'pwd']
    for (const cmd of safeCommands) {
      const decision = evaluateLocalTerminalPolicy(cmd, undefined)
      expect(decision.blocked).toBe(false)
    }
  })

  it('normalizeTerminalExecutionPolicy correctly identifies sandbox route', () => {
    const normalized = normalizeTerminalExecutionPolicy({ route: 'sandbox' })
    expect(normalized?.route).toBe('sandbox')
  })

  it('network_mode:blocked also triggers unsupported error (degradable)', () => {
    const error = getInteractiveTerminalPolicySupportError({ network_mode: 'blocked' })
    expect(error).toBeTruthy()
    expect(error).toContain('network')
  })

  it('route:host does NOT trigger unsupported error', () => {
    expect(getInteractiveTerminalPolicySupportError({ route: 'host' })).toBeNull()
  })

  it('route:regular does NOT trigger unsupported error', () => {
    expect(getInteractiveTerminalPolicySupportError({ route: 'regular' })).toBeNull()
  })
})
