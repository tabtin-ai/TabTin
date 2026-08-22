/**
 * T8 端到端回放（T2-grep-glob_2026-05-12 PRD §九 Step 10）：模拟 c39cd8b2 事故
 * 现场的关键 LLM 行为路径，验证 T2 改造解决了事故潜在源。
 *
 * **事故背景**：
 *   - 用户让 Agent 把 `/Users/developer/dev/stripe/calculator.html` 改成黑白配色
 *   - 17 次工具调用里 3 次 edit_file 失败
 *   - 第 14 次工具调用（version 28）LLM 主动用 grep 找文件里**真没有**的一段样式
 *   - grep 返回 `{success:true, output:""}` —— 空字符串
 *   - LLM 推断"没匹配"（本次推对了，下次未必）
 *
 * **本测试钉死**：T2 改造后，grep 0 匹配返清晰文案而非空字符串，下游 LLM 不再
 * 需要"自己推断"——直接看到 `No matches found.` / `No files found.` /
 * `Found 0 total occurrences across 0 files.` 三种 mode 各自的明确反馈。
 *
 * **预期文案**：content / count / files_with_matches 三种 0 匹配输出。
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ReadFileState,
  ToolContext,
} from '@tabtin/agent-runtime';
import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';

// ── 复用 tabcode-adapter.test.ts 同款 fixture ──
let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 't2-replay-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(state?: ReadFileState): ToolContext {
  return {
    threadId: 'test',
    runtimeId: 'test',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: tmpDir,
    readFileState: state,
  };
}

function getTool(name: string) {
  const tools = createTabCodeTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not in createTabCodeTools()`);
  return tool;
}

function parseContent(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

// ── c39cd8b2 calculator.html 节选（仅保留事故关键段）──
const CALCULATOR_HTML_SNIPPET = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>彩色计算器</title>
    <style>
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 25%);
        }

        .display .current {
            color: #00d4ff;
            text-shadow: 0 0 20px rgba(0, 212, 255, 0.5);
        }

        .calculator {
            background: rgba(255, 255, 255, 0.15);
        }

        button:hover {
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
        }

        /* 注意：本片段不含 button::after 涟漪样式，跟事故现场一致 */
        /* —— LLM 想找的"涟漪颜色"在该文件里并不存在 */
        /* —— 注释里有意不写出目标字面量，避免被 grep pattern 自己命中 */
    </style>
