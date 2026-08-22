/**
 * Unit test for CheckpointService.getAffectedPaths() — EP-006 support method.
 *
 * Verifies that getAffectedPaths returns the correct list of relative file paths
 * that would be modified by a restore operation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGit, mockFs } = vi.hoisted(() => {
  const mockGit = {
    init: vi.fn().mockResolvedValue(undefined),
    addConfig: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockResolvedValue({ value: '/tmp/test-project' }),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
    raw: vi.fn().mockResolvedValue('1'),
    revparse: vi.fn().mockResolvedValue('abc123'),
    diffSummary: vi.fn().mockResolvedValue({ files: [] }),
    show: vi.fn().mockResolvedValue(''),
    reset: vi.fn().mockResolvedValue(undefined),
  }
  const mockFs = {
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
    readdir: vi.fn().mockResolvedValue([]),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  }
  return { mockGit, mockFs }
})

vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue(mockGit),
}))

vi.mock('node:fs/promises', () => ({ default: mockFs }))

const mockLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}

import { CheckpointService } from '@tabtin/checkpoint-core'

describe('CheckpointService.getAffectedPaths', () => {
  let service: CheckpointService

  beforeEach(() => {
    vi.clearAllMocks()
    mockGit.raw.mockResolvedValue('1')
    service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', mockLogger)
    ;(service as any).initialized = true
  })

  it('returns list of affected file paths', async () => {
    mockGit.raw
      .mockResolvedValueOnce('src/app.ts\n.env\nREADME.md\n')

    const paths = await service.getAffectedPaths('abc123')
    expect(paths).toEqual(['src/app.ts', '.env', 'README.md'])

    const rawCalls = mockGit.raw.mock.calls
    const diffCall = rawCalls.find(
      (call: any[]) => Array.isArray(call[0]) && call[0].includes('--name-only'),
    )
    expect(diffCall).toBeTruthy()
    expect(diffCall![0]).toContain('abc123')
    expect(diffCall![0]).toContain('HEAD')
  })

  it('returns empty array when no files differ', async () => {
    mockGit.raw
      .mockResolvedValueOnce('\n')

    const paths = await service.getAffectedPaths('abc123')
    expect(paths).toEqual([])
  })

  it('strips whitespace from file paths', async () => {
    mockGit.raw
      .mockResolvedValueOnce('  src/app.ts  \n  .env  \n')

    const paths = await service.getAffectedPaths('abc123')
    expect(paths).toEqual(['src/app.ts', '.env'])
  })

  it('sanitizes commit hash (removes non-hex chars)', async () => {
    mockGit.raw
      .mockResolvedValueOnce('src/app.ts\n')

    await service.getAffectedPaths('abc123; rm -rf /')

    const rawCalls = mockGit.raw.mock.calls
    const diffCall = rawCalls.find(
      (call: any[]) => Array.isArray(call[0]) && call[0].includes('--name-only'),
    )
    expect(diffCall![0]).toContain('abc123f')
    expect(diffCall![0]).not.toContain(';')
    expect(diffCall![0]).not.toContain('rm')
  })

  it('propagates errors from git diff', async () => {
    mockGit.raw
      .mockRejectedValueOnce(new Error('fatal: bad object abc123'))

    await expect(service.getAffectedPaths('abc123')).rejects.toThrow('bad object')
  })
})
