/**
 * 回归测试：WFE-001 / WFE-012
 *
 * WFE-001: upload-dist 路由中 siteData.organization_id 应来自 Django API 响应
 *          （现已在 SiteDetail schema 中包含 organization_id 字段）
 *
 * WFE-012: publish 路由必须对 dist_url 做非空校验，
 *          空/undefined/null 的 dist_url 不应透传给 Django
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'

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
    error: message,
    code,
  })),
  mockGetCLISpaceId: vi.fn(() => 'space-1'),
  mockGetCLIOrganizationId: vi.fn(() => 'wt-1'),
  mockGetCLIOrganizationRoot: vi.fn(() => '/sandbox'),
  mockResolveSandboxRoot: vi.fn(() => '/sandbox'),
  mockSanitizePathSegment: vi.fn((s: string) => s),
  mockCopyDirSafe: vi.fn(),
  mockResolveTemplatePath: vi.fn(() => '/templates/blank'),
  mockProvisionTokenAndWriteEnv: vi.fn(async () => ({ tokenProvisioned: false })),
}))

vi.mock('../shared/error-handler', () => ({
  djangoRequest: mockDjangoRequest,
  errorResponse: mockErrorResponse,
}))

vi.mock('../../cli-context', () => ({
  getCLISpaceId: mockGetCLISpaceId,
  getCLIOrganizationId: mockGetCLIOrganizationId,
  getCLIOrganizationRoot: mockGetCLIOrganizationRoot,
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: mockResolveSandboxRoot,
}))

vi.mock('../../utils/path-sanitize', () => ({
  sanitizePathSegment: mockSanitizePathSegment,
}))

vi.mock('../../utils/tabsite-helpers', () => ({
  copyDirSafe: mockCopyDirSafe,
  resolveTemplatePath: mockResolveTemplatePath,
  provisionTokenAndWriteEnv: mockProvisionTokenAndWriteEnv,
}))

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true), readdirSync: vi.fn(() => []) },
  existsSync: vi.fn(() => true),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
  },
}))

vi.mock('node:crypto', () => {
  const actual = require('crypto')
  return {
    ...actual,
    default: actual,
    randomUUID: () => 'abcdefgh-1234-5678-9abc-def012345678',
  }
})

import { handleTabsiteRoute } from '../tabsite'

// ═══════════════════════════════════════════════════════════
// WFE-012: publish 路由 dist_url 非空校验
// ═══════════════════════════════════════════════════════════

describe('WFE-012: publish route dist_url validation', () => {
  const res = {} as http.ServerResponse
  const sendJSON = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dist_url 为 undefined 时返回 400', async () => {
    await handleTabsiteRoute(
      '/site/publish/site-1',
      'POST',
      { message: 'v1' },
      res,
      sendJSON,
    )

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      400,
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })

  it('dist_url 为空字符串时返回 400', async () => {
    await handleTabsiteRoute(
      '/site/publish/site-1',
      'POST',
      { message: 'v1', dist_url: '' },
      res,
      sendJSON,
    )

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      400,
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })

  it('dist_url 为 null 时返回 400', async () => {
    await handleTabsiteRoute(
      '/site/publish/site-1',
      'POST',
      { message: 'v1', dist_url: null },
      res,
      sendJSON,
    )

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      400,
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })

  it('body 为 undefined 时返回 400', async () => {
    await handleTabsiteRoute(
      '/site/publish/site-1',
      'POST',
      undefined,
      res,
      sendJSON,
    )

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      400,
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(mockDjangoRequest).not.toHaveBeenCalled()
  })

  it('dist_url 有效时正常透传给 Django', async () => {
    mockDjangoRequest.mockResolvedValue({
      status: 200,
      data: { success: true, data: { version: 1 } },
    })

    await handleTabsiteRoute(
      '/site/publish/site-1',
      'POST',
      { message: 'v1', dist_url: 'https://cdn.example.com/dist/', file_count: 5, total_size: 1024 },
      res,
      sendJSON,
    )

    expect(mockDjangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/tabsite/sites/site-1/publish/',
      expect.objectContaining({
        dist_url: 'https://cdn.example.com/dist/',
        message: 'v1',
        file_count: 5,
        total_size: 1024,
      }),
    )
    expect(sendJSON).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({ success: true, data: { version: 1 } }),
    )
  })
})

// ═══════════════════════════════════════════════════════════
// WFE-001: upload-dist 路由使用 siteData.organization_id
// ═══════════════════════════════════════════════════════════

describe('WFE-001: upload-dist uses organization_id from site data', () => {
  const res = {} as http.ServerResponse
  const sendJSON = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('presign-upload 请求应携带 Django 返回的 organization_id', async () => {
    const fs = await import('node:fs')
    const fsPromises = await import('node:fs/promises')

    ;(fs.default.existsSync as any).mockReturnValue(true)
    mockResolveSandboxRoot.mockReturnValue('/sandbox')
    mockGetCLIOrganizationRoot.mockReturnValue('/sandbox')

    ;(fsPromises.default.readdir as any).mockResolvedValueOnce([
      { name: 'index.html', isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true },
    ])
    ;(fsPromises.default.stat as any).mockResolvedValue({ size: 100 })
    ;(fsPromises.default.readFile as any).mockResolvedValue(Buffer.from('test'))

    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const siteOrganizationId = 'real-organization-uuid-from-django'
    let capturedPresignBody: any = null

    mockDjangoRequest.mockImplementation(async (method: string, url: string, body?: any) => {
      if (url.includes('/api/tabsite/sites/') && method === 'GET') {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              id: 'site-1',
              organization_id: siteOrganizationId,
              slug: 'test',
            },
          },
        }
      }
      if (url.includes('presign-upload')) {
        capturedPresignBody = body
        return {
          status: 200,
          data: {
            success: true,
            data: {
              presigned_url: 'https://oss.example.com/put',
              object_key: 'tabsite/sites/site-1/abcdefgh/index.html',
              cdn_url: 'https://cdn.example.com/tabsite/sites/site-1/abcdefgh/index.html',
              instant: false,
            },
          },
        }
      }
      if (url.includes('confirm-upload')) {
        return { status: 200, data: { success: true } }
      }
      return { status: 200, data: { success: true } }
    })

    await handleTabsiteRoute(
      '/site/upload-dist/site-1',
      'POST',
      { dist_path: '/sandbox/dist' },
      res,
      sendJSON,
    )

    expect(capturedPresignBody).not.toBeNull()
    expect(capturedPresignBody.organization_id).toBe(siteOrganizationId)
  })
})
