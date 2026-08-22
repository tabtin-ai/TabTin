import { describe, expect, it } from 'vitest'
import { resolveAuthoritativeSessionRefs } from '../resolve-session-refs'
import type { ImportScanResult, ImportSessionRef } from '@tabtin/cli-server-core'

function ref(partial: Partial<ImportSessionRef> & { sourceSessionId: string }): ImportSessionRef {
  return {
    source: 'codex',
    sourcePath: '/AUTHORITATIVE/from-scan.jsonl',
    title: 't',
    cwd: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    subagent: false,
    layer: 'full',
    ...partial,
  }
}

const scanned: ImportScanResult = {
  source: 'codex',
  workspaces: [
    {
      cwd: '/proj',
      cwdExists: true,
      sessions: [ref({ sourceSessionId: 'sess-ok', sourcePath: '/AUTHORITATIVE/from-scan.jsonl' })],
    },
  ],
  orphanSessions: [],
}

describe('resolveAuthoritativeSessionRefs', () => {
  it('丢弃客户端伪造 sourcePath，改用 scan 权威路径', () => {
    const { refs, failures } = resolveAuthoritativeSessionRefs({
      groupSource: 'codex',
      scanned,
      clientRefs: [
        ref({
          sourceSessionId: 'sess-ok',
          sourcePath: '/tmp/pr7801-private.jsonl',
        }),
      ],
    })
    expect(failures).toEqual([])
    expect(refs).toHaveLength(1)
    expect(refs[0]?.sourcePath).toBe('/AUTHORITATIVE/from-scan.jsonl')
    expect(refs[0]?.sourcePath).not.toContain('/tmp/')
  })

  it('未知 sourceSessionId 拒绝且不返回 ref', () => {
    const { refs, failures } = resolveAuthoritativeSessionRefs({
      groupSource: 'codex',
      scanned,
      clientRefs: [ref({ sourceSessionId: 'missing', sourcePath: '/tmp/x.jsonl' })],
    })
    expect(refs).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error).toMatch(/不在主进程 scan/)
  })

  it('source 与分组不一致时拒绝', () => {
    const { refs, failures } = resolveAuthoritativeSessionRefs({
      groupSource: 'codex',
      scanned,
      clientRefs: [ref({ source: 'cursor', sourceSessionId: 'sess-ok' })],
    })
    expect(refs).toEqual([])
    expect(failures[0]?.error).toMatch(/不一致/)
  })

  it('空清单返回 scan 全量', () => {
    const { refs, failures } = resolveAuthoritativeSessionRefs({
      groupSource: 'codex',
      scanned,
      clientRefs: [],
    })
    expect(failures).toEqual([])
    expect(refs.map((r) => r.sourceSessionId)).toEqual(['sess-ok'])
  })
})
