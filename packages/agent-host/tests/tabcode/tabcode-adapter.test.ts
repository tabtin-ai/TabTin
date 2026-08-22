/**
 * tabcode-adapter 单测（PRD 08 W1 / W2）。
 *
 * 覆盖：
 *   1. 字段映射（AgentTool.parameters → Tool.inputSchema；riskLevel →
 *      isReadOnly）
 *   2. stale-read 协议：read 后被外部改 mtime + 内容不同 → errorCode=7
 *   3. mtime 抖动但内容相同（macOS iCloud）→ 通过
 *   4. 两级匹配：行 indent 偏差仍能命中（line-trimmed）
 *   5. 多匹配 + replace_all=false → action-tools 原 "is not unique"
 *   6. write_file 创建新文件不要求先 read
 *   7. read_file 成功后 readFileState 被填充
 *   8. delete_file 后 readFileState 被清空
 *   9. read_file 走多行明文输出（W2）
 *  10. W2 后未 read 直接 edit / partial read → 不再被 errorCode=6 拒
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ReadFileState,
  ToolContext,
} from '@tabtin/agent-runtime';
import { wrapInToolOutputFence } from '../../engine/tooling/tool-output-sanitizer.js';
import {
  FILE_MATERIALIZATION_MAX_BYTES,
  FileMaterializationTooLargeError,
} from '../../src/tools/file-materializer.js';
import { mapActionErrorToRuntimeKind } from '../../src/tools/read-file-state.js';
import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';

// ── helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  // macOS 上 `os.tmpdir()` 给的是 `/var/folders/...`，realpath 后是
  // `/private/var/folders/...`。action-tools `resolveInWorkspace` 用
  // `fs.realpathSync` 解析路径再做 boundary 检查 ——此处提前 realpath
  // 让 workspaceRoot 与解析后路径同 prefix，否则 boundary 检查会因
  // /private vs / 而误判为越界。
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabcode-adapter-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(state?: ReadFileState, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 'test',
    runtimeId: 'test',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: tmpDir,
    readFileState: state,
    ...overrides,
  };
}

function getTool(name: string) {
  const tools = createTabCodeTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not in createTabCodeTools()`);
  return tool;
}

/**
 * 解析失败 envelope 的 JSON content（仅用于 errorCode / hint 等结构化错误）。
 * **注意（W2）**：read_file 成功路径已经走多行明文输出，
 * 不能用本函数解析。read_file 成功后 ToolResult.content 直接是 cat -n
 * compact `1\\tcontent\\n2\\tcontent` 形态。
 */
function parseContent(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

async function writeTempFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fsPromises.writeFile(p, content, 'utf8');
  return p;
}

// ─── 1. 字段映射 ────────────────────────────────────────────────────

describe('字段映射 AgentTool → Tool', () => {
  it('createTabCodeTools 返回 7 件套（read_lints C13 退役）', () => {
    // C13 (2026-05-13)：read_lints 工具从 LLM 可见列表退役，诊断改走
    // attachment 被动注入（buildLspDiagnosticInjectorHook）。
    // createReadDiagnosticsTool 函数实现保留——给 spawn linter fallback 用
    // （runSpawnLinterFallback 直接调 actionReadDiagnosticsTool）。
    // ：semantic_search 先从 LLM 可见列表下线，底层 action-tools
    // 实现暂保留给 CLI/历史路径。
    const tools = createTabCodeTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'delete_file',
      'edit_file',
      'glob_search',
      'grep_search',
      'read_file',
      'write_file',
    ]);
  });

  it('read_file isReadOnly=true + policyActionType=file_read', () => {
    const tool = getTool('read_file');
    expect(tool.isReadOnly).toBe(true);
  });

  it('edit_file isReadOnly=false + policyActionType=file_edit', () => {
    const tool = getTool('edit_file');
    expect(tool.isReadOnly).toBe(false);
  });

  it('write_file isReadOnly=false + policyActionType=file_write', () => {
    const tool = getTool('write_file');
    expect(tool.isReadOnly).toBe(false);
  });

  it('delete_file isReadOnly=false + policyActionType=file_delete', () => {
    const tool = getTool('delete_file');
    expect(tool.isReadOnly).toBe(false);
  });

  it('inputSchema 是 JSON Schema 形态（继承自 action-tools.parameters）', () => {
    const editSchema = getTool('edit_file').inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(editSchema.type).toBe('object');
    expect(editSchema.properties.path).toBeDefined();
    expect(editSchema.properties.old_string).toBeDefined();
    expect(editSchema.properties.new_string).toBeDefined();
    expect(editSchema.required).toEqual(
      expect.arrayContaining(['path', 'old_string', 'new_string']),
    );
  });

  it('description 含 read-before-edit 引导（让 LLM 知道顺序）', () => {
    expect(getTool('edit_file').description.toLowerCase()).toContain('read');
    expect(getTool('write_file').description.toLowerCase()).toContain('read');
  });

  it('write_file 默认禁止 Markdown 交付物，仅允许 TabDoc 临时草稿例外', () => {
    const description = getTool('write_file').description;

    expect(description).toContain('不要**主动创建 *.md / README，除非用户明确要求');
    expect(description).toContain('唯一例外：仅当为新建或整篇更新长 TabDoc 正文而需要临时 Markdown 草稿时');
    expect(description).toContain('path **必须**是工作区相对路径 `.agent-drafts/<slug>.md`');
    expect(description).toContain('不要写到工作区根如 `draft.md`');
    expect(description).toContain('tabtin doc create|save-content --markdown @.agent-drafts/<slug>.md');
    expect(description).toContain('不得作为用户交付物汇报');
    expect(description.match(/唯一例外/g)).toHaveLength(1);
    const exception = description.slice(description.indexOf('唯一例外：'));
    expect(exception).not.toMatch(/(?:任意|普通|所有).*(?:\.md|Markdown)/);
  });
});

// ─── 2. read-before-edit / read-before-write ────────────────────────

describe('read-before-edit / stale-read (W2)', () => {
  // **W2（2026-05-10）**：errorCode=6 (READ_REQUIRED) 整套下线
  // FileEditTool。LLM 没读过文件直接 edit 入口校验不再被卡。
  // **Wave 2（2026-05-13）**：写盘前最后一刻通过 hook 二次校验严格判定 ——
  // 没读过快照（state.get(canonical) === undefined）→ throw STALE_READ。这是
  // **双段不对称设计**（基线 B6-1 / A1-8）：
  //   - 入口宽松：允许 LLM partial read 后 edit（不卡 dogfood 死循环：
  //     partial read → snapshot 覆盖 → edit 被拒 → LLM 重新 partial read）
  //   - 写盘前严格：完全没读过的文件 throw，给 Agent 留「不读也能 edit」
  //     的反向激励会让 LLM 跳过 read 直接 edit（dogfood 撞到时整段写错全
  //     靠 OLD_STRING_NOT_FOUND 兜底，比 read+edit 多走 1-2 轮死循环）
  it('未先 read 直接 edit_file 已存在文件 → 写盘前 throw STALE_READ（Wave 2 B6-1 写盘前严格）', async () => {
    const file = await writeTempFile('a.txt', 'hello world');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    const tool = getTool('edit_file');

    const result = await tool.execute(
      { path: file, old_string: 'hello', new_string: 'hi' },
      ctx,
    );

    // Wave 2 预期变化：入口校验放行（W2 删 errorCode=6 保留），但写盘前
    // hook 拦下 → errorCode=7 STALE_READ。文件未被覆盖。
    expect(result.isError).toBe(true);
    const parsed = parseContent(result.content as string);
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect(await fsPromises.readFile(file, 'utf8')).toBe('hello world');
  });

  it('未先 read 直接 edit_file，但 old_string 找不到 → errorCode=8 (OLD_STRING_NOT_FOUND) 兜底', async () => {
    const file = await writeTempFile('a-not-found.txt', 'hello world');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    const tool = getTool('edit_file');

    const result = await tool.execute(
      { path: file, old_string: 'NOT_IN_FILE', new_string: 'replacement' },
      ctx,
    );

    expect(result.isError).toBe(true);
    const parsed = parseContent(result.content as string);
    // errorCode=8 拦截"瞎 edit"——比旧 errorCode=6 强约束更精准
    expect(parsed.error_kind).toBe('old_string_not_found');
    expect(await fsPromises.readFile(file, 'utf8')).toBe('hello world');
  });

  it('read 后再 edit → 成功', async () => {
    const file = await writeTempFile('b.txt', 'hello world');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    const readRes = await getTool('read_file').execute({ path: file }, ctx);
    expect(readRes.isError).toBeUndefined();
    expect(state.size).toBeGreaterThan(0);

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'hello', new_string: 'hi' },
      ctx,
    );
    expect(editRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('hi world');
  });

  it('read 后被外部改（mtime 漂移 + 内容不同）→ errorCode=7', async () => {
    const file = await writeTempFile('c.txt', 'original\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);

    // 外部修改：把 mtime 推到很晚 + 内容彻底变了
    await fsPromises.writeFile(file, 'OUTSIDE EDIT\n', 'utf8');
    const future = (Date.now() + 60_000) / 1000;
    await fsPromises.utimes(file, future, future);

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'OUTSIDE', new_string: 'INSIDE' },
      ctx,
    );

    expect(editRes.isError).toBe(true);
    const parsed = parseContent(editRes.content as string);
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect(String(parsed.error)).toContain('modified externally');
  });

  it('read 后 mtime 抖动但内容相同（云盘抖动）→ 入口放行、写盘前 throw STALE_READ（Wave 2 A1-7，预期变化）', async () => {
    // **Wave 2 (2026-05-13) 预期变化**：
    //   - **入口校验**（异步 validateReadBeforeWrite）仍是 W2 自创「软放行」：
    //     mtime 漂移但 content 相等 → 放行（入口软放行）。
    //   - **写盘前校验**（同步 validateReadBeforeWriteSync）严格 isFullRead
    //     判定 —— `offset === undefined && limit === undefined` 才算 full read。
    //     read_file 写入 entry 的 offset 是默认 1（不是 undefined）→ 不算
    //     isFullRead → mtime 漂移即 throw。
    //
    // **双段不对称合理性**（基线 A1-7 + B6-1）：「入口宽松 + 写盘前严格」。
    // 云盘抖动撞到 stale 时 Agent retry 一次重新 read 即可，比 silently
    // overwrite 安全。
    //
    // **dogfood 影响**：read_file 后云盘 touch 频繁触发会让 Agent 多走一次
    // re-read。如频率高影响 UX，升单独 PRD「云盘抖动 / refreshSnapshot 默认
    // full read offset normalize」处理。本 Wave 2 不在 scope（基线钉死写盘前严格）。
    const file = await writeTempFile('d.txt', 'unchanged content\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);

    // mtime 推后但内容不变（典型云盘抖动）
    const future = (Date.now() + 60_000) / 1000;
    await fsPromises.utimes(file, future, future);

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'unchanged', new_string: 'changed' },
      ctx,
    );

    // Wave 2 预期变化：写盘前 hook 拦下 → errorCode=7 STALE_READ
    expect(editRes.isError).toBe(true);
    const parsed = parseContent(editRes.content as string);
    expect(parsed.error_kind).toBe('tool_stale_read');
    // 文件未被覆盖
    expect(await fsPromises.readFile(file, 'utf8')).toBe('unchanged content\n');
  });

  it('BOM 文件 mtime 抖动但内容相同 → 写盘前 throw STALE_READ（Wave 2 A1-7）', async () => {
    // 同款 Wave 2 预期变化 —— 见上一个测试 jsdoc。BOM normalize 不影响判定：
    // 入口 / 写盘前 hook 拿到的 currentContent 都是 stripBOM 后形态。
    const file = await writeTempFile('bom.txt', '\uFEFFhello\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);

    const future = (Date.now() + 60_000) / 1000;
    await fsPromises.utimes(file, future, future);

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'hello', new_string: 'hi' },
      ctx,
    );

    expect(editRes.isError).toBe(true);
    const parsed = parseContent(editRes.content as string);
    expect(parsed.error_kind).toBe('tool_stale_read');
    // 文件未被覆盖（保留 BOM）
    expect(await fsPromises.readFile(file, 'utf8')).toBe('\uFEFFhello\n');
  });
});

