import { describe, it, expect, vi } from 'vitest'
import {
  sanitizeEnv,
  isSensitiveByPattern,
  DANGEROUS_INJECTION_VARS,
  SENSITIVE_ENV_VARS,
  SENSITIVE_PATTERNS,
  SAFE_ALLOWLIST,
  sanitizeSandboxEnv,
  isSensitiveSandboxKey,
  SENSITIVE_SANDBOX_PATTERNS,
} from '../src/index'

describe('sanitizeEnv — 注入变量过滤', () => {
  const safeEnv = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
  }

  it('过滤 LD_PRELOAD', () => {
    const result = sanitizeEnv({ ...safeEnv, LD_PRELOAD: '/tmp/evil.so' })
    expect(result).not.toHaveProperty('LD_PRELOAD')
    expect(result).toHaveProperty('PATH', '/usr/bin')
  })

  it('过滤所有 DANGEROUS_INJECTION_VARS', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' }
    for (const v of DANGEROUS_INJECTION_VARS) {
      env[v] = 'malicious'
    }
    const result = sanitizeEnv(env)
    for (const v of DANGEROUS_INJECTION_VARS) {
      expect(result, `${v} should be blocked`).not.toHaveProperty(v)
    }
    expect(result).toHaveProperty('PATH')
  })

  it('过滤 DYLD_INSERT_LIBRARIES', () => {
    const result = sanitizeEnv({ ...safeEnv, DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' })
    expect(result).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
  })

  it('过滤 NODE_OPTIONS', () => {
    const result = sanitizeEnv({ ...safeEnv, NODE_OPTIONS: '--require /tmp/evil.js' })
    expect(result).not.toHaveProperty('NODE_OPTIONS')
  })

  it('过滤 BASH_ENV', () => {
    const result = sanitizeEnv({ ...safeEnv, BASH_ENV: '/tmp/evil.sh' })
    expect(result).not.toHaveProperty('BASH_ENV')
  })

  it('过滤 JVM 注入变量', () => {
    for (const v of ['MAVEN_OPTS', 'SBT_OPTS', 'GRADLE_OPTS', 'ANT_OPTS', '_JAVA_OPTIONS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS']) {
      const result = sanitizeEnv({ ...safeEnv, [v]: '-javaagent:/tmp/evil.jar' })
      expect(result, `${v} should be blocked`).not.toHaveProperty(v)
    }
  })

  it('过滤 GLIBC_TUNABLES', () => {
    const result = sanitizeEnv({ ...safeEnv, GLIBC_TUNABLES: 'glibc.malloc.mxfast=0' })
    expect(result).not.toHaveProperty('GLIBC_TUNABLES')
  })

  it('过滤 .NET 注入变量', () => {
    const result = sanitizeEnv({ ...safeEnv, DOTNET_ADDITIONAL_DEPS: '/tmp/evil.deps.json', DOTNET_STARTUP_HOOKS: '/tmp/evil.dll' })
    expect(result).not.toHaveProperty('DOTNET_ADDITIONAL_DEPS')
    expect(result).not.toHaveProperty('DOTNET_STARTUP_HOOKS')
  })

  it('过滤模块路径劫持变量', () => {
    for (const v of ['NODE_PATH', 'PYTHONPATH', 'PERL5LIB', 'PERLLIB']) {
      const result = sanitizeEnv({ ...safeEnv, [v]: '/tmp/evil' })
      expect(result, `${v} should be blocked`).not.toHaveProperty(v)
    }
  })

  it('过滤 DYLD_PRINT_TO_FILE', () => {
    const result = sanitizeEnv({ ...safeEnv, DYLD_PRINT_TO_FILE: '/etc/crontab' })
    expect(result).not.toHaveProperty('DYLD_PRINT_TO_FILE')
  })

  it('空值注入变量仍被过滤', () => {
    const result = sanitizeEnv({ PATH: '/usr/bin', LD_PRELOAD: '', DYLD_INSERT_LIBRARIES: '', NODE_OPTIONS: '' })
    expect(result).not.toHaveProperty('LD_PRELOAD')
    expect(result).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
    expect(result).not.toHaveProperty('NODE_OPTIONS')
  })

  it('DANGEROUS_INJECTION_VARS 应包含 30 个变量', () => {
    expect(DANGEROUS_INJECTION_VARS.size).toBe(30)
  })
})

