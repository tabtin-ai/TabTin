/**
 * read_file 端到端打造（2026-05-12）回归测试。
 *
 * 覆盖 4 桶能力：
 *   - A1 编码识别：UTF-16/GBK/BOM/jschardet 嗅探
 *   - A3 目录截断：entries > 200 时只返前 200 + truncated 标记
 *   - A4 单行截断：单行 > 2000 字符 substring + 标记
 *   - B1 macOS 截图 thin-space 兼容（U+202F ↔ space）
 *
 * 这些测试故意走 fileReadTool.execute 的真实路径（fs / iconv / jschardet），
 * 不 mock 任何编码检测组件——为防"jschardet 升级 / iconv-lite 接口变化"
 * 等场景悄悄回归到强制 utf8 解析。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';

vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

import { fileReadTool } from '../index';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'read-file-improvements-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

async function writeRaw(name: string, content: Buffer): Promise<string> {
  const file = path.join(tmpDir, name);
  await fsPromises.writeFile(file, content);
  return file;
}

// ──────────────────────────────────────────────────────────────────────
// A1 编码识别
// ──────────────────────────────────────────────────────────────────────

describe('A1 编码识别', () => {
  it('UTF-16LE BOM 文件能正确解码（不再被 null byte 误判为二进制）', async () => {
    // BOM (FF FE) + UTF-16LE 编码的 "Hello\nWorld\n"
    const text = 'Hello\nWorld\n';
    const utf16leBuf = iconv.encode(text, 'utf-16le');
    const bom = Buffer.from([0xff, 0xfe]);
    const file = await writeRaw('utf16le.txt', Buffer.concat([bom, utf16leBuf]));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    expect(res.data?.contentRaw).toBe('Hello\nWorld\n');
    // BOM 已剥，行号正常
    expect(res.data?.content).toContain('1\tHello');
    expect(res.data?.content).toContain('2\tWorld');
  });

  it('UTF-16BE BOM 文件能正确解码', async () => {
    const text = 'foo\nbar\n';
    const utf16beBuf = iconv.encode(text, 'utf-16be');
    const bom = Buffer.from([0xfe, 0xff]);
    const file = await writeRaw('utf16be.txt', Buffer.concat([bom, utf16beBuf]));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    expect(res.data?.contentRaw).toBe('foo\nbar\n');
  });

  it('GBK 中文文件能识别并解码（jschardet 嗅探路径）', async () => {
    // GBK 编码的中文样本，长度足够 jschardet 自信识别（confidence > 0.85）
    const chineseText = '你好世界，这是一段中文内容\n用来测试编码自动识别和解码功能\n这一行是第三行\n';
    // 重复 3 遍提高 jschardet 置信度
    const fullText = chineseText.repeat(3);
    const gbkBuf = iconv.encode(fullText, 'gbk');
    const file = await writeRaw('gbk.txt', gbkBuf);

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    // 解码后应该含中文（不是乱码）
    expect(res.data?.contentRaw).toContain('你好世界');
    expect(res.data?.contentRaw).toContain('编码自动识别');
  });

  it('UTF-8 BOM 文件正常解码（BOM 优先级最高，跳过 jschardet）', async () => {
    const text = 'alpha\nbeta\n';
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const utf8Buf = Buffer.from(text, 'utf-8');
    const file = await writeRaw('utf8bom.txt', Buffer.concat([bom, utf8Buf]));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    expect(res.data?.contentRaw).toBe('alpha\nbeta\n');
  });

  it('纯 UTF-8 文件（无 BOM）走原 utf8 路径，不被错误识别成其它编码', async () => {
    const text = 'function hello() {\n  return "world";\n}\n';
    const file = await writeRaw('script.ts', Buffer.from(text, 'utf-8'));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    expect(res.data?.contentRaw).toBe(text);
  });

  it('真二进制文件返回可材料化元数据，不把字节塞进工具结果', async () => {
    // 模拟真二进制：随机字节 + 大量 null byte
    const buf = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) buf[i] = i % 2 === 0 ? 0 : i;
    const file = await writeRaw('weird.dat', buf);

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    expect(res.data).toEqual(expect.objectContaining({
      type: 'non_text_file',
      category: 'binary',
      path: file,
      size_bytes: buf.length,
    }));
    expect(res.data).not.toHaveProperty('content');
    expect(res.data).not.toHaveProperty('contentRaw');
  });

  it('可执行文件仍明确拒绝，不进入材料化链路', async () => {
    const file = await writeRaw('unsafe.exe', Buffer.from([0x4d, 0x5a, 0, 0]));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(false);
    expect(res.error_code).toBe('unsupported_operation');
  });
});

// ──────────────────────────────────────────────────────────────────────
// A3 目录截断
// ──────────────────────────────────────────────────────────────────────

describe('A3 目录截断', () => {
  it('目录 entries ≤ 200 时不截断', async () => {
    const dir = path.join(tmpDir, 'small-dir');
    await fsPromises.mkdir(dir);
    for (let i = 0; i < 50; i++) {
      await fsPromises.writeFile(path.join(dir, `file-${i}.txt`), '');
    }

    const res = await fileReadTool.execute({ path: dir });

    expect(res.success).toBe(true);
    expect(res.data?.is_directory).toBe(true);
    expect(res.data?.entries).toHaveLength(50);
    expect(res.data?.truncated).toBeUndefined();
    expect(res.data?.total_count).toBeUndefined();
  });

  it('目录 entries > 200 时只返前 200 + truncated:true + total_count', async () => {
    const dir = path.join(tmpDir, 'large-dir');
    await fsPromises.mkdir(dir);
    for (let i = 0; i < 250; i++) {
      // 用 padStart 让排序更可预测：file-001 / file-002 ... file-250
      await fsPromises.writeFile(
        path.join(dir, `file-${String(i).padStart(3, '0')}.txt`),
        '',
      );
    }

    const res = await fileReadTool.execute({ path: dir });

    expect(res.success).toBe(true);
    expect(res.data?.is_directory).toBe(true);
    expect(res.data?.entries).toHaveLength(200);
    expect(res.data?.truncated).toBe(true);
    expect(res.data?.total_count).toBe(250);
    // localeCompare 排序：file-000 在前
    expect(res.data?.entries?.[0].name).toBe('file-000.txt');
    expect(res.data?.entries?.[199].name).toBe('file-199.txt');
  });
});

// ──────────────────────────────────────────────────────────────────────
// A4 单行截断
// ──────────────────────────────────────────────────────────────────────

describe('A4 单行截断', () => {
  it('单行 > 2000 字符截断到 2000 + 追加截断标记', async () => {
    const longLine = 'x'.repeat(3000);
    const text = `short line\n${longLine}\nanother short\n`;
    const file = await writeRaw('long-line.txt', Buffer.from(text, 'utf-8'));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    const lines = String(res.data?.content).split('\n');
    // 第 1 行短，第 2 行被截断，第 3 行短，第 4 行空（trailing newline）
    expect(lines[0]).toBe('1\tshort line');
    // 第 2 行：行号 + tab + 2000 个 x + 截断标记
    expect(lines[1]).toMatch(/^2\tx{2000} \.\.\. \(line truncated to 2000 chars\)$/);
    expect(lines[2]).toBe('3\tanother short');
  });

  it('单行 ≤ 2000 字符不动', async () => {
    const exactly2000 = 'y'.repeat(2000);
    const text = `${exactly2000}\nshort\n`;
    const file = await writeRaw('exact.txt', Buffer.from(text, 'utf-8'));

    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(true);
    const lines = String(res.data?.content).split('\n');
    expect(lines[0]).toBe(`1\t${exactly2000}`);
    expect(lines[0]).not.toContain('truncated');
  });
});

// ──────────────────────────────────────────────────────────────────────
// B1 macOS 截图 thin-space 兼容
// ──────────────────────────────────────────────────────────────────────

describe('B1 macOS 截图 thin-space 兼容', () => {
  it('盘上是普通空格的截图，LLM 用 NARROW NBSP 路径能读到', async () => {
    // 实际盘上：截图 2026-05-12 at 3.45.12 PM.png（普通空格）
    const realName = '截图 2026-05-12 at 3.45.12 PM.txt';
    const realPath = await writeRaw(realName, Buffer.from('screenshot content\n', 'utf-8'));
    // LLM 抄到的：U+202F NARROW NO-BREAK SPACE 形态
    const altPath = realPath.replace(' PM.txt', '\u202FPM.txt');

    const res = await fileReadTool.execute({ path: altPath });

    expect(res.success).toBe(true);
    expect(res.data?.contentRaw).toBe('screenshot content\n');
  });

  it('盘上是 NARROW NBSP 的截图，LLM 用普通空格路径能读到', async () => {
    const realName = '截图 2026-05-12 at 9.30.05\u202FAM.txt';
    const realPath = await writeRaw(realName, Buffer.from('alt screenshot\n', 'utf-8'));
    const altPath = realPath.replace('\u202FAM.txt', ' AM.txt');

    const res = await fileReadTool.execute({ path: altPath });

    expect(res.success).toBe(true);
    expect(res.data?.contentRaw).toBe('alt screenshot\n');
  });

  it('非截图模式的文件名（不含 H.MM.SS 时间戳）不触发 thin-space 重试', async () => {
    const file = path.join(tmpDir, 'regular file.txt');
    // 不创建文件，请求一个不存在的"普通"路径
    const res = await fileReadTool.execute({ path: file });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('File does not exist');
  });
});
