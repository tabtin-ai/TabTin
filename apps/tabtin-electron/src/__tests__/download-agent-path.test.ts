import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExistsSync, mockMkdirSync, mockGetCLIOrganizationId } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockGetCLIOrganizationId: vi.fn(() => 'org-1' as string | null),
}))

vi.mock('fs', () => {
  const mocks = {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    realpathSync: vi.fn((p: any) => String(p)),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  }
  return { ...mocks, default: mocks }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/downloads') },
  Notification: { isSupported: vi.fn(() => false) },
  systemPreferences: {},
  dialog: { showMessageBox: vi.fn() },
  session: { defaultSession: { on: vi.fn() } },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  BrowserWindow: vi.fn(),
}))

vi.mock('@tabtin/terminal-core', () => ({
  CommandValidator: class CommandValidator {
    validate() {
      return { ok: true }
    }
  },
  resolveSpacesRoot: vi.fn(() => '/mock/spaces'),
  resolvePlatformDataRoot: vi.fn(() => '/mock/platform-data'),
  resolveDataRoot: vi.fn(() => '/mock/data-root'),
}))

// ：downloads 目录挪到 workspace 元数据下；userId / orgId / workspaceId 均必填。
vi.mock('@tabtin/agent-runtime', () => ({
  resolveWorkspaceDownloadsDir: (
    dataRoot: string,
    userId: string,
    orgId: string,
    workspaceId: string,
  ) =>
    `${dataRoot}/users/${userId}/organizations/${orgId}/workspaces/${workspaceId}/downloads`,
}))

vi.mock('../main/cli/cli-context', () => ({
  getCLIOrganizationId: () => mockGetCLIOrganizationId(),
}))

const mockGetUserInfo = vi.fn(async () => null as { id?: string } | null)
vi.mock('../main/auth', () => ({
  TokenManager: {
    getUserInfo: () => mockGetUserInfo(),
  },
}))

import { sanitizePathSegment, resolveSpaceDownloadDir } from '../main/download-manager'

describe('sanitizePathSegment', () => {
  it('returns "default" for empty string', () => {
    expect(sanitizePathSegment('')).toBe('default')
    expect(sanitizePathSegment('   ')).toBe('default')
  })

  it('replaces path separators with underscore', () => {
    expect(sanitizePathSegment('a/b')).toBe('a_b')
    expect(sanitizePathSegment('a\\b')).toBe('a_b')
  })

  it('replaces double dots to prevent traversal', () => {
    expect(sanitizePathSegment('../etc/passwd')).toBe('__etc_passwd')
    expect(sanitizePathSegment('a..b')).toBe('a_b')
  })

  it('strips leading dots and falls back to default for single dot', () => {
    expect(sanitizePathSegment('.hidden')).toBe('hidden')
    expect(sanitizePathSegment('..test')).toBe('_test')
    expect(sanitizePathSegment('...test')).toBe('_.test')
    expect(sanitizePathSegment('.')).toBe('default')
    expect(sanitizePathSegment('..')).toBe('_')
  })

  it('strips NUL bytes', () => {
    expect(sanitizePathSegment('abc\0def')).toBe('abcdef')
    expect(sanitizePathSegment('\0')).toBe('default')
  })

  it('preserves normal agent space IDs', () => {
    expect(sanitizePathSegment('abc-123-def')).toBe('abc-123-def')
    expect(sanitizePathSegment('space_1')).toBe('space_1')
  })
})

describe('resolveSpaceDownloadDir', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCLIOrganizationId.mockReturnValue('org-1')
    // 大多数用例默认已登录 —— 未登录场景单独用例覆盖。
    mockGetUserInfo.mockResolvedValue({ id: 'user-42' })
  })

  it('returns null for empty spaceId', async () => {
    expect(await resolveSpaceDownloadDir(null)).toBeNull()
    expect(await resolveSpaceDownloadDir(undefined)).toBeNull()
    expect(await resolveSpaceDownloadDir('')).toBeNull()
  })

  it('creates downloads directory when it does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const result = await resolveSpaceDownloadDir('space-1')
    expect(result).toBe(
      '/mock/data-root/users/user-42/organizations/org-1/workspaces/space-1/downloads',
    )
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/mock/data-root/users/user-42/organizations/org-1/workspaces/space-1/downloads',
      { recursive: true },
    )
  })

  it('skips mkdir when directory exists', async () => {
    mockExistsSync.mockReturnValue(true)
    const result = await resolveSpaceDownloadDir('space-1')
    expect(result).toBe(
      '/mock/data-root/users/user-42/organizations/org-1/workspaces/space-1/downloads',
    )
    expect(mockMkdirSync).not.toHaveBeenCalled()
  })

  it('sanitizes spaceId to prevent path traversal', async () => {
    mockExistsSync.mockReturnValue(false)
    const result = await resolveSpaceDownloadDir('../etc')
    expect(result).toBe(
      '/mock/data-root/users/user-42/organizations/org-1/workspaces/__etc/downloads',
    )
  })

  it('returns null for non-string spaceId', async () => {
    expect(await resolveSpaceDownloadDir(123 as any)).toBeNull()
    expect(await resolveSpaceDownloadDir({} as any)).toBeNull()
  })

  it('returns null when unauthenticated ( hard-cut — no _unscoped fallback)', async () => {
    mockExistsSync.mockReturnValue(false)
    mockGetUserInfo.mockResolvedValue(null)
    const result = await resolveSpaceDownloadDir('space-1')
    expect(result).toBeNull()
    expect(mockMkdirSync).not.toHaveBeenCalled()
  })

  it('returns null when organizationId missing ( hard-cut)', async () => {
    mockExistsSync.mockReturnValue(false)
    mockGetCLIOrganizationId.mockReturnValue(null)
    const result = await resolveSpaceDownloadDir('space-1')
    expect(result).toBeNull()
    expect(mockMkdirSync).not.toHaveBeenCalled()
  })
})