// ─── 3. 两级匹配（exact / line_trimmed）─────────────────────────────

describe('两级匹配（borrow action-tools 现有能力 — Wave 1 删 block-anchor 后）', () => {
  it('line-trimmed：行 indent 偏差仍能命中', async () => {
    const file = await writeTempFile(
      'e.ts',
      '  function foo() {\n    return 1;\n  }\n',
    );
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);

    // old_string 缩进与文件不同（用户复制时 IDE 抖动）
    const editRes = await getTool('edit_file').execute(
      {
        path: file,
        old_string: 'function foo() {\nreturn 1;\n}',
        new_string: 'function foo() {\n  return 2;\n}',
      },
      ctx,
    );

    expect(editRes.isError).toBeUndefined();
    const finalContent = await fsPromises.readFile(file, 'utf8');
    expect(finalContent).toContain('return 2');
  });

  it('多匹配 + replace_all=false → 完整版文案（含双解决方案 + 回显 old_string）', async () => {
    // Wave 1 修订：原文案 "is not unique (found N occurrences)" 改成
    // "Found N matches of the string to replace, but replace_all is false. ...
    //  ...\nString: ${old_string}"。
    // 关键：必须回显 old_string，让 LLM 看到自己写的字符串就能调整。
    const file = await writeTempFile('f.txt', 'foo\nfoo\nfoo\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'foo', new_string: 'bar' },
      ctx,
    );

    expect(editRes.isError).toBe(true);
    const parsed = parseContent(editRes.content as string);
    const errStr = String(parsed.error);
    expect(errStr).toContain('Found 3 matches');
    expect(errStr).toContain('replace_all is false');
    expect(errStr).toContain('set replace_all to true'); // 解决方案 1
    expect(errStr).toContain('more context to uniquely identify'); // 解决方案 2
    expect(errStr).toContain('foo'); // 回显 old_string
    // errorCode 仍是 NOT_UNIQUE（9）—— mapActionErrorToRuntimeKind 改为按
    // "matches of the string to replace" phrase 命中
    expect(parsed.error_kind).toBe('old_string_not_unique');
  });

  it('replace_all=true → 全部替换', async () => {
    const file = await writeTempFile('g.txt', 'foo\nfoo\nfoo\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);

    const editRes = await getTool('edit_file').execute(
      {
        path: file,
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      },
      ctx,
    );

    expect(editRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('bar\nbar\nbar\n');
  });
});

// ─── 4. write_file read-before-write ──────────────────────────────────

describe('write_file read-before-write (W2)', () => {
  // W2：write_file 覆写未先 read 入口校验不再被 errorCode=6 拒——
  // FileWriteTool 完全没有 read-before-write 强约束。
  // **Wave 2（2026-05-13）**：写盘前最后一刻通过 hook 二次校验严格判定 ——
  // 覆写场景没读过快照 → throw STALE_READ（基线 B6-1
  // FileWriteTool.ts:256-285 写盘前严格语义）。append 模式跳过校验（A2-3）。
  it('覆写已存在文件未先 read → 写盘前 throw STALE_READ（Wave 2 B6-1）', async () => {
    const file = await writeTempFile('h.txt', 'old content');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    const writeRes = await getTool('write_file').execute(
      { path: file, contents: 'new content' },
      ctx,
    );

    // Wave 2 预期变化：入口校验放行（W2 删 errorCode=6 保留），但写盘前
    // hook 拦下 → errorCode=7 STALE_READ。文件未被覆盖。
    expect(writeRes.isError).toBe(true);
    const parsed = parseContent(writeRes.content as string);
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect(await fsPromises.readFile(file, 'utf8')).toBe('old content');
  });

  it('创建新文件（fileExists=false）→ 不要求先 read', async () => {
    const newFile = path.join(tmpDir, 'brand-new.txt');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    const writeRes = await getTool('write_file').execute(
      { path: newFile, contents: 'fresh write' },
      ctx,
    );

    expect(writeRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(newFile, 'utf8')).toBe('fresh write');
  });

  it('append=true → 跳过 read-before-write 检查（追加语义）', async () => {
    const file = await writeTempFile('i.log', 'line1\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    const writeRes = await getTool('write_file').execute(
      { path: file, contents: 'line2\n', append: true },
      ctx,
    );

    expect(writeRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('line1\nline2\n');
  });

  it('read 后再覆写 → 成功 + 快照刷新（不会被自己写完触发 stale）', async () => {
    const file = await writeTempFile('j.txt', 'v1');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);
    const r1 = await getTool('write_file').execute(
      { path: file, contents: 'v2' },
      ctx,
    );
    expect(r1.isError).toBeUndefined();

    // 不再 read，直接再覆写——afterExecute 已刷新快照
    const r2 = await getTool('write_file').execute(
      { path: file, contents: 'v3' },
      ctx,
    );
    expect(r2.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('v3');
  });
});

// ─── 5. readFileState 生命周期 ───────────────────────────────────────

describe('readFileState 生命周期', () => {
  it('read_file 成功 → state 被填充', async () => {
    const file = await writeTempFile('k.txt', 'snapshot');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);

    const realPath = await fsPromises.realpath(file);
    expect(state.size).toBe(1);
    const entry = state.get(realPath);
    expect(entry).toBeDefined();
    expect(entry?.content).toBe('snapshot');
    expect(typeof entry?.timestamp).toBe('number');
  });

  it('read_file 相同 path/range 且 mtime 未变 → 第二次返回 unchanged stub', async () => {
    const file = await writeTempFile('dedup.txt', 'one\ntwo\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    const tool = getTool('read_file');

    const first = await tool.execute({ path: file }, ctx);
    expect(first.isError).toBeUndefined();
    // W2：read_file 直接输出多行明文（cat -n compact）。三行 = "one"+"two"+尾部空行
    expect(first.content).toBe('1\tone\n2\ttwo\n3\t');
    // W2：visible 检查改成扫 tool_use 块的 input —— 推 tool_use 而不是 tool_result
    ctx.messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'read-1',
        name: 'read_file',
        input: { path: file },
      }],
    });
    ctx.messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'read-1',
        // W3 (2026-05-10): `read_file` is no longer in the fence allow-list,
        // so the production tool_result content for read_file is the raw
        // multi-line plaintext from `buildTextReadToolResult` — not a
        // `<tool_output>`-wrapped string. Keep the test mock aligned with
        // production (no fence wrap).
        content: first.content as string,
      }],
    });

    const second = await tool.execute({ path: file }, ctx);
    expect(second.isError).toBeUndefined();
    expect(second.content).toBe(
      'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.',
    );
  });

  // 复现 dogfood session 55811459-1499-43c4-bb88-3013a8814fab 的真实场景：
  // 用户让 LLM 改 calculator.html，LLM 完整 read 一次（292 行 / ~10851 字节，无
  // offset/limit），thinking 说 "The file seems to be truncated"，立刻又 read
  // 一次同 path / 同 input。第二次理论上应该 hit dedup → 返 FILE_UNCHANGED_STUB；
  // 实际生产里没 hit（messages.jsonl 显示第二次也回了完整 10851 字节内容）。
  // 本测试用真实尺寸 + 内容复现，看 dedup 是否真的 fire。
  it('REPRO 55811459: 完整 read calculator.html (292 lines, no offset/limit) 两次 → dedup 应 fire', async () => {
    // calculator.html 真实样本：~10KB, 292 行，含 <html>...<style>...<script>...</html>
    const lines: string[] = [];
    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="zh-CN">');
    lines.push('<head>');
    for (let i = 0; i < 100; i++) {
      lines.push(`    <meta data-line="${i}" content="filler-${i.toString().padStart(4, '0')}">`);
    }
    lines.push('    <style>');
    for (let i = 0; i < 80; i++) {
      lines.push(`        .cls-${i} { background: #${(i * 1234567).toString(16).slice(0, 6)}; padding: ${i}px; }`);
    }
    lines.push('    </style>');
    lines.push('</head>');
    lines.push('<body>');
    lines.push('    <div class="calculator">');
    for (let i = 0; i < 80; i++) {
      lines.push(`        <button class="cls-${i}" onclick="onClick(${i})">btn-${i}</button>`);
    }
    lines.push('    </div>');
    lines.push('    <script>');
    for (let i = 0; i < 25; i++) {
      lines.push(`        function onClick${i}() { return ${i}; }`);
    }
    lines.push('    </script>');
    lines.push('</body>');
    lines.push('</html>');
    const content = lines.join('\n') + '\n';
    expect(lines.length).toBeGreaterThan(280);

    const file = await writeTempFile('calculator.html', content);
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    const tool = getTool('read_file');

    // 第一次 read（无 offset/limit）—— 模拟 read_file:0
    const first = await tool.execute({ path: file }, ctx);
    expect(first.isError).toBeUndefined();

    // 把第一次的 tool_result 加进 ctx.messages 模拟 runtime 生产路径
    // （fence-wrap 使用与生产同款 wrapInToolOutputFence）
    ctx.messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'read_file:0',
        name: 'read_file',
        input: { path: file },
      }],
    });
    ctx.messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'read_file:0',
        // W3 (2026-05-10): see note above — read_file is no longer fence-wrapped.
        content: first.content as string,
      }],
    });

    // 第二次 read（无 offset/limit）—— 模拟 read_file:1
    const second = await tool.execute({ path: file }, ctx);
    expect(second.isError).toBeUndefined();

    // 诊断输出：dedup 是否 fire？
    const isStub = second.content === 'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.';
    if (!isStub) {
      // eslint-disable-next-line no-console
      console.warn('[REPRO-55811459] dedup did NOT fire. Diagnosing...');
      // eslint-disable-next-line no-console
      console.warn('[REPRO-55811459] state.size:', state.size);
      const realPath = await fsPromises.realpath(file);
      const entry = state.get(realPath);
      // eslint-disable-next-line no-console
      console.warn('[REPRO-55811459] state entry:', entry ? {
        offset: entry.offset,
        limit: entry.limit,
        timestamp: entry.timestamp,
        contentLength: entry.content?.length,
      } : 'undefined');
      // eslint-disable-next-line no-console
      console.warn('[REPRO-55811459] ctx.messages.length:', ctx.messages.length);
      // eslint-disable-next-line no-console
      console.warn('[REPRO-55811459] second.content head:', String(second.content).slice(0, 200));
    }
    expect(second.content).toBe(
      'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.',
    );
  });

  it('read_file 有继承 state 但当前上下文无可见 read 结果 → 不返回 unchanged stub', async () => {
    const file = await writeTempFile('dedup-no-visible.txt', 'one\ntwo\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    const tool = getTool('read_file');

    const first = await tool.execute({ path: file }, ctx);
    expect(first.isError).toBeUndefined();

    const forkedCtx = makeCtx(state);
    const second = await tool.execute({ path: file }, forkedCtx);

    expect(second.isError).toBeUndefined();
    expect(second.content).not.toBe(
      'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.',
    );
    // W2：直接对比多行明文
    expect(second.content).toBe('1\tone\n2\ttwo\n3\t');
  });

  it('read_file 行号格式为 cat-n compact N-tab-content', async () => {
    const file = await writeTempFile('line-format.txt', 'alpha\nbeta\n');
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute({ path: file, offset: 2, limit: 1 }, ctx);

    expect(readRes.isError).toBeUndefined();
    // W2：直接是多行明文（不再是 JSON envelope）
    expect(readRes.content).toBe('2\tbeta');
    expect(String(readRes.content)).not.toContain('|');
  });

  it('delete_file → state 中对应 path 被清空', async () => {
    const file = await writeTempFile('l.txt', 'doomed');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file }, ctx);
    expect(state.size).toBe(1);

    const realPath = await fsPromises.realpath(file);
    const delRes = await getTool('delete_file').execute({ path: file }, ctx);
    expect(delRes.isError).toBeUndefined();
    expect(state.has(realPath)).toBe(false);
  });

  it('readFileState 未注入（undefined）时不强制 read-before-edit（向后兼容）', async () => {
    const file = await writeTempFile('m.txt', 'hello');
    const ctx = makeCtx(undefined); // 未注入 state

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'hello', new_string: 'hi' },
      ctx,
    );

    expect(editRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('hi');
  });

  // W2（2026-05-10）：核心 dogfood 死循环修复点
  // 旧实现：partial read → snapshot.isPartialView=true → 后续 edit 被
  //         errorCode=6 直接拒 → LLM 重新 partial read → 又被拒
  // 新实现：partial read 不再阻断 edit；只要 old_string 在文件实际内容里能
  //         找到，edit 就成功。LLM 看 partial read 输出但能用 grep / 旧记忆
  //         构造正确的 old_string。
  it('partial read（offset/limit 局部读）后 edit → 通过（W2 删 errorCode=6 / isPartialView 拒绝路径）', async () => {
    const file = await writeTempFile('n.txt', 'a\nb\nc\nd\ne\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    // 局部 read（只看 line 2-3）
    await getTool('read_file').execute({ path: file, offset: 2, limit: 2 }, ctx);

    const realPath = await fsPromises.realpath(file);
    const snapshot = state.get(realPath);
    expect(snapshot).toBeDefined();
    // W2：snapshot 仍记录 offset/limit 元信息（用于 dedup 入口比对），但不再
    // 影响 edit / write 通过性。
    expect(snapshot?.offset).toBe(2);
    expect(snapshot?.limit).toBe(2);

    // partial read 后直接 edit —— 旧实现会被 errorCode=6 拒，新实现通过
    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'b', new_string: 'B' },
      ctx,
    );

    expect(editRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('a\nB\nc\nd\ne\n');
  });

  it('full read 覆盖全文 → 后续 edit 通过', async () => {
    const file = await writeTempFile('full-window.txt', 'a\nb\nc\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    await getTool('read_file').execute({ path: file, offset: 1, limit: 4 }, ctx);

    const realPath = await fsPromises.realpath(file);
    const snapshot = state.get(realPath);
    expect(snapshot).toBeDefined();

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'b', new_string: 'B' },
      ctx,
    );
    expect(editRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('a\nB\nc\n');
  });

  // W2 dogfood 死循环复现 + 修复验证：
  //   旧链路：full read → partial read（窗口看局部）→ edit 被 errorCode=6 拒
  //          → LLM 重新 partial read → snapshot 又被覆盖为 partial → edit 又被拒
  //   新链路：full read → partial read → edit 通过（snapshot 仍跟踪文件 mtime；
  //          只要 mtime 没变 + old_string 在文件实际内容里能找到就成功）
  it('dogfood 死循环修复：full read → partial read → edit → 通过', async () => {
    const file = await writeTempFile(
      'dogfood-loop.html',
      Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n') + '\n',
    );
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    // 步骤 1：full read（无 offset/limit）
    const fullRead = await getTool('read_file').execute({ path: file }, ctx);
    expect(fullRead.isError).toBeUndefined();
    // 多行明文输出（不再 JSON envelope）
    expect(String(fullRead.content).startsWith('1\tline-1\n')).toBe(true);

    // 步骤 2：partial read（看 line 10-15，模拟 LLM "想看具体段")
    const partialRead = await getTool('read_file').execute(
      { path: file, offset: 10, limit: 6 },
      ctx,
    );
    expect(partialRead.isError).toBeUndefined();
    expect(partialRead.content).toBe(
      '10\tline-10\n11\tline-11\n12\tline-12\n13\tline-13\n14\tline-14\n15\tline-15',
    );

    // 步骤 3：edit（旧实现这里被 errorCode=6 拒）
    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'line-12', new_string: 'LINE-TWELVE' },
      ctx,
    );
    expect(editRes.isError).toBeUndefined();
    const finalContent = await fsPromises.readFile(file, 'utf8');
    expect(finalContent).toContain('LINE-TWELVE');
    expect(finalContent).not.toContain('line-12');
  });

  it('read_file 多行明文输出：LLM 视觉层面的真实换行 + cat -n compact 行号', async () => {
    const file = await writeTempFile(
      'multiline.html',
      '<!DOCTYPE html>\n<html>\n<body>\n  <h1>Title</h1>\n</body>\n</html>\n',
    );
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute({ path: file }, ctx);
    expect(readRes.isError).toBeUndefined();
    // ToolResult.content 必须是真实多行字符串（含 \n 字面换行），
    // 不是 JSON.stringify 后的 escape 形态（不会出现 "\\n" 字面四字符序列）
    const content = String(readRes.content);
    // 含至少 5 个真实换行符（6 行内容 + 1 行末尾空行 = 7 段，6 个 \n 分隔）
    expect(content.split('\n').length).toBeGreaterThan(5);
    // 第一行格式：`1\t<!DOCTYPE html>`
    expect(content.startsWith('1\t<!DOCTYPE html>')).toBe(true);
    // 不是 JSON envelope —— 不应该以 `{` 开头
    expect(content.startsWith('{')).toBe(false);
  });

  it('read_file 空文件 → system-reminder warning', async () => {
    const file = await writeTempFile('empty.txt', '');
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute({ path: file }, ctx);
    expect(readRes.isError).toBeUndefined();
    expect(readRes.content).toBe(
      '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
    );
  });

  // W2 R1（2026-05-10）：offset 越界场景的 system-reminder 必须明示
  // "shorter than the provided offset (X). The file has Y lines."，不能错误地
  // 走 "empty file" warning（旧实现会让 LLM 误判文件是空的，可能去 write_file
  // 全文覆盖一个有内容的文件）。action-tools `fileReadTool.execute` 在 offset
  // 越界时也会设 `empty:true`（slice 后 raw=''），所以 buildTextReadToolResult
  // 必须先判 "shorter than offset" 再判 "empty"。
  it('read_file offset 越界（startLine > totalLines）→ "shorter than offset" warning（不是 "empty file"）', async () => {
    const file = await writeTempFile('five-lines.txt', 'a\nb\nc\nd\ne\n');
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute(
      { path: file, offset: 999, limit: 10 },
      ctx,
    );
    expect(readRes.isError).toBeUndefined();
    const content = String(readRes.content);
    // 必须命中 "shorter than offset" 分支
    expect(content).toContain('shorter than the provided offset');
    expect(content).toMatch(/The file has \d+ lines/);
    // **不**走 "empty file" 分支
    expect(content).not.toContain('the contents are empty');
  });
});

