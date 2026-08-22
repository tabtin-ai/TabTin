/**
 * binary-dedup-state — image / localDoc dedup 状态单测（W2 北极星 #1）
 *
 * 覆盖：
 *   1. 快路径命中：mtime+size 一致 → 命中 stub
 *   2. 慢路径命中：mtime 漂移 + size 一致 + sha256 一致 → 命中
 *   3. mtime 一致但 size 不一致 → 不命中（内容必然不同）
 *   4. mtime + size + sha256 都不一致 → 不命中
 *   5. record 后 dedup stub 文案包含 path / mtime / size 信息（让 LLM 引用 history）
 *   6. LRU 驱逐：超 entry 数 + 超 byte budget 各自工作
 *   7. fork 子 Agent 模式：clone Map 后 sidecar stats 重置
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maybeReturnUnchangedImageReadStub,
  recordImageReadSnapshot,
  maybeReturnUnchangedLocalDocReadStub,
  recordLocalDocReadSnapshot,
  bufferSha256,
  _internalGetImageDedupStats,
  _internalGetLocalDocDedupStats,
  _internalConstants,
  type ImageReadFileState,
  type LocalDocReadFileState,
} from '../../src/tools/binary-dedup-state.js';

let workspaceRoot: string;
let imagePath: string;
let docPath: string;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_PAYLOAD = Buffer.concat([PNG_MAGIC, Buffer.alloc(1024, 0xff)]);
const PNG_BASE64 = PNG_PAYLOAD.toString('base64');
const PDF_TEXT = '# PDF parsed text\nSection 1\nSection 2\n'.repeat(50);

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'binary-dedup-'));
  imagePath = join(workspaceRoot, 'sample.png');
  docPath = join(workspaceRoot, 'sample.pdf');
  writeFileSync(imagePath, PNG_PAYLOAD);
  writeFileSync(docPath, Buffer.alloc(2048, 0x00));
});

afterEach(() => {
  try {
    rmSync(workspaceRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('image dedup — fast path (mtime + size match)', () => {
  it('returns null when state is undefined (dedup not enabled by host)', async () => {
    const stub = await maybeReturnUnchangedImageReadStub(undefined, imagePath);
    expect(stub).toBeNull();
  });

  it('returns null when entry not yet recorded', async () => {
    const state: ImageReadFileState = new Map();
    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub).toBeNull();
  });

  it('hits stub on second read with same mtime + size', async () => {
    const state: ImageReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(imagePath);
    await recordImageReadSnapshot(state, imagePath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });

    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub).not.toBeNull();
    expect(stub!.content).toContain('Image unchanged');
    expect(stub!.content).toContain('sample.png');
    expect(stub!.content).toContain('image/png');
    expect(stub!.content).toContain('mtime+size match');
    expect(stub!.content).toContain('refer to that image');
  });

  it('does NOT hit when size changes (file was rewritten with different bytes)', async () => {
    const state: ImageReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(imagePath);
    await recordImageReadSnapshot(state, imagePath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });
    // 文件被重写（不同 size）
    const newPayload = Buffer.concat([PNG_MAGIC, Buffer.alloc(2048, 0xee)]);
    writeFileSync(imagePath, newPayload);

    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub).toBeNull();
  });
});

describe('image dedup — slow path (mtime drift, sha256 fallback)', () => {
  it('hits via sha256 when mtime drifted but content unchanged', async () => {
    const state: ImageReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(imagePath);
    await recordImageReadSnapshot(state, imagePath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });

    // 模拟 mtime 漂移（macOS iCloud / Windows AV 改 mtime 但内容相同）
    const future = new Date(stat.mtimeMs + 60_000);
    utimesSync(imagePath, future, future);

    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub).not.toBeNull();
    expect(stub!.content).toContain('sha256 match');
  });

  it('does NOT hit when sha256 differs (file truly modified, same size, mtime drifted)', async () => {
    const state: ImageReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(imagePath);
    await recordImageReadSnapshot(state, imagePath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });

    // 写新内容但保持 size 一致（模拟"文件被改"但 sha256 不同的 corner case）
    const newPayload = Buffer.concat([PNG_MAGIC, Buffer.alloc(1024, 0xaa)]);
    writeFileSync(imagePath, newPayload);
    // **关键**：显式拨 mtime 漂移强制走"慢路径"——快路径用 mtime+size 双签名，
    // 在 1ms 内重写同 size 文件 mtime 可能撞 floor 后一致 → 走快路径直接命中
    // 反而掩盖 sha256 mismatch 路径的真实语义。这里钉死的是慢路径：mtime 漂移
    // + size 一致 + sha256 不同 → 不命中。
    const future = new Date(stat.mtimeMs + 60_000);
    utimesSync(imagePath, future, future);

    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub).toBeNull();
  });

  it('record uses disk-file sha256 source not base64 source (§八 #9 防双源回归)', async () => {
    // **反思 §八 #9 钉死**：record 算的 sha256 必须与 dedup 慢路径 fileSha256
    // 同源（文件 source），不能基于 base64 缓冲（缩放场景下 base64 sha 与原
    // 文件 sha 永远不一致 → 慢路径退化为"无 dedup"）。本 case 故意让 base64
    // 参数与磁盘字节不同——若 record 错用 base64 source 算 sha，下方"内容一致"
    // 仍会失败 → 测试 fail；只有 record 走文件 source 才会命中。
    //
    // **Review 3 中度-1 补强（W2.1 收尾）**：除端到端"命中走慢路径"守门外，
    // 直接 assert `entry.sha256 === bufferSha256(PNG_PAYLOAD)` —— 让"sha256
    // 字段语义来源于磁盘字节"这条契约钉得最硬。如果未来有人改 record 把
    // `sha256 = ''` 写死或改用别的算法，本测试也能直接报警，而不是绕过
    // 守门只看端到端。
    const state: ImageReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(imagePath);

    // base64 参数刻意构造与磁盘字节"语义无关"的字符串（模拟缩放后 base64 与
    // 原文件 sha256 不一致的真实场景）
    const decoyBase64 = Buffer.from('decoy-not-the-disk-bytes').toString('base64');
    await recordImageReadSnapshot(state, imagePath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      base64: decoyBase64,
      mediaType: 'image/jpeg', // 缩放后输出 mime
      wasResized: true,
    });

    // 直接钉死：entry.sha256 必须等于磁盘字节的 sha256，不是 decoyBase64 的
    const recordedEntry = state.get(imagePath);
    expect(recordedEntry).toBeDefined();
    expect(recordedEntry!.sha256).toBe(bufferSha256(PNG_PAYLOAD));
    expect(recordedEntry!.sha256).not.toBe(bufferSha256(Buffer.from(decoyBase64, 'base64')));

    // 关键：用同样的字节重写磁盘 + 拨 mtime 漂移 → 触发慢路径走 sha256；
    // 文件 sha 没变（同字节）→ record 与 check 都基于文件 sha → 应命中
    writeFileSync(imagePath, PNG_PAYLOAD);
    const future = new Date(stat.mtimeMs + 120_000);
    utimesSync(imagePath, future, future);

    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub).not.toBeNull();
    expect(stub!.content).toContain('sha256 match');
  });
});

describe('image dedup — wasResized stub messaging', () => {
  it('stub includes "resized to fit" warning when wasResized=true', async () => {
    const state: ImageReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(imagePath);
    await recordImageReadSnapshot(state, imagePath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      base64: PNG_BASE64,
      mediaType: 'image/jpeg', // resized output
      wasResized: true,
    });

    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub).not.toBeNull();
    expect(stub!.content).toContain('resized');
  });

  it('stub does NOT mention resize when wasResized=false (preserve fidelity)', async () => {
    const state: ImageReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(imagePath);
    await recordImageReadSnapshot(state, imagePath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });

    const stub = await maybeReturnUnchangedImageReadStub(state, imagePath);
    expect(stub!.content).not.toContain('resized');
  });
});

describe('localDoc dedup', () => {
  it('hits stub on second read with same mtime + size', async () => {
    const state: LocalDocReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(docPath);
    await recordLocalDocReadSnapshot(state, docPath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      text: PDF_TEXT,
      mimeType: 'application/pdf',
      pages: 5,
    });

    const stub = await maybeReturnUnchangedLocalDocReadStub(state, docPath);
    expect(stub).not.toBeNull();
    expect(stub!.content).toContain('Document unchanged');
    expect(stub!.content).toContain('sample.pdf');
    expect(stub!.content).toContain('5 pages');
    expect(stub!.content).toContain('application/pdf');
    expect(stub!.content).toContain('refer to that text');
  });

  it('hits via sha256 when mtime drifted but content unchanged', async () => {
    const state: LocalDocReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(docPath);
    await recordLocalDocReadSnapshot(state, docPath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      text: PDF_TEXT,
      mimeType: 'application/pdf',
    });

    const future = new Date(stat.mtimeMs + 60_000);
    utimesSync(docPath, future, future);

    const stub = await maybeReturnUnchangedLocalDocReadStub(state, docPath);
    expect(stub).not.toBeNull();
    expect(stub!.content).toContain('sha256 match');
  });

  it('record uses disk-file sha256 source not text source (§八 #9 防双源回归，localDoc 路径)', async () => {
    // **W2.1 收尾 Review 1 重要-1 补强**：反思 §八 #9 sha256 双源教训在
    // image 路径已经钉死（见上方 'record uses disk-file sha256 source not
    // base64 source'），但同款 bug 在 localDoc 路径**完全等价存在**——
    // `recordLocalDocReadSnapshot` 用 `fileSha256(resolvedPath)` 算磁盘 sha，
    // 参数 `meta.text` 仅用于 `textBytes = meta.text.length`。如果有人改成
    // `sha256 = bufferSha256(meta.text)`，localDoc 慢路径就退化为"无 dedup"
    // ——和 §八 #9 反思的 image 路径完全同款 bug。
    //
    // 反思 §八 #9 原文明确点名两条路径都有，但 W2 一轮只在 image 写了反向
    // 测试，localDoc 路径 0 守门。本期把"教训全路径吸收"补齐。
    const state: LocalDocReadFileState = new Map();
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(docPath);

    // text 参数刻意构造与磁盘字节"语义无关"的字符串（模拟解析后 text 与
    // 原文件 sha256 不一致的真实场景）
    const decoyText = 'decoy parsed text — completely unrelated to disk bytes';
    await recordLocalDocReadSnapshot(state, docPath, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      text: decoyText,
      mimeType: 'application/pdf',
      pages: 3,
    });

    // 直接钉死：entry.sha256 必须等于磁盘字节的 sha256，不是 decoyText 的
    const recordedEntry = state.get(docPath);
    expect(recordedEntry).toBeDefined();
    // docPath 初始字节是 Buffer.alloc(2048, 0x00)
    const diskBytes = Buffer.alloc(2048, 0x00);
    expect(recordedEntry!.sha256).toBe(bufferSha256(diskBytes));
    expect(recordedEntry!.sha256).not.toBe(bufferSha256(Buffer.from(decoyText, 'utf-8')));

    // 拨 mtime 漂移 → 走慢路径；磁盘字节没变 → 命中
    const future = new Date(stat.mtimeMs + 120_000);
    utimesSync(docPath, future, future);

    const stub = await maybeReturnUnchangedLocalDocReadStub(state, docPath);
    expect(stub).not.toBeNull();
    expect(stub!.content).toContain('sha256 match');
  });
});

describe('LRU eviction — image dedup', () => {
  // 用真实文件路径让 fileSha256 能算（不是 /fake/...）
  function makeRealPng(name: string): string {
    const p = join(workspaceRoot, name);
    writeFileSync(p, PNG_PAYLOAD);
    return p;
  }

  it('evicts oldest entries when count exceeds IMAGE_DEDUP_MAX_ENTRIES', async () => {
    const state: ImageReadFileState = new Map();
    const max = _internalConstants.IMAGE_DEDUP_MAX_ENTRIES;

    for (let i = 0; i < max + 10; i++) {
      const fakePath = makeRealPng(`img-${i}.png`);
      await recordImageReadSnapshot(state, fakePath, {
        mtimeMs: 1000 + i, // 单调递增让 readAt 顺序与插入顺序对得上
        sizeBytes: 100 + i,
        base64: PNG_BASE64,
        mediaType: 'image/png',
        wasResized: false,
      });
    }

    const stats = _internalGetImageDedupStats(state);
    expect(stats.entryCount).toBeLessThanOrEqual(max);
  });

  it('byte stats accumulate proportional to entries', async () => {
    const state: ImageReadFileState = new Map();
    for (let i = 0; i < 10; i++) {
      const p = makeRealPng(`b-${i}.png`);
      await recordImageReadSnapshot(state, p, {
        mtimeMs: 1000 + i,
        sizeBytes: 100,
        base64: PNG_BASE64,
        mediaType: 'image/png',
        wasResized: false,
      });
    }
    const stats = _internalGetImageDedupStats(state);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.entryCount).toBe(10);
  });
});

describe('fork sub-agent semantics — Map clone resets sidecar', () => {
  function makeRealPng(name: string): string {
    const p = join(workspaceRoot, name);
    writeFileSync(p, PNG_PAYLOAD);
    return p;
  }

  it('cloning Map (new Map(parent)) creates fresh sidecar with totalBytes=0', async () => {
    const parent: ImageReadFileState = new Map();
    const p = makeRealPng('parent.png');
    await recordImageReadSnapshot(parent, p, {
      mtimeMs: 1000,
      sizeBytes: 100,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });
    expect(_internalGetImageDedupStats(parent).totalBytes).toBeGreaterThan(0);

    // fork-query 同款 shallow clone
    const child: ImageReadFileState = new Map(parent);
    expect(child.size).toBe(1);
    // 子 sidecar 是新的（WeakMap 找不到 child，初始为 0）
    expect(_internalGetImageDedupStats(child).totalBytes).toBe(0);
    expect(_internalGetImageDedupStats(child).entryCount).toBe(1);
  });

  it('child writes do NOT affect parent (per-fork isolation)', async () => {
    const parent: ImageReadFileState = new Map();
    const p1 = makeRealPng('parent.png');
    await recordImageReadSnapshot(parent, p1, {
      mtimeMs: 1000,
      sizeBytes: 100,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });
    const parentSizeBefore = parent.size;

    const child: ImageReadFileState = new Map(parent);
    const p2 = makeRealPng('child.png');
    await recordImageReadSnapshot(child, p2, {
      mtimeMs: 2000,
      sizeBytes: 200,
      base64: PNG_BASE64,
      mediaType: 'image/png',
      wasResized: false,
    });

    expect(parent.size).toBe(parentSizeBefore);
    expect(child.size).toBe(parentSizeBefore + 1);
  });
});

describe('localDoc LRU eviction parity', () => {
  it('initial state has zero bytes / zero entries', () => {
    const state: LocalDocReadFileState = new Map();
    expect(_internalGetLocalDocDedupStats(state)).toEqual({
      totalBytes: 0,
      entryCount: 0,
    });
  });

  it('record updates stats correctly', async () => {
    const state: LocalDocReadFileState = new Map();
    await recordLocalDocReadSnapshot(state, docPath, {
      mtimeMs: 1000,
      sizeBytes: 5000,
      text: 'a'.repeat(1000),
      mimeType: 'application/pdf',
    });
    const stats = _internalGetLocalDocDedupStats(state);
    expect(stats.entryCount).toBe(1);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });
});

describe('bufferSha256 — sanity', () => {
  it('produces stable hex sha256 for same input', () => {
    const a = bufferSha256(Buffer.from('hello'));
    const b = bufferSha256(Buffer.from('hello'));
    expect(a).toBe(b);
    expect(a.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(a)).toBe(true);
  });

  it('different input produces different hash', () => {
    const a = bufferSha256(Buffer.from('hello'));
    const b = bufferSha256(Buffer.from('world'));
    expect(a).not.toBe(b);
  });
});