</head>
</html>
`;

describe('T8 端到端回放：c39cd8b2 calculator.html grep 事故', () => {
  it('事故场景：LLM grep 找文件里不存在的样式 → 清晰 "No matches found." 文案（非空字符串）', async () => {
    // 模拟 c39cd8b2 version 22-26：用户已改了一些样式，LLM 想找原版的"涟漪
    // 效果"颜色 `rgba(255, 255, 255, 0.4)`——文件里其实没有这段（之前版本
    // 就没 button::after 块），grep 应该 0 匹配。
    await fsPromises.writeFile(
      path.join(tmpDir, 'calculator.html'),
      CALCULATOR_HTML_SNIPPET,
      'utf8',
    );

    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');

    // 复刻 c39cd8b2 version 28 LLM 实际调用：
    // pattern: "rgba\\(255.*0\\.[34]"  (匹配 rgba(255, ..., 0.4) 这种)
    // path: directory（避开 applyHeadLimit single-file regex 副作用——见下方
    //       "已知遗留" 注释；c39cd8b2 实际 LLM 传单文件，但这条不阻塞 T2 修复）
    // output_mode: 'content'（事故里 LLM 显式传了）
    const res = await tool.execute(
      {
        pattern: 'rgba\\(255.*0\\.[34]',
        path: tmpDir,
        output_mode: 'content',
      },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);

    // **事故现场的旧行为**：output: ""（空字符串）—— LLM 自行推断
    // **T2-C1 改造后**：output: "No matches found."
    // 这是事故根因的直接修复
    expect(String(parsed.output)).toBe('No matches found.');
    expect(String(parsed.output)).not.toBe('');
  });

  it('对照场景：LLM grep 找文件里真存在的样式 → 正常返回匹配行', async () => {
    // 验证修复没有破坏 happy path——文件里有 rgba(0, 0, 0, 0.3) 这种
    await fsPromises.writeFile(
      path.join(tmpDir, 'calculator.html'),
      CALCULATOR_HTML_SNIPPET,
      'utf8',
    );

    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');

    // path: directory —— ripgrep 输出 `path:lineNo:content`，applyHeadLimit
    // 现有正则 `^(.*):(\d+):/` 能正确识别 match 行
    const res = await tool.execute(
      {
        pattern: 'rgba\\(0',
        path: tmpDir,
        output_mode: 'content',
      },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(String(parsed.output)).toMatch(/rgba\(0/);
    // 不是 0 匹配文案
    expect(String(parsed.output)).not.toBe('No matches found.');
    // T2-C5 路径 relative：输出含 calculator.html 但不含 tmpDir 绝对路径前缀
    if (process.platform !== 'win32') {
      expect(String(parsed.output)).toContain('calculator.html');
      expect(String(parsed.output)).not.toContain(tmpDir);
    }
  });

  it('files_with_matches 模式下 LLM grep 找不存在的字符串 → "No files found."（默认 mode）', async () => {
    // c39cd8b2 事故里如果 LLM 漏传 output_mode（W4 默认 files_with_matches），
    // 0 匹配应当看到 "No files found." 而非空字符串
    await fsPromises.writeFile(
      path.join(tmpDir, 'calculator.html'),
      CALCULATOR_HTML_SNIPPET,
      'utf8',
    );

    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');

    const res = await tool.execute(
      {
        pattern: 'NEVER_EXIST_IN_THIS_FILE_xyz',
        path: tmpDir,
        // 不传 output_mode → 走 W4 默认 files_with_matches
      },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(String(parsed.output)).toBe('No files found.');
  });

  it('回放 c39cd8b2 message stream：LLM 决策不再依赖空字符串 heuristic', async () => {
    // 完整的事故回放：模拟 LLM 在 calculator.html 上做的两次 grep
    //   1. rgba\(255.*0\.[34] —— 找不存在的涟漪样式 → 应当 No matches found.
    //   2. rgba\(0 —— 找存在的 box-shadow rgba —— 应当返回匹配行
    // LLM 的决策路径不再依赖"output 是不是空字符串"，而是直接看清晰文案。
    await fsPromises.writeFile(
      path.join(tmpDir, 'calculator.html'),
      CALCULATOR_HTML_SNIPPET,
      'utf8',
    );

    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');

    // Round 1: 不存在的 pattern
    const res1 = await tool.execute(
      {
        pattern: 'rgba\\(255.*0\\.[34]',
        path: tmpDir,
        output_mode: 'content',
      },
      ctx,
    );
    const parsed1 = parseContent(res1.content as string);
    expect(parsed1.success).toBe(true);
    // LLM 看到的明确反馈：0 匹配
    expect(String(parsed1.output)).toBe('No matches found.');

    // Round 2: 存在的 pattern
    const res2 = await tool.execute(
      {
        pattern: 'rgba\\(0',
        path: tmpDir,
        output_mode: 'content',
      },
      ctx,
    );
    const parsed2 = parseContent(res2.content as string);
    expect(parsed2.success).toBe(true);
    expect(String(parsed2.output)).toMatch(/rgba\(0/);

    // **关键不变量**：两次 round 的输出**形态明显不同**
    // —— Round 1 是固定文案，Round 2 是 ripgrep 实际匹配行
    // —— LLM 不需要"空字符串 vs 非空字符串"的微妙推断
    expect(parsed1.output).not.toEqual(parsed2.output);
  });
});

// ─── 已知遗留（T2 范围之外，加进 PRD §十 follow-up） ─────────────────
//
// **applyHeadLimit 单文件 content 模式的 match-line 识别 regex 不全**：
//   - ripgrep 输出格式：
//     - 多文件搜索：`path:lineNo:content`（含 path 前缀）
//     - 单文件搜索：`lineNo:content`（无 path）
//   - 现有 regex `/^(.*):(\d+):/` 只识别 multi-file 格式 → 单文件 content 模式
//     有匹配时，applyHeadLimit 把 matchLines 当作 0，触发 `(no matches in this page)`
//     fallback 文案
//   - **影响**：c39cd8b2 LLM 实际传单文件路径，事故时 grep "找不到" + 这个 bug
//     双重 mask；T2 修了 0 匹配文案，但单文件**有匹配**场景下分页 / 截断信号
//     仍不准
//   - **修法**：applyHeadLimit content 模式同时识别 `^(.*):(\d+):` （多文件）
//     和 `^(\d+):` （单文件）两种形态——见 PRD §十 follow-up 第 9 条
//   - **本测试规避**：所有 e2e 用 directory path（multi-file 输出格式），完整
//     钉死 T2 9 个 C 改动效果；单文件 regex 修复留 follow-up