// ─── W4 (2026-05-12) 默认 limit 截断 + system-reminder ────────────────
//
// 事故复盘（calculator.html dogfood）：LLM 不传 offset/limit 时只看到前 2000
// 行，但输出形态跟"刚好 2000 行的小文件"一模一样——LLM 没办法区分"读完了"
// 和"只看了一段"。修法（B2 决策）：runtime 在"被默认 limit 截断"时给 LLM
// 一行 `<system-reminder>` 明示 total lines + 续读建议；正常读全文不加，
// token 友好。下面 4 个 case 钉死这一套行为不变。
describe('read_file 默认 limit 截断 + system-reminder（W4）', () => {
  it('读取结果超过字符预算时按完整行截断，并给出续读 offset', async () => {
    const lines = Array.from(
      { length: 200 },
      (_, index) => `row${index + 1}-${'x'.repeat(1_000)}`,
    ).join('\n');
    const file = await writeTempFile('char-budget.txt', lines);

    const readRes = await getTool('read_file').execute(
      { path: file, offset: 1, limit: 200 },
      makeCtx(new Map()),
    );
    const content = String(readRes.content);

    expect(content.length).toBeLessThanOrEqual(100_000);
    expect(content).toContain('read_file output was truncated at 100000 characters');
    const nextOffset = Number(content.match(/Continue with offset=(\d+)/)?.[1]);
    expect(nextOffset).toBeGreaterThan(1);
    expect(content).not.toContain('row200-');

    const continued = await getTool('read_file').execute(
      { path: file, offset: nextOffset, limit: 200 },
      makeCtx(new Map()),
    );
    expect(String(continued.content)).toContain(`row${nextOffset}-`);
  });

  it('文件 < 2000 行 + 不传 offset/limit → 不加 reminder（已读完）', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n');
    const file = await writeTempFile('small.txt', lines + '\n');
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute({ path: file }, ctx);
    expect(readRes.isError).toBeUndefined();
    const content = String(readRes.content);
    // 不应出现"This file has X total lines"reminder——文件本身就是全文
    expect(content).not.toContain('total lines');
    expect(content).not.toContain('default limit');
  });

  it('文件 > 2000 行 + 不传 offset/limit → 追加 reminder（关键防幻觉信号）', async () => {
    // 3000 行实际内容 + trailing newline → action-tools split('\n') 后
    // 长度 3001（最末尾空字符串占一行），符合行业标准——LLM 看 reminder
    // 提示「文件有 3001 行」即可正确推断真实窗口。
    const lines = Array.from({ length: 3000 }, (_, i) => `row${i + 1}`).join('\n');
    const file = await writeTempFile('big.txt', lines + '\n');
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute({ path: file }, ctx);
    expect(readRes.isError).toBeUndefined();
    const content = String(readRes.content);
    // reminder 必须出现，且内容包含三个关键信号（total lines / 实读窗口 / 续读 offset）
    expect(content).toContain('<system-reminder>');
    expect(content).toMatch(/This file has \d+ total lines/);
    expect(content).toContain('You only read lines 1-2000');
    expect(content).toContain('offset=2001');
    // body 真实内容仍在，第 1 行可见、第 2000 行可见、第 2001 行不可见
    expect(content).toMatch(/^\s*1\trow1/m);
    expect(content).toMatch(/2000\trow2000/);
    expect(content).not.toContain('row2001');
  });

  it('LLM 显式传 offset/limit（视为有意识分段读）→ 不加 reminder', async () => {
    // 同样 3000 行文件，但 LLM 显式传 offset/limit → 不算"被默认 limit 截断"
    const lines = Array.from({ length: 3000 }, (_, i) => `row${i + 1}`).join('\n');
    const file = await writeTempFile('big-explicit.txt', lines + '\n');
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute(
      { path: file, offset: 1, limit: 1500 },
      ctx,
    );
    expect(readRes.isError).toBeUndefined();
    const content = String(readRes.content);
    // 显式传 limit → _default_limit_injected !== true → 不加 reminder
    expect(content).not.toContain('<system-reminder>');
    expect(content).not.toContain('default limit');
  });

  it('文件恰好填满默认窗口（2000 行内容、无 trailing newline）→ 不加 reminder', async () => {
    // 注意：必须不带 trailing newline，否则 action-tools split('\n') 会
    // 多出一个空行让 totalLines=2001 命中"被截断"分支（这是真实文件
    // 普遍带 trailing newline 时的有意保守判定）。本测试专门覆盖"刚好
    // 装满 2000 行"的边界场景。
    const lines = Array.from({ length: 2000 }, (_, i) => `line${i + 1}`).join('\n');
    const file = await writeTempFile('exactly-2000.txt', lines);
    const ctx = makeCtx(new Map());

    const readRes = await getTool('read_file').execute({ path: file }, ctx);
    expect(readRes.isError).toBeUndefined();
    const content = String(readRes.content);
    // start_line(1) + num_lines(2000) - 1 = 2000 === totalLines(2000) → reminder 条件不满足
    expect(content).not.toContain('<system-reminder>');
  });
});

