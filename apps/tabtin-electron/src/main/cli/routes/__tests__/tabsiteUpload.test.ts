import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

const {
  mockDjangoRequest,
  mockErrorResponse,
  mockGetCLISpaceId,
  mockGetCLIOrganizationId,
  mockGetCLIOrganizationRoot,
  mockResolveSandboxRoot,
  mockSanitizePathSegment,
  mockCopyDirSafe,
  mockResolveTemplatePath,
  mockProvisionTokenAndWriteEnv,
} = vi.hoisted(() => ({
  mockDjangoRequest: vi.fn(),
  mockErrorResponse: vi.fn((code: string, message: string, opts?: any) => ({
    ok: false,
    error: { code, message, ...(opts?.detail ? { detail: opts.detail } : {}) },
  })),
  mockGetCLISpaceId: vi.fn(() => 'space-1'),
  mockGetCLIOrganizationId: vi.fn(() => 'wt-1'),
  mockGetCLIOrganizationRoot: vi.fn(() => '/sandbox'),
  mockResolveSandboxRoot: vi.fn(() => '/sandbox'),
  mockSanitizePathSegment: vi.fn((s: string) => s),
  mockCopyDirSafe: vi.fn(),
  mockResolveTemplatePath: vi.fn(() => '/templates/blank'),
  mockProvisionTokenAndWriteEnv: vi.fn(async () => ({
    tokenProvisioned: false,
  })),
}));

vi.mock('../shared/error-handler', () => ({
  djangoRequest: mockDjangoRequest,
  errorResponse: mockErrorResponse,
}));

vi.mock('../../cli-context', () => ({
  getCLISpaceId: mockGetCLISpaceId,
  getCLIOrganizationId: mockGetCLIOrganizationId,
  getCLIOrganizationRoot: mockGetCLIOrganizationRoot,
}));

vi.mock('@tabtin/terminal-core', () => ({
  resolveDataRoot: mockResolveSandboxRoot,
  resolveSpacesRoot: mockResolveSandboxRoot,
}));

vi.mock('../../utils/path-sanitize', () => ({
  sanitizePathSegment: mockSanitizePathSegment,
}));

vi.mock('../../utils/tabsite-helpers', () => ({
  copyDirSafe: mockCopyDirSafe,
  resolveTemplatePath: mockResolveTemplatePath,
  provisionTokenAndWriteEnv: mockProvisionTokenAndWriteEnv,
}));

const mockExistsSync = vi.fn();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readdirSync: vi.fn(() => []),
  },
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockMkdir = vi.fn();
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: (...args: any[]) => mockReaddir(...args),
    stat: (...args: any[]) => mockStat(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
  },
  readdir: (...args: any[]) => mockReaddir(...args),
  stat: (...args: any[]) => mockStat(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
}));

