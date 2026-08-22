/**
 * FR-18 Phase 2 (H2-E)：Daemon 端 doc-parser handlers 真跑集成测试。
 *
 * 与 Electron `apps/tabtin-electron/src/main/workers/__tests__/doc-parser-handlers.test.ts`
 * 对称。直接 import 共享包 `@tabtin/local-docparse/workers` 的 handlers，
 * 不经 worker_threads（与 Electron 同一种"绕开 worker 协议测纯函数"的策略）。
 *
 * 关键验证：
 *   - Daemon 端的 pdfjs 解析路径与 Electron 一致（POC fixtures 真跑）
 *   - 共享包 handlers 在 Daemon 的 Node 环境（无 Electron）下能解析到 pdfjs/mammoth/xlsx
 *
 * 复用 Electron 的 fixtures（`apps/tabtin-electron/fixtures/poc-pdfs/`）—— 单独再
 * 拷贝一份既浪费空间也让两端快速漂移。
 */

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleParseDocx,
  handleParsePdf,
  handleParseXlsx,
} from '@tabtin/local-docparse/workers';

const __dirname = dirname(fileURLToPath(import.meta.url));
// fixtures 在 apps/tabtin-electron/fixtures/poc-pdfs/，相对 Daemon 测试目录是 ../../tabtin-electron/...
const FIXTURES = resolve(
  __dirname,
  '..',
  '..',
  'tabtin-electron',
  'fixtures',
  'poc-pdfs',
);

const PERF_TOLERANCE = (() => {
  const raw = process.env.TABTIN_PERF_TOLERANCE;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return process.env.CI ? 3 : 1;
})();

describe('Daemon doc-parser handlers — PDF 集成（与 Electron 同 fixtures）', () => {
  it('text-only.pdf（10 页）→ 抽取正确 + 性能 < 1s × tolerance', { timeout: 15000 }, async () => {
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'text-only.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    });

    expect(r.pages).toBe(10);
    expect(r.text).toMatch(/Lorem ipsum/i);
    expect(r.charsPerPageAvg).toBeGreaterThan(500);
    expect(r.isScanned).toBe(false);
    expect(r.qualityScore).toBeGreaterThanOrEqual(0);
    expect(r.qualityScore).toBeLessThanOrEqual(1);
    expect(r.parseDurationMs).toBeLessThan(1000 * PERF_TOLERANCE);
  });

  it('scanned-fake.pdf（无文本层）→ isScanned=true + qualityScore=0', { timeout: 15000 }, async () => {
    const r = await handleParsePdf({
      filePath: resolve(FIXTURES, 'scanned-fake.pdf'),
      maxPages: 2000,
      scannedThresholdCharsPerPage: 100,
    });
    expect(r.isScanned).toBe(true);
    expect(r.charsPerPageAvg).toBeLessThan(100);
    expect(r.qualityScore).toBe(0);
  });

  it('encrypted.pdf → 抛 PasswordException', { timeout: 15000 }, async () => {
    await expect(
      handleParsePdf({
        filePath: resolve(FIXTURES, 'encrypted.pdf'),
        maxPages: 2000,
        scannedThresholdCharsPerPage: 100,
      }),
    ).rejects.toThrow(/password/i);
  });

  it('corrupted.pdf → 抛 InvalidPDFException', { timeout: 15000 }, async () => {
    await expect(
      handleParsePdf({
        filePath: resolve(FIXTURES, 'corrupted.pdf'),
        maxPages: 2000,
        scannedThresholdCharsPerPage: 100,
      }),
    ).rejects.toThrow();
  });

  it('不存在的文件 → 抛 ENOENT', { timeout: 5000 }, async () => {
    await expect(
      handleParsePdf({
        filePath: resolve(FIXTURES, 'does-not-exist-' + Date.now() + '.pdf'),
        maxPages: 2000,
        scannedThresholdCharsPerPage: 100,
      }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });
});

describe('Daemon doc-parser handlers — docx / xlsx 接线', () => {
  it('docx 不存在路径 → 抛错（便于上层 classify not_found）', async () => {
    await expect(
      handleParseDocx({ filePath: '/tmp/does-not-exist-' + Date.now() + '.docx' }),
    ).rejects.toThrow();
  });

  it('xlsx 不存在路径 → 抛错', async () => {
    await expect(
      handleParseXlsx({
        filePath: '/tmp/does-not-exist-' + Date.now() + '.xlsx',
        maxSheets: 20,
        maxRowsPerSheet: 200,
      }),
    ).rejects.toThrow();
  });
});
