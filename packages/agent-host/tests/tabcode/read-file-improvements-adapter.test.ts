/**
 * read_file 端到端打造（2026-05-12）adapter 层回归测试。
 *
 * 覆盖：
 *   - A2 非文本文件材料化：不把 image/base64 直接塞进上下文
 *   - A3 目录截断 system-reminder 注入
 *   - B3 cyber risk reminder opt-in 行为
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ToolContext,
} from '@tabtin/agent-runtime';
import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'read-file-improvements-adapter-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    threadId: 'test',
    runtimeId: 'test',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: tmpDir,
    readFileState: new Map(),
  } as unknown as ToolContext;
}

function makeFileMaterializer() {
  return {
    materialize: vi.fn(async (input: {
      path: string;
      filename?: string;
      mimeType?: string;
    }) => ({
      fileId: 'file_image_123',
      filename: input.filename ?? path.basename(input.path),
      mimeType: input.mimeType ?? 'application/octet-stream',
      sizeBytes: 4,
      url: 'https://files.example/file_image_123',
    })),
  };
}

function getReadTool(deps: Parameters<typeof createTabCodeTools>[0] = {}) {
  const tools = createTabCodeTools(deps);
  const tool = tools.find((t) => t.name === 'read_file');
  if (!tool) throw new Error('read_file not found');
  return tool;
}

// ──────────────────────────────────────────────────────────────────────
// B3 cyber risk reminder opt-in 行为
// ──────────────────────────────────────────────────────────────────────

describe('B3 cyber risk reminder opt-in', () => {
  it('默认（不传 deps.enableCyberRiskReminder）→ 不附加 reminder', async () => {
    const file = path.join(tmpDir, 'sample.ts');
    await fsPromises.writeFile(file, 'const x = 1;\n');

    const tool = getReadTool();
    const res = await tool.execute({ path: file }, makeCtx());

    expect(typeof res.content).toBe('string');
    expect(String(res.content)).not.toContain('<system-reminder>');
    expect(String(res.content)).not.toContain('considered malware');
  });

  it('显式传 deps.enableCyberRiskReminder=false → 不附加 reminder', async () => {
    const file = path.join(tmpDir, 'sample2.ts');
    await fsPromises.writeFile(file, 'const y = 2;\n');

    const tool = getReadTool({ enableCyberRiskReminder: false });
    const res = await tool.execute({ path: file }, makeCtx());

    expect(String(res.content)).not.toContain('considered malware');
  });

  it('显式传 deps.enableCyberRiskReminder=true → 文本末尾附加 cyber risk reminder', async () => {
    const file = path.join(tmpDir, 'malware-sample.py');
    await fsPromises.writeFile(file, 'print("hello")\n');

    const tool = getReadTool({ enableCyberRiskReminder: true });
    const res = await tool.execute({ path: file }, makeCtx());

    const content = String(res.content);
    expect(content).toContain('1\tprint("hello")');
    expect(content).toContain('<system-reminder>');
    expect(content).toContain('considered malware');
    expect(content).toContain('refuse to improve or augment');
  });

  it('cyber reminder 不污染图像材料化分支', async () => {
    // 1×1 px JPEG 最小合法 buffer（不需要真图，扩展名走图像分支即可）
    const minimalJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = path.join(tmpDir, 'pic.jpg');
    await fsPromises.writeFile(file, minimalJpeg);
    const fileMaterializer = makeFileMaterializer();

    const tool = getReadTool({ enableCyberRiskReminder: true, fileMaterializer });
    const res = await tool.execute({ path: file }, makeCtx());

    expect(res.newMessages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://files.example/file_image_123' },
          },
        ],
      },
    ]);
    const parsed = JSON.parse(String(res.content)) as Record<string, unknown>;
    expect(parsed.type).toBe('file_materialized');
    expect(parsed.file_id).toBe('file_image_123');
    expect(String(res.content)).not.toContain('considered malware');
    expect(String(res.content)).not.toContain('base64');
  });

  it('cyber reminder 不污染目录分支', async () => {
    const dir = path.join(tmpDir, 'sub');
    await fsPromises.mkdir(dir);
    await fsPromises.writeFile(path.join(dir, 'a.txt'), '');

    const tool = getReadTool({ enableCyberRiskReminder: true });
    const res = await tool.execute({ path: dir }, makeCtx());

    const content = String(res.content);
    expect(content).not.toContain('considered malware');
  });
});

// ──────────────────────────────────────────────────────────────────────
// A3 目录截断 system-reminder 注入（adapter 层）
// ──────────────────────────────────────────────────────────────────────

describe('A3 目录截断 system-reminder', () => {
  it('目录 ≤ 200 entries → 不附加 reminder', async () => {
    const dir = path.join(tmpDir, 'small');
    await fsPromises.mkdir(dir);
    for (let i = 0; i < 30; i++) {
      await fsPromises.writeFile(path.join(dir, `f${i}.txt`), '');
    }

    const tool = getReadTool();
    const res = await tool.execute({ path: dir }, makeCtx());

    expect(String(res.content)).not.toContain('<system-reminder>');
    expect(String(res.content)).not.toContain('only first');
  });

  it('目录 > 200 entries → 末尾附加 system-reminder（含 total + 引导）', async () => {
    const dir = path.join(tmpDir, 'huge');
    await fsPromises.mkdir(dir);
    for (let i = 0; i < 250; i++) {
      await fsPromises.writeFile(
        path.join(dir, `file-${String(i).padStart(3, '0')}.txt`),
        '',
      );
    }

    const tool = getReadTool();
    const res = await tool.execute({ path: dir }, makeCtx());

    const content = String(res.content);
    expect(content).toContain('<system-reminder>');
    expect(content).toContain('Directory has 250 entries');
    expect(content).toContain('only first 200 shown');
    expect(content).toContain('grep_search');
    expect(content).toContain('glob_search');
  });
});

// ──────────────────────────────────────────────────────────────────────
// A2 非文本文件材料化（额外覆盖）
// ──────────────────────────────────────────────────────────────────────

describe('A2 非文本文件材料化', () => {
  it('图像返回 file_materialized 元数据，并用 URL 注入视觉消息', async () => {
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
      0x00, 0x00, 0x00, 0x0d, // IHDR length
    ]);
    const file = path.join(tmpDir, 'tiny.png');
    await fsPromises.writeFile(file, minimalPng);
    const fileMaterializer = makeFileMaterializer();

    const tool = getReadTool({ fileMaterializer });
    const res = await tool.execute({ path: file }, makeCtx());

    expect(res.newMessages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://files.example/file_image_123' },
          },
        ],
      },
    ]);
    const parsed = JSON.parse(String(res.content)) as Record<string, unknown>;
    expect(parsed.type).toBe('file_materialized');
    expect(parsed.category).toBe('image');
    expect(parsed.path).toBe(file);
    expect(parsed.mime_type).toBe('image/png');
    expect(parsed.file_id).toBe('file_image_123');
    expect(String(res.content)).not.toContain('base64');
  });
});
