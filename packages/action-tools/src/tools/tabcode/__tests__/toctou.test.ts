/**
 * Wave 2 TOCTOU 二次校验单测（文件并发安全 / 2026-05-13）
 *
 * 覆盖 PRD §B.6 + 字节对照基线 W2 测试矩阵 T1-T8：
 *   - T1 入口通过、外部改 mtime + content → 写盘前 throw STALE_READ，文件未被覆盖
 *   - T2 入口通过、外部改 mtime 但 content 没变 → 放行（isFullRead + content 相等）
 *   - T3 partial read 后 edit、外部改 content → throw
 *   - T4 没读过的文件直接 edit → throw STALE_READ（B6-1 写盘前必须先读的严格校验）
 *   - T5 refreshSnapshot 后立刻第二次 edit → 不撞 stale
 *   - T6 throw 后 Agent retry：第二次 edit 应能成功
 *   - T7 concurrent 同文件 2 次 edit（Wave 1 锁兜底）→ 一次成功一次 throw
 *   - T8 临界区禁 await 单测：源码扫描 marker → atomicWriteFile 之间 0 `\bawait\b`
 *
 * **跨包契约**：hook 形态是 input 内部协议字段 `_validate_before_write`
 *（基线 B1-1 / PRD §B.3 2026-05-13 修订）—— 不是 agentTool 对象 mutation。
 * 本测试直接构造 input.`_validate_before_write` 函数模拟 adapter 注入行为
 * + ToolStaleReadError throw 路径，覆盖 fileEditTool / fileWriteTool 内部
 * 的 try/catch 跟 envelope 转换链路。完整 adapter → fileEditTool 端到端
 * 集成走 agent-runtime 一侧的 cross-entry / edit-lock-matrix 已有测试覆盖。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileEditTool, fileWriteTool } from '../index';
import { ToolErrorCode } from '../../../types/errors';
import { ToolStaleReadError } from '../../../utils/tool-stale-read-error';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'toctou-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fsPromises.writeFile(p, content, 'utf8');
  return p;
}

/**
 * 构造一个 mock `_validate_before_write` hook，模拟 adapter
 * 注入的同款行为（撞 stale 时 throw ToolStaleReadError）。
 *
 * @param shouldThrow 决定 hook 是否 throw（true → throw STALE_READ）
 * @param path  错误信号里的 canonical path
 */
function makeHook(shouldThrow: boolean, filePath: string) {
  return (_params: {
    filePath: string;
    currentMtimeMs: number;
    currentContent: string;
  }): void => {
    if (shouldThrow) {
      throw new ToolStaleReadError({
        errorKind: 'tool_stale_read',
        message: `File has been modified externally since you last read it (${filePath}). Your snapshot is stale.`,
        suggestion: 'Re-read the file with read_file to refresh the in-memory snapshot, then retry.',
        path: filePath,
      });
    }
  };
}

/**
 * 真实校验 hook：基于 caller 传入的「snapshot」做 mtime / content 比对，
 * 跟 validateReadBeforeWriteSync 字面同款判定路径，但内嵌在 mock 里方便
 * 测试构造任意 snapshot 状态。
 */
function makeRealisticHook(snapshot: {
  content: string;
  timestamp: number;
  offset?: number;
  limit?: number;
} | null) {
  return (params: {
    filePath: string;
    currentMtimeMs: number;
    currentContent: string;
  }): void => {
    if (!snapshot) {
      throw new ToolStaleReadError({
        errorKind: 'tool_stale_read',
        message: `File has been modified externally since you last read it (${params.filePath}). Your snapshot is stale.`,
        suggestion: 'Re-read the file with read_file to refresh the in-memory snapshot, then retry.',
        path: params.filePath,
      });
    }
    if (params.currentMtimeMs <= snapshot.timestamp + 1) return;
    const isFullRead = snapshot.offset === undefined && snapshot.limit === undefined;
    if (isFullRead && params.currentContent === snapshot.content) return;
    throw new ToolStaleReadError({
      errorKind: 'tool_stale_read',
      message: `File has been modified externally since you last read it (${params.filePath}). Your snapshot is stale.`,
      suggestion: 'Re-read the file with read_file to refresh the in-memory snapshot, then retry.',
      path: params.filePath,
    });
  };
}

