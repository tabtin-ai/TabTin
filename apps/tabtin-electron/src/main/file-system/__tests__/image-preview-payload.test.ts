/**
 * ：本机图片预览走 path / tabtin-file://，远程才 base64 内联并截断。
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}))

vi.mock('node:child_process', () => {
  const execFile = vi.fn()
  return { execFile, default: { execFile } }
})

vi.mock('node:util', () => ({
  promisify: () => vi.fn(),
  default: { promisify: () => vi.fn() },
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: vi.fn(() => '/tmp/sandbox'),
  resolveDataRoot: vi.fn(() => '/tmp/data'),
  resolvePlatformDataRoot: vi.fn(() => '/tmp/platform'),
  computeSkillContentHash: vi.fn().mockResolvedValue('hash'),
  matchSensitivePath: vi.fn(() => null),
}))

vi.mock('@tabtin/agent-runtime', () => ({
  resolveSpaceWorkspaceRoot: vi.fn(),
  resolveOrganizationSkillsDir: vi.fn(),
}))

vi.mock('@tabtin/security-policy', () => ({
  checkHardlinePath: vi.fn(() => ({ allowed: true })),
}))

vi.mock('../../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: () => ({ allowed: true }),
  }),
}))

vi.mock('../../utils/path-sanitize', () => ({
  sanitizePathSegment: (s: string) => s,
}))

vi.mock('../../auth', () => ({
  TokenManager: {},
  isTrustedSender: vi.fn(() => true),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../utils/guarded-handle', () => ({
  guardedHandle: vi.fn(),
}))

vi.mock('../ripgrep-bundle-path', () => ({
  getBundledRipgrepPath: () => null,
}))

vi.mock('../office-preview-renderer', () => ({
  renderOfficePreview: vi.fn(),
  renderOfficePreviewBuffer: vi.fn(),
  supportsRenderedOfficePreview: vi.fn(() => false),
}))

vi.mock('keytar', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
  findPassword: vi.fn(),
}))

import { buildFilePreviewPayload } from '../ipc'

describe('buildFilePreviewPayload image ', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tabtin-image-preview-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('local preview returns path without reading base64 (no size cap)', async () => {
    // 超过旧 5MB 硬顶，本机仍应可预览
    const filePath = path.join(tempDir, 'large.png')
    const bytes = Buffer.alloc(6 * 1024 * 1024, 0x41)
    await writeFile(filePath, bytes)

    const result = await buildFilePreviewPayload(filePath)

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      kind: 'image',
      path: filePath,
      size: bytes.length,
      truncated: false,
      mime: 'image/png',
    })
    expect(result.data).not.toHaveProperty('content')
  })

  it('remote preview inlines small images as base64', async () => {
    const filePath = path.join(tempDir, 'small.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await writeFile(filePath, bytes)

    const result = await buildFilePreviewPayload(filePath, { imageMaxBytes: 160 * 1024 })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      kind: 'image',
      content: bytes.toString('base64'),
      size: bytes.length,
      truncated: false,
      mime: 'image/png',
    })
    expect(result.data).not.toHaveProperty('path')
  })

  it('remote preview marks oversized images as truncated binary', async () => {
    const filePath = path.join(tempDir, 'too-big.png')
    const bytes = Buffer.alloc(200 * 1024, 0x42)
    await writeFile(filePath, bytes)

    const result = await buildFilePreviewPayload(filePath, { imageMaxBytes: 160 * 1024 })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      kind: 'binary',
      size: bytes.length,
      truncated: true,
    })
  })
})