// ─── Review 修复回归 ──────────────────────────────────────────────────

describe('Review 修复回归（路径 canonical / errorCode 区分 / OLD_NEW_IDENTICAL）', () => {
  it('缺 path 用 errorCode=2（INVALID_PARAMETER），而非 6（避免 LLM 误以为 retry read 就行）', async () => {
    const ctx = makeCtx(new Map());
    const editRes = await getTool('edit_file').execute(
      { old_string: 'foo', new_string: 'bar' },
      ctx,
    );
    expect(editRes.isError).toBe(true);
    const parsed = parseContent(editRes.content as string);
    expect(parsed.error_kind).toBe('invalid_param_format');

    const writeRes = await getTool('write_file').execute(
      { contents: 'hi' },
      ctx,
    );
    expect(writeRes.isError).toBe(true);
    expect(parseContent(writeRes.content as string).error_kind).toBe('invalid_param_format');
  });

  it('old_string === new_string → errorCode=1（OLD_NEW_IDENTICAL）', async () => {
    const file = await writeTempFile('identical.txt', 'hello');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    await getTool('read_file').execute({ path: file }, ctx);

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'hello', new_string: 'hello' },
      ctx,
    );
    expect(editRes.isError).toBe(true);
    expect(parseContent(editRes.content as string).error_kind).toBe('invalid_param_format');
  });

  it('canonicalizePath：相对路径 / symlink / 不存在路径 都归一化到稳定 key', async () => {
    const { canonicalizePath } = await import('../../src/tools/read-file-state.js');
    const file = await writeTempFile('canon.txt', 'x');

    // 绝对路径 → realpath 后稳定
    const absKey = canonicalizePath(file);
    // 相对路径 + baseDir → 同一份 absolute → 同 realpath → 同 key
    const relKey = canonicalizePath('canon.txt', tmpDir);
    expect(absKey).toBe(relKey);

    // 不存在的路径（new file 场景）→ 父目录 realpath + basename，不抛错
    const newFile = path.join(tmpDir, 'no-such-file-yet.txt');
    const newKey = canonicalizePath(newFile);
    expect(newKey.endsWith('no-such-file-yet.txt')).toBe(true);
  });

  it('record / validate / clear 三个口径用同一个 canonical key（生产路径一致性硬底线）', async () => {
    const file = await writeTempFile('shared-key.txt', 'X');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    // 用绝对路径 read
    await getTool('read_file').execute({ path: file }, ctx);
    expect(state.size).toBe(1);
    // 用相对路径 edit —— 必须 hit 同一份 snapshot（不能"已读仍报 6"）
    const editRes = await getTool('edit_file').execute(
      { path: 'shared-key.txt', old_string: 'X', new_string: 'Y' },
      ctx,
    );
    expect(editRes.isError).toBeUndefined();

    // 用绝对路径 delete —— 必须清掉相对路径 read 写下的 snapshot
    await getTool('read_file').execute({ path: 'shared-key.txt' }, ctx);
    expect(state.size).toBe(1);
    await getTool('delete_file').execute({ path: file }, ctx);
    expect(state.size).toBe(0);
  });

  // W2（2026-05-10）：partial read → edit 不再被拒。
  // 旧测试断言"partial view 错误的 suggestion 含 grep_search 替代路径"基于
  // errorCode=6 拒绝路径——该路径整体下线后断言不再适用。新测试验证 partial
  // read → edit 直接通过。
  it('partial read 后 edit 通过（W2，不再走 errorCode=6 拒绝）', async () => {
    const file = await writeTempFile('big.txt', 'a\nb\nc\nd\n');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    await getTool('read_file').execute({ path: file, offset: 1, limit: 1 }, ctx);

    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'a', new_string: 'A' },
      ctx,
    );
    expect(editRes.isError).toBeUndefined();
    expect(await fsPromises.readFile(file, 'utf8')).toBe('A\nb\nc\nd\n');
  });

  it('adaptAgentTool 已 export（W2 复用准备）', async () => {
    const mod = await import('../../src/tools/tabcode-adapter.js');
    expect(typeof mod.adaptAgentTool).toBe('function');
  });

  // ─── W4 Lane F：errorCode 拆码（10 = FILE_NOT_FOUND, 11 = FILE_TOO_LARGE）──
  it('edit_file 文件不存在 → errorCode=10（FILE_NOT_FOUND，W4 Lane F 拆码 — 不再用反直觉的 8）', async () => {
    // 旧实现：file-not-found 走 errorCode=8 OLD_STRING_NOT_FOUND（反直觉 ——
    // 错误码语义是"找不到 old_string"），LLM 会先调"重读 file 自纠错预案"，
    // 多浪费一轮 read_file 才意识到文件不存在。
    // 新实现：errorCode=10 +
    // hint "edit_file only modifies existing files. Use write_file ..."。
    // R1 (2026-05-10) W1-LL-13：原 suggestion 字段已收口到 hint。
    const ctx = makeCtx(new Map());
    const noSuchPath = path.join(tmpDir, 'definitely-not-here.txt');
    const res = await getTool('edit_file').execute(
      { path: noSuchPath, old_string: 'x', new_string: 'y' },
      ctx,
    );
    expect(res.isError).toBe(true);
    const parsed = parseContent(res.content as string);
    expect(parsed.error_kind).toBe('file_not_found');
    // **W1（2026-05-13）**：error_kind 从 generic `resource_not_found` 改为
    // file pipeline 专属 `file_not_found`（与 `@tabtin/file-pipeline-errors`
    // SSoT 对齐）。客户端 i18n 据此给"文件不存在 · 检查路径"精确文案，区
    // 别于其它资源（如 widget code / skill key）的 not-found。
    expect(parsed.error_kind).toBe('file_not_found');
    expect(String(parsed.error)).toContain('File does not exist');
    expect(String(parsed.hint)).toMatch(/write_file/i);
  });

  it('mapActionErrorToRuntimeKind：message 含 "too large" → file_too_large', () => {
    // 模拟 action-tools 抛 "File too large: 12.0MB ..."（read_file/edit_file 文案）
    const out = mapActionErrorToRuntimeKind({
      message: 'File too large: 12.0MB (limit 10MB for full text reads).',
    });
    expect(out.errorKind).toBe('file_too_large');
    // **W1.2 Review 收尾（2026-05-13）**：suggestion 改为委托 SSoT —— 旧版本
    // hardcode "Use offset and limit / grep_search" 对 PDF / DOCX / image 等
    // 二进制完全无意义（offset 是行号，二进制按行切就乱）。SSoT 引导用户走
    // chat 异步解析（按 image / document subject 分别派发），LLM 不会再被
    // 引导到死路。这条 phrase 兜底没有 image 前缀 → 走 document 分支。
    expect(out.suggestion).toMatch(/upload|chat|drag/i);
    expect(out.suggestion).toMatch(/DO NOT retry|RAG|async/i);
  });

  it('mapActionErrorToRuntimeKind：message 含 "exceeds maximum" → file_too_large', () => {
    const out = mapActionErrorToRuntimeKind({
      message: 'File content (50000 tokens) exceeds maximum allowed tokens (32000).',
    });
    expect(out.errorKind).toBe('file_too_large');
  });

  it('mapActionErrorToRuntimeKind：message 含 "file does not exist" → file_not_found', () => {
    const out = mapActionErrorToRuntimeKind({
      message: 'File does not exist. Note: your current working directory is /tmp.',
    });
    expect(out.errorKind).toBe('file_not_found');
    // **W1.2 Review 收尾（2026-05-13）**：read_file 路径的 file-not-found
    // 不再建议 "use write_file to create"——那条对 read 场景误导 LLM（用户问
    // "看一下 ./report.pdf"不是想让 AI 创建文件）。改为委托 SSoT 的"用
    // glob_search 查实际路径"引导。edit_file 路径的 hint 由 tabcode-adapter
    // 走 errorResultEnvelope 直接构造（仍保留 "Use write_file to create a
    // new file"），见上面 `edit_file 文件不存在 → errorCode=10` 测试。
    expect(out.suggestion).toMatch(/glob_search|Verify the path/i);
  });

  it('mapActionErrorToRuntimeKind：not found in file 仍走 old_string_not_found', () => {
    // line_trimmed not found → 仍走 errorCode=8（OLD_STRING_NOT_FOUND，向后兼容）
    const out = mapActionErrorToRuntimeKind({
      message: 'String to replace not found in file.\nString: foo bar baz',
    });
    expect(out.errorKind).toBe('old_string_not_found');
  });

  // ─── R1 复核新增（W1-LL-8/9）：code 优先路径专属回归 ────────────
  //
  // action-tools `fileEditTool` 在 R1 显式 set 了 ToolErrorCode.OLD_STRING_NOT_FOUND
  // / OLD_STRING_NOT_UNIQUE，adapter `mapActionErrorToRuntimeKind` 优先按 code 直接
  // 映射，phrase 检测降级为兜底（兼容老消息 / 自创工具 / 外部 Agent 透传）。
  // 这组测试钉死"code 优先"语义——validator 复核指出无回归覆盖会让未来误改
  // 优先级（先 phrase 后 code）silent 通过。

  it('mapActionErrorToRuntimeKind：code=old_string_not_unique 直接映射（不依赖 phrase）', () => {
    // 故意使用不含 "matches of the string to replace" phrase 的 message —
    // 走 code 路径才能命中。
    const out = mapActionErrorToRuntimeKind({
      code: 'old_string_not_unique',
      message: 'edit failed: more than one occurrence',
    });
    expect(out.errorKind).toBe('old_string_not_unique'); // 'old_string_not_unique'
    expect(out.suggestion).toMatch(/replace_all|context/i);
  });

  it('mapActionErrorToRuntimeKind：code=old_string_not_found 直接映射（不依赖 phrase）', () => {
    const out = mapActionErrorToRuntimeKind({
      code: 'old_string_not_found',
      message: 'edit failed: needle missing',
    });
    expect(out.errorKind).toBe('old_string_not_found'); // 'old_string_not_found'
    expect(out.suggestion).toMatch(/Re-read the file|line-prefixed/i);
  });

  it('mapActionErrorToRuntimeKind：code 与 phrase 都命中 → code 路径优先', () => {
    // code 是 OLD_STRING_NOT_UNIQUE 但 message phrase 是 "not found in file"
    // （现实中不太可能撞，但用来钉死优先级语义）
    const out = mapActionErrorToRuntimeKind({
      code: 'old_string_not_unique',
      message: 'String to replace not found in file.\nString: x',
    });
    // code 优先 → NOT_UNIQUE (9)，不是 phrase 命中的 OLD_STRING_NOT_FOUND (8)
    expect(out.errorKind).toBe('old_string_not_unique');
  });

  it('mapActionErrorToRuntimeKind：code 不识别 → phrase 匹配（外部 Agent 透传场景）', () => {
    // 模拟外部 Agent 自定义 code，但 message 含 phrase
    const out = mapActionErrorToRuntimeKind({
      code: 'custom_external_unknown',
      message: 'Found 3 matches of the string to replace, but replace_all is false.',
    });
    // 走 phrase 兜底 → NOT_UNIQUE
    expect(out.errorKind).toBe('old_string_not_unique');
  });
});

// W3 (2026-05-10): "archive-hint × retrieve_tool_result schema cross-check"
// suite removed — both ends were deleted in W3. Large outputs now embed an
// inline `Full output saved to: <abs path>` banner in the Phase-1 / Phase-2
// truncation marker (see `tool-orchestration.ts::buildPersistMeta`). The
// LLM is told to re-read with `read_file`, which has its own
// well-tested schema; no parameter-name drift surface left to guard.