describe('sanitizeEnv — 敏感凭据过滤', () => {
  it('过滤 TabTin 内部变量', () => {
    const result = sanitizeEnv({ TABTIN_TOKEN: 'tok', TABTIN_JWT: 'jwt', TABTIN_SOCK: '/sock', PATH: '/usr/bin' })
    expect(result).not.toHaveProperty('TABTIN_TOKEN')
    expect(result).not.toHaveProperty('TABTIN_JWT')
    expect(result).not.toHaveProperty('TABTIN_SOCK')
  })

  it('过滤云厂商密钥', () => {
    const result = sanitizeEnv({ AWS_SECRET_ACCESS_KEY: 'x', AWS_SESSION_TOKEN: 'x', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'ak-x', PATH: '/usr/bin' })
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(result).not.toHaveProperty('AWS_SESSION_TOKEN')
    expect(result).not.toHaveProperty('OPENAI_API_KEY')
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('过滤数据库凭据', () => {
    const env = { DATABASE_URL: 'x', DATABASE_PASSWORD: 'x', PGPASSWORD: 'x', MYSQL_PWD: 'x', REDIS_PASSWORD: 'x' }
    const result = sanitizeEnv(env)
    for (const k of Object.keys(env)) {
      expect(result).not.toHaveProperty(k)
    }
  })

  it('通过模式过滤含敏感关键词的变量', () => {
    const env = { CUSTOM_SECRET_KEY: 'v', MY_API_KEY: 'v', SOME_AUTH_TOKEN: 'v', DB_PASSWORD: 'v', SERVICE_CREDENTIAL: 'v' }
    const result = sanitizeEnv(env)
    for (const k of Object.keys(env)) {
      expect(result).not.toHaveProperty(k)
    }
  })

  it('模式过滤不区分大小写', () => {
    const result = sanitizeEnv({ my_secret: 'v', My_Api_Key: 'v', SOME_TOKEN: 'v' })
    expect(result).not.toHaveProperty('my_secret')
    expect(result).not.toHaveProperty('My_Api_Key')
    expect(result).not.toHaveProperty('SOME_TOKEN')
  })

  it('preserveKeys 仅放行 Skill 注入的凭据键', () => {
    const result = sanitizeEnv(
      {
        OPENAI_API_KEY: 'sk-skill-injected',
        MY_API_KEY: 'user-supplied',
        PATH: '/usr/bin',
      },
      { preserveKeys: ['OPENAI_API_KEY'] },
    )
    expect(result.OPENAI_API_KEY).toBe('sk-skill-injected')
    expect(result).not.toHaveProperty('MY_API_KEY')
  })

  it('preserveKeys 仍阻止注入变量', () => {
    const result = sanitizeEnv(
      { LD_PRELOAD: '/tmp/evil.so', OPENAI_API_KEY: 'sk-skill-injected' },
      { preserveKeys: ['LD_PRELOAD', 'OPENAI_API_KEY'] },
    )
    expect(result).not.toHaveProperty('LD_PRELOAD')
    expect(result.OPENAI_API_KEY).toBe('sk-skill-injected')
  })
})

describe('sanitizeEnv — 安全允许列表', () => {
  it('保留系统必要变量', () => {
    const env = { PATH: '/usr/bin', HOME: '/root', SHELL: '/bin/bash', TERM: 'xterm', LANG: 'en_US.UTF-8', SSH_AUTH_SOCK: '/tmp/ssh.sock', EDITOR: 'vim' }
    const result = sanitizeEnv(env)
    for (const k of Object.keys(env)) {
      expect(result).toHaveProperty(k)
    }
  })

  it('无 TERM 时提供默认值 xterm-256color', () => {
    const result = sanitizeEnv({ PATH: '/usr/bin' })
    expect(result).toHaveProperty('TERM', 'xterm-256color')
  })

  it('保留普通非敏感变量', () => {
    const result = sanitizeEnv({ PATH: '/usr/bin', NODE_ENV: 'dev', DEBUG: 'true', MY_APP_PORT: '3000' })
    expect(result).toHaveProperty('NODE_ENV')
    expect(result).toHaveProperty('DEBUG')
    expect(result).toHaveProperty('MY_APP_PORT')
  })

  it('跳过 undefined 值', () => {
    const result = sanitizeEnv({ PATH: '/usr/bin', UNDEF_VAR: undefined })
    expect(result).not.toHaveProperty('UNDEF_VAR')
  })
})

describe('isSensitiveByPattern', () => {
  it('检测 _SECRET 后缀', () => {
    expect(isSensitiveByPattern('MY_SECRET')).toBe(true)
    expect(isSensitiveByPattern('app_secret')).toBe(true)
  })

  it('检测 _KEY 后缀', () => {
    expect(isSensitiveByPattern('API_KEY')).toBe(true)
    expect(isSensitiveByPattern('ENCRYPTION_KEY')).toBe(true)
  })

  it('检测 _TOKEN 后缀', () => {
    expect(isSensitiveByPattern('AUTH_TOKEN')).toBe(true)
    expect(isSensitiveByPattern('ACCESS_TOKEN')).toBe(true)
  })

  it('不误报非敏感名称', () => {
    expect(isSensitiveByPattern('NODE_ENV')).toBe(false)
    expect(isSensitiveByPattern('PATH')).toBe(false)
    expect(isSensitiveByPattern('HOME')).toBe(false)
    expect(isSensitiveByPattern('DEBUG')).toBe(false)
  })
})

describe('DANGEROUS_INJECTION_PREFIXES — 前缀封堵', () => {
  it('should block BASH_FUNC_ exported function variables (ShellShock)', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      'BASH_FUNC_myfunc%%': '() { malicious; }',
      'BASH_FUNC_another%%': '() { evil; }',
      NORMAL_VAR: 'safe',
    }
    const result = sanitizeEnv(env)
    expect(result).not.toHaveProperty('BASH_FUNC_myfunc%%')
    expect(result).not.toHaveProperty('BASH_FUNC_another%%')
    expect(result).toHaveProperty('NORMAL_VAR', 'safe')
  })

  it('should not block vars that merely contain BASH_FUNC_ as substring', () => {
    const env = {
      MY_BASH_FUNC_HELPER: 'safe',
    }
    const result = sanitizeEnv(env)
    expect(result).toHaveProperty('MY_BASH_FUNC_HELPER', 'safe')
  })

  it('should include BASH_FUNC_ in log output when filtered', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sanitizeEnv({ 'BASH_FUNC_evil%%': '() { rm -rf /; }' })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BASH_FUNC_evil%%'),
    )
    warnSpy.mockRestore()
  })
})

