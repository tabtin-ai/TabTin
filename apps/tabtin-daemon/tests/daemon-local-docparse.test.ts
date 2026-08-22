/**
 * FR-18 Phase 2 (H2-E)：Daemon 侧本地附件解析回归。
 *
 * 设计意图：
 *   - 共享包 `@tabtin/local-docparse` 的核心逻辑（mime 分类、扫描件识别、错误
 *     分类、URL 下载等）由 Electron `localDocParse.test.ts` 全量覆盖（62 个用例）
 *     —— 那是 H1-D-MAIN 实施时建立的金标准
 *   - Daemon 这里**只**测两件事：
 *     1. Daemon-specific defaults：默认 maxFileSizeMb = 20MB（vs Electron 50MB）
 *     2. Daemon 的 wrapper 把 logger / runner 正确接到共享包
 *   - 不重测共享包逻辑（避免每次共享包升级两端测试同时失败）
 *
 * 与 Electron 单测的关键差异：
 *   - Electron 单测 mock `'../../workers/doc-parser-runner'` 模块；
 *     Daemon 单测同样 mock `'../src/platform/content/document/doc-parser-runner.js'`
 *   - 因为共享包通过 deps 注入运行 worker，本测仍用模块 mock 的方式确保
 *     Daemon 侧调用链 wrapper → packages → injected runner 全过路
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseLocalAttachment as parseLocalAttachmentWithDeps,
  DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
  type DaemonParseLocalAttachmentOverrides,
} from '../src/platform/content/document/localDocParse.js';
import type { Logger } from '../src/platform/observability/logging/logger.js';
import type { LocalDocParseOptions, ParseLocalAttachmentInput } from '@tabtin/local-docparse';

const runDocParserTaskMock = vi.fn();

function parseLocalAttachment(
  input: ParseLocalAttachmentInput,
  options: LocalDocParseOptions,
  logger: Logger,
  overrides?: DaemonParseLocalAttachmentOverrides,
) {
  return parseLocalAttachmentWithDeps(input, options, logger, runDocParserTaskMock, overrides);
}

function makeLogger(): Logger {
  // 不实例化真 Logger（构造会创建 fs stream）；最小满足 KernelLogger 接口即可
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

beforeEach(() => {
  runDocParserTaskMock.mockReset();
});

describe('Daemon localDocParse — 默认体积上限 20MB（vs Electron 50MB）', () => {
  it('Daemon 默认上限是 20MB', () => {
    expect(DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB).toBe(20);
  });

  it('25MB PDF 触发 oversize（Daemon 默认 20MB 严于 Electron 50MB）', async () => {
    const logger = makeLogger();
    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/big.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 25 * 1024 * 1024,
      },
      {},
      logger,
    );

    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errorClass).toBe('file_too_large');
    expect(r.fallbackToCloud).toBe(false);
    // 不应调 worker（在 mime 分类后立即拦截）
    expect(runDocParserTaskMock).not.toHaveBeenCalled();
  });

  it('15MB PDF 不触发 oversize（落入 Daemon 20MB 之内）', async () => {
    const logger = makeLogger();
    runDocParserTaskMock.mockResolvedValue({
      text: 'Some PDF text content that passes quality threshold easily.',
      pages: 5,
      charCount: 60,
      charsPerPageAvg: 12,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 1.0,
      fileSizeBytes: 15 * 1024 * 1024,
      parseDurationMs: 15,
      firstPageDurationMs: 5,
    });

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/medium.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 15 * 1024 * 1024,
      },
      {},
      logger,
    );

    expect(r.success).toBe(true);
    expect(runDocParserTaskMock).toHaveBeenCalled();
  });

  it('options.maxFileSizeMb 显式覆盖 Daemon 默认值', async () => {
    const logger = makeLogger();
    // 用户配置 50MB → 25MB 文件落入 limit 内
    runDocParserTaskMock.mockResolvedValue({
      text: 'Big but within explicit 50MB cap. Long enough to pass quality 30%.',
      pages: 50,
      charCount: 60,
      charsPerPageAvg: 1.2,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 1.0,
      fileSizeBytes: 25 * 1024 * 1024,
      parseDurationMs: 200,
      firstPageDurationMs: 5,
    });

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/big-but-allowed.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 25 * 1024 * 1024,
      },
      { maxFileSizeMb: 50 },
      logger,
    );

    expect(r.success).toBe(true);
    expect(runDocParserTaskMock).toHaveBeenCalled();
  });

  it('overrides.maxFileSizeMb 也能覆盖默认（覆盖优先级低于 options）', async () => {
    const logger = makeLogger();
    // overrides 给 30MB → 25MB 文件应通过
    runDocParserTaskMock.mockResolvedValue({
      text: 'Some long content from a NAS-tuned 30MB cap to pass quality threshold easily',
      pages: 30,
      charCount: 80,
      charsPerPageAvg: 2.7,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 1.0,
      fileSizeBytes: 25 * 1024 * 1024,
      parseDurationMs: 100,
      firstPageDurationMs: 5,
    });

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/nas-tuned.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 25 * 1024 * 1024,
      },
      {},
      logger,
      { maxFileSizeMb: 30 },
    );

    expect(r.success).toBe(true);
  });

  it('options.maxFileSizeMb 优先于 overrides.maxFileSizeMb', async () => {
    const logger = makeLogger();
    // options 给 10MB → 即使 overrides 给 100MB 也以 10MB 为准 → 15MB 文件应被拦
    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/x.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 15 * 1024 * 1024,
      },
      { maxFileSizeMb: 10 },
      logger,
      { maxFileSizeMb: 100 },
    );

    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errorClass).toBe('file_too_large');
  });
});

describe('Daemon localDocParse — wrapper 完整接线（logger / runner 注入）', () => {
  it('PDF 成功路径：worker 被调 + result 字段透传', async () => {
    const logger = makeLogger();
    runDocParserTaskMock.mockResolvedValue({
      text: 'A Daemon-side PDF parsed via shared package handlers. Full content here.',
      pages: 8,
      charCount: 75,
      charsPerPageAvg: 9.4,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 0.95,
      fileSizeBytes: 5 * 1024 * 1024,
      parseDurationMs: 50,
      firstPageDurationMs: 8,
    });

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/daemon.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 5 * 1024 * 1024,
      },
      {},
      logger,
    );

    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.text).toContain('Daemon-side PDF');
    expect(r.pages).toBe(8);
    expect(r.qualityScore).toBe(0.95);
    expect(r.mimeType).toBe('application/pdf');

    // 验证 worker 被调用，且 task type 正确（即 wrapper 把 runner 接到共享包）
    expect(runDocParserTaskMock).toHaveBeenCalledTimes(1);
    expect(runDocParserTaskMock.mock.calls[0][0]).toBe('parse-pdf');
  });

  it('扫描件 → scanned 失败（逻辑来自共享包，确认 wrapper 不丢失字段）', async () => {
    const logger = makeLogger();
    runDocParserTaskMock.mockResolvedValue({
      text: '',
      pages: 5,
      charCount: 20,
      charsPerPageAvg: 4,
      emptyPages: 5,
      isScanned: true,
      qualityScore: 0,
      fileSizeBytes: 2 * 1024 * 1024,
      parseDurationMs: 10,
      firstPageDurationMs: 4,
    });

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/scan.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 2 * 1024 * 1024,
      },
      {},
      logger,
    );

    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errorClass).toBe('scanned_pdf');
    expect(r.fallbackToCloud).toBe(true);
  });

  it('加密 PDF → encrypted（fallbackToCloud=false 透传）', async () => {
    const logger = makeLogger();
    const err = new Error('Password required');
    err.name = 'PasswordException';
    runDocParserTaskMock.mockRejectedValue(err);

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/enc.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 1 * 1024 * 1024,
      },
      {},
      logger,
    );

    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errorClass).toBe('encrypted');
    expect(r.fallbackToCloud).toBe(false);
  });

  it('docx wrapper 接线正确', async () => {
    const logger = makeLogger();
    runDocParserTaskMock.mockResolvedValue({
      text: 'Word doc content from Daemon-side wrapper.',
      fileSizeBytes: 8000,
      parseDurationMs: 12,
      messageCount: 0,
    });

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/d.docx' },
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSizeBytes: 8000,
      },
      {},
      logger,
    );

    expect(r.success).toBe(true);
    if (r.success) expect(r.text).toContain('Daemon-side');
    expect(runDocParserTaskMock.mock.calls[0][0]).toBe('parse-docx');
  });

  it('xlsx wrapper 接线正确', async () => {
    const logger = makeLogger();
    runDocParserTaskMock.mockResolvedValue({
      text: '## Sheet1\n\n| A | B |\n|---|---|\n| 1 | 2 |',
      sheetCount: 1,
      sheetsTruncated: 0,
      rowsTruncatedCount: 0,
      cellCount: 4,
      fileSizeBytes: 4000,
      parseDurationMs: 6,
    });

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/d.xlsx' },
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSizeBytes: 4000,
      },
      {},
      logger,
    );

    expect(r.success).toBe(true);
    expect(runDocParserTaskMock.mock.calls[0][0]).toBe('parse-xlsx');
  });

  it('PPT 走 unsupported 分支（直接拦截，不调 worker）', async () => {
    const logger = makeLogger();
    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/ignored.pptx' },
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
      {},
      logger,
    );

    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errorClass).toBe('unsupported_format');
    expect(r.fallbackToCloud).toBe(true);
    expect(runDocParserTaskMock).not.toHaveBeenCalled();
  });
});

describe('Daemon localDocParse — abort 行为（H2-E Review 必修）', () => {
  it('用户主动 abort URL 下载 → errorClass=aborted（不切云端）', async () => {
    const logger = makeLogger();

    // mock fetch 在 abort 触发后立即 reject AbortError
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit | undefined) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
          return;
        }
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/slow.pdf' }, mimeType: 'application/pdf' },
      { signal: controller.signal, timeoutMs: 10_000 },
      logger,
    );

    vi.unstubAllGlobals();
    expect(r.success).toBe(false);
    if (r.success) return;
    // 必须是 'aborted' 而非 'timeout' —— "停止"是用户行为，不应切云端
    expect(r.errorClass).toBe('aborted');
    expect(r.fallbackToCloud).toBe(false);
  });

  it('worker abort → errorClass=aborted（WorkerTaskAbortedError）', async () => {
    const logger = makeLogger();
    const err = new Error('Worker task aborted');
    err.name = 'WorkerTaskAbortedError';
    runDocParserTaskMock.mockRejectedValue(err);

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/x.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 1024 },
      {},
      logger,
    );

    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errorClass).toBe('aborted');
    expect(r.fallbackToCloud).toBe(false);
  });

  it('内部超时（非用户 abort） → errorClass=timeout（仍切云端）', async () => {
    const logger = makeLogger();

    // mock fetch 也是 AbortError（fetch 内部 ac.abort()），但 options.signal 未触发
    const fetchMock = vi.fn().mockImplementation(() => {
      return new Promise((_resolve, reject) => {
        // 等下游内部 AbortController（来自 timeoutMs）触发后 reject
        setTimeout(() => {
          const e = new Error('aborted by timeout');
          e.name = 'AbortError';
          reject(e);
        }, 100);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/slow.pdf' }, mimeType: 'application/pdf' },
      { timeoutMs: 50 }, // 没有 user signal，靠内部 timeout
      logger,
    );

    vi.unstubAllGlobals();
    expect(r.success).toBe(false);
    if (r.success) return;
    // 没有 user abort → 应识别为 timeout（fallbackToCloud=true）
    expect(r.errorClass).toBe('parse_timeout');
    expect(r.fallbackToCloud).toBe(true);
  });
});
