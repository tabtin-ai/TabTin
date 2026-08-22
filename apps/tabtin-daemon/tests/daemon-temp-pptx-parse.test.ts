/**
 * W3 收尾：Daemon `createRunTempPptxParse` 端到端单测
 *
 * 与 `apps/tabtin-electron/src/main/services/__tests__/tempPptxParse.test.ts`
 * 同款覆盖：presign + PUT + parse-sync 三段链路 + 13 类失败 + abort + timeout，
 * 但 token / apiBaseUrl 走 factory 注入而非 module-level 拿。
 */

import { promises as fsPromises, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunTempPptxParse } from '../src/platform/content/document/tempPptxParse.js';
import {
  FILE_PIPELINE_ERROR_KINDS,
  FilePipelineErrorCode,
} from '@tabtin/local-docparse';

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

let tmpDir: string;
let pptxPath: string;

beforeEach(async () => {
  vi.unstubAllGlobals();
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'daemon-temp-pptx-'));
  tmpDir = await fsPromises.realpath(raw);
  pptxPath = path.join(tmpDir, 'sample.pptx');
  writeFileSync(
    pptxPath,
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 0)]),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function setupFetchMock(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const baseFactoryOpts = {
  apiBaseUrl: 'https://api.daemon.test',
  getAuthToken: () => 'daemon-test-token',
};

describe('createRunTempPptxParse — happy path', () => {
  it('chains presign → PUT → parse-sync; returns success', async () => {
    const fetchMock = setupFetchMock([
      {
        ok: true,
        body: {
          success: true,
          presigned_url: 'https://oss.test/signed',
          temp_object_key: 'temp-parse/daemonu/abc.pptx',
          expires_in: 3600,
        },
      },
      { ok: true, body: {} },
      {
        ok: true,
        body: {
          success: true,
          chunks: [{ type: 'paragraph', content: 'OK', page: 1 }],
          duration_ms: 99,
          pages: 1,
          title: '',
        },
      },
    ]);
    const run = createRunTempPptxParse(baseFactoryOpts);
    const result = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.chunks).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.daemon.test/services/oss/temp-parse-presign',
    );
  });
});

describe('createRunTempPptxParse — failure paths', () => {
  it('no token → NETWORK_ERROR + does not call fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const run = createRunTempPptxParse({ ...baseFactoryOpts, getAuthToken: () => undefined });
    const result = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.errorClass).toBe(FilePipelineErrorCode.NETWORK_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('file not found → FILE_NOT_FOUND', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const run = createRunTempPptxParse(baseFactoryOpts);
    const result = await run(path.join(tmpDir, 'no.pptx'), PPTX_MIME, { timeoutMs: 30_000 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.errorClass).toBe(FilePipelineErrorCode.FILE_NOT_FOUND);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('presign HTTP 500 → NETWORK_ERROR', async () => {
    setupFetchMock([{ ok: false, status: 500, body: {} }]);
    const run = createRunTempPptxParse(baseFactoryOpts);
    const r = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.errorClass).toBe(FilePipelineErrorCode.NETWORK_ERROR);
  });

  it.each(FILE_PIPELINE_ERROR_KINDS)(
    'parse-sync failure_code=%s → SSoT errorClass=%s (auto from FILE_PIPELINE_ERROR_KINDS)',
    async (code) => {
      setupFetchMock([
        {
          ok: true,
          body: {
            success: true,
            presigned_url: 'https://oss.test/x',
            temp_object_key: 'temp-parse/u/y.pptx',
            expires_in: 3600,
          },
        },
        { ok: true, body: {} },
        { ok: true, body: { success: false, message: 'msg', failure_code: code } },
      ]);
      const run = createRunTempPptxParse(baseFactoryOpts);
      const r = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
      expect(r.success).toBe(false);
      if (r.success) throw new Error('unreachable');
      expect(r.errorClass).toBe(code);
    },
  );
});

describe('createRunTempPptxParse — abort + timeout', () => {
  it('caller aborts → USER_ABORTED', async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      ac.abort();
      const sig: AbortSignal = init.signal;
      if (sig.aborted) {
        const err = new Error('aborted by user');
        err.name = 'AbortError';
        throw err;
      }
      return { ok: true, json: async () => ({}), text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = createRunTempPptxParse(baseFactoryOpts);
    const r = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000, signal: ac.signal });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.errorClass).toBe(FilePipelineErrorCode.USER_ABORTED);
  });

  it('TimeoutError → PARSE_TIMEOUT', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    });
    vi.stubGlobal('fetch', fetchMock);
    const run = createRunTempPptxParse(baseFactoryOpts);
    const r = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.errorClass).toBe(FilePipelineErrorCode.PARSE_TIMEOUT);
  });
});

