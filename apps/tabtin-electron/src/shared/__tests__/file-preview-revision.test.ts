import { describe, expect, it } from 'vitest'
import { buildLocalFilePreviewRevision } from '../file-preview-revision'

describe('buildLocalFilePreviewRevision', () => {
  it('排序路径与原始字节指纹，并把当前/目标版本绑定到同一修订', async () => {
    const first = await buildLocalFilePreviewRevision({
      sessionId: 'session-1',
      deviceFingerprint: 'device-1',
      rewindAnchorId: 'run-1',
      status: 'available',
      reason: null,
      affectedPaths: ['/workspace/b.ts', '/workspace/a.ts'],
      fingerprints: [
        {
          path: 'b.ts',
          status: 'modified',
          current: { kind: 'file', size: 9, mode: 0o100644, sha256: 'current-b' },
          target: { kind: 'file', size: 8, mode: 0o100644, sha256: 'target-b' },
        },
        {
          path: 'a.ts',
          status: 'deleted',
          current: { kind: 'file', size: 9, mode: 0o100644, sha256: 'current-a' },
          target: { kind: 'absent' },
        },
      ],
    })
    const reordered = await buildLocalFilePreviewRevision({
      sessionId: 'session-1',
      deviceFingerprint: 'device-1',
      rewindAnchorId: 'run-1',
      status: 'available',
      reason: null,
      affectedPaths: ['/workspace/a.ts', '/workspace/b.ts'],
      fingerprints: [
        {
          path: 'a.ts',
          status: 'deleted',
          current: { kind: 'file', size: 9, mode: 0o100644, sha256: 'current-a' },
          target: { kind: 'absent' },
        },
        {
          path: 'b.ts',
          status: 'modified',
          current: { kind: 'file', size: 9, mode: 0o100644, sha256: 'current-b' },
          target: { kind: 'file', size: 8, mode: 0o100644, sha256: 'target-b' },
        },
      ],
    })
    const changedCurrentContent = await buildLocalFilePreviewRevision({
      sessionId: 'session-1',
      deviceFingerprint: 'device-1',
      rewindAnchorId: 'run-1',
      status: 'available',
      reason: null,
      affectedPaths: ['/workspace/a.ts', '/workspace/b.ts'],
      fingerprints: [
        {
          path: 'a.ts',
          status: 'deleted',
          current: { kind: 'file', size: 16, mode: 0o100644, sha256: 'current-a-edited' },
          target: { kind: 'absent' },
        },
        {
          path: 'b.ts',
          status: 'modified',
          current: { kind: 'file', size: 9, mode: 0o100644, sha256: 'current-b' },
          target: { kind: 'file', size: 8, mode: 0o100644, sha256: 'target-b' },
        },
      ],
    })

    expect(first).toMatch(/^v2:[0-9a-f]{64}$/)
    expect(reordered).toBe(first)
    expect(changedCurrentContent).not.toBe(first)

    const withKnownGap = await buildLocalFilePreviewRevision({
      sessionId: 'session-1',
      deviceFingerprint: 'device-1',
      rewindAnchorId: 'run-1',
      status: 'unavailable',
      reason: 'unrestorable_files',
      affectedPaths: ['/workspace/a.ts', '/workspace/b.ts'],
      fingerprints: [],
      unrestorable: [{ path: 'lost.ts', reason: 'backup_missing' }],
    })
    expect(withKnownGap).not.toBe(first)

    const otherDevice = await buildLocalFilePreviewRevision({
      sessionId: 'session-1',
      deviceFingerprint: 'device-2',
      rewindAnchorId: 'run-1',
      status: 'available',
      reason: null,
      affectedPaths: ['/workspace/a.ts', '/workspace/b.ts'],
      fingerprints: reordered === first ? [
        {
          path: 'a.ts',
          status: 'deleted',
          current: { kind: 'file', size: 9, mode: 0o100644, sha256: 'current-a' },
          target: { kind: 'absent' },
        },
        {
          path: 'b.ts',
          status: 'modified',
          current: { kind: 'file', size: 9, mode: 0o100644, sha256: 'current-b' },
          target: { kind: 'file', size: 8, mode: 0o100644, sha256: 'target-b' },
        },
      ] : [],
    })
    expect(otherDevice).not.toBe(first)
  })
})
