/**
 * cwd-quote-protection.test.ts —— W1 北极星 #5
 *
 * `detectUnquotedWorkspacePath` 的精度回归。问题陈述：
 *   macOS workspace 默认在 `~/Library/Application Support/TabTin/...`
 *   含空格。LLM 把字面量路径直接拼到命令里时漏掉引号 → bash word-split
 *   → 命令实际跑成多 argv → 工具回报 usage 错误 → LLM 完全不知道根因。
 *
 * 检测器要做到：
 *   - 含空格路径未引号 → 命中 + 含 hint
 *   - 含空格路径在双引号 / 单引号内 → 不命中
 *   - 不含空格的路径 → 不命中（无 word-split 风险）
 *   - undefined / 空 paths → 不崩溃
 *   - 同一路径多次出现 → 只报一次（避免噪声）
 */

import { describe, it, expect } from 'vitest';
import { detectUnquotedWorkspacePath } from '../src/cwd-quote-protection';

const SPACED = '/Users/foo/Application Support/TabTin/spaces/wt/sp';
const NO_SPACE = '/Users/foo/.tabtin/spaces';

// ─── 1. 含空格路径 + 未引号 = 命中 ──────────────────────────────────

describe('detectUnquotedWorkspacePath：含空格路径未引号被命中', () => {
  it('裸字面量路径作为 argv → 命中', () => {
    const cmd = `pdftoppm /tmp/x.pdf ${SPACED}/out`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(SPACED);
    expect(hits[0].hint).toContain('split it into multiple argv');
    expect(hits[0].hint).toContain(SPACED);
  });

  it('hint 给出动作化建议（含 single-quote / TABTIN_WORKSPACE 双引号示例）', () => {
    const cmd = `cp ${SPACED}/a.txt /tmp/b.txt`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(1);
    // hint 必须给出可执行的下一步姿势，不能是空话
    expect(hits[0].hint).toMatch(/single quotes/i);
    expect(hits[0].hint).toMatch(/TABTIN_WORKSPACE/);
  });

  it('多个不同含空格路径 → 多条命中（每路径报一次）', () => {
    const altPath = '/Users/bar/My Documents/proj';
    const cmd = `cp ${SPACED}/a.txt ${altPath}/b.txt`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED, altPath]);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.path).sort()).toEqual([SPACED, altPath].sort());
  });

  it('同一路径在命令里出现两次 → 只报一次', () => {
    const cmd = `cp ${SPACED}/a.txt ${SPACED}/b.txt`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(1);
  });
});

// ─── 2. 引号包裹 = 不命中 ────────────────────────────────────────────

describe('detectUnquotedWorkspacePath：引号内不命中', () => {
  it('双引号包裹路径 → 不命中', () => {
    const cmd = `pdftoppm /tmp/x.pdf "${SPACED}/out"`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(0);
  });

  it('单引号包裹路径 → 不命中', () => {
    const cmd = `pdftoppm /tmp/x.pdf '${SPACED}/out'`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(0);
  });

  it('双引号包裹整个路径 + 后跟 / 文件名 → 不命中', () => {
    // bash 把 `"$TABTIN_WORKSPACE"/a.txt` 看作完整 token（路径含空格但被引）
    const cmd = `cat "${SPACED}/notes/today.md"`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(0);
  });
});

// ─── 3. 不含空格 / 空 / 无监控路径 → 跳过 ────────────────────────────

describe('detectUnquotedWorkspacePath：跳过逻辑', () => {
  it('不含空格的路径 → 不命中（无 word-split 风险）', () => {
    const cmd = `cat ${NO_SPACE}/a.txt`;
    const hits = detectUnquotedWorkspacePath(cmd, [NO_SPACE]);
    expect(hits).toHaveLength(0);
  });

  it('protectedPaths 为空数组 → 不命中', () => {
    const cmd = `cat ${SPACED}/x`;
    const hits = detectUnquotedWorkspacePath(cmd, []);
    expect(hits).toHaveLength(0);
  });

  it('protectedPaths 为 undefined → 不崩溃且不命中', () => {
    const cmd = `cat ${SPACED}/x`;
    const hits = detectUnquotedWorkspacePath(cmd, undefined);
    expect(hits).toHaveLength(0);
  });

  it('protectedPaths 含 undefined / 空字符串 / 非字符串 → 静默跳过', () => {
    const cmd = `cat ${SPACED}/x`;
    const hits = detectUnquotedWorkspacePath(
      cmd,
      [undefined, '', SPACED, undefined as unknown as string],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(SPACED);
  });

  it('command 为空字符串 → 不命中', () => {
    const hits = detectUnquotedWorkspacePath('', [SPACED]);
    expect(hits).toHaveLength(0);
  });

  it('command 不含 path → 不命中', () => {
    const cmd = `pwd`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(0);
  });
});

// ─── 4. 引号嵌套 / 转义边界 case ─────────────────────────────────────

describe('detectUnquotedWorkspacePath：引号嵌套与转义', () => {
  it('双引号内嵌单引号字符串中含路径 → 不命中（单引号无效，外层是双引号）', () => {
    // bash 在双引号内，单引号是字面量，不开始新引号上下文。所以路径
    // 整体仍在双引号保护内。
    const cmd = `echo "outer 'inner ${SPACED}/x' rest"`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(0);
  });

  it('反斜杠转义双引号 → 路径仍在引号外被命中', () => {
    // `echo \"foo\" ${SPACED}/x` 这里 `\"` 不开启双引号上下文，
    // 路径仍然处于无引号状态，应被命中。
    const cmd = `echo \\"foo\\" ${SPACED}/x`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(1);
  });

  it('同一路径首次在引号内、第二次未引号 → 命中一次（语义锁）', () => {
    // 锁住 `searchFrom += 1` + 未引号首次匹配后 `break` 的双重语义：
    // 引号内的首次出现不命中，循环继续查找，找到第二次未引号位置
    // 后命中并 break。这是 detector 的正确行为——LLM 部分加引号、
    // 部分忘加引号时，只要存在一处未引号就提示。
    const cmd = `cp "${SPACED}/a.txt" ${SPACED}/b.txt`;
    const hits = detectUnquotedWorkspacePath(cmd, [SPACED]);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(SPACED);
  });
});

// ─── 5. ：提示按 shellKind 出文案（去 bash 硬编码）────────────────

describe('detectUnquotedWorkspacePath：shell 感知提示', () => {
  const cmd = `cat ${SPACED}/x.md`;

  it('缺省 / bash → 保留 POSIX word-splitting 文案', () => {
    const hit = detectUnquotedWorkspacePath(cmd, [SPACED])[0];
    expect(hit.hint).toContain('Bash will split it');
    const hitBash = detectUnquotedWorkspacePath(cmd, [SPACED], 'bash')[0];
    expect(hitBash.hint).toContain('Bash will split it');
  });

  it('powershell → PS 文案，不提 bash，建议单引号字面字符串', () => {
    const hit = detectUnquotedWorkspacePath(cmd, [SPACED], 'powershell')[0];
    expect(hit.hint).toContain('PowerShell');
    expect(hit.hint).not.toContain('Bash will split it');
    expect(hit.hint).toContain('single quotes');
  });

  it('cmd → cmd.exe 文案，建议双引号且点明单引号无效', () => {
    const hit = detectUnquotedWorkspacePath(cmd, [SPACED], 'cmd')[0];
    expect(hit.hint).toContain('cmd.exe');
    expect(hit.hint).toContain('double quotes');
    expect(hit.hint).toContain('does not treat single quotes');
    expect(hit.hint).not.toContain('Bash will split it');
  });
});
