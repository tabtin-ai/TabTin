/**
 * W1（失败信号保真）回归测试
 *
 * 覆盖：
 *   1. redirect-write 规则精度修复：`2>/dev/null` 不被误伤，`> file` 仍被拒；
 *      `1>file`（显式 stdout fd=1）也被正确拦截（P0 修复）
 *   2. DENY_RULE_HINTS 表完整性：所有 CRITICAL_DENYLIST + DEFAULT_DENYLIST
 *      规则名在 hints 表里都有对应 hint
 *   3. buildTabtinVarPreamble / buildPSTabtinVarPreamble 单元测试
 */
import { describe, it, expect } from 'vitest';
import { CommandValidator } from '../src/commandValidator';
import { CRITICAL_DENYLIST, DEFAULT_DENYLIST, HARDLINE_COMMAND_DENYLIST } from '../src/denylist';
import { DENY_RULE_HINTS } from '../src/deny-rule-hints';
import { buildTabtinVarPreamble, buildPSTabtinVarPreamble } from '../src/commandExecutor';

// ─── 1. redirect-write 规则精度 ────────────────────────────────────────

describe('redirect-write 规则精度修复（W1 #3）', () => {
  const validator = new CommandValidator();

  // ── 应被拒绝：stdout 重定向（写文件）──
  it('`echo hello > out.txt` 被拒（stdout 重定向）', () => {
    const r = validator.validate('echo hello > out.txt');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });

  it('`echo hello >> out.txt` 被拒（stdout append）', () => {
    const r = validator.validate('echo hello >> out.txt');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });

  it('`cat /etc/hostname>/tmp/out` 被拒（无空格的 stdout 重定向）', () => {
    const r = validator.validate('cat /etc/hostname>/tmp/out');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });

  it('`ls -la > /tmp/listing.txt` 被拒', () => {
    const r = validator.validate('ls -la > /tmp/listing.txt');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });

  // ── 不应被拒：stderr / combined 重定向（合法用途）──
  it('`ls /nonexistent 2>/dev/null` 不被 redirect-write 误伤', () => {
    // 注意：ls 在 allowlist 中，且 2> 不应触发 redirect-write
    // 此命令经过 env-var-expansion 检测后（无变量），走 allowlist → pass
    const r = validator.validate('ls /nonexistent 2>/dev/null');
    // redirect-write 不再误伤 stderr 重定向
    // （ls 在 allowlist，无 denylist 命中 → allowed）
    expect(r.ruleName).not.toBe('redirect-write');
  });

  it('`ls /nonexistent 2> /dev/null` 不被 redirect-write 误伤（含空格）', () => {
    const r = validator.validate('ls /nonexistent 2> /dev/null');
    expect(r.ruleName).not.toBe('redirect-write');
  });

  it('`ls /nonexistent 2>>/dev/null` 不被 redirect-write 误伤（append）', () => {
    const r = validator.validate('ls /nonexistent 2>>/dev/null');
    expect(r.ruleName).not.toBe('redirect-write');
  });

  it('`ls /nonexistent &>/dev/null` 不被 redirect-write 误伤（combined）', () => {
    const r = validator.validate('ls /nonexistent &>/dev/null');
    expect(r.ruleName).not.toBe('redirect-write');
  });

  it('`ls /nonexistent &>>/dev/null` 不被 redirect-write 误伤（combined append）', () => {
    const r = validator.validate('ls /nonexistent &>>/dev/null');
    expect(r.ruleName).not.toBe('redirect-write');
  });
});

// ─── 2. DENY_RULE_HINTS 覆盖率 ────────────────────────────────────────────

