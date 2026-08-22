import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  listFileEditPatchRecords,
  parseFileEditPatchRecord,
  recordFileEditPatch,
} from '../file-edit-patch-store'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-edit-patch-store-'))
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('file-edit-patch-store', () => {
  it('appends patches and can reread them after a simulated restart', async () => {
    await recordFileEditPatch({
      threadId: 'sess-1',
      toolUseId: 'tu_1',
      patch: {
        toolName: 'edit_file',
        relativePath: 'a.ts',
        status: 'modified',
        before: 'old',
        after: 'new',
      },
    }, tmpDir)

    await recordFileEditPatch({
      threadId: 'sess-1',
      toolUseId: 'tu_2',
      patch: {
        toolName: 'write_file',
        relativePath: 'b.ts',
        status: 'added',
        after: 'created',
      },
    }, tmpDir)

    const first = await listFileEditPatchRecords('sess-1', tmpDir)
    expect(first.map((item) => item.toolUseId)).toEqual(['tu_1', 'tu_2'])

    await recordFileEditPatch({
      threadId: 'sess-1',
      toolUseId: 'tu_1',
      patch: {
        toolName: 'edit_file',
        relativePath: 'a.ts',
        status: 'modified',
        before: 'should-not-overwrite',
        after: 'nope',
      },
    }, tmpDir)

    const reread = await listFileEditPatchRecords('sess-1', tmpDir)
    expect(reread).toHaveLength(2)
    expect(reread[0]?.patch.after).toBe('new')
  })

  it('round-trips beforeFull/afterFull for final-file composition', async () => {
    await recordFileEditPatch({
      threadId: 'sess-full',
      toolUseId: 'tu_full',
      patch: {
        toolName: 'edit_file',
        relativePath: 'a.ts',
        status: 'modified',
        before: 'old',
        after: 'new',
        beforeFull: 'keep\nold\n',
        afterFull: 'keep\nnew\n',
      },
    }, tmpDir)

    const reread = await listFileEditPatchRecords('sess-full', tmpDir)
    expect(reread[0]?.patch).toMatchObject({
      before: 'old',
      after: 'new',
      beforeFull: 'keep\nold\n',
      afterFull: 'keep\nnew\n',
    })
  })

  it('records the code root and normalizes an absolute in-root patch path', async () => {
    await recordFileEditPatch({
      threadId: 'sess-root',
      toolUseId: 'tu_root',
      codeRootPath: '/repo/worktree-a',
      patch: {
        toolName: 'edit_file',
        relativePath: '/repo/worktree-a/src/a.ts',
        status: 'modified',
        before: 'old',
        after: 'new',
      },
    }, tmpDir)

    const records = await listFileEditPatchRecords('sess-root', tmpDir)
    expect(records[0]).toMatchObject({
      codeRootPath: '/repo/worktree-a',
      patch: { relativePath: 'src/a.ts' },
    })
  })

  it('reads legacy records without assigning them to a code root', () => {
    const record = parseFileEditPatchRecord(JSON.stringify({
      toolUseId: 'legacy',
      recordedAt: '2026-08-13T00:00:00.000Z',
      patch: { toolName: 'edit_file', relativePath: 'a.ts', status: 'modified' },
    }))

    expect(record?.codeRootPath).toBeUndefined()
  })

  it('skips corrupt jsonl lines', () => {
    expect(parseFileEditPatchRecord('not-json')).toBeNull()
    expect(parseFileEditPatchRecord(JSON.stringify({
      toolUseId: 'tu',
      recordedAt: '2026-08-13T00:00:00.000Z',
      patch: { toolName: 'run_terminal_command', relativePath: 'a.ts', status: 'modified' },
    }))).toBeNull()
  })
})
