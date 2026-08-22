/**
 * HF3: commandExecutor sanitizeEnv 验证
 *
 * 确保 CommandExecutor 使用的 sanitizeEnv 正确过滤
 * 危险注入变量（LD_PRELOAD 等）和敏感凭据。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeEnv, DANGEROUS_INJECTION_VARS, SENSITIVE_ENV_VARS, SAFE_ALLOWLIST, sanitizeSandboxEnv, isSensitiveSandboxKey } from '../src/sanitizeEnv';

describe('sanitizeEnv — 注入变量过滤', () => {
  it('过滤 LD_PRELOAD', () => {
    const env = { PATH: '/usr/bin', LD_PRELOAD: '/tmp/evil.so', HOME: '/root' };
    const result = sanitizeEnv(env);
    expect(result).not.toHaveProperty('LD_PRELOAD');
    expect(result).toHaveProperty('PATH', '/usr/bin');
    expect(result).toHaveProperty('HOME', '/root');
  });

  it('过滤所有 DANGEROUS_INJECTION_VARS', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    for (const v of DANGEROUS_INJECTION_VARS) {
      env[v] = 'malicious';
    }
    const result = sanitizeEnv(env);
    for (const v of DANGEROUS_INJECTION_VARS) {
      expect(result).not.toHaveProperty(v);
    }
    expect(result).toHaveProperty('PATH');
  });

  it('过滤 DYLD_INSERT_LIBRARIES', () => {
    const result = sanitizeEnv({ DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
  });

  it('过滤 NODE_OPTIONS', () => {
    const result = sanitizeEnv({ NODE_OPTIONS: '--require /tmp/evil.js', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('NODE_OPTIONS');
  });

  it('过滤 BASH_ENV', () => {
    const result = sanitizeEnv({ BASH_ENV: '/tmp/evil.sh', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('BASH_ENV');
  });

  // JVM / 构建工具注入

  it('过滤 MAVEN_OPTS', () => {
    const result = sanitizeEnv({ MAVEN_OPTS: '-javaagent:/tmp/evil.jar', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('MAVEN_OPTS');
  });

  it('过滤 SBT_OPTS', () => {
    const result = sanitizeEnv({ SBT_OPTS: '-javaagent:/tmp/evil.jar', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('SBT_OPTS');
  });

  it('过滤 GRADLE_OPTS', () => {
    const result = sanitizeEnv({ GRADLE_OPTS: '-javaagent:/tmp/evil.jar', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('GRADLE_OPTS');
  });

  it('过滤 ANT_OPTS', () => {
    const result = sanitizeEnv({ ANT_OPTS: '-javaagent:/tmp/evil.jar', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('ANT_OPTS');
  });

  it('过滤 _JAVA_OPTIONS', () => {
    const result = sanitizeEnv({ _JAVA_OPTIONS: '-agentlib:jdwp=transport=dt_socket', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('_JAVA_OPTIONS');
  });

  it('过滤 JAVA_TOOL_OPTIONS', () => {
    const result = sanitizeEnv({ JAVA_TOOL_OPTIONS: '-javaagent:/tmp/evil.jar', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('JAVA_TOOL_OPTIONS');
  });

  it('过滤 JDK_JAVA_OPTIONS', () => {
    const result = sanitizeEnv({ JDK_JAVA_OPTIONS: '-javaagent:/tmp/evil.jar', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('JDK_JAVA_OPTIONS');
  });

  // glibc 调优

  it('过滤 GLIBC_TUNABLES', () => {
    const result = sanitizeEnv({ GLIBC_TUNABLES: 'glibc.malloc.mxfast=0', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('GLIBC_TUNABLES');
  });

  // .NET 运行时注入

  it('过滤 DOTNET_ADDITIONAL_DEPS', () => {
    const result = sanitizeEnv({ DOTNET_ADDITIONAL_DEPS: '/tmp/evil.deps.json', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('DOTNET_ADDITIONAL_DEPS');
  });

  it('过滤 DOTNET_STARTUP_HOOKS', () => {
    const result = sanitizeEnv({ DOTNET_STARTUP_HOOKS: '/tmp/evil.dll', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('DOTNET_STARTUP_HOOKS');
  });

  // Node.js 模块路径劫持

  it('过滤 NODE_PATH', () => {
    const result = sanitizeEnv({ NODE_PATH: '/tmp/evil-modules', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('NODE_PATH');
  });

  // Python 模块路径劫持

  it('过滤 PYTHONPATH', () => {
    const result = sanitizeEnv({ PYTHONPATH: '/tmp/evil-packages', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('PYTHONPATH');
  });

  // Perl 模块路径劫持

  it('过滤 PERL5LIB', () => {
    const result = sanitizeEnv({ PERL5LIB: '/tmp/evil-perl', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('PERL5LIB');
  });

  it('过滤 PERLLIB', () => {
    const result = sanitizeEnv({ PERLLIB: '/tmp/evil-perl', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('PERLLIB');
  });

  // macOS dyld 输出文件注入

  it('过滤 DYLD_PRINT_TO_FILE', () => {
    const result = sanitizeEnv({ DYLD_PRINT_TO_FILE: '/etc/crontab', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('DYLD_PRINT_TO_FILE');
  });

  // 注入变量数量一致性

  it('DANGEROUS_INJECTION_VARS 应包含 30 个变量', () => {
    expect(DANGEROUS_INJECTION_VARS.size).toBe(30);
  });
});

describe('sanitizeEnv — 敏感凭据过滤', () => {
  it('过滤 OPENAI_API_KEY', () => {
    const result = sanitizeEnv({ OPENAI_API_KEY: 'sk-xxx', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('过滤 TABTIN_TOKEN', () => {
    const result = sanitizeEnv({ TABTIN_TOKEN: 'tok-xxx', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('TABTIN_TOKEN');
  });

  it('通过模式过滤 CUSTOM_SECRET_KEY', () => {
    const result = sanitizeEnv({ CUSTOM_SECRET_KEY: 'val', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('CUSTOM_SECRET_KEY');
  });

  it('通过模式过滤 MY_API_KEY', () => {
    const result = sanitizeEnv({ MY_API_KEY: 'val', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('MY_API_KEY');
  });
});

describe('sanitizeEnv — 安全允许列表', () => {
  it('保留 PATH、HOME、SHELL、TERM 等系统变量', () => {
    const env = { PATH: '/usr/bin', HOME: '/root', SHELL: '/bin/bash', TERM: 'xterm-256color' };
    const result = sanitizeEnv(env);
    expect(result).toHaveProperty('PATH', '/usr/bin');
    expect(result).toHaveProperty('HOME', '/root');
    expect(result).toHaveProperty('SHELL', '/bin/bash');
    expect(result).toHaveProperty('TERM', 'xterm-256color');
  });

  it('无 TERM 时提供默认值', () => {
    const result = sanitizeEnv({ PATH: '/usr/bin' });
    expect(result).toHaveProperty('TERM', 'xterm-256color');
  });

  it('保留普通环境变量', () => {
    const result = sanitizeEnv({ PATH: '/usr/bin', MY_APP_MODE: 'dev', CUSTOM_VAR: '1' });
    expect(result).toHaveProperty('MY_APP_MODE', 'dev');
    expect(result).toHaveProperty('CUSTOM_VAR', '1');
  });

  it('跳过 undefined 值', () => {
    const result = sanitizeEnv({ PATH: '/usr/bin', UNDEF_VAR: undefined as any });
    expect(result).not.toHaveProperty('UNDEF_VAR');
  });
});

describe('sanitizeSandboxEnv — re-export 验证', () => {
  it('通过 terminal-core re-export 可正常使用 sanitizeSandboxEnv', () => {
    const env = { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'x', NODE_ENV: 'dev' };
    const result = sanitizeSandboxEnv(env);
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result).toHaveProperty('PATH');
    expect(result).toHaveProperty('NODE_ENV');
  });

  it('isSensitiveSandboxKey 可通过 re-export 正常调用', () => {
    expect(isSensitiveSandboxKey('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(isSensitiveSandboxKey('PATH')).toBe(false);
  });
});