describe('sanitizeSandboxEnv — 沙箱二次消毒', () => {
  it('过滤 AWS 开头的环境变量', () => {
    const env = { PATH: '/usr/bin', HOME: '/root', AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'secret' }
    const result = sanitizeSandboxEnv(env)
    expect(result).not.toHaveProperty('AWS_ACCESS_KEY_ID')
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(result).toHaveProperty('PATH')
    expect(result).toHaveProperty('HOME')
  })

  it('过滤含 SECRET / PASSWORD / CREDENTIAL 的变量', () => {
    const env = { MY_SECRET_VALUE: 'x', DB_PASSWORD: 'x', SERVICE_CREDENTIAL: 'x', SAFE_VAR: 'ok' }
    const result = sanitizeSandboxEnv(env)
    expect(result).not.toHaveProperty('MY_SECRET_VALUE')
    expect(result).not.toHaveProperty('DB_PASSWORD')
    expect(result).not.toHaveProperty('SERVICE_CREDENTIAL')
    expect(result).toHaveProperty('SAFE_VAR', 'ok')
  })

  it('过滤 OPENAI_API_KEY / ANTHROPIC_API_KEY 等 AI 提供商密钥', () => {
    const env = { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'ak-x', NODE_ENV: 'prod' }
    const result = sanitizeSandboxEnv(env)
    expect(result).not.toHaveProperty('OPENAI_API_KEY')
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(result).toHaveProperty('NODE_ENV', 'prod')
  })

  it('过滤 STRIPE_ / TWILIO_ / SENDGRID_ 开头的变量', () => {
    const env = { STRIPE_SECRET_KEY: 'x', TWILIO_AUTH_TOKEN: 'x', SENDGRID_API_KEY: 'x', DEBUG: '1' }
    const result = sanitizeSandboxEnv(env)
    expect(result).not.toHaveProperty('STRIPE_SECRET_KEY')
    expect(result).not.toHaveProperty('TWILIO_AUTH_TOKEN')
    expect(result).not.toHaveProperty('SENDGRID_API_KEY')
    expect(result).toHaveProperty('DEBUG', '1')
  })

  it('过滤 SSH_AUTH_SOCK / SSH_AGENT_PID / GPG_AGENT_INFO', () => {
    const env = { SSH_AUTH_SOCK: '/tmp/ssh.sock', SSH_AGENT_PID: '1234', GPG_AGENT_INFO: 'info', TERM: 'xterm' }
    const result = sanitizeSandboxEnv(env)
    expect(result).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(result).not.toHaveProperty('SSH_AGENT_PID')
    expect(result).not.toHaveProperty('GPG_AGENT_INFO')
    expect(result).toHaveProperty('TERM', 'xterm')
  })

  it('不过滤无关的普通变量', () => {
    const env = { PATH: '/usr/bin', NODE_ENV: 'dev', LANG: 'en_US.UTF-8', MY_APP_PORT: '3000' }
    const result = sanitizeSandboxEnv(env)
    expect(Object.keys(result)).toHaveLength(4)
  })

  it('removedCount > 0 时输出 warn 日志', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sanitizeSandboxEnv({ OPENAI_API_KEY: 'sk-x' })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('沙箱二次过滤移除了 1 个敏感环境变量'),
    )
    warnSpy.mockRestore()
  })

  it('空 env 不输出 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sanitizeSandboxEnv({})
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('isSensitiveSandboxKey', () => {
  it('匹配 AWS_ 前缀', () => {
    expect(isSensitiveSandboxKey('AWS_ACCESS_KEY_ID')).toBe(true)
  })

  it('匹配 SECRET 关键词（不区分大小写）', () => {
    expect(isSensitiveSandboxKey('my_secret')).toBe(true)
    expect(isSensitiveSandboxKey('MY_SECRET')).toBe(true)
  })

  it('不匹配普通变量', () => {
    expect(isSensitiveSandboxKey('PATH')).toBe(false)
    expect(isSensitiveSandboxKey('NODE_ENV')).toBe(false)
    expect(isSensitiveSandboxKey('HOME')).toBe(false)
  })
})

describe('SENSITIVE_SANDBOX_PATTERNS', () => {
  it('包含预期数量的正则', () => {
    expect(SENSITIVE_SANDBOX_PATTERNS.length).toBe(29)
  })
})

describe('导出常量完整性', () => {
  it('SENSITIVE_ENV_VARS 包含关键条目', () => {
    expect(SENSITIVE_ENV_VARS.has('OPENAI_API_KEY')).toBe(true)
    expect(SENSITIVE_ENV_VARS.has('TABTIN_TOKEN')).toBe(true)
    expect(SENSITIVE_ENV_VARS.has('SSH_PRIVATE_KEY')).toBe(true)
  })

  it('SENSITIVE_PATTERNS 非空', () => {
    expect(SENSITIVE_PATTERNS.length).toBeGreaterThan(0)
  })

  it('SAFE_ALLOWLIST 包含 PATH 和 HOME', () => {
    expect(SAFE_ALLOWLIST.has('PATH')).toBe(true)
    expect(SAFE_ALLOWLIST.has('HOME')).toBe(true)
  })
})
