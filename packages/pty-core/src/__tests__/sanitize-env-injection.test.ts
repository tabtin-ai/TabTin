import { describe, it, expect } from 'vitest'
import {
  sanitizeEnv,
  DANGEROUS_INJECTION_VARS,
} from '../utils/sanitize-env'

// ─── P0: shared-library / code injection variable filtering ─────

describe('P0-F1: sanitizeEnv blocks shared-library and runtime injection variables', () => {
  const safeEnv = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
  }

  // ── Linux dynamic linker ──

  it('should block LD_PRELOAD', () => {
    const result = sanitizeEnv({ ...safeEnv, LD_PRELOAD: '/tmp/evil.so' })
    expect(result).not.toHaveProperty('LD_PRELOAD')
    expect(result).toHaveProperty('PATH')
  })

  it('should block LD_LIBRARY_PATH', () => {
    const result = sanitizeEnv({ ...safeEnv, LD_LIBRARY_PATH: '/tmp/libs' })
    expect(result).not.toHaveProperty('LD_LIBRARY_PATH')
  })

  it('should block LD_AUDIT', () => {
    const result = sanitizeEnv({ ...safeEnv, LD_AUDIT: '/tmp/audit.so' })
    expect(result).not.toHaveProperty('LD_AUDIT')
  })

  it('should block LD_PROFILE', () => {
    const result = sanitizeEnv({ ...safeEnv, LD_PROFILE: 'libc.so.6' })
    expect(result).not.toHaveProperty('LD_PROFILE')
  })

  // ── macOS dyld ──

  it('should block DYLD_INSERT_LIBRARIES', () => {
    const result = sanitizeEnv({ ...safeEnv, DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' })
    expect(result).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
  })

  it('should block DYLD_LIBRARY_PATH', () => {
    const result = sanitizeEnv({ ...safeEnv, DYLD_LIBRARY_PATH: '/tmp/libs' })
    expect(result).not.toHaveProperty('DYLD_LIBRARY_PATH')
  })

  it('should block DYLD_FRAMEWORK_PATH', () => {
    const result = sanitizeEnv({ ...safeEnv, DYLD_FRAMEWORK_PATH: '/tmp/frameworks' })
    expect(result).not.toHaveProperty('DYLD_FRAMEWORK_PATH')
  })

  it('should block DYLD_FALLBACK_LIBRARY_PATH', () => {
    const result = sanitizeEnv({ ...safeEnv, DYLD_FALLBACK_LIBRARY_PATH: '/tmp/fallback' })
    expect(result).not.toHaveProperty('DYLD_FALLBACK_LIBRARY_PATH')
  })

  // ── Shell startup injection ──

  it('should block BASH_ENV', () => {
    const result = sanitizeEnv({ ...safeEnv, BASH_ENV: '/tmp/evil.sh' })
    expect(result).not.toHaveProperty('BASH_ENV')
  })

  it('should block ENV', () => {
    const result = sanitizeEnv({ ...safeEnv, ENV: '/tmp/evil.sh' })
    expect(result).not.toHaveProperty('ENV')
  })

  it('should block CDPATH', () => {
    const result = sanitizeEnv({ ...safeEnv, CDPATH: '/tmp' })
    expect(result).not.toHaveProperty('CDPATH')
  })

  // ── Language runtime injection ──

  it('should block PYTHONSTARTUP', () => {
    const result = sanitizeEnv({ ...safeEnv, PYTHONSTARTUP: '/tmp/evil.py' })
    expect(result).not.toHaveProperty('PYTHONSTARTUP')
  })

  it('should block PERL5OPT', () => {
    const result = sanitizeEnv({ ...safeEnv, PERL5OPT: '-e system("id")' })
    expect(result).not.toHaveProperty('PERL5OPT')
  })

  it('should block RUBYOPT', () => {
    const result = sanitizeEnv({ ...safeEnv, RUBYOPT: '-e system("id")' })
    expect(result).not.toHaveProperty('RUBYOPT')
  })

  it('should block NODE_OPTIONS', () => {
    const result = sanitizeEnv({ ...safeEnv, NODE_OPTIONS: '--require /tmp/evil.js' })
    expect(result).not.toHaveProperty('NODE_OPTIONS')
  })

  // ── JVM / 构建工具注入 ──

  it('should block MAVEN_OPTS', () => {
    const result = sanitizeEnv({ ...safeEnv, MAVEN_OPTS: '-javaagent:/tmp/evil.jar' })
    expect(result).not.toHaveProperty('MAVEN_OPTS')
  })

  it('should block SBT_OPTS', () => {
    const result = sanitizeEnv({ ...safeEnv, SBT_OPTS: '-javaagent:/tmp/evil.jar' })
    expect(result).not.toHaveProperty('SBT_OPTS')
  })

  it('should block GRADLE_OPTS', () => {
    const result = sanitizeEnv({ ...safeEnv, GRADLE_OPTS: '-javaagent:/tmp/evil.jar' })
    expect(result).not.toHaveProperty('GRADLE_OPTS')
  })

  it('should block ANT_OPTS', () => {
    const result = sanitizeEnv({ ...safeEnv, ANT_OPTS: '-javaagent:/tmp/evil.jar' })
    expect(result).not.toHaveProperty('ANT_OPTS')
  })

  it('should block _JAVA_OPTIONS', () => {
    const result = sanitizeEnv({ ...safeEnv, _JAVA_OPTIONS: '-agentlib:jdwp=transport=dt_socket' })
    expect(result).not.toHaveProperty('_JAVA_OPTIONS')
  })

  it('should block JAVA_TOOL_OPTIONS', () => {
    const result = sanitizeEnv({ ...safeEnv, JAVA_TOOL_OPTIONS: '-javaagent:/tmp/evil.jar' })
    expect(result).not.toHaveProperty('JAVA_TOOL_OPTIONS')
  })

  it('should block JDK_JAVA_OPTIONS', () => {
    const result = sanitizeEnv({ ...safeEnv, JDK_JAVA_OPTIONS: '-javaagent:/tmp/evil.jar' })
    expect(result).not.toHaveProperty('JDK_JAVA_OPTIONS')
  })

  // ── glibc 调优 ──

  it('should block GLIBC_TUNABLES', () => {
    const result = sanitizeEnv({ ...safeEnv, GLIBC_TUNABLES: 'glibc.malloc.mxfast=0' })
    expect(result).not.toHaveProperty('GLIBC_TUNABLES')
  })

  // ── .NET 运行时注入 ──

  it('should block DOTNET_ADDITIONAL_DEPS', () => {
    const result = sanitizeEnv({ ...safeEnv, DOTNET_ADDITIONAL_DEPS: '/tmp/evil.deps.json' })
    expect(result).not.toHaveProperty('DOTNET_ADDITIONAL_DEPS')
  })

  it('should block DOTNET_STARTUP_HOOKS', () => {
    const result = sanitizeEnv({ ...safeEnv, DOTNET_STARTUP_HOOKS: '/tmp/evil.dll' })
    expect(result).not.toHaveProperty('DOTNET_STARTUP_HOOKS')
  })

  // ── Node.js 模块路径劫持 ──

  it('should block NODE_PATH', () => {
    const result = sanitizeEnv({ ...safeEnv, NODE_PATH: '/tmp/evil-modules' })
    expect(result).not.toHaveProperty('NODE_PATH')
  })

  // ── Python 模块路径劫持 ──

  it('should block PYTHONPATH', () => {
    const result = sanitizeEnv({ ...safeEnv, PYTHONPATH: '/tmp/evil-packages' })
    expect(result).not.toHaveProperty('PYTHONPATH')
  })

  // ── Perl 模块路径劫持 ──

  it('should block PERL5LIB', () => {
    const result = sanitizeEnv({ ...safeEnv, PERL5LIB: '/tmp/evil-perl' })
    expect(result).not.toHaveProperty('PERL5LIB')
  })

  it('should block PERLLIB', () => {
    const result = sanitizeEnv({ ...safeEnv, PERLLIB: '/tmp/evil-perl' })
    expect(result).not.toHaveProperty('PERLLIB')
  })

  // ── macOS dyld 输出文件注入 ──

  it('should block DYLD_PRINT_TO_FILE', () => {
    const result = sanitizeEnv({ ...safeEnv, DYLD_PRINT_TO_FILE: '/etc/crontab' })
    expect(result).not.toHaveProperty('DYLD_PRINT_TO_FILE')
  })

  // ── Bulk verification ──

  it('should block ALL injection variables simultaneously', () => {
    const injectionPayload: Record<string, string> = {}
    for (const varName of DANGEROUS_INJECTION_VARS) {
      injectionPayload[varName] = `/tmp/malicious-${varName}`
    }
    const result = sanitizeEnv({ ...safeEnv, ...injectionPayload })

    // All injection vars must be removed
    for (const varName of DANGEROUS_INJECTION_VARS) {
      expect(result, `${varName} should be blocked`).not.toHaveProperty(varName)
    }

    // Safe vars must survive
    expect(result).toHaveProperty('PATH', '/usr/bin')
    expect(result).toHaveProperty('HOME', '/home/user')
    expect(result).toHaveProperty('SHELL', '/bin/bash')
    expect(result).toHaveProperty('TERM', 'xterm-256color')
  })

  it('should have exactly 30 injection variables in the blocklist', () => {
    expect(DANGEROUS_INJECTION_VARS.size).toBe(30)
  })

  // ── Injection vars take priority over everything ──

  it('should block injection vars even if they appear normal', () => {
    // Ensure injection blocking happens before any other logic
    const result = sanitizeEnv({
      PATH: '/usr/bin',
      LD_PRELOAD: '',  // even empty values must be blocked
      DYLD_INSERT_LIBRARIES: '',
      NODE_OPTIONS: '',
    })
    expect(result).not.toHaveProperty('LD_PRELOAD')
    expect(result).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
    expect(result).not.toHaveProperty('NODE_OPTIONS')
  })
})