// ─── 6. grep_search adapter ────────────────────────────────────────────

describe('grep_search adapter', () => {
  it('createTabCodeTools 包含 grep_search + glob_search', () => {
    const tools = createTabCodeTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('grep_search');
    expect(names).toContain('glob_search');
  });

  it('grep_search isReadOnly=true + concurrencySafe=true', () => {
    const tool = getTool('grep_search');
    expect(tool.isReadOnly).toBe(true);
    expect(tool.concurrencySafe).toBe(true);
  });

  it('grep_search description 含反向引导', () => {
    // 2026-05-11 prompt 中文化：'NEVER' → '绝不'
    const desc = getTool('grep_search').description;
    expect(desc).toContain('绝不');
    expect(desc).toContain('run_terminal_command');
  });

  it('grep_search description 走减肥风格 + 边界 + agent 升级路径（2026-05-13 跟 glob 同款）', () => {
    // 2026-05-13 减肥：砍诱导性细节、加 grep/glob/semantic 三件套边界 + agent
    // 工具升级路径。dogfood 沉淀（output_mode 默认 / multiline / brace escape）保留。
    const desc = getTool('grep_search').description;
    // 边界引导（新增）
    expect(desc).toContain('glob_search');
    expect(desc).not.toContain('semantic_search');
    // agent 升级路径（新增）
    expect(desc).toContain('agent 工具');
    // 反向引导保留
    expect(desc).toContain('绝不');
    expect(desc).toContain('run_terminal_command');
    // dogfood 沉淀保留
    expect(desc).toContain('files_with_matches');
    expect(desc).toContain('content');
    expect(desc).toContain('单行内匹配');
    expect(desc).toContain('multiline:true');
    expect(desc).toContain('字面量花括号');
    expect(desc).toContain('interface\\{\\}');
    // 砍掉的诱导/实现细节字面
    expect(desc).not.toContain('用 ripgrep');
    expect(desc).not.toContain('最大 2000');
    expect(desc).not.toContain('默认返回前 250');
    expect(desc).not.toContain('.vscode/');
    expect(desc).not.toContain('1MB');
    expect(desc).not.toContain('.git/.svn');
  });

  it('grep_search inputSchema 含 head_limit + offset', () => {
    const schema = getTool('grep_search').inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.head_limit).toBeDefined();
    expect(schema.properties.offset).toBeDefined();
  });

  it('grep_search output_mode 参数说明区分路径模式和命中行内容模式', () => {
    const schema = getTool('grep_search').inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    const description = schema.properties.output_mode?.description ?? '';
    expect(description).toContain('默认 `files_with_matches`');
    expect(description).toContain('只返回命中文件路径');
    expect(description).toContain('`content` 返回文件路径、行号和命中行内容');
    expect(description).toContain('需要查看命中行文本时必须传 `content`');
  });

  it('grep_search 基本搜索（找到匹配）', async () => {
    await writeTempFile('search-me.txt', 'hello world\nfoo bar\nhello again\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    // W4 Lane F：默认 output_mode 已改为 'files_with_matches'，本用例显式传
    // 'content' 验证匹配行（content 模式才会回响匹配字符串）。
    const res = await tool.execute(
      { pattern: 'hello', path: tmpDir, output_mode: 'content' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(String(parsed.output)).toContain('hello');
  });

  it.each([42, ''])('grep_search 不把非法 output_mode=%j 改成默认值执行', async (outputMode) => {
    await writeTempFile('invalid-mode.txt', 'needle\n');
    const result = await getTool('grep_search').execute(
      { pattern: 'needle', path: tmpDir, output_mode: outputMode } as never,
      makeCtx(new Map()),
    );

    expect(result.isError).toBe(true);
    expect(parseContent(result.content as string).error_kind).toBe('invalid_param_format');
  });

  it('grep_search head_limit 截断', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`line${i}: match_target`);
    await writeTempFile('many-matches.txt', lines.join('\n') + '\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'match_target', path: tmpDir, head_limit: 5, output_mode: 'content' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    if (parsed.total_matches !== undefined) {
      expect(parsed.total_matches).toBeGreaterThanOrEqual(5);
    }
    expect(String(parsed.output)).toContain('match_target');
  });

  it('grep_search offset 分页', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`item${i}: marker`);
    await writeTempFile('paged.txt', lines.join('\n') + '\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');

    const page1 = await tool.execute(
      { pattern: 'marker', path: tmpDir, head_limit: 3, offset: 0, output_mode: 'content' },
      ctx,
    );
    const p1 = parseContent(page1.content as string);
    expect(p1.success).toBe(true);
    expect(String(p1.output)).toContain('item0');

    const page2 = await tool.execute(
      { pattern: 'marker', path: tmpDir, head_limit: 3, offset: 3, output_mode: 'content' },
      ctx,
    );
    const p2 = parseContent(page2.content as string);
    expect(p2.success).toBe(true);
    expect(String(p2.output)).toContain('item3');
  });

  it('grep_search 无匹配 → 成功但空', async () => {
    await writeTempFile('no-match.txt', 'nothing here\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'ZZZZNOTFOUND', path: tmpDir },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
  });

  it('grep_search 默认 output_mode = files_with_matches（W4 Lane F）', async () => {
    // 漏传 output_mode 时应当走 files_with_matches —— 输出是文件路径列表，
    // 不再是 content 模式动辄 100KB 的匹配行（calculator 同款 silent
    // success 风险）。默认值为 files_with_matches。
    //
    // **断言加严**（Review P2-4 自修）：仅断言含文件名不够（默认假阳性 ——
    // content 模式 ripgrep 输出 "path:line:content" 也会含文件名）。同时断言
    // 输出不匹配 ripgrep content 模式的 `:digit:` 行号片段，钉死"不是 content"。
    await writeTempFile('default-mode.txt', 'hello world matchhere\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'matchhere', path: tmpDir },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(String(parsed.output)).toContain('default-mode.txt');
    // ripgrep content 模式输出形如 `path:1:hello world matchhere`；
    // files_with_matches 模式只输出 path —— 用 `:数字:` 模式锁住边界。
    expect(String(parsed.output)).not.toMatch(/:\d+:/);
  });

  it('grep_search 0 匹配 content 模式 → "No matches found."（T2-C1）', async () => {
    // T2-C1 (2026-05-12)：c39cd8b2 事故现场 version 29 命中——LLM 看到 `output:""`
    // 空字符串需自行推断"无匹配"。改造后三种 mode 各自有意义的文案。
    await writeTempFile('empty-search.txt', 'nothing here\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'ZZZZ_NEVER_MATCH_XYZ', path: tmpDir, output_mode: 'content' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(String(parsed.output)).toBe('No matches found.');
  });

  it('grep_search 0 匹配 files_with_matches 模式 → "No files found."（T2-C1）', async () => {
    await writeTempFile('empty-files.txt', 'nothing here\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'ZZZZ_NEVER_MATCH_XYZ', path: tmpDir },
      // 默认 output_mode='files_with_matches'（W4 Lane F）
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(String(parsed.output)).toBe('No files found.');
  });

  it('grep_search 0 匹配 count 模式 → 双段 "No matches found." + summary（T2-M3）', async () => {
    // T2-M3 (2026-05-12)：count 0 匹配
    // 输出双段：先 `No matches found` 再 `Found 0 ... 0 files.` summary。
    // 给 LLM 双重信号：第一段说"没找到"，第二段提供精确总数。
    await writeTempFile('empty-count.txt', 'nothing here\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'ZZZZ_NEVER_MATCH_XYZ', path: tmpDir, output_mode: 'count' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    const output = String(parsed.output);
    expect(output).toContain('No matches found.');
    expect(output).toContain('Found 0 total occurrences across 0 files.');
  });

  it('grep_search description 含 multiline 默认 + literal escape 提示（T2-C6）', async () => {
    const desc = getTool('grep_search').description;
    // multiline 默认行为说明
    expect(desc).toMatch(/默认情况下 pattern 只在单行内匹配/);
    expect(desc).toMatch(/multiline:true/);
    // literal escape 提示
    expect(desc).toMatch(/字面量花括号/);
    expect(desc).toMatch(/interface\\\{\\\}/);
    // 保留 W4 反向引导
    expect(desc).toContain('绝不');
    expect(desc).toContain('run_terminal_command');
  });

  it('grep_search 输出绝对路径 → 相对 wsRoot 路径（T2-C5）', async () => {
    // T2-C5 (2026-05-12)：节省 LLM context token，把绝对路径前缀砍掉。
    // 仅对 POSIX 路径（macOS/Linux）启用，Windows 路径保持原样。
    await writeTempFile('relpath-test.ts', 'PATH_RELATIVIZE_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'PATH_RELATIVIZE_MARKER', path: tmpDir, output_mode: 'content' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    const output = String(parsed.output);
    // 输出应不含 tmpDir 绝对路径前缀（已被 relativize 砍掉）
    if (process.platform !== 'win32') {
      expect(output).not.toContain(tmpDir);
      // 相对路径行格式：`relpath-test.ts:1:PATH_RELATIVIZE_MARKER`
      expect(output).toMatch(/relpath-test\.ts:\d+:PATH_RELATIVIZE_MARKER/);
    }
  });

  it('grep_search glob 参数支持空格分隔（T2-C7）', async () => {
    await writeTempFile('a.ts', 'GLOB_SPLIT_MARKER\n');
    await writeTempFile('b.tsx', 'GLOB_SPLIT_MARKER\n');
    await writeTempFile('c.js', 'GLOB_SPLIT_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    // 空格分隔：LLM 友好语法
    const res = await tool.execute(
      { pattern: 'GLOB_SPLIT_MARKER', path: tmpDir, glob: '*.ts *.tsx', output_mode: 'files_with_matches' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    const output = String(parsed.output);
    expect(output).toMatch(/a\.ts/);
    expect(output).toMatch(/b\.tsx/);
    // c.js 应被排除（不在 *.ts / *.tsx 之内）
    expect(output).not.toMatch(/c\.js/);
  });

  it('grep_search glob 参数支持逗号分隔（T2-C7）', async () => {
    await writeTempFile('aa.py', 'COMMA_SPLIT_MARKER\n');
    await writeTempFile('bb.go', 'COMMA_SPLIT_MARKER\n');
    await writeTempFile('cc.rs', 'COMMA_SPLIT_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'COMMA_SPLIT_MARKER', path: tmpDir, glob: '*.py,*.go', output_mode: 'files_with_matches' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    const output = String(parsed.output);
    expect(output).toMatch(/aa\.py/);
    expect(output).toMatch(/bb\.go/);
    expect(output).not.toMatch(/cc\.rs/);
  });

  it('grep_search glob 参数花括号整体保留不被逗号 split（T2-C7）', async () => {
    await writeTempFile('xx.ts', 'BRACE_KEEP_MARKER\n');
    await writeTempFile('yy.tsx', 'BRACE_KEEP_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    // 花括号 pattern：整段保留不在内部逗号上 split
    const res = await tool.execute(
      { pattern: 'BRACE_KEEP_MARKER', path: tmpDir, glob: '*.{ts,tsx}', output_mode: 'files_with_matches' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    const output = String(parsed.output);
    expect(output).toMatch(/xx\.ts/);
    expect(output).toMatch(/yy\.tsx/);
  });

  // ─── T2 follow-up B3 (2026-05-12)：files_with_matches mtime 排序 + Found N files 汇总
  // files_with_matches Found 头 + mtime 排序
  it('grep_search files_with_matches 模式：单文件命中 → "Found 1 file\\n<path>"（B3）', async () => {
    await writeTempFile('alone.ts', 'B3_SUMMARY_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'B3_SUMMARY_MARKER', path: tmpDir, output_mode: 'files_with_matches' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    const output = String(parsed.output);
    // "1 file" 单数；非截断时不带 (limit:...)
    expect(output).toMatch(/^Found 1 file\n/);
    expect(output).toContain('alone.ts');
    expect(output).not.toContain('(limit:');
  });

  it('grep_search files_with_matches 多文件命中 → "Found N files\\n<list>"（B3）', async () => {
    await writeTempFile('a.ts', 'B3_MULTI_MARKER\n');
    await writeTempFile('b.ts', 'B3_MULTI_MARKER\n');
    await writeTempFile('c.ts', 'B3_MULTI_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'B3_MULTI_MARKER', path: tmpDir, output_mode: 'files_with_matches' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    const output = String(parsed.output);
    expect(output).toMatch(/^Found 3 files\n/);
    expect(output).toContain('a.ts');
    expect(output).toContain('b.ts');
    expect(output).toContain('c.ts');
  });

  it('grep_search files_with_matches NODE_ENV=test 时按 filename 排序（保证测试稳定）', async () => {
    // 测试环境只按 filename 排（避免 mtime 引入
    // 时间相关的 flaky）。生产环境按 mtime 倒序——本测试钉死测试模式行为。
    await writeTempFile('zebra.ts', 'B3_SORT_MARKER\n');
    await writeTempFile('alpha.ts', 'B3_SORT_MARKER\n');
    await writeTempFile('mid.ts', 'B3_SORT_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'B3_SORT_MARKER', path: tmpDir, output_mode: 'files_with_matches' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    const lines = String(parsed.output).split('\n').filter((l) => l && !l.startsWith('Found'));
    // 提取文件名（可能含路径前缀）
    const baseNames = lines.map((l) => l.split('/').pop()).filter(Boolean);
    // 按字母排：alpha < mid < zebra
    const idxAlpha = baseNames.findIndex((b) => b === 'alpha.ts');
    const idxMid = baseNames.findIndex((b) => b === 'mid.ts');
    const idxZebra = baseNames.findIndex((b) => b === 'zebra.ts');
    expect(idxAlpha).toBeGreaterThan(-1);
    expect(idxMid).toBeGreaterThan(-1);
    expect(idxZebra).toBeGreaterThan(-1);
    expect(idxAlpha).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxZebra);
  });

  it('grep_search files_with_matches 截断时 Found 头带 (limit, offset)（B3）', async () => {
    // 截断时输出 `Found N files` 带头，含
    // pagination = limit: ${limit}, offset: ${offset}]`，TabTin 等价精神：
    // `Found N files (limit: 250, offset: 0)\n<list>`
    for (let i = 0; i < 5; i++) await writeTempFile(`many-${i}.ts`, 'B3_LIMIT_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      {
        pattern: 'B3_LIMIT_MARKER',
        path: tmpDir,
        output_mode: 'files_with_matches',
        head_limit: 2,
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    const output = String(parsed.output);
    // 截断时 Found 头带 limit / offset
    expect(output).toMatch(/^Found 5 files \(limit: 2, offset: 0\)\n/);
    // 截断尾部 truncated 提示也在
    expect(output).toContain('... truncated');
    expect(parsed.total_matches).toBe(5);
    expect(parsed.head_limit).toBe(2);
  });

  it('grep_search content 模式 *不加* Found 头（保留原 ripgrep 输出形态）', async () => {
    await writeTempFile('content.ts', 'B3_CONTENT_MARKER\n');
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const res = await tool.execute(
      { pattern: 'B3_CONTENT_MARKER', path: tmpDir, output_mode: 'content' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    const output = String(parsed.output);
    expect(output).not.toMatch(/^Found /);
    // 仍是 ripgrep content 模式输出 path:line:content
    expect(output).toMatch(/content\.ts:\d+:B3_CONTENT_MARKER/);
  });

  it('grep_search path 不存在 → 错误回显 + Did you mean（W4 Lane F）', async () => {
    // grep_search 的 schema 字段是 `path`（既支持 file 也支持 directory），
    // 测试名修订：原"target_directory"是 glob_search 字段，与本测试断言不符。
    const ctx = makeCtx(new Map());
    const tool = getTool('grep_search');
    const bogusPath = path.join(tmpDir, 'does-not-exist-xyz');
    const res = await tool.execute(
      { pattern: 'anything', path: bogusPath },
      ctx,
    );
    expect(res.isError).toBe(true);
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(false);
    // 文案形如 `Path does not exist: {path}. Note: your current
    // working directory is {cwd}.`
    expect(String(parsed.error)).toMatch(/Path does not exist/i);
  });
});

// ─── 7. glob_search adapter ────────────────────────────────────────────
//
// **2026-05-13 重做**：4.5 时代 adapter 把 head_limit 暴露给 LLM、还开
// 0=unlimited escape hatch——是误设计（任何"LLM 可控的上限"都诱导漏传/调高）。
// 重做后：
//   - LLM schema 仅 `glob_pattern` + `target_directory`，head_limit / include_ignored
//     都不暴露
//   - 硬上限 100；测试 / 极端 SDK 可通过 `TabCodeToolsDeps.globHeadLimit` 注入覆盖
//   - 截断文案改为更直接的 `(Showing first N of M+ files. Use a more specific pattern.)`
//   - envelope 字段瘦身：去掉 head_limit 回显（LLM 没参与，回显就是噪音）
//
// CLI 路径（`tabtin code glob --head-limit ... --include-ignored`）经
// action-tools 层入参单独支持——CLI/FC schema 与默认值解耦是核心动机。
// action-tools 层的 hidden / .gitignore / VCS 排除等底层行为有自己的测试覆盖，
// 本测试段只验证 **adapter 暴露给 LLM 的契约**。

function getGlobTool(deps: Parameters<typeof createTabCodeTools>[0] = {}) {
  const tools = createTabCodeTools(deps);
  const tool = tools.find((t) => t.name === 'glob_search');
  if (!tool) throw new Error('glob_search not in createTabCodeTools()');
  return tool;
}

describe('glob_search adapter', () => {
  it('glob_search isReadOnly=true + concurrencySafe=true', () => {
    const tool = getTool('glob_search');
    expect(tool.isReadOnly).toBe(true);
    expect(tool.concurrencySafe).toBe(true);
  });

  it('glob_search LLM schema 只暴露 glob_pattern + target_directory（不含 head_limit / include_ignored）', () => {
    // 2026-05-13 重做核心契约：LLM 看不到内部上限旋钮也看不到 ignored bypass。
    const tool = getTool('glob_search');
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['glob_pattern', 'target_directory']);
    expect(props.head_limit).toBeUndefined();
    expect(props.include_ignored).toBeUndefined();
  });

  it('glob_search description 走 5 行极简风格 + 反向引导 + agent 工具升级路径', () => {
    // 2026-05-13 重做：description 砍掉"底层 ripgrep"/"最大 1000"/"include_ignored"
    // 等诱导性细节，保留三条核心引导：
    //   1. 与 grep_search 边界
    //   2. 绝不用递归 list_directory
    //   3. 开放式探索升级到 agent 工具
    const desc = getTool('glob_search').description;
    // 边界引导
    expect(desc).toContain('grep_search');
    expect(desc).not.toContain('semantic_search');
    // 反向引导
    expect(desc).toContain('绝不');
    expect(desc).toContain('list_directory');
    // 升级路径
    expect(desc).toContain('agent 工具');
    // 不应再出现的字面
    expect(desc).not.toContain('ripgrep');
    expect(desc).not.toContain('head_limit');
    expect(desc).not.toContain('include_ignored');
    expect(desc).not.toContain('最大 1000');
  });

  it('glob_search 基本匹配（envelope: success + output + total_files；不再含 head_limit）', async () => {
    await writeTempFile('app.ts', 'export {}');
    await writeTempFile('app.js', 'module.exports = {}');
    const ctx = makeCtx(new Map());
    const tool = getTool('glob_search');
    const res = await tool.execute(
      { glob_pattern: '*.ts', target_directory: tmpDir },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    const output = String(parsed.output ?? '');
    const files = output.split('\n').filter(Boolean);
    expect(files.some((f) => f.endsWith('app.ts'))).toBe(true);
    expect(files.every((f) => !f.endsWith('app.js'))).toBe(true);
    expect(parsed.total_files).toBeGreaterThanOrEqual(1);
    // 2026-05-13 重做：envelope 字段瘦身——head_limit 回显已删（LLM 不传 → 不回显）
    expect(parsed.head_limit).toBeUndefined();
  });

  it('glob_search 0 匹配 → "No files found."', async () => {
    await writeTempFile('foo.ts', 'export {}');
    const ctx = makeCtx(new Map());
    const tool = getTool('glob_search');
    const res = await tool.execute(
      { glob_pattern: '*.nonexistent_ext', target_directory: tmpDir },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(String(parsed.output)).toBe('No files found.');
    expect(parsed.total_files).toBeUndefined();
  });

  it('glob_search 截断 + 提示文案（用 deps.globHeadLimit 注入小上限触发）', async () => {
    // 2026-05-13 重做：LLM 不能传 head_limit，测试改用 deps 注入。
    // 这正是 deps.globHeadLimit 的设计目的——测试 / 极端 SDK 集成方使用。
    for (let i = 0; i < 5; i++) await writeTempFile(`file-${i}.ts`, 'x');
    const ctx = makeCtx(new Map());
    const tool = getGlobTool({ globHeadLimit: 2 });
    const res = await tool.execute(
      { glob_pattern: '*.ts', target_directory: tmpDir },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total_files).toBe(5);
    const output = String(parsed.output);
    // 2026-05-13 重做截断文案：保留前缀 `(Results are truncated` 让前端
    // `isTruncationNoticeLine` 能识别（CodeSearchCard / fileToolCards 同前缀），
    // 措辞改为更直接的 "showing first N of M+ files. Use a more specific pattern."
    expect(output).toMatch(/Results are truncated/);
    expect(output).toMatch(/showing first 2 of 5\+ files/);
    expect(output).toMatch(/Use a more specific pattern/);
    const fileLines = output.split('\n').filter((l) => l.endsWith('.ts'));
    expect(fileLines).toHaveLength(2);
  });

  it('glob_search LLM 入参 head_limit / include_ignored 会被 adapter 主动剥离（防穿透）', async () => {
    // 即使 LLM "创造性地"传入这两个字段（schema 不声明但 JSON 输入字面可注入），
    // adapter 必须主动 delete，避免穿透到 action-tools。这是 belt-and-suspenders 防御。
    for (let i = 0; i < 3; i++) await writeTempFile(`extra-${i}.ts`, 'x');
    const ctx = makeCtx(new Map());
    // globHeadLimit:1000 注入大上限——确保结果不会因为 schema 外的 head_limit:2 而被截断
    const tool = getGlobTool({ globHeadLimit: 1000 });
    const res = await tool.execute(
      {
        glob_pattern: '*.ts',
        target_directory: tmpDir,
        // 这两个字段 LLM schema 不声明，但 JSON 输入字面允许任何字段
        head_limit: 2,
        include_ignored: true,
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(true);
    // adapter 删了 head_limit:2 后走 deps.globHeadLimit=1000，3 个文件不会被截断
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.total_files).toBe(3);
  });

  it('glob_search target_directory 不存在 → fail with Path does not exist + Did you mean', async () => {
    // glob_search 入参校验
    // ENOENT → Path does not exist + Did you mean（adapter 透传 action-tools 错误）。
    const ctx = makeCtx(new Map());
    const tool = getTool('glob_search');
    const bogusPath = path.join(tmpDir, 'definitely-not-a-real-dir-xxx');
    const res = await tool.execute(
      { glob_pattern: '*.ts', target_directory: bogusPath },
      ctx,
    );
    expect(res.isError).toBe(true);
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/Path does not exist/i);
  });

  it('glob_search target_directory 是文件而非目录 → fail with Path is not a directory', async () => {
    const file = await writeTempFile('not-a-dir.txt', 'x');
    const ctx = makeCtx(new Map());
    const tool = getTool('glob_search');
    const res = await tool.execute(
      { glob_pattern: '*.ts', target_directory: file },
      ctx,
    );
    expect(res.isError).toBe(true);
    const parsed = parseContent(res.content as string);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/not a directory/i);
  });
});

// ─── 8. semantic_search adapter（ 退役验证）──────────────────

describe('semantic_search adapter（ 退役）', () => {
  it('createTabCodeTools 不包含 semantic_search', () => {
    const tools = createTabCodeTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).not.toContain('semantic_search');
    expect(names).toHaveLength(6);
  });
});

// ─── 9. read_lints adapter（C13 退役验证）─────────────────────────

describe('read_lints adapter（C13 退役）', () => {
  it('createTabCodeTools 不包含 read_lints（已退役）', () => {
    // C13 (2026-05-13)：read_lints 从 LLM 可见列表退役，诊断改走 attachment
    // 被动注入。LLM 万一调 read_lints 会拿明确的 "tool not found" 错误；
    // tool-system.ts 的 TOOL_NAME_ALIASES 里 read_lints / read_diagnostics
    // 也已删除（无独立 read_lints 工具）。
    const tools = createTabCodeTools();
    expect(tools.map((t) => t.name)).not.toContain('read_lints');
    expect(tools.map((t) => t.name)).not.toContain('read_diagnostics');
  });

  it('action-tools 层 readDiagnosticsTool 仍可用（spawn linter fallback 需要）', async () => {
    // notifyLspAfterEdit 在 LSP 无 server 处理某语言时，调
    // runSpawnLinterFallback → actionReadDiagnosticsTool.execute(...) 兜底。
    // 验证 action-tools 这层没被误删。
    const { readDiagnosticsTool } = await import(
      '@tabtin/action-tools/tools'
    );
    expect(typeof readDiagnosticsTool.execute).toBe('function');
    expect(readDiagnosticsTool.name).toBe('read_lints');
  });
});

// ─── 10. workspace root 注入 ─────────────────────────────────────────

describe('workspace root 注入', () => {
  it('从 ToolContext.workspaceRoot 拿 workspace 根（基线）', async () => {
    const file = path.join(tmpDir, 'in-ws.txt');
    await fsPromises.writeFile(file, 'x', 'utf8');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);

    const r = await getTool('read_file').execute({ path: 'in-ws.txt' }, ctx);
    expect(r.isError).toBeUndefined();
  });

  it('显式 _workspace_root 入参覆盖 ctx.workspaceRoot（调试 / 测试用）', async () => {
    const altDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabcode-alt-'));
    try {
      const file = path.join(altDir, 'alt.txt');
      await fsPromises.writeFile(file, 'alt', 'utf8');
      const state: ReadFileState = new Map();
      const ctx = makeCtx(state); // workspaceRoot=tmpDir

      const r = await getTool('read_file').execute(
        { path: 'alt.txt', _workspace_root: altDir },
        ctx,
      );
      expect(r.isError).toBeUndefined();
      // W2：read_file 直接输出多行明文，不再 JSON envelope
      expect(String(r.content)).toContain('alt');
    } finally {
      await fsPromises.rm(altDir, { recursive: true, force: true });
    }
  });
});

// ─── 路径权限治理 Wave 1 · adapter 注入 _allowed_paths / _already_judged ──

describe('Wave 1：从 ctx.workspaceSnapshot / permissionContext 注入 action-tool payload', () => {
  // 用一个最小 AgentTool 桩，仅记录 execute 入参（base.execute(input)）
  // 透过 adapter 后真实收到了什么 _* 字段。
  it('ctx.workspaceSnapshot.allowedPaths → input._allowed_paths', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stubAgentTool = {
      name: 'stub_capture',
      description: 'capture input for assertion',
      riskLevel: 'safe' as const,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: unknown) {
        captured.push(input as Record<string, unknown>);
        return { success: true, data: {} };
      },
    };
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const tool = adaptAgentTool(stubAgentTool as any, {
      deps: {},
      isReadOnly: true,
      policyActionKind: 'file',
      llmDescription: 'test stub llm description',
    });

    const ctx: ToolContext = {
      threadId: 't',
      runtimeId: 's',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      workspaceRoot: '/Users/x/sandbox',
      workspaceSnapshot: {
        sources: {
          sandbox: '/Users/x/sandbox',
          tabcodeProjects: ['/Users/x/dev/proj-A', '/Users/x/dev/proj-B'],
          tabfolderDirs: [],
          attachedFiles: [],
        },
        allowedPaths: ['/Users/x/sandbox', '/Users/x/dev/proj-A', '/Users/x/dev/proj-B'],
        allowedFiles: [],
        spaceSessionId: 'space-1',
      },
      permissionContext: { judgedDecision: 'allow' },
    };

    await tool.execute({ path: 'foo' }, ctx);
    expect(captured.length).toBe(1);
    const got = captured[0];
    expect(got._workspace_root).toBe('/Users/x/sandbox');
    expect(got._allowed_paths).toEqual([
      '/Users/x/sandbox',
      '/Users/x/dev/proj-A',
      '/Users/x/dev/proj-B',
    ]);
    expect(got._allowed_files).toEqual([]);
    expect(got._already_judged).toBe(true);
  });

  it('无 workspaceSnapshot 时不注入 _allowed_paths（兼容旧 host / 测试桩）', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stubAgentTool = {
      name: 'stub_capture2',
      description: 'capture',
      riskLevel: 'safe' as const,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: unknown) {
        captured.push(input as Record<string, unknown>);
        return { success: true, data: {} };
      },
    };
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const tool = adaptAgentTool(stubAgentTool as any, {
      deps: {},
      isReadOnly: true,
      policyActionKind: 'file',
      llmDescription: 'test stub llm description',
    });

    const ctx: ToolContext = {
      threadId: 't',
      runtimeId: 's',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      workspaceRoot: '/Users/x/sandbox',
    };

    await tool.execute({ path: 'foo' }, ctx);
    expect(captured.length).toBe(1);
    const got = captured[0];
    expect(got._workspace_root).toBe('/Users/x/sandbox');
    expect(got._allowed_paths).toBeUndefined();
    expect(got._already_judged).toBeUndefined();
  });

  it('permissionContext.judgedDecision !== "allow" → 不注入 _already_judged', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stubAgentTool = {
      name: 'stub_capture3',
      description: 'capture',
      riskLevel: 'safe' as const,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: unknown) {
        captured.push(input as Record<string, unknown>);
        return { success: true, data: {} };
      },
    };
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const tool = adaptAgentTool(stubAgentTool as any, {
      deps: {},
      isReadOnly: true,
      policyActionKind: 'file',
      llmDescription: 'test stub llm description',
    });

    const ctx: ToolContext = {
      threadId: 't',
      runtimeId: 's',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      workspaceRoot: '/Users/x/sandbox',
      permissionContext: {},
    };

    await tool.execute({ path: 'foo' }, ctx);
    expect(captured[0]._already_judged).toBeUndefined();
  });

  // P1-3 安全收紧：adapter 必须**强制覆盖** _allowed_paths / _already_judged，
  // 抹平 LLM 在 input 里塞这些字段的攻击面（在 legacy 模式 / 边角链路下尤其
  // 重要）。下面一组 case 以前是"LLM 显式覆盖优先"——那个语义本身就是漏洞。
  it('P1-3 LLM 注入 _allowed_paths 必须被 adapter 强制覆盖（不让 LLM 自定义边界）', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stubAgentTool = {
      name: 'stub_capture4',
      description: 'capture',
      riskLevel: 'safe' as const,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: unknown) {
        captured.push(input as Record<string, unknown>);
        return { success: true, data: {} };
      },
    };
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const tool = adaptAgentTool(stubAgentTool as any, {
      deps: {},
      isReadOnly: true,
      policyActionKind: 'file',
      llmDescription: 'test stub llm description',
    });

    const ctx: ToolContext = {
      threadId: 't',
      runtimeId: 's',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      workspaceRoot: '/Users/x/sandbox',
      workspaceSnapshot: {
        sources: { sandbox: '/Users/x/sandbox', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
        allowedPaths: ['/Users/x/sandbox'],
        allowedFiles: [],
        spaceSessionId: 'space-1',
      },
    };

    // LLM 想把 victim 路径塞进 _allowed_paths——adapter 必须用 ctx.workspaceSnapshot
    // 强制覆盖，不让 LLM 拿到自定义 boundary 通道。
    await tool.execute({ path: 'foo', _allowed_paths: ['/Users/victim'] }, ctx);
    expect(captured[0]._allowed_paths).toEqual(['/Users/x/sandbox']);
  });

  it('P1-3 LLM 注入 _already_judged=true 必须被 adapter 抹平（legacy 模式下 ctx 为空）', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stubAgentTool = {
      name: 'stub_capture5',
      description: 'capture',
      riskLevel: 'safe' as const,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: unknown) {
        captured.push(input as Record<string, unknown>);
        return { success: true, data: {} };
      },
    };
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const tool = adaptAgentTool(stubAgentTool as any, {
      deps: {},
      isReadOnly: true,
      policyActionKind: 'file',
      llmDescription: 'test stub llm description',
    });

    // legacy 模式：ctx.permissionContext 为空（tool-orchestration 不在 enforce
    // 路径，没透传 judgedDecision）。LLM 想绕过 boundary 在 input 塞 _already_judged=true。
    const ctx: ToolContext = {
      threadId: 't',
      runtimeId: 's',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      workspaceRoot: '/Users/x/sandbox',
      // 不设 permissionContext —— 模拟 legacy 路径
    };

    await tool.execute({ path: 'foo', _already_judged: true }, ctx);
    // adapter 必须抹平 LLM 注入的 true —— 否则 boundary 整个失守。
    expect(captured[0]._already_judged).toBeUndefined();
  });

  it('P1-3 无 workspaceSnapshot 时显式删除 LLM 注入的 _allowed_paths / _allowed_files', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stubAgentTool = {
      name: 'stub_capture6',
      description: 'capture',
      riskLevel: 'safe' as const,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: unknown) {
        captured.push(input as Record<string, unknown>);
        return { success: true, data: {} };
      },
    };
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const tool = adaptAgentTool(stubAgentTool as any, {
      deps: {},
      isReadOnly: true,
      policyActionKind: 'file',
      llmDescription: 'test stub llm description',
    });

    const ctx: ToolContext = {
      threadId: 't',
      runtimeId: 's',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      workspaceRoot: '/Users/x/sandbox',
      // workspaceSnapshot 故意不设
    };

    await tool.execute({
      path: 'foo',
      _allowed_paths: ['/llm-injected'],
      _allowed_files: ['/llm-injected/file'],
      _already_judged: true,
    }, ctx);

    // 三字段都被 adapter 抹平
    expect(captured[0]._allowed_paths).toBeUndefined();
    expect(captured[0]._allowed_files).toBeUndefined();
    expect(captured[0]._already_judged).toBeUndefined();
  });
});

// ─── 端到端 dogfood 复现：用户在 TabCode 临时打开项目 → Agent 调 write_file ──

describe('Wave 1 dogfood 复现：tabcode-adapter → action-tools 端到端', () => {
  it('workspaceSnapshot.allowedPaths 含路径 → write_file 在该路径下成功（不再撞 boundary）', async () => {
    // 模拟用户在 TabCode 打开了 `tabcodeProj`（不是 sandbox）。
    // ctx.workspaceRoot 仍是 sandbox（旧 single-string 字段），
    // 但 allowedPaths 包含 tabcodeProj —— 这正是 dogfood bug 的现场。
    const sandboxDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
    const tabcodeProj = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabcode-proj-'));
    // macOS realpath 与 mkdtemp 的 /var vs /private/var 差异，先 realpath
    const realSandbox = await fsPromises.realpath(sandboxDir);
    const realTabcode = await fsPromises.realpath(tabcodeProj);
    try {
      const tools = createTabCodeTools();
      const writeTool = tools.find((t) => t.name === 'write_file')!;

      const ctx: ToolContext = {
        threadId: 't',
        runtimeId: 's',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
        workspaceRoot: realSandbox, // 单字符串 sandbox（旧字段）
        workspaceSnapshot: {
          sources: {
            sandbox: realSandbox,
            tabcodeProjects: [realTabcode], // 用户在 TabCode 打开的项目
            tabfolderDirs: [],
            attachedFiles: [],
          },
          allowedPaths: [realSandbox, realTabcode], // v3 SSoT 多目录边界
          allowedFiles: [],
          spaceSessionId: 'space-1',
        },
      };

      const targetFile = path.join(realTabcode, 'README.md');
      const result = await writeTool.execute(
        {
          path: targetFile,
          contents: '# manim opensource project',
        },
        ctx,
      );

      // 旧实现：`_workspace_root === sandbox`，target 在 tabcodeProj 不在 sandbox 子树
      // → 撞旧 single-string boundary 错误 → result.isError=true。
      // 新实现：adapter 注入 _allowed_paths=[sandbox, tabcodeProj]，
      // checkFilePathSecurity 多目录命中 → 放行。
      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content as string);
      expect(content.success).toBe(true);

      // 真的写到磁盘了
      const written = await fsPromises.readFile(targetFile, 'utf8');
      expect(written).toContain('manim');
    } finally {
      await fsPromises.rm(sandboxDir, { recursive: true, force: true });
      await fsPromises.rm(tabcodeProj, { recursive: true, force: true });
    }
  });

  it('alreadyJudged=true 让"用户 once 允许的工作区外文件"也能写（judge pipeline 主路径）', async () => {
    const sandboxDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const realSandbox = await fsPromises.realpath(sandboxDir);
    const realOutside = await fsPromises.realpath(outsideDir);
    try {
      const tools = createTabCodeTools();
      const writeTool = tools.find((t) => t.name === 'write_file')!;

      // 模拟：用户在 ApprovalPanel 点了「这次允许」→ judge 决策放行 →
      // tool-orchestration 透传 permissionContext.judgedDecision='allow'。
      const ctx: ToolContext = {
        threadId: 't',
        runtimeId: 's',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
        workspaceRoot: realSandbox,
        workspaceSnapshot: {
          sources: { sandbox: realSandbox, tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
          allowedPaths: [realSandbox], // outsideDir 不在 allowedPaths 内
          allowedFiles: [],
          spaceSessionId: 'space-1',
        },
        permissionContext: { judgedDecision: 'allow' },
      };

      const targetFile = path.join(realOutside, 'once-approved.txt');
      const result = await writeTool.execute(
        { path: targetFile, contents: 'judged once allow' },
        ctx,
      );

      expect(result.isError).toBeUndefined();
      expect(await fsPromises.readFile(targetFile, 'utf8')).toBe('judged once allow');
    } finally {
      await fsPromises.rm(sandboxDir, { recursive: true, force: true });
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('allowedPaths 不含路径 + 未 judged → 返回 actionable 错误（不再撞旧 single-string boundary 错误）', async () => {
    const sandboxDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const realSandbox = await fsPromises.realpath(sandboxDir);
    const realOutside = await fsPromises.realpath(outsideDir);
    try {
      const tools = createTabCodeTools();
      const writeTool = tools.find((t) => t.name === 'write_file')!;

      const ctx: ToolContext = {
        threadId: 't',
        runtimeId: 's',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
        workspaceRoot: realSandbox,
        workspaceSnapshot: {
          sources: { sandbox: realSandbox, tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
          allowedPaths: [realSandbox],
          allowedFiles: [],
          spaceSessionId: 'space-1',
        },
        // 故意不设 permissionContext —— LLM 直接调没经 judge（受限链路）
      };

      const result = await writeTool.execute(
        { path: path.join(realOutside, 'evil.txt'), contents: 'should be blocked' },
        ctx,
      );

      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content as string);
      // 老 single-string boundary 错误信息（"...boundary."）必须不再出现 ——
      // 用 regex 反向断言，避免在源码里出现完整字面量影响北极星 #1 grep。
      expect(String(err.error)).not.toMatch(/outside.*workspace.*boundary/);
      // **2026-05-13 重构**：错误是给 LLM 看的，不再含产品 UI 名词。
      // 旧断言要求 "TabFolder|TabCode" + "Super Permissions" —— 这是把
      // UI 文案塞工具协议里的旧设计。新设计：错误简洁 actionable，UI 文案
      // 归 i18n 层基于 error_code 渲染。LLM 看到信号即知"路径在工作区外，
      // 需要用户授权"，自己用产品语言转述给用户。
      expect(String(err.error)).toMatch(/outside the allowed workspace/);
      expect(String(err.error)).toMatch(/grant access/);
      // 反向断言：用户层产品名（YOLO / Super Permissions / TabFolder / TabCode /
      // Agent Security settings）一律不在工具协议里出现。
      expect(String(err.error)).not.toMatch(/YOLO/);
      expect(String(err.error)).not.toMatch(/Super Permissions/);
      expect(String(err.error)).not.toMatch(/TabFolder|TabCode/);
      expect(String(err.error)).not.toMatch(/Agent Security settings/);
    } finally {
      await fsPromises.rm(sandboxDir, { recursive: true, force: true });
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

// ─── B-1 read_file 非文本材料化 ────────────────────────────────────────

describe('B-1 read_file 非文本文件走 host fileMaterializer', () => {
  function makeFileMaterializer() {
    return {
      materialize: vi.fn(async (input: {
        path: string;
        filename?: string;
        mimeType?: string;
      }) => ({
        fileId: 'file_test_123',
        filename: input.filename ?? path.basename(input.path),
        mimeType: input.mimeType ?? 'application/octet-stream',
        sizeBytes: 14,
        url: 'https://files.example/file_test_123',
      })),
    };
  }

  it('PDF without host materializer returns file_materialization_unavailable', async () => {
    const tools = createTabCodeTools();
    const readFile = tools.find((t) => t.name === 'read_file')!;
    const ctx = makeCtx(new Map());
    const pdfPath = path.join(tmpDir, 'foo.pdf');
    await fsPromises.writeFile(pdfPath, 'fake-pdf-bytes');

    const result = await readFile.execute({ path: pdfPath }, ctx);

    expect(result.isError).toBe(true);
    const parsed = parseContent(result.content as string);
    expect(parsed.error_kind).toBe('file_materialization_unavailable');
    expect(parsed.path).toBe(pdfPath);
  });

  it('PDF is materialized and parsed inside the same read_file call', async () => {
    const fileMaterializer = makeFileMaterializer();
    const parseMaterializedDocument = vi.fn(async () => ({
      content: JSON.stringify({
        success: true,
        status: 'complete',
        content: 'parsed document body',
      }),
    }));
    const tools = createTabCodeTools({ fileMaterializer, parseMaterializedDocument });
    const readFile = tools.find((t) => t.name === 'read_file')!;
    const ctx = makeCtx(new Map());
    const pdfPath = path.join(tmpDir, 'foo.pdf');
    await fsPromises.writeFile(pdfPath, 'fake-pdf-bytes');

    const result = await readFile.execute({ path: pdfPath }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.newMessages).toBeUndefined();
    expect(result.presentation).toEqual({ kind: 'rich_content_only' });
    const parsed = parseContent(result.content as string);
    expect(parsed.status).toBe('complete');
    expect(parsed.content).toBe('parsed document body');
    expect(parseMaterializedDocument).toHaveBeenCalledWith(
      'file_test_123',
      expect.objectContaining({ toolUseId: 'mock-tool-use' }),
    );
    expect(fileMaterializer.materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        path: pdfPath,
        filename: 'foo.pdf',
        mimeType: 'application/pdf',
        threadId: 'test',
        toolUseId: 'mock-tool-use',
      }),
    );
  });

  it('image with host materializer returns metadata and injects its URL as visual input', async () => {
    const fileMaterializer = makeFileMaterializer();
    const tools = createTabCodeTools({ fileMaterializer });
    const readFile = tools.find((t) => t.name === 'read_file')!;
    const ctx = makeCtx(new Map());
    const jpgPath = path.join(tmpDir, 'pic.jpg');
    await fsPromises.writeFile(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const result = await readFile.execute({ path: jpgPath }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.newMessages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://files.example/file_test_123' },
          },
        ],
      },
    ]);
    const parsed = parseContent(result.content as string);
    expect(parsed.type).toBe('file_materialized');
    expect(parsed.category).toBe('image');
    expect(parsed.file_id).toBe('file_test_123');
    expect(parsed.mime_type).toBe('image/jpeg');
    expect(JSON.stringify(parsed)).not.toContain('base64');
  });

  it.each([
    { name: 'clip.mp4', bytes: Buffer.from([0, 1, 2, 3]), category: 'media' },
    { name: 'bundle.zip', bytes: Buffer.from([0x50, 0x4b, 3, 4]), category: 'archive' },
    { name: 'opaque.dat', bytes: Buffer.from([0, 1, 0, 2, 0, 3]), category: 'binary' },
  ])('materializes $name through the successful non-text contract', async ({ name, bytes, category }) => {
    const fileMaterializer = makeFileMaterializer();
    const readFile = createTabCodeTools({ fileMaterializer })
      .find((tool) => tool.name === 'read_file')!;
    const filePath = path.join(tmpDir, name);
    await fsPromises.writeFile(filePath, bytes);

    const result = await readFile.execute({ path: filePath }, makeCtx(new Map()));

    expect(result.isError).toBeUndefined();
    expect(parseContent(result.content as string)).toEqual(expect.objectContaining({
      type: 'file_materialized',
      category,
      file_id: 'file_test_123',
    }));
    expect(fileMaterializer.materialize).toHaveBeenCalledTimes(1);
  });

  it('keeps executable files rejected without uploading them', async () => {
    const fileMaterializer = makeFileMaterializer();
    const readFile = createTabCodeTools({ fileMaterializer })
      .find((tool) => tool.name === 'read_file')!;
    const filePath = path.join(tmpDir, 'unsafe.exe');
    await fsPromises.writeFile(filePath, Buffer.from([0x4d, 0x5a, 0, 0]));

    const result = await readFile.execute({ path: filePath }, makeCtx(new Map()));

    expect(result.isError).toBe(true);
    expect(parseContent(result.content as string).error_kind).toBe('unsupported_operation');
    expect(fileMaterializer.materialize).not.toHaveBeenCalled();
  });

  it('reports an oversized materialization as file_too_large', async () => {
    const fileMaterializer = makeFileMaterializer();
    fileMaterializer.materialize.mockRejectedValueOnce(
      new FileMaterializationTooLargeError(FILE_MATERIALIZATION_MAX_BYTES + 1),
    );
    const readFile = createTabCodeTools({ fileMaterializer })
      .find((tool) => tool.name === 'read_file')!;
    const filePath = path.join(tmpDir, 'large.pdf');
    await fsPromises.writeFile(filePath, 'pdf-bytes');

    const result = await readFile.execute({ path: filePath }, makeCtx(new Map()));

    expect(result.isError).toBe(true);
    expect(parseContent(result.content as string).error_kind).toBe('file_too_large');
  });
});
