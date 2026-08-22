import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sanitizeEnv,
  SENSITIVE_ENV_VARS,
  SENSITIVE_PATTERNS,
  SAFE_ALLOWLIST,
  isSensitiveByPattern,
} from '../utils/sanitize-env'

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    accessSync: vi.fn(actual.accessSync),
  }
})

import * as fs from 'fs'
import { resolveShell, isValidShell } from '../utils/resolve-shell'

// ─── sanitizeEnv tests ──────────────────────────────────────────

describe('PC-7: sanitizeEnv filters sensitive environment variables', () => {
  it('should filter exact-match TabTin internal variables', () => {
    const env = {
      PATH: '/usr/bin',
      TABTIN_TOKEN: 'secret-token',
      TABTIN_JWT: 'secret-jwt',
      HOME: '/home/user',
    }
    const result = sanitizeEnv(env)
    expect(result).not.toHaveProperty('TABTIN_TOKEN')
    expect(result).not.toHaveProperty('TABTIN_JWT')
    expect(result).toHaveProperty('PATH', '/usr/bin')
    expect(result).toHaveProperty('HOME', '/home/user')
  })

  it('should filter common cloud provider keys', () => {
    const env = {
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_SESSION_TOKEN: 'aws-token',
      OPENAI_API_KEY: 'sk-xxx',
      ANTHROPIC_API_KEY: 'ak-xxx',
      PATH: '/usr/bin',
    }
    const result = sanitizeEnv(env)
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(result).not.toHaveProperty('AWS_SESSION_TOKEN')
    expect(result).not.toHaveProperty('OPENAI_API_KEY')
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(result).toHaveProperty('PATH')
  })

  it('should filter database credentials', () => {
    const env = {
      DATABASE_URL: 'postgres://user:pass@host/db',
      DATABASE_PASSWORD: 'dbpass',
      PGPASSWORD: 'pgpass',
      MYSQL_PWD: 'mysqlpass',
      REDIS_PASSWORD: 'redispass',
    }
    const result = sanitizeEnv(env)
    expect(result).not.toHaveProperty('DATABASE_URL')
    expect(result).not.toHaveProperty('DATABASE_PASSWORD')
    expect(result).not.toHaveProperty('PGPASSWORD')
    expect(result).not.toHaveProperty('MYSQL_PWD')
    expect(result).not.toHaveProperty('REDIS_PASSWORD')
  })

  it('should filter variables matching sensitive patterns (case-insensitive)', () => {
    const env = {
      MY_CUSTOM_SECRET: 'secret-value',
      APP_API_KEY: 'key-value',
      SOME_AUTH_TOKEN: 'token-value',
      DB_PASSWORD: 'pass-value',
      SERVICE_CREDENTIAL: 'cred-value',
      MY_PRIVATE_KEY: 'private-value',
    }
    const result = sanitizeEnv(env)
    expect(result).not.toHaveProperty('MY_CUSTOM_SECRET')
    expect(result).not.toHaveProperty('APP_API_KEY')
    expect(result).not.toHaveProperty('SOME_AUTH_TOKEN')
    expect(result).not.toHaveProperty('DB_PASSWORD')
    expect(result).not.toHaveProperty('SERVICE_CREDENTIAL')
    expect(result).not.toHaveProperty('MY_PRIVATE_KEY')
  })

  it('should preserve essential system variables even if they match patterns', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      SHELL: '/bin/bash',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      EDITOR: 'vim',
    }
    const result = sanitizeEnv(env)
    expect(result).toHaveProperty('PATH')
    expect(result).toHaveProperty('HOME')
    expect(result).toHaveProperty('SHELL')
    expect(result).toHaveProperty('TERM')
    expect(result).toHaveProperty('LANG')
    expect(result).toHaveProperty('SSH_AUTH_SOCK')
    expect(result).toHaveProperty('EDITOR')
  })

  it('should skip undefined values', () => {
    const env: NodeJS.ProcessEnv = {
      DEFINED: 'value',
      UNDEF: undefined,
    }
    const result = sanitizeEnv(env)
    expect(result).toHaveProperty('DEFINED', 'value')
    expect(result).not.toHaveProperty('UNDEF')
  })

  it('should allow non-sensitive custom variables through', () => {
    const env = {
      NODE_ENV: 'development',
      DEBUG: 'true',
      RUST_LOG: 'info',
      MY_APP_PORT: '3000',
    }
    const result = sanitizeEnv(env)
    expect(result).toHaveProperty('NODE_ENV')
    expect(result).toHaveProperty('DEBUG')
    expect(result).toHaveProperty('RUST_LOG')
    expect(result).toHaveProperty('MY_APP_PORT')
  })

  it('should filter pattern-matched vars with different casing', () => {
    const env = {
      my_secret: 'lowercase',
      My_Api_Key: 'mixed-case',
      SOME_TOKEN: 'uppercase',
    }
    const result = sanitizeEnv(env)
    expect(result).not.toHaveProperty('my_secret')
    expect(result).not.toHaveProperty('My_Api_Key')
    expect(result).not.toHaveProperty('SOME_TOKEN')
  })
})

