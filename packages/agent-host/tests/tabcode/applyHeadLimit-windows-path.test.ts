/**
 * applyHeadLimit Windows 路径正则边界 audit（L-12 收口）。
 *
 * **背景**：W2 review 担忧 `applyHeadLimit` 用 `/^(.*):(\d+):/` 正则解析
 * `path:line:content` 形态时，Windows 路径 `C:\Users\foo:123:xxx` 里的 `C:`
 * 可能被误识别为 `file:line` 边界，导致 head 计数错乱。
 *
 * **结论**：误报。原因——`applyHeadLimit` 只用 `.test()` 判定"这一行是不是
 * ripgrep match 行"，不解析 path / line 子组。即便贪婪 `(.*)` 在 Windows 路径
 * 下选了"错"的 `:数字:` 边界（如 `C:\Users\123\foo:5:x` 选了 `:5:` 而非 `:数字
 * 段:`），整行依然算 1 个匹配，head_limit 计数正确。
 *
 * **本测试钉死**这一关键不变量：6 条易触发 W2 担忧的 case 输入下，
 * `applyHeadLimit` 必须返回正确的匹配行数 + 截断行数。如果未来有人
 * 改正则改成 `.match()` / `.exec()` 提取行号，本测试会立即报警。
 *
 * @see packages/agent-host/src/tools/tabcode-adapter.ts applyHeadLimit
 */

import { describe, expect, it } from 'vitest';

import { applyHeadLimit } from '../../src/tools/tabcode-adapter.js';

// 6 条易触发 W2 担忧的 Windows 路径输入（外加边界）
const WINDOWS_PATH_CASES: ReadonlyArray<readonly [string, string]> = [
  ['C:\\foo\\bar.ts:42:hello world', 'Windows 普通路径'],
  ['D:\\Users\\developer\\file.txt:1:world', 'Windows D 盘 + 用户名'],
  ['C:\\Users\\123\\foo.ts:5:x', 'Windows 路径段含数字（最易误识别场景）'],
  ['C:\\用户\\foo.ts:1:x', 'Windows 路径含中文'],
  ['src/foo.ts:42:if (x === ":10:y")', 'Linux + content 含 :数字:'],
  ['C:\\foo.ts:42:if (x === ":10:y")', 'Windows + content 含 :数字:'],
];

describe('applyHeadLimit Windows 路径边界（L-12 audit）', () => {
  it('6 条 Windows 路径全部识别为 match 行（不会被 C:\\ 当成 file:line 误识别）', () => {
    const raw = WINDOWS_PATH_CASES.map(([line]) => line).join('\n');
    // head_limit = 100 让所有匹配都返回，看 total_matches 是否 = 6
    const result = applyHeadLimit(raw, 100, 0, 'content');
    expect(result.totalMatches).toBeUndefined();
    // 6 条全部出现在输出里
    for (const [line, label] of WINDOWS_PATH_CASES) {
      expect(result.text, `case "${label}" 应出现在输出里`).toContain(line);
    }
  });

  it('head_limit=3 时正好截到前 3 条（计数不被 Windows C: 边界打乱）', () => {
    const raw = WINDOWS_PATH_CASES.map(([line]) => line).join('\n');
    const result = applyHeadLimit(raw, 3, 0, 'content');

    expect(result.totalMatches).toBe(6);

    const outputLines = result.text.split('\n').filter((line) => line.length > 0);
    const matchLineCount = outputLines.filter((line) =>
      /^(.*):(\d+):/.test(line),
    ).length;
    // 3 条 match + truncated 提示行（提示行不命中 path:line: 模式）
    expect(matchLineCount, 'head=3 应该正好 3 行 match 内容').toBe(3);

    // 前 3 条原文必须在；第 4-6 条不能在
    expect(result.text).toContain(WINDOWS_PATH_CASES[0][0]);
    expect(result.text).toContain(WINDOWS_PATH_CASES[1][0]);
    expect(result.text).toContain(WINDOWS_PATH_CASES[2][0]);
    expect(result.text).not.toContain(WINDOWS_PATH_CASES[3][0]);
    expect(result.text).not.toContain(WINDOWS_PATH_CASES[4][0]);
    expect(result.text).not.toContain(WINDOWS_PATH_CASES[5][0]);

    // truncated 提示
    expect(result.text).toMatch(/truncated/);
    expect(result.text).toMatch(/of at least 6 matches/);
    expect(result.text).toMatch(/offset=0/);
    expect(result.text).toMatch(/offset=3/); // next-page hint
  });

  it('offset=3 + head_limit=3 翻页：拿到第 4-6 条', () => {
    const raw = WINDOWS_PATH_CASES.map(([line]) => line).join('\n');
    const result = applyHeadLimit(raw, 3, 3, 'content');

    expect(result.text).not.toContain(WINDOWS_PATH_CASES[0][0]);
    expect(result.text).not.toContain(WINDOWS_PATH_CASES[1][0]);
    expect(result.text).not.toContain(WINDOWS_PATH_CASES[2][0]);
    expect(result.text).toContain(WINDOWS_PATH_CASES[3][0]);
    expect(result.text).toContain(WINDOWS_PATH_CASES[4][0]);
    expect(result.text).toContain(WINDOWS_PATH_CASES[5][0]);
    expect(result.text).not.toMatch(/truncated/);
  });

  it('offset 超过总数时返回 no matches in this page', () => {
    const raw = WINDOWS_PATH_CASES.map(([line]) => line).join('\n');
    const result = applyHeadLimit(raw, 10, 100, 'content');
    expect(result.text).toBe('(no matches in this page)');
    expect(result.totalMatches).toBe(6);
  });

  it('混合 Windows + Linux 路径下计数仍然正确', () => {
    const mixed = [
      'C:\\foo\\a.ts:1:line a',
      '/etc/foo.conf:2:line b',
      'D:\\bar\\b.ts:3:line c',
      'src/baz.ts:4:line d',
    ].join('\n');
    const result = applyHeadLimit(mixed, 2, 0, 'content');
    expect(result.totalMatches).toBe(4);
    expect(result.text).toContain('C:\\foo\\a.ts:1:line a');
    expect(result.text).toContain('/etc/foo.conf:2:line b');
    expect(result.text).not.toContain('D:\\bar\\b.ts:3:line c');
  });

  it('output_mode=files_with_matches 走另一条路径，不依赖正则', () => {
    const raw = WINDOWS_PATH_CASES.map(([line]) => line).join('\n');
    const result = applyHeadLimit(raw, 3, 0, 'files_with_matches');
    // files 模式按行计算，不解析 path:line:
    const contentLines = result.text
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('...'));
    expect(contentLines).toHaveLength(3);
    expect(result.totalMatches).toBe(6);
  });

  it('空输入返回空字符串', () => {
    expect(applyHeadLimit('', 10, 0, 'content')).toEqual({ text: '' });
  });

  it('rg --context 上下文行（用 - 分隔）不被误算为 match', () => {
    // ripgrep --context 输出格式：match 行用 `:`，context 行用 `-`
    const withContext = [
      'C:\\foo.ts:42:matched line',
      'C:\\foo.ts-43-context after',
      'C:\\foo.ts-44-another context',
      'C:\\foo.ts:50:another match',
    ].join('\n');
    const result = applyHeadLimit(withContext, 10, 0, 'content');
    // 只有 :42: 和 :50: 算 match，--- 不算
    expect(result.totalMatches).toBeUndefined(); // 2 < 10，不需要 truncate
    expect(result.text.split('\n').filter((line) =>
      /^(.*):(\d+):/.test(line),
    ).length).toBe(2);
  });
});
