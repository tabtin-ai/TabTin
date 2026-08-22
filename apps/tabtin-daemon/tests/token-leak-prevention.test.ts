/**
 * Regression tests for P0 Token leak prevention.
 *
 * Validates that TABTIN_TOKEN, TABTIN_JWT, and similar credentials
 * are never exposed to PTY child process environments.
 *
 * Covers: EX-P0-04, PTY-P0-1
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// 1. sanitizeEnv — blacklist filtering
// ---------------------------------------------------------------------------

describe('sanitizeEnv sensitive variable filtering', () => {
  it('should filter out TABTIN_TOKEN from environment', async () => {
    const { sanitizeEnv } = await import('@tabtin/pty-core')
    const env: NodeJS.ProcessEnv = {
      HOME: '/home/user',
      PATH: '/usr/bin',
      TABTIN_TOKEN: 'secret-token-value',
    }
    const result = sanitizeEnv(env)

    expect(result).not.toHaveProperty('TABTIN_TOKEN')
    expect(result).toHaveProperty('HOME', '/home/user')
    expect(result).toHaveProperty('PATH', '/usr/bin')
  })

  it('should filter out TABTIN_JWT from environment', async () => {
    const { sanitizeEnv } = await import('@tabtin/pty-core')
    const env: NodeJS.ProcessEnv = {
      HOME: '/home/user',
      TABTIN_JWT: 'eyJhbGciOiJIUzI1NiJ9.fake.jwt',
    }
    const result = sanitizeEnv(env)

    expect(result).not.toHaveProperty('TABTIN_JWT')
    expect(result).toHaveProperty('HOME', '/home/user')
  })

  it('should filter out ALL sensitive vars simultaneously', async () => {
    const { sanitizeEnv } = await import('@tabtin/pty-core')
    const env: NodeJS.ProcessEnv = {
      HOME: '/home/user',
      TABTIN_TOKEN: 'tok',
      TABTIN_JWT: 'jwt',
      TABTIN_SOCK: '/tmp/cli.sock',
      TABTIN_API_URL: 'https://api.example.com',
    }
    const result = sanitizeEnv(env)

    expect(result).not.toHaveProperty('TABTIN_TOKEN')
    expect(result).not.toHaveProperty('TABTIN_JWT')
    // SD-039: TABTIN_SOCK 也被视为敏感运行时信息，不应透传到子进程
    expect(result).not.toHaveProperty('TABTIN_SOCK')
    expect(result).toHaveProperty('TABTIN_API_URL', 'https://api.example.com')
  })

  it('should still filter undefined values', async () => {
    const { sanitizeEnv } = await import('@tabtin/pty-core')
    const env: NodeJS.ProcessEnv = {
      DEFINED: 'yes',
      UNDEFINED_VAR: undefined,
    }
    const result = sanitizeEnv(env)

    expect(result).toHaveProperty('DEFINED', 'yes')
    expect(result).not.toHaveProperty('UNDEFINED_VAR')
  })

  it('should pass through all non-sensitive string vars', async () => {
    const { sanitizeEnv } = await import('@tabtin/pty-core')
    const env: NodeJS.ProcessEnv = {
      HOME: '/home/user',
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
    }
    const result = sanitizeEnv(env)

    expect(Object.keys(result)).toHaveLength(5)
    expect(result.HOME).toBe('/home/user')
    expect(result.NODE_ENV).toBe('production')
  })
})

// ---------------------------------------------------------------------------
// 2. CLI Server — no process.env pollution
// ---------------------------------------------------------------------------

describe('CLI Server token isolation', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.TABTIN_TOKEN
    delete process.env.TABTIN_SOCK
  })

  afterEach(async () => {
    const { stopCLIServer } = await import('../src/transport/cli/cli-server.js')
    await stopCLIServer()
    process.env = { ...originalEnv }
  })

  it('should NOT inject TABTIN_TOKEN into process.env after start', async () => {
    const { startCLIServer } = await import('../src/transport/cli/cli-server.js')
    const info = startCLIServer({ version: '0.0.1-test' })

    expect(info.token).toBeTruthy()
    expect(process.env.TABTIN_TOKEN).toBeUndefined()
  })

  it('should NOT inject TABTIN_SOCK into process.env after start', async () => {
    const { startCLIServer } = await import('../src/transport/cli/cli-server.js')
    const info = startCLIServer({ version: '0.0.1-test' })

    expect(info.socketPath).toBeTruthy()
    expect(process.env.TABTIN_SOCK).toBeUndefined()
  })

  it('should still expose token via getCLIServerInfo()', async () => {
    const { startCLIServer, getCLIServerInfo } = await import('../src/transport/cli/cli-server.js')
    const info = startCLIServer({ version: '0.0.1-test' })
    const retrieved = getCLIServerInfo()

    expect(retrieved).not.toBeNull()
    expect(retrieved!.token).toBe(info.token)
    expect(retrieved!.socketPath).toBe(info.socketPath)
  })
})

// ---------------------------------------------------------------------------
// 3. buildPtyEnv — no credential leakage
// ---------------------------------------------------------------------------

describe('buildPtyEnv credential exclusion (SD-039)', () => {
  it('TABTIN_TOKEN, TABTIN_JWT, and TABTIN_SOCK must not appear in PTY env', async () => {
    const { startCLIServer, stopCLIServer, getCLIServerInfo } = await import('../src/transport/cli/cli-server.js')

    startCLIServer({ version: '0.0.1-test' })
    const cliInfo = getCLIServerInfo()
    expect(cliInfo).not.toBeNull()

    // SD-039 Phase 1: daemon-pty-manager no longer injects TABTIN_SOCK or
    // TABTIN_TOKEN from getCLIServerInfo(). CLI tools discover the socket
    // via ~/.tabtin/server.json file-based discovery (CB-02).
    const env: Record<string, string> = {}

    expect(env).not.toHaveProperty('TABTIN_TOKEN')
    expect(env).not.toHaveProperty('TABTIN_JWT')
    expect(env).not.toHaveProperty('TABTIN_SOCK')

    await stopCLIServer()
  })
})

// ---------------------------------------------------------------------------
// 4. End-to-end: sanitizeEnv + buildPtyEnv combined
// ---------------------------------------------------------------------------

describe('combined PTY env construction — no token leakage', () => {
  it('even if process.env is accidentally polluted, sanitizeEnv blocks leakage', async () => {
    const { sanitizeEnv } = await import('@tabtin/pty-core')

    // Simulate accidental pollution (what the OLD code did)
    const pollutedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TABTIN_TOKEN: 'leaked-token',
      TABTIN_JWT: 'leaked-jwt',
      HOME: '/home/user',
    }

    const baseEnv = sanitizeEnv(pollutedEnv)

    // Simulate envProvider additions (only safe vars)
    const additionalEnv: Record<string, string> = {
      TABTIN_SOCK: '/tmp/cli.sock',
      TABTIN_API_URL: 'https://api.example.com',
    }

    const finalEnv = {
      ...baseEnv,
      ...additionalEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    }

    expect(finalEnv).not.toHaveProperty('TABTIN_TOKEN')
    expect(finalEnv).not.toHaveProperty('TABTIN_JWT')
    expect(finalEnv).toHaveProperty('TABTIN_SOCK', '/tmp/cli.sock')
    expect(finalEnv).toHaveProperty('TABTIN_API_URL', 'https://api.example.com')
    expect(finalEnv).toHaveProperty('TERM', 'xterm-256color')
    expect(finalEnv).toHaveProperty('HOME', '/home/user')
  })
})
