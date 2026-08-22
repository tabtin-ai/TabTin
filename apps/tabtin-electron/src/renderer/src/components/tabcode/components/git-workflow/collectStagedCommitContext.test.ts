import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectCommitMessageContext,
  hasSensitiveCommitContent,
  truncateDiff,
  MAX_STAGED_DIFF_CHARS,
} from './collectStagedCommitContext'

describe('collectCommitMessageContext helpers', () => {
  it('truncates oversize diffs', () => {
    const raw = 'a'.repeat(MAX_STAGED_DIFF_CHARS + 10)
    const result = truncateDiff(raw)
    expect(result.truncated).toBe(true)
    expect(result.diffExcerpt.length).toBe(MAX_STAGED_DIFF_CHARS)
  })

  it('flags .env paths as sensitive', () => {
    expect(hasSensitiveCommitContent(['apps/.env.local'], 'diff')).toBe(true)
  })

  it('flags secret assignments as sensitive', () => {
    expect(
      hasSensitiveCommitContent(
        ['apps/config.ts'],
        "+const api_key = 'test-api-key'",
      ),
    ).toBe(true)
  })

  it('allows ordinary source diffs', () => {
    expect(
      hasSensitiveCommitContent(
        ['apps/foo.ts'],
        '+export function hello() { return 1 }\n',
      ),
    ).toBe(false)
  })
})

describe('collectCommitMessageContext', () => {
  const rawDiff = vi.fn()
  const getStatus = vi.fn()
  const readFilePreview = vi.fn()

  beforeEach(() => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        git: { rawDiff, getStatus },
        fileSystem: { readFilePreview },
      },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('staged scope only uses --cached diffs', async () => {
    rawDiff.mockImplementation(async (_cwd: string, args: string[] = []) => {
      if (args.includes('--cached') && args.includes('--name-only')) {
        return { success: true, diff: 'apps/staged.ts\n' }
      }
      if (args.includes('--cached')) {
        return { success: true, diff: 'diff --git a/apps/staged.ts\n+staged\n' }
      }
      return { success: true, diff: 'apps/workspace.ts\n' }
    })

    const result = await collectCommitMessageContext('/repo', 'staged')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scope).toBe('staged')
    expect(result.files).toEqual(['apps/staged.ts'])
    expect(result.diffExcerpt).toContain('staged')
    expect(rawDiff).toHaveBeenCalledWith('/repo', ['--cached', '--name-only'])
    expect(rawDiff).toHaveBeenCalledWith('/repo', ['--cached'])
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('workspace scope merges tracked unstaged and untracked text files', async () => {
    rawDiff.mockImplementation(async (_cwd: string, args: string[] = []) => {
      if (args.includes('--name-only')) {
        return { success: true, diff: 'apps/tracked.ts\n' }
      }
      return { success: true, diff: 'diff --git a/apps/tracked.ts\n+tracked\n' }
    })
    getStatus.mockResolvedValue({
      success: true,
      files: {},
      entries: {
        'apps/tracked.ts': { x: ' ', y: 'M' },
        'apps/new.ts': { x: '?', y: '?' },
      },
    })
    readFilePreview.mockResolvedValue({
      success: true,
      data: { kind: 'text', content: 'console.log(1)\n', truncated: false },
    })

    const result = await collectCommitMessageContext('/repo', 'workspace')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scope).toBe('workspace')
    expect(result.files).toEqual(['apps/new.ts', 'apps/tracked.ts'])
    expect(result.diffExcerpt).toContain('+tracked')
    expect(result.diffExcerpt).toContain('new file mode 100644')
    expect(result.diffExcerpt).toContain('+console.log(1)')
    expect(rawDiff).toHaveBeenCalledWith('/repo', ['--name-only'])
    expect(rawDiff).toHaveBeenCalledWith('/repo', [])
    expect(getStatus).toHaveBeenCalledWith('/repo')
  })

  it('workspace scope blocks sensitive untracked paths without uploading content', async () => {
    rawDiff.mockResolvedValue({ success: true, diff: '' })
    getStatus.mockResolvedValue({
      success: true,
      files: {},
      entries: {
        '.env': { x: '?', y: '?' },
      },
    })

    const result = await collectCommitMessageContext('/repo', 'workspace')
    expect(result).toEqual({ ok: false, reason: 'sensitive', scope: 'workspace' })
    expect(readFilePreview).not.toHaveBeenCalled()
  })

  it('workspace scope blocks sensitive content inside untracked text files', async () => {
    rawDiff.mockResolvedValue({ success: true, diff: '' })
    getStatus.mockResolvedValue({
      success: true,
      files: {},
      entries: {
        'apps/secrets.ts': { x: '?', y: '?' },
      },
    })
    readFilePreview.mockResolvedValue({
      success: true,
      data: {
        kind: 'text',
        content: "const api_key = 'test-api-key'\n",
        truncated: false,
      },
    })

    const result = await collectCommitMessageContext('/repo', 'workspace')
    expect(result).toEqual({ ok: false, reason: 'sensitive', scope: 'workspace' })
  })

  it('workspace scope keeps path when untracked preview fails', async () => {
    rawDiff.mockResolvedValue({ success: true, diff: '' })
    getStatus.mockResolvedValue({
      success: true,
      files: {},
      entries: {
        'apps/orphan.ts': { x: '?', y: '?' },
      },
    })
    readFilePreview.mockResolvedValue({ success: false, error: 'permission denied' })

    const result = await collectCommitMessageContext('/repo', 'workspace')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toEqual(['apps/orphan.ts'])
    expect(result.diffExcerpt).toContain('apps/orphan.ts')
  })

  it('workspace scope returns empty when nothing changed', async () => {
    rawDiff.mockResolvedValue({ success: true, diff: '' })
    getStatus.mockResolvedValue({ success: true, files: {}, entries: {} })

    const result = await collectCommitMessageContext('/repo', 'workspace')
    expect(result).toEqual({ ok: false, reason: 'empty', scope: 'workspace' })
  })

  it('marks truncated when tracked diff exceeds budget', async () => {
    const huge = 'x'.repeat(MAX_STAGED_DIFF_CHARS + 20)
    rawDiff.mockImplementation(async (_cwd: string, args: string[] = []) => {
      if (args.includes('--name-only')) {
        return { success: true, diff: 'apps/big.ts\n' }
      }
      return { success: true, diff: huge }
    })
    getStatus.mockResolvedValue({ success: true, files: {}, entries: {} })

    const result = await collectCommitMessageContext('/repo', 'workspace')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.diffExcerpt.length).toBe(MAX_STAGED_DIFF_CHARS)
  })
})