vi.mock('node:crypto', () => {
  const actual = require('crypto');
  return {
    ...actual,
    default: actual,
    randomUUID: () => 'abcdefgh-1234-5678-9abc-def012345678',
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { handleTabsiteRoute } from '../tabsite';


function makeDirent(
  name: string,
  opts: { isDir?: boolean; isSymlink?: boolean } = {},
): any {
  return {
    name,
    isDirectory: () => !!opts.isDir,
    isSymbolicLink: () => !!opts.isSymlink,
    isFile: () => !opts.isDir && !opts.isSymlink,
  };
}

function setupSiteInfoMock() {
  mockDjangoRequest.mockImplementation(
    async (method: string, url: string, body?: any) => {
      if (url.includes('/api/tabsite/sites/') && method === 'GET') {
        return {
          status: 200,
          data: {
            success: true,
            data: { id: 'site-1', organization_id: 'wt-1', slug: 'test' },
          },
        };
      }
      return { status: 404, data: { success: false } };
    },
  );
}

describe('upload-dist route — collectFiles 防御', () => {
  const res = {} as http.ServerResponse;
  const sendJSON = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockResolveSandboxRoot.mockReturnValue('/sandbox');
    mockGetCLIOrganizationRoot.mockReturnValue('/sandbox');
  });

  // DU-006: 符号链接应被跳过
  it('DU-006: collectFiles 跳过符号链接', async () => {
    setupSiteInfoMock();
    mockReaddir.mockResolvedValueOnce([
      makeDirent('index.html'),
      makeDirent('dangerous-link', { isSymlink: true }),
    ]);
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(Buffer.from('test'));
    mockFetch.mockResolvedValue({ ok: true });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                presigned_url: 'https://oss.example.com/put',
                object_key: 'tabsite/sites/site-1/abcdefgh/index.html',
                cdn_url:
                  'https://cdn.example.com/tabsite/sites/site-1/abcdefgh/index.html',
                instant: false,
              },
            },
          };
        }
        if (url.includes('confirm-upload')) {
          return { status: 200, data: { success: true } };
        }
        return { status: 404, data: { success: false } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ file_count: 1 }),
      }),
    );
    // readFile 只被调用 1 次（index.html），符号链接被跳过
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  // DU-020: 超大文件应被跳过
  it('DU-020: collectFiles 跳过超过 50MB 的文件', async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent('index.html'),
      makeDirent('huge.wasm'),
    ]);
    mockStat
      .mockResolvedValueOnce({ size: 500 })
      .mockResolvedValueOnce({ size: 60 * 1024 * 1024 }); // 60MB

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                presigned_url: 'https://oss.example.com/put',
                object_key: 'tabsite/sites/site-1/abcdefgh/index.html',
                cdn_url:
                  'https://cdn.example.com/tabsite/sites/site-1/abcdefgh/index.html',
                instant: false,
              },
            },
          };
        }
        if (url.includes('confirm-upload')) {
          return { status: 200, data: { success: true } };
        }
        return { status: 404, data: { success: false } };
      },
    );
    mockReadFile.mockResolvedValue(Buffer.from('test'));
    mockFetch.mockResolvedValue({ ok: true });

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          file_count: 1,
          skipped_files: expect.arrayContaining([
            expect.stringContaining('60.0MB'),
          ]),
        }),
      }),
    );
  });
});

describe('upload-dist route — uploadOne 校验', () => {
  const res = {} as http.ServerResponse;
  const sendJSON = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockResolveSandboxRoot.mockReturnValue('/sandbox');
    mockGetCLIOrganizationRoot.mockReturnValue('/sandbox');
  });

  // DU-005: confirm-upload 失败应抛错
  it('DU-005: confirm-upload 返回失败时应报错而非静默继续', async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent('index.html')]);
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(Buffer.from('test'));
    mockFetch.mockResolvedValue({ ok: true });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                presigned_url: 'https://oss.example.com/put',
                object_key: 'tabsite/sites/site-1/abcdefgh/index.html',
                cdn_url:
                  'https://cdn.example.com/tabsite/sites/site-1/abcdefgh/index.html',
                instant: false,
              },
            },
          };
        }
        if (url.includes('confirm-upload')) {
          return {
            status: 500,
            data: { success: false, message: 'DB 写入失败' },
          };
        }
        return { status: 404, data: { success: false } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      500,
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'UPLOAD_FAILED',
          detail: expect.objectContaining({
            failed_files: expect.arrayContaining([
              expect.objectContaining({
                error: expect.stringContaining('Confirm 失败'),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  // DU-004/CC-016: partial upload failure — successful files still reported (DVC-012: single file failure continues)
  it('DU-004/CC-016: 批量上传部分失败时继续上传剩余文件，返回 failed_files', async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent('a.html'),
      makeDirent('b.js'),
    ]);
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(Buffer.from('test'));

    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { ok: false, status: 503 };
      return { ok: true };
    });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                presigned_url: 'https://oss.example.com/put',
                object_key: 'tabsite/sites/site-1/abcdefgh/file',
                cdn_url:
                  'https://cdn.example.com/tabsite/sites/site-1/abcdefgh/file',
                instant: false,
              },
            },
          };
        }
        if (url.includes('confirm-upload')) {
          return { status: 200, data: { success: true } };
        }
        return { status: 404, data: { success: false } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          file_count: 1,
          failed_files: expect.arrayContaining([
            expect.objectContaining({
              error: expect.stringContaining('OSS PUT'),
            }),
          ]),
        }),
      }),
    );
  });
});