describe('createRunTempPptxParse — token rotation', () => {
  // **W4 (2026-05-13) L51 收**：升级到 per-fetch token rotation——一次 run
  // 内 presign + parse-sync 两段 fetch 都 re-await `getAuthToken()`。让长
  // 流程（>5min token TTL 时）中段 token 旋转后立即生效，不再被闭包锁死
  // 在 run 开始时拿的 token。
  it('factory accepts callable token resolver — fresh value used per FETCH not per run (W4 L51)', async () => {
    // 4 个 token 配 2 次 run × 2 段 fetch 用 token = 4 token 实例。
    // PUT 不带 Authorization 不消耗 token。
    const tokens = ['t1', 't2', 't3', 't4'];
    let i = 0;

    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    };
    const parseSyncBody = {
      success: true,
      chunks: [],
      duration_ms: 1,
      pages: 0,
      title: '',
    };
    setupFetchMock([
      { ok: true, body: presignBody },
      { ok: true, body: {} },
      { ok: true, body: parseSyncBody },
      { ok: true, body: presignBody },
      { ok: true, body: {} },
      { ok: true, body: parseSyncBody },
    ]);

    const run = createRunTempPptxParse({
      ...baseFactoryOpts,
      getAuthToken: () => tokens[i++],
    });
    await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    // 第 1 次 run：presign[0] 用 t1, parse-sync[2] 用 t2（per-fetch rotation）
    const r1Presign = (calls[0]![1] as RequestInit).headers as Record<string, string>;
    const r1ParseSync = (calls[2]![1] as RequestInit).headers as Record<string, string>;
    expect(r1Presign.Authorization).toBe('Bearer t1');
    expect(r1ParseSync.Authorization).toBe('Bearer t2');

    // 第 2 次 run：presign[3] 用 t3, parse-sync[5] 用 t4
    const r2Presign = (calls[3]![1] as RequestInit).headers as Record<string, string>;
    const r2ParseSync = (calls[5]![1] as RequestInit).headers as Record<string, string>;
    expect(r2Presign.Authorization).toBe('Bearer t3');
    expect(r2ParseSync.Authorization).toBe('Bearer t4');
  });
});

// W4 (2026-05-13) L52 钉死：fetch 5xx 一次 retry（反思 §八 #14 修了不补测试 +
// #15 教训不对称应用——Electron 端 W4 L52 测试同款，本组 Daemon 对称）
describe('createRunTempPptxParse — W4 L52 fetch 5xx one-shot retry', () => {
  it('presign 503 then 200 → 4 fetch calls + success', async () => {
    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    };
    const parseSyncBody = {
      success: true,
      chunks: [],
      duration_ms: 1,
      pages: 0,
      title: '',
    };
    setupFetchMock([
      { ok: false, status: 503, body: { error: 'busy' } },
      { ok: true, body: presignBody },
      { ok: true, body: {} },
      { ok: true, body: parseSyncBody },
    ]);

    const run = createRunTempPptxParse(baseFactoryOpts);
    const r = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    expect(r.success).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(4);
  });

  it('OSS PUT 502 then 200 → 4 fetch calls + success', async () => {
    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    };
    const parseSyncBody = {
      success: true,
      chunks: [],
      duration_ms: 1,
      pages: 0,
      title: '',
    };
    setupFetchMock([
      { ok: true, body: presignBody },
      { ok: false, status: 502, body: { error: 'bad gateway' } },
      { ok: true, body: {} },
      { ok: true, body: parseSyncBody },
    ]);

    const run = createRunTempPptxParse(baseFactoryOpts);
    const r = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    expect(r.success).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(4);
  });

  it('presign 4xx → NO retry (immediate fail)', async () => {
    setupFetchMock([
      { ok: false, status: 400, body: { error: 'bad request' } },
    ]);

    const run = createRunTempPptxParse(baseFactoryOpts);
    const r = await run(pptxPath, PPTX_MIME, { timeoutMs: 30_000 });
    expect(r.success).toBe(false);
    if (r.success) throw new Error('unreachable');
    expect(r.errorClass).toBe(FilePipelineErrorCode.NETWORK_ERROR);
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(1);
  });
});
