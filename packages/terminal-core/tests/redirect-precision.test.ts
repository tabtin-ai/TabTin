/**
 * redirect-precision.test.ts —— W1 北极星 #4
 *
 * `redirect-write` deny 规则的精度回归。问题陈述：早期实现把 `>` 误伤
 * `2>` / `&>` / `>&2` 等合法的 stderr / combined 重定向，导致 LLM 写
 * `pdftotext file.pdf - 2>/dev/null` 被拒，看到的错误信息只是"禁止
 * 输出重定向"，根本不知道真实原因（stderr 重定向并非禁止项）。
 *
 * **本测试覆盖**：
 *   - 真违规仍被拒（`> file` / `>> file` / `1> file` / 无空格 stdout
 *     重定向 `cat /etc/x>/tmp/y`）
 *   - 合法用法不被误伤（`2>` / `&>` / `2>>` / `&>>` / `>&2`）
 *   - 边界 case（引号内的 `>` / 命令链中混合 `2>` + `>` ）
 *
 * **与 `w1-redirect-hints.test.ts` 的关系**：那个测试同时覆盖
 * `DENY_RULE_HINTS` 表 + `redirect-write` 规则；本文件按 W1 北极星
 * 命名（`tests/redirect-precision.test.ts`）专注规则精度，便于子 Agent /
 * harness 用文件名定位回归。两文件是同一规则的不同切面，互不替代。
 */

import { describe, it, expect } from 'vitest';
import { CommandValidator } from '../src/commandValidator';

const validator = new CommandValidator();

// ─── 1. 真违规：必须被拒 ──────────────────────────────────────────

describe('redirect-write 真违规（必须被拒）', () => {
  it.each([
    ['echo hello > out.txt', '基本 stdout 重定向'],
    ['echo hello >> out.txt', 'stdout append'],
    ['cat /etc/hostname>/tmp/out', '无空格写法'],
    ['ls 1>/tmp/out.txt', '显式 fd=1 (stdout)'],
    ['ls 1>> /tmp/out.txt', '显式 fd=1 append'],
    ['ls -la > /tmp/listing.txt', '组合参数 + 重定向'],
    ['printf "%s" foo > /tmp/p.out', 'printf 写文件'],
  ])('%s 被拒（%s）', (cmd) => {
    const r = validator.validate(cmd);
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });
});

// ─── 2. 合法用法：不被 redirect-write 误伤 ──────────────────────────

describe('redirect-write 不误伤 stderr / combined 重定向', () => {
  it.each([
    'ls /nonexistent 2>/dev/null',
    'ls /nonexistent 2> /dev/null',
    'ls /nonexistent 2>>/dev/null',
    'ls /nonexistent 2>> /tmp/stderr.log',
    'ls /nonexistent &>/dev/null',
    'ls /nonexistent &>>/dev/null',
    'ls /nonexistent &> /dev/null',
  ])('%s 不被 redirect-write 误伤', (cmd) => {
    const r = validator.validate(cmd);
    expect(r.ruleName).not.toBe('redirect-write');
  });
});

// ─── 3. 引号内的 `>` 不应触发（splitCommandChain 已引号感知） ───────

describe('redirect-write 不误伤引号内字面量 `>`', () => {
  it('双引号内 `echo "a > b"` 不被 redirect-write 误伤', () => {
    // splitCommandChain 不在引号内拆分；validateSingle 接到完整子命令
    // 后，redirect-write 检测使用引号内 `>` 时**也会**命中（这是设计上
    // 的安全保守倾向：若需放行引号内 `>` 需更细粒度词法分析）。
    // 当前实现保留"宁可误伤少数引号内 `>` 字面量、也保安全"的取舍。
    // 本断言记录该取舍——LLM 写 `echo "a > b"` 想打印含 `>` 的文本时
    // 会被拒，需用 hint 引导改用 write_file。
    const r = validator.validate('echo "a > b"');
    expect(r.allowed).toBe(false);
    // 记录当前行为是 redirect-write 命中——若未来想精确放行引号内
    // 字面量 `>`，本测试需对应更新。
    expect(r.ruleName).toBe('redirect-write');
  });

  it('单引号内 `echo \'a > b\'` 行为同上（保守倾向）', () => {
    const r = validator.validate("echo 'a > b'");
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });
});

// ─── 4. 命令链：`>` 出现在子命令则整条拒绝 ─────────────────────────

describe('redirect-write 与命令链组合', () => {
  it('`ls /tmp 2>/dev/null && echo done > out.txt` 被拒（第二段含 stdout 重定向）', () => {
    const r = validator.validate('ls /tmp 2>/dev/null && echo done > out.txt');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });

  it('`ls /tmp 2>/dev/null && pwd` 通过（第二段无重定向）', () => {
    const r = validator.validate('ls /tmp 2>/dev/null && pwd');
    expect(r.allowed).toBe(true);
  });
});

// ─── 5. `>&` 复制 fd（合法 bash 语法）不被误伤 ────────────────────

describe('redirect-write 不误伤 fd 复制语法', () => {
  it('`ls 2>&1` 不被 redirect-write 误伤（`>&` 不是重定向写文件）', () => {
    // 注意：`>&1` 中的 `>` 后面是 `&`（其他操作符），按 redirect-write
    // 模式 `(?<![2&>])>+\s*[^\s>|&]` —— 后面接 `&` 不命中（被排除
    // 在结尾 `[^\s>|&]` 字符类外）。
    const r = validator.validate('ls 2>&1');
    expect(r.ruleName).not.toBe('redirect-write');
  });

  it('`ls >&2` 不被 redirect-write 误伤（写到 stderr）', () => {
    // `>&2` 把 stdout 复制到 stderr —— 不是写文件。
    const r = validator.validate('ls >&2');
    expect(r.ruleName).not.toBe('redirect-write');
  });

  it('`cmd >&-` 关闭 stdout fd 不被 redirect-write 误伤', () => {
    // POSIX `>&-` 关闭 stdout（不是重定向写文件）。redirect-write 模式
    // 末位字符类排除 `&`，因此不命中——保持合规。
    const r = validator.validate('echo data >&-');
    expect(r.ruleName).not.toBe('redirect-write');
  });
});

// ─── 6. heredoc body 含 `>` 的当前行为（保守取舍记录） ────────────

describe('redirect-write 与 heredoc 的取舍', () => {
  it('heredoc body 含 `>` 当前会被命中（false positive 取舍）', () => {
    // splitCommandChain 不感知 heredoc 边界，body 内的 `> file` 会被
    // 当成真重定向。当前为保守安全取舍——LLM 用 heredoc 写文件本身
    // 也是替代姿势（应改用 write_file 工具），命中后引导一致。
    // 该测试锚定行为，未来想精确支持 heredoc 时本断言需更新。
    const r = validator.validate('cat <<EOF\necho > x\nEOF');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });
});

// ─── 7. 多 fd 重定向组合 ────────────────────────────────────────────

describe('redirect-write 与多 fd 组合', () => {
  it('`echo data 1>>file 2>&1` 被拒（`1>>` 是 stdout append）', () => {
    // 显式 fd=1 + append 的常见日志写法。redirect-write 应命中前段
    // `1>>file`，不被后段 `2>&1` 干扰。
    const r = validator.validate('echo data 1>>file 2>&1');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });

  it('`echo data > out 2> err` 被拒（同时含 stdout / stderr 重定向）', () => {
    // stdout 重定向命中即整条拒绝，stderr 重定向不影响判定。
    const r = validator.validate('echo data > out 2> err');
    expect(r.allowed).toBe(false);
    expect(r.ruleName).toBe('redirect-write');
  });
});