describe('DENY_RULE_HINTS 对所有 denylist 规则的覆盖（W1 #2）', () => {
  const allRuleNames = [
    ...HARDLINE_COMMAND_DENYLIST.map((r) => r.name),
    ...CRITICAL_DENYLIST.map((r) => r.name),
    ...DEFAULT_DENYLIST.map((r) => r.name),
    // runtime pseudo-rules from commandValidator.ts
    'env-var-expansion',
    'command-substitution',
    'sensitive-path',
    'empty',
  ];

  it('每条 deny 规则名在 DENY_RULE_HINTS 中都有非空 hint', () => {
    const missing: string[] = [];
    for (const name of allRuleNames) {
      const hint = DENY_RULE_HINTS[name];
      if (!hint || typeof hint !== 'string' || hint.trim().length === 0) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('hint 内容为英文（D3：LLM-facing 消息用英文）', () => {
    // 粗检：hint 字符串中 ASCII 字母 > 20 字符（含 CJK 字符的中文 hint 不合格）
    for (const [name, hint] of Object.entries(DENY_RULE_HINTS)) {
      const asciiLetterCount = (hint.match(/[a-zA-Z]/g) ?? []).length;
      expect(asciiLetterCount).toBeGreaterThan(20);
      // 不含中文字符
      expect(/[\u4e00-\u9fff]/.test(hint)).toBe(false);
    }
    // suppress linter warning about unused `name`
    void DENY_RULE_HINTS['redirect-write'];
  });

  it('redirect-write hint 包含正确引导：write_file 工具 + 允许 2>/dev/null', () => {
    const hint = DENY_RULE_HINTS['redirect-write'];
    expect(hint).toBeDefined();
    expect(hint).toContain('write_file');
    expect(hint).toContain('2>/dev/null');
  });

  it('env-var-expansion hint 包含绝对路径替换指引', () => {
    const hint = DENY_RULE_HINTS['env-var-expansion'];
    expect(hint).toBeDefined();
    // 应提示用绝对路径替换 $HOME 等变量引用
    expect(hint).toMatch(/absolute path|replace/i);
  });

  it('python-inline hint 包含 write_file + python3 引导', () => {
    const hint = DENY_RULE_HINTS['python-inline'];
    expect(hint).toBeDefined();
    expect(hint).toContain('write_file');
    expect(hint).toContain('python3');
  });

  it('rm hint 包含 delete_file 工具引导', () => {
    const hint = DENY_RULE_HINTS['rm'];
    expect(hint).toBeDefined();
    expect(hint).toContain('delete_file');
  });
});

// ─── 1b. redirect-write P0 回归：1>file 应被拦截 ──────────────────────────

describe('redirect-write P0 修复：1>file 被正确拦截（stdout 显式 fd=1）', () => {
  const validator = new CommandValidator();

  it('`ls 1>/tmp/out.txt` 被拒（显式 fd=1 = stdout）', () => {
    const r = validator.validate('ls 1>/tmp/out.txt');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });

  it('`ls 1>> /tmp/out.txt` 被拒（显式 fd=1 append）', () => {
    const r = validator.validate('ls 1>> /tmp/out.txt');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });
});

// ─── 3. buildTabtinVarPreamble / buildPSTabtinVarPreamble 单元测试 ────────

describe('buildTabtinVarPreamble（POSIX shell，W1 #4）', () => {
  it('值含空格的 TABTIN_* 变量生成 export 语句', () => {
    const preamble = buildTabtinVarPreamble({
      TABTIN_WORKSPACE: '/Users/foo/Application Support/TabTin/spaces',
      PATH: '/usr/bin:/bin',
    });
    expect(preamble).toBe("export TABTIN_WORKSPACE='/Users/foo/Application Support/TabTin/spaces'");
  });

  it('值不含空格的变量不出现在 preamble 中', () => {
    const preamble = buildTabtinVarPreamble({
      TABTIN_WORKSPACE: '/Users/foo/.tabtin/spaces',
      TABTIN_LOG_DIR: '/var/log/tabtin',
    });
    expect(preamble).toBe('');
  });

  it('非 TABTIN_* 前缀变量不出现在 preamble 中', () => {
    const preamble = buildTabtinVarPreamble({
      MY_PATH: '/some/path with spaces',
      TABTIN_CLEAN: '/clean/no-space',
    });
    expect(preamble).toBe('');
  });

  it('值含单引号时正确转义（POSIX \'\\\'\'）', () => {
    const preamble = buildTabtinVarPreamble({
      TABTIN_WORKSPACE: "/Users/foo/it's here/spaces",
    });
    expect(preamble).toBe("export TABTIN_WORKSPACE='/Users/foo/it'\\''s here/spaces'");
  });

  it('多个含空格变量用 "; " 连接', () => {
    const preamble = buildTabtinVarPreamble({
      TABTIN_WORKSPACE: '/a b',
      TABTIN_HOME: '/c d',
    });
    expect(preamble).toContain("export TABTIN_WORKSPACE='/a b'");
    expect(preamble).toContain("export TABTIN_HOME='/c d'");
    expect(preamble).toContain('; ');
  });
});

describe('buildPSTabtinVarPreamble（PowerShell Win32，W1 #4）', () => {
  it('值含空格的 TABTIN_* 变量生成 $env: 赋值语句', () => {
    const preamble = buildPSTabtinVarPreamble({
      TABTIN_WORKSPACE: 'C:\\Users\\foo\\Application Support\\TabTin',
      PATH: 'C:\\Windows\\System32',
    });
    expect(preamble).toBe("$env:TABTIN_WORKSPACE = 'C:\\Users\\foo\\Application Support\\TabTin'");
  });

  it('值含单引号时用 PowerShell 双单引号转义', () => {
    const preamble = buildPSTabtinVarPreamble({
      TABTIN_WORKSPACE: "C:\\it's here with space",
    });
    expect(preamble).toBe("$env:TABTIN_WORKSPACE = 'C:\\it''s here with space'");
  });

  it('值不含空格的变量不出现在 preamble 中', () => {
    const preamble = buildPSTabtinVarPreamble({
      TABTIN_WORKSPACE: 'C:\\nospace',
    });
    expect(preamble).toBe('');
  });
});