describe('upload-dist route — CDN URL 推导', () => {
  const res = {} as http.ServerResponse;
  const sendJSON = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockResolveSandboxRoot.mockReturnValue('/sandbox');
    mockGetCLIOrganizationRoot.mockReturnValue('/sandbox');
  });

  // DU-008: 全部秒传时通过环境变量兜底推导 cdnBaseUrl
  it('DU-008: 全部文件秒传且 cdn_url 为空时，通过环境变量兜底推导', async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent('index.html')]);
    mockStat.mockResolvedValue({ size: 100 });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                instant: true,
                object_key: 'tabsite/sites/site-1/abcdefgh/index.html',
                cdn_url: '',
                access_url: '',
              },
            },
          };
        }
        return { status: 200, data: { success: true } };
      },
    );

    process.env.TABTIN_CDN_DOMAIN = 'cdn.example.com';
    try {
      await handleTabsiteRoute(
        '/site/upload-dist/site-1',
        'POST',
        { dist_path: '/sandbox/dist' },
        res,
        sendJSON,
      );

      expect(sendJSON).toHaveBeenCalledWith(
        res,
        200,
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            dist_url: expect.stringContaining('cdn.example.com'),
          }),
        }),
      );
    } finally {
      delete process.env.TABTIN_CDN_DOMAIN;
    }
  });

  // DU-016: extractCdnBaseUrl 使用 lastIndexOf 避免重复子串截断错误
  it('DU-016: CDN URL 中正确提取 cdnBaseUrl 并生成 dist_url', async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent('index.html')]);
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(Buffer.from('test'));
    mockFetch.mockResolvedValue({ ok: true });

    let capturedFolder = '';
    mockDjangoRequest.mockImplementation(
      async (method: string, url: string, body?: any) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          const objectKey = body?.object_key || '';
          const folder = body?.folder || '';
          capturedFolder = folder;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                presigned_url: 'https://oss.example.com/put',
                object_key: objectKey,
                cdn_url: `https://cdn.example.com/${objectKey}`,
                instant: false,
              },
            },
          };
        }
        if (url.includes('confirm-upload')) {
          return { status: 200, data: { success: true } };
        }
        return { status: 200, data: { success: true } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(capturedFolder).toMatch(/^tabsite\/sites\/site-1\/[a-f0-9]{8}$/);
    expect(sendJSON).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          dist_url: `https://cdn.example.com/${capturedFolder}/`,
        }),
      }),
    );
  });
});

describe('DVC-005 regression: cdnBaseUrl with instant-upload files', () => {
  const res = {} as http.ServerResponse;
  const sendJSON = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockResolveSandboxRoot.mockReturnValue('/sandbox');
    mockGetCLIOrganizationRoot.mockReturnValue('/sandbox');
    delete process.env.TABTIN_CDN_DOMAIN;
    delete process.env.ALIYUN_OSS_CDN_DOMAIN;
    delete process.env.ALIYUN_OSS_ENDPOINT;
    delete process.env.TABTIN_OSS_DOMAIN;
    delete process.env.ALIYUN_OSS_BUCKET;
  });

  it('DVC-005: all files instant-uploaded, cdnBaseUrl resolved from TABTIN_CDN_DOMAIN', async () => {
    process.env.TABTIN_CDN_DOMAIN = 'cdn.example.com';
    mockReaddir.mockResolvedValueOnce([
      makeDirent('index.html'),
      makeDirent('app.js'),
    ]);
    mockStat.mockResolvedValue({ size: 200 });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                instant: true,
                object_key: 'tabsite/sites/site-1/other-uuid/old-file.html',
                cdn_url:
                  'https://cdn.example.com/tabsite/sites/site-1/other-uuid/old-file.html',
              },
            },
          };
        }
        return { status: 200, data: { success: true } };
      },
    );

    try {
      await handleTabsiteRoute(
        '/site/upload-dist/site-1',
        'POST',
        { dist_path: '/sandbox/dist' },
        res,
        sendJSON,
      );

      expect(sendJSON).toHaveBeenCalledWith(
        res,
        200,
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            dist_url: expect.stringMatching(/^https:\/\/cdn\.tabtin\.com\/tabsite\/sites\/site-1\/[a-f0-9]{8}\/$/),
            file_count: 2,
          }),
        }),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      delete process.env.TABTIN_CDN_DOMAIN;
    }
  });

  it('DVC-005: instant files with deduped cdn_url, ENV not set → fallback to origin extraction', async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent('main.js')]);
    mockStat.mockResolvedValue({ size: 100 });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                instant: true,
                object_key: 'tabsite/sites/site-1/abcdefgh/main.js',
                cdn_url:
                  'https://cdn.example.com/tabsite/sites/site-1/old-upload-id/deduped-file.js',
                access_url: '',
              },
            },
          };
        }
        return { status: 200, data: { success: true } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    const responseBody = sendJSON.mock.calls.at(-1)?.[2];
    expect(responseBody).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        dist_url: expect.stringMatching(/^https:\/\/cdn\.example\.com\/tabsite\/sites\/site-1\/[a-f0-9]{8}\/$/),
      }),
    });
  });

  it('DVC-005: no ENV, no cdn_url → returns 500 with clear error message', async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent('index.html')]);
    mockStat.mockResolvedValue({ size: 100 });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                instant: true,
                object_key: 'k',
                cdn_url: '',
                access_url: '',
              },
            },
          };
        }
        return { status: 200, data: { success: true } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      500,
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'UNAVAILABLE',
          message: expect.stringContaining('CDN/OSS'),
        }),
      }),
    );
  });
});