describe('isSensitiveByPattern', () => {
  it('should detect _SECRET suffix', () => {
    expect(isSensitiveByPattern('MY_SECRET')).toBe(true)
    expect(isSensitiveByPattern('app_secret')).toBe(true)
  })

  it('should detect _KEY suffix', () => {
    expect(isSensitiveByPattern('API_KEY')).toBe(true)
    expect(isSensitiveByPattern('ENCRYPTION_KEY')).toBe(true)
  })

  it('should detect _TOKEN suffix', () => {
    expect(isSensitiveByPattern('AUTH_TOKEN')).toBe(true)
    expect(isSensitiveByPattern('ACCESS_TOKEN')).toBe(true)
  })

  it('should detect _PASSWORD suffix', () => {
    expect(isSensitiveByPattern('DB_PASSWORD')).toBe(true)
  })

  it('should NOT flag non-sensitive names', () => {
    expect(isSensitiveByPattern('NODE_ENV')).toBe(false)
    expect(isSensitiveByPattern('PATH')).toBe(false)
    expect(isSensitiveByPattern('HOME')).toBe(false)
    expect(isSensitiveByPattern('DEBUG')).toBe(false)
  })
})

// ─── resolveShell tests ─────────────────────────────────────────

describe('PC-6: resolveShell validates $SHELL executable safety', () => {
  const originalEnv = process.env
  const originalPlatform = process.platform

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.restoreAllMocks()
  })

  it('should reject $SHELL pointing to a non-existent path', () => {
    process.env.SHELL = '/nonexistent/path/bash'
    const result = resolveShell()
    expect(result).not.toBe('/nonexistent/path/bash')
  })

  it('should reject $SHELL pointing to a malicious binary outside safe dirs', () => {
    process.env.SHELL = '/tmp/malicious-binary'
    // Even if the file exists, it's not in a safe dir
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === '/tmp/malicious-binary') return true
      if (p === '/bin/bash') return true
      if (p === '/bin/sh') return true
      return false
    })
    vi.mocked(fs.accessSync).mockImplementation(() => {
      // All files are "executable"
    })
    const result = resolveShell()
    expect(result).not.toBe('/tmp/malicious-binary')
  })

  it('should reject $SHELL with relative path', () => {
    process.env.SHELL = 'bash'
    const result = resolveShell()
    expect(result).not.toBe('bash')
  })

  it('should reject $SHELL pointing to non-shell executable in safe dir', () => {
    process.env.SHELL = '/usr/bin/python3'
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === '/usr/bin/python3') return true
      if (p === '/bin/bash') return true
      return false
    })
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    const result = resolveShell()
    expect(result).not.toBe('/usr/bin/python3')
  })

  it('should accept $SHELL pointing to valid bash in safe dir', () => {
    process.env.SHELL = '/bin/bash'
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    const result = resolveShell()
    expect(result).toBe('/bin/bash')
  })

  it('should accept $SHELL pointing to zsh in /usr/bin', () => {
    process.env.SHELL = '/usr/bin/zsh'
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    const result = resolveShell()
    expect(result).toBe('/usr/bin/zsh')
  })

  it('should accept fish in /usr/local/bin', () => {
    process.env.SHELL = '/usr/local/bin/fish'
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    const result = resolveShell()
    expect(result).toBe('/usr/local/bin/fish')
  })

  it('should fallback to /bin/bash when $SHELL is invalid', () => {
    process.env.SHELL = '/tmp/evil'
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === '/tmp/evil') return true
      if (p === '/bin/bash') return true
      return false
    })
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    const result = resolveShell()
    expect(result).toBe('/bin/bash')
  })

  it('should fallback through candidates when $SHELL and /bin/bash are invalid', () => {
    process.env.SHELL = '/tmp/evil'
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === '/bin/bash') return false
      if (p === '/bin/zsh') return true
      if (p === '/bin/sh') return true
      return false
    })
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    const result = resolveShell()
    expect(result).toBe('/bin/zsh')
  })

  it('should reject $SHELL with path traversal (../)', () => {
    process.env.SHELL = '/bin/../tmp/malicious'
    const result = resolveShell()
    // pathResolve would resolve this to /tmp/malicious which is not in safe dirs
    expect(result).not.toBe('/bin/../tmp/malicious')
    expect(result).not.toBe('/tmp/malicious')
  })
})

describe('isValidShell', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should reject relative paths', () => {
    expect(isValidShell('bash')).toBe(false)
    expect(isValidShell('./bash')).toBe(false)
  })

  it('should reject paths outside safe directories', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    expect(isValidShell('/tmp/bash')).toBe(false)
    expect(isValidShell('/home/user/bash')).toBe(false)
  })

  it('should reject unrecognized shell names', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    expect(isValidShell('/bin/python3')).toBe(false)
    expect(isValidShell('/usr/bin/node')).toBe(false)
    expect(isValidShell('/bin/cat')).toBe(false)
  })

  it('should accept valid shells in safe directories', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.accessSync).mockImplementation(() => {})
    expect(isValidShell('/bin/bash')).toBe(true)
    expect(isValidShell('/usr/bin/zsh')).toBe(true)
    expect(isValidShell('/usr/local/bin/fish')).toBe(true)
    expect(isValidShell('/bin/sh')).toBe(true)
    expect(isValidShell('/bin/dash')).toBe(true)
  })

  it('should reject non-executable files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(isValidShell('/bin/bash')).toBe(false)
  })

  it('should reject non-existent files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    expect(isValidShell('/bin/bash')).toBe(false)
  })
})