describe('Wave 2 TOCTOU — fileEditTool 写盘前二次校验', () => {
  it('T1: 入口通过，外部改 mtime + content → 写盘前 throw STALE_READ + 文件未被覆盖', async () => {
    // 文件初始 + snapshot 看到的形态：含 'original' 标记 + line2
    const file = await writeFile('t1.txt', 'original\nline2\n');
    const snapshotContent = 'original\nline2\n';
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);

    // 外部进程改文件：line2 → modified（但保留 'original' 让 findMatch 仍命中
    // —— 否则 fileEditTool 在 findMatch 阶段先返 OLD_STRING_NOT_FOUND，走不
    // 到 hook 校验那一步，TOCTOU 测试就变成 OLD_STRING_NOT_FOUND 测试）。
    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.writeFile(file, 'original\nmodified\n', 'utf8');

    const res = await fileEditTool.execute({
      path: file,
      old_string: 'original',
      new_string: 'edited',
      _validate_before_write: makeRealisticHook({
        content: snapshotContent,
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);

    expect(res.success).toBe(false);
    const err = (res as { error?: { code?: string } }).error;
    expect(err?.code).toBe(ToolErrorCode.STALE_READ);

    // 文件未被 edit 覆盖：保持外部修改后的内容
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('original\nmodified\n');
  });

  it('T2: 入口通过，外部改 mtime 但 content 没变（云同步抖动假阳性） → 放行', async () => {
    const file = await writeFile('t2.txt', 'stable\ncontent\n');
    const snapshotContent = 'stable\ncontent\n';
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);

    // 外部 touch 文件让 mtime 漂移，但 content 字面相等
    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.utimes(file, new Date(), new Date());

    const res = await fileEditTool.execute({
      path: file,
      old_string: 'stable',
      new_string: 'edited',
      _validate_before_write: makeRealisticHook({
        content: snapshotContent,
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);

    expect(res.success).toBe(true);
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('edited\ncontent\n');
  });

  it('T3: partial read 后 edit，外部改 content → throw（partial 不享受 isFullRead 兜底）', async () => {
    // 保留 'hello' 在文件里让 findMatch 命中 → 走到 hook
    const file = await writeFile('t3.txt', 'hello\nline2\n');
    const snapshotContent = 'hello\nline2\n';
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);

    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.writeFile(file, 'hello\nmodified\n', 'utf8');

    const res = await fileEditTool.execute({
      path: file,
      old_string: 'hello',
      new_string: 'hi',
      _validate_before_write: makeRealisticHook({
        content: snapshotContent,
        timestamp: snapshotMtime,
        offset: 1, // partial read
        limit: 100,
      }),
    } as any);

    expect(res.success).toBe(false);
    const err = (res as { error?: { code?: string } }).error;
    expect(err?.code).toBe(ToolErrorCode.STALE_READ);
  });

  it('T4: 没读过的文件直接 edit → throw STALE_READ（B6-1 写盘前严格于入口）', async () => {
    const file = await writeFile('t4.txt', 'content\n');
    // hook 接到 snapshot=null → throw
    const res = await fileEditTool.execute({
      path: file,
      old_string: 'content',
      new_string: 'edited',
      _validate_before_write: makeRealisticHook(null),
    } as any);

    expect(res.success).toBe(false);
    const err = (res as { error?: { code?: string } }).error;
    expect(err?.code).toBe(ToolErrorCode.STALE_READ);
    // 文件未被改
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('content\n');
  });

  it('T5: refreshSnapshot 后立刻第二次 edit → 不撞 stale', async () => {
    const file = await writeFile('t5.txt', 'v1\n');
    // 模拟第一次 edit 成功后 refresh → snapshot 跟磁盘一致
    // 直接构造：第一次 edit 完成后，磁盘内容 + mtime 跟 snapshot 全对齐
    // 第二次 edit 跑 hook，hook 拿到的 currentMtime / currentContent 跟
    // snapshot 字面一致 → 放行
    const res1 = await fileEditTool.execute({
      path: file,
      old_string: 'v1',
      new_string: 'v2',
      _validate_before_write: makeRealisticHook({
        content: 'v1\n',
        timestamp: Math.floor(fs.statSync(file).mtimeMs),
        offset: undefined,
        limit: undefined,
      }),
    } as any);
    expect(res1.success).toBe(true);

    // refresh snapshot：第二次 hook 用「跟当前磁盘对齐」的 snapshot
    const stat = fs.statSync(file);
    const content = fs.readFileSync(file, 'utf8');
    const res2 = await fileEditTool.execute({
      path: file,
      old_string: 'v2',
      new_string: 'v3',
      _validate_before_write: makeRealisticHook({
        content,
        timestamp: Math.floor(stat.mtimeMs),
        offset: undefined,
        limit: undefined,
      }),
    } as any);
    expect(res2.success).toBe(true);
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('v3\n');
  });

  it('T6: throw 后 Agent retry：重新 read（更新 snapshot）+ 第二次 edit 成功', async () => {
    // 文件初始：含 'target' 标记 + 'extra' 行（hook 要校验的不一致点）
    const file = await writeFile('t6.txt', 'target\nextra\n');
    const snapshotContent = 'target\nextra\n';
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);

    // 外部进程改文件：'extra' → 'modified'（保留 'target' 让 findMatch 不会
    // 在 hook 之前先返 OLD_STRING_NOT_FOUND）
    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.writeFile(file, 'target\nmodified\n', 'utf8');

    // 第一次 edit：findMatch 命中 'target'，但 hook 校验 mtime/content 漂移 → throw stale
    const res1 = await fileEditTool.execute({
      path: file,
      old_string: 'target',
      new_string: 'new-target',
      _validate_before_write: makeRealisticHook({
        content: snapshotContent,
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);
    expect(res1.success).toBe(false);
    expect((res1 as { error?: { code?: string } }).error?.code).toBe(ToolErrorCode.STALE_READ);

    // Agent retry：重新 read → 更新 snapshot 跟当前磁盘对齐
    const freshStat = fs.statSync(file);
    const freshContent = fs.readFileSync(file, 'utf8');

    // 第二次 edit：snapshot 已对齐，hook 放行
    const res2 = await fileEditTool.execute({
      path: file,
      old_string: 'target',
      new_string: 'new-target',
      _validate_before_write: makeRealisticHook({
        content: freshContent,
        timestamp: Math.floor(freshStat.mtimeMs),
        offset: undefined,
        limit: undefined,
      }),
    } as any);
    expect(res2.success).toBe(true);
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('new-target\nmodified\n');
  });

  it('T7: concurrent 同文件 2 次 edit（无 hook 时 atomicWriteFile 不串行覆盖一致性）', async () => {
    // 注意：fileEditTool.execute 不带锁（锁在 adapter 一侧 Wave 1）。
    // 本测试验证「即便不带锁，hook 校验也能区分覆盖场景」——给两次 edit
    // 不同的 snapshot 让其中一次 hook throw。
    const file = await writeFile('t7.txt', 'AAA\nBBB\n');
    const snapshotContent = 'AAA\nBBB\n';
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);

    const op1 = fileEditTool.execute({
      path: file,
      old_string: 'AAA',
      new_string: 'XXX',
      _validate_before_write: makeRealisticHook({
        content: snapshotContent,
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);
    // 第二次 hook 拿到的 snapshot 已 stale（snapshot.content = 'AAA' but
    // 当前磁盘 = 'XXX' 假设 op1 先完成）—— 实际并发场景下时序不确定，
    // 这里只断言「至少一次成功」+ 「失败的那次必为 STALE_READ」。
    const op2 = fileEditTool.execute({
      path: file,
      old_string: 'BBB',
      new_string: 'YYY',
      _validate_before_write: makeRealisticHook({
        content: 'totally different\n',
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);

    const [res1, res2] = await Promise.all([op1, op2]);
    const successes = [res1, res2].filter((r) => r.success);
    const failures = [res1, res2].filter((r) => !r.success);
    // op1 snapshot 正确 → 应该成功；op2 snapshot 错误 → 应该 throw stale
    // 容忍并发顺序：至少一次成功
    expect(successes.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      // 失败的那次必为 STALE_READ（hook 拦的）或 OLD_STRING_NOT_FOUND（前次
      // 覆盖了字符串）—— 不能是 unknown_error / silently corrupt
      const code = (f as { error?: { code?: string } }).error?.code;
      expect([ToolErrorCode.STALE_READ, ToolErrorCode.OLD_STRING_NOT_FOUND]).toContain(code);
    }
  });

  it('T8: 临界区禁 await 不变量 —— 源码 marker → atomicWriteFile 之间 0 `\\bawait\\b`', async () => {
    // 读 fileEditTool / fileWriteTool 源码，定位每个「CRITICAL: no async ops」
    // marker 行号，断言 marker 到下一个 atomicWriteFile 调用之间不含 `await`
    // 关键字 —— 写盘临界区禁 await 的同款不变量（基线 B4-2）。
    const sourceFile = path.resolve(__dirname, '../index.ts');
    const src = await fsPromises.readFile(sourceFile, 'utf8');
    const lines = src.split('\n');

    const markerRegex = /CRITICAL: no async ops between here and atomicWriteFile/;
    const awaitRegex = /\bawait\b/;
    const atomicWriteRegex = /\batomicWriteFile\s*\(/;

    const markerLines: number[] = [];
    lines.forEach((line, idx) => {
      if (markerRegex.test(line)) markerLines.push(idx);
    });

    // 至少 3 处 marker（fileEditTool 2 处 + fileWriteTool 1 处 = 3）
    expect(markerLines.length).toBeGreaterThanOrEqual(3);

    // **Wave 3 整体收尾 L-33 修复**：marker 行必须独占注释行（`// CRITICAL: ...`
    // 严格 prefix），不能混在 `let x = 1; // CRITICAL: ...` 这种 inline 注释里。
    // 旧实现 markerRegex 不要求 marker 独占行，未来重构 inline 注释合并到代码
    // 行时会让「marker → atomicWriteFile 之间」扫描漏报真撞 await 的违例。
    for (const markerLine of markerLines) {
      const markerTrimmed = lines[markerLine].trim();
      expect(
        markerTrimmed.startsWith('// CRITICAL:'),
        `marker 行 ${markerLine + 1} 必须以 "// CRITICAL:" 独占行开头（实际: "${markerTrimmed.slice(0, 80)}"）`,
      ).toBe(true);
    }

    for (const markerLine of markerLines) {
      // 找 marker 之后第一个 atomicWriteFile 调用行
      let atomicLine = -1;
      for (let i = markerLine + 1; i < lines.length; i++) {
        if (atomicWriteRegex.test(lines[i])) {
          atomicLine = i;
          break;
        }
      }
      expect(atomicLine).toBeGreaterThan(markerLine);

      // marker → atomicWriteFile 之间 0 `await` 出现
      for (let i = markerLine + 1; i < atomicLine; i++) {
        const line = lines[i];
        // 跳过注释行（注释里可能有 'await' 文字描述）
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        expect(awaitRegex.test(line)).toBe(false);
      }
    }
    // **L-33 已知限制（暂不修）**：本扫描仍有假阳性盲区 ——
    //   1. 字符串 / template literal 内含字面 `await` 会被误报（生产代码极少
    //      出现，dogfood 撞到再加 string-literal 排除）
    //   2. inline 注释如 `let x = 1; // await foo` 不会被跳过（marker 严格 prefix
    //      已防止这条假阳性进入扫描范围，但 marker 后非注释行仍可能撞）
    // 真实生产代码出现以上模式时再加防御。
  });
});

describe('Wave 2 TOCTOU — fileWriteTool 写盘前二次校验（append 跳过）', () => {
  it('覆写：外部改 mtime + content → throw STALE_READ + 文件未被覆盖', async () => {
    const file = await writeFile('w-overwrite.txt', 'original\n');
    const snapshotContent = 'original\n';
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);

    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.writeFile(file, 'externally modified\n', 'utf8');

    const res = await fileWriteTool.execute({
      path: file,
      contents: 'agent override\n',
      _validate_before_write: makeRealisticHook({
        content: snapshotContent,
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);

    expect(res.success).toBe(false);
    const err = (res as { error?: { code?: string } }).error;
    expect(err?.code).toBe(ToolErrorCode.STALE_READ);
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('externally modified\n');
  });

  it('文件不存在（新建）→ 跳过校验（A2-2）+ 写入成功', async () => {
    const file = path.join(tmpDir, 'w-new.txt');
    // hook 不会被调，因为 currentContent / currentMtimeMs 都是 undefined
    // 即便 hook 总 throw 也不会被触发
    const res = await fileWriteTool.execute({
      path: file,
      contents: 'newly created\n',
      _validate_before_write: makeHook(true, file), // 总 throw 但不该被调
    } as any);

    expect(res.success).toBe(true);
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('newly created\n');
  });

  it('append 模式 → 跳过 Wave 2 校验（A2-3）', async () => {
    const file = await writeFile('w-append.txt', 'first line\n');
    // append 路径不走 Wave 2 校验，即便 hook 总 throw 也不影响
    const res = await fileWriteTool.execute({
      path: file,
      contents: 'second line\n',
      append: true,
      _validate_before_write: makeHook(true, file),
    } as any);

    expect(res.success).toBe(true);
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('first line\nsecond line\n');
  });

  it('覆写 + hook 未注入 → 走 happy path（向后兼容旧 caller 没透传 hook）', async () => {
    const file = await writeFile('w-no-hook.txt', 'before\n');
    const res = await fileWriteTool.execute({
      path: file,
      contents: 'after\n',
    });

    expect(res.success).toBe(true);
    const after = await fsPromises.readFile(file, 'utf8');
    expect(after).toBe('after\n');
  });

  it('覆写 + content 已 normalize 对齐：hook 拿到的 currentContent 是 LF + 无 BOM 形态', async () => {
    // 写一个 CRLF + BOM 文件
    const file = path.join(tmpDir, 'w-crlf-bom.txt');
    await fsPromises.writeFile(file, '\uFEFFhello\r\nworld\r\n', 'utf8');

    let observedContent: string | undefined;
    const res = await fileWriteTool.execute({
      path: file,
      contents: 'replaced\n',
      _validate_before_write: (params: any): void => {
        observedContent = params.currentContent;
        // 不 throw —— 让写入完成
      },
    } as any);

    expect(res.success).toBe(true);
    // hook 看到的 currentContent 必须是 LF + 无 BOM 形态，跟 readFileState entry
    // 内的 normalize 形态对齐
    expect(observedContent).toBe('hello\nworld\n');
  });
});

describe('Wave 2 TOCTOU — 错误信号字节一致性（基线 B5-1）', () => {
  it('fileEditTool replace_all 路径 throw STALE_READ → envelope 字段一致', async () => {
    // 保留 'foo' 在外部 modify 后让 replace_all 找得到 → 走到 hook
    const file = await writeFile('sig-edit-all.txt', 'foo\nfoo\nline3\n');
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);
    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.writeFile(file, 'foo\nfoo\nmodified\n', 'utf8');

    const res = await fileEditTool.execute({
      path: file,
      old_string: 'foo',
      new_string: 'baz',
      replace_all: true,
      _validate_before_write: makeRealisticHook({
        content: 'foo\nfoo\nline3\n',
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);

    expect(res.success).toBe(false);
    const err = (res as { error?: { code?: string; message?: string } }).error;
    expect(err?.code).toBe(ToolErrorCode.STALE_READ);
    // message 字面对齐入口校验
    expect(err?.message).toContain('File has been modified externally since you last read it');
    expect(err?.message).toContain('Your snapshot is stale');
  });

  it('fileEditTool 非 replace_all 路径 throw STALE_READ → 同款 envelope', async () => {
    const file = await writeFile('sig-edit-one.txt', 'foo\n');
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);
    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.writeFile(file, 'bar\n', 'utf8');

    const res = await fileEditTool.execute({
      path: file,
      old_string: 'foo',
      new_string: 'baz',
      _validate_before_write: makeRealisticHook({
        content: 'foo\n',
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);

    // foo 已不在文件 → OLD_STRING_NOT_FOUND 先发生（findMatch 在 hook 之前）
    // 或者如果 hook 先发现 stale 也可以 —— 关键是不能 silently overwrite
    expect(res.success).toBe(false);
    const err = (res as { error?: { code?: string } }).error;
    expect([
      ToolErrorCode.STALE_READ,
      ToolErrorCode.OLD_STRING_NOT_FOUND,
    ]).toContain(err?.code);
  });

  it('fileWriteTool 覆写路径 throw STALE_READ → 同款 envelope', async () => {
    const file = await writeFile('sig-write.txt', 'before\n');
    const snapshotMtime = Math.floor(fs.statSync(file).mtimeMs);
    await new Promise((r) => setTimeout(r, 5));
    await fsPromises.writeFile(file, 'externally modified\n', 'utf8');

    const res = await fileWriteTool.execute({
      path: file,
      contents: 'agent override\n',
      _validate_before_write: makeRealisticHook({
        content: 'before\n',
        timestamp: snapshotMtime,
        offset: undefined,
        limit: undefined,
      }),
    } as any);

    expect(res.success).toBe(false);
    const err = (res as { error?: { code?: string; message?: string } }).error;
    expect(err?.code).toBe(ToolErrorCode.STALE_READ);
    expect(err?.message).toContain('File has been modified externally since you last read it');
  });
});

describe('write_file — workspace root missing ', () => {
  it('does not mkdir -p resurrect a missing workspace root', async () => {
    const missingRoot = path.join(tmpDir, 'renamed-away-root');
    const target = path.join(missingRoot, 'nested', 'ghost.txt');

    const res = await fileWriteTool.execute({
      path: target,
      contents: 'should not land\n',
      _workspace_root: missingRoot,
      _allowed_paths: [missingRoot],
    } as any);

    expect(res.success).toBe(false);
    const errMsg = typeof (res as { error?: unknown }).error === 'string'
      ? (res as { error: string }).error
      : String((res as { error?: { message?: string } }).error?.message ?? (res as { error?: unknown }).error);
    expect(errMsg).toContain('Workspace root no longer exists');
    expect(fs.existsSync(missingRoot)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('still creates intermediate dirs when the workspace root exists', async () => {
    const target = path.join(tmpDir, 'nested', 'ok.txt');
    const res = await fileWriteTool.execute({
      path: target,
      contents: 'ok\n',
      _workspace_root: tmpDir,
      _allowed_paths: [tmpDir],
    } as any);

    expect(res.success).toBe(true);
    expect(await fsPromises.readFile(target, 'utf8')).toBe('ok\n');
  });
});