describe('DVC-012 regression: dynamic timeout and partial failure resilience', () => {
  const res = {} as http.ServerResponse;
  const sendJSON = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockResolveSandboxRoot.mockReturnValue('/sandbox');
    mockGetCLIOrganizationRoot.mockReturnValue('/sandbox');
  });

  it('DVC-012: all files fail → returns 500 UPLOAD_FAILED', async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDirent('a.html'),
      makeDirent('b.js'),
    ]);
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(Buffer.from('test'));
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                presigned_url: 'https://oss.example.com/put',
                object_key: 'key',
                cdn_url: '',
                instant: false,
              },
            },
          };
        }
        return { status: 200, data: { success: true } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      500,
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'UPLOAD_FAILED',
          detail: expect.objectContaining({
            failed_files: expect.arrayContaining([
              expect.objectContaining({ path: 'a.html' }),
              expect.objectContaining({ path: 'b.js' }),
            ]),
          }),
        }),
      }),
    );
  });
});

describe('upload-dist route — DU-021 超时保护', () => {
  const res = {} as http.ServerResponse;
  const sendJSON = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockResolveSandboxRoot.mockReturnValue('/sandbox');
    mockGetCLIOrganizationRoot.mockReturnValue('/sandbox');
  });

  // DU-021: fetch PUT 使用 AbortController signal
  it('DU-021: fetch PUT 请求携带 abort signal', async () => {
    mockReaddir.mockResolvedValueOnce([makeDirent('index.html')]);
    mockStat.mockResolvedValue({ size: 100 });
    mockReadFile.mockResolvedValue(Buffer.from('test'));
    mockFetch.mockResolvedValue({ ok: true });

    mockDjangoRequest.mockImplementation(
      async (method: string, url: string) => {
        if (url.includes('/api/tabsite/sites/') && method === 'GET') {
          return {
            status: 200,
            data: {
              success: true,
              data: { id: 'site-1', organization_id: 'wt-1' },
            },
          };
        }
        if (url.includes('presign-upload')) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                presigned_url: 'https://oss.example.com/put',
                object_key: 'tabsite/sites/site-1/abcdefgh/index.html',
                cdn_url:
                  'https://cdn.example.com/tabsite/sites/site-1/abcdefgh/index.html',
                instant: false,
              },
            },
          };
        }
        if (url.includes('confirm-upload')) {
          return { status: 200, data: { success: true } };
        }
        return { status: 200, data: { success: true } };
      },
    );

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://oss.example.com/put',
      expect.objectContaining({
        method: 'PUT',
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
