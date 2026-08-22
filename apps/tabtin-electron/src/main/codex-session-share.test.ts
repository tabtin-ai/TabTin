import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

function createAppServerChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, any>
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stdout.setEncoding = vi.fn()
  stderr.setEncoding = vi.fn()
  child.stdout = stdout
  child.stderr = stderr
  child.stdin = {
    write(line: string) {
      const message = JSON.parse(line) as { id?: number }
      if (typeof message.id === 'number') {
        queueMicrotask(() => stdout.emit('data', `${JSON.stringify({
          id: message.id,
          result: {},
        })}\n`))
      }
    },
  }
  child.kill = vi.fn()
  return child
}

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, default: { ...actual, spawn: spawnMock }, spawn: spawnMock }
})

import { shell } from 'electron'
import JSZip from 'jszip'
import {
  assignCodexThreadToProject,
  extractCodexSessionArchive,
  createCodexSessionRefreshFrame,
  nextImportedSessionTitle,
  parseCodexSessionShareHeader,
  openCodexSession,
  parseCodexGlobalProjects,
  resolveCodexSessionShareTitle,
  resolveCodexProjectSelection,
  rewriteCodexSessionCwd,
} from './codex-session-share'

describe('parseCodexSessionShareHeader', () => {
  it('accepts Codex session_meta and rejects an arbitrary JSONL file', () => {
    expect(parseCodexSessionShareHeader(JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '019ff047-d01a-73e3-bea6-26d65f98d7a8',
        timestamp: '2026-08-11T10:04:26.000Z',
        cwd: '/tmp/project',
      },
    }))).toEqual({
      sessionId: '019ff047-d01a-73e3-bea6-26d65f98d7a8',
      timestamp: '2026-08-11T10:04:26.000Z',
      cwd: '/tmp/project',
    })

    expect(() => parseCodexSessionShareHeader('{"type":"response_item"}'))
      .toThrow('session_meta')
  })

  it('extracts exactly one JSONL file from a session archive', async () => {
    const jsonl = `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '019ff047-d01a-73e3-bea6-26d65f98d7a8',
        timestamp: '2026-08-11T10:04:26.000Z',
        cwd: '/tmp/project',
      },
    })}\n`
    const zip = new JSZip()
    zip.file('session.codex-session.jsonl', jsonl)
    const archive = await zip.generateAsync({ type: 'nodebuffer' })

    await expect(extractCodexSessionArchive(archive)).resolves.toEqual(Buffer.from(jsonl))

    zip.file('extra.jsonl', jsonl)
    await expect(extractCodexSessionArchive(await zip.generateAsync({ type: 'nodebuffer' })))
      .rejects.toThrow('只包含一个文件')
  })

  it('imports an archive produced by an older sender that wrapped the ZIP twice', async () => {
    const jsonl = `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '019ff047-d01a-73e3-bea6-26d65f98d7a8',
        timestamp: '2026-08-11T10:04:26.000Z',
        cwd: '/tmp/project',
      },
    })}\n`
    const inner = new JSZip()
    inner.file('session.codex-session.jsonl', jsonl)
    const outer = new JSZip()
    outer.file('session.codex-session.zip', await inner.generateAsync({ type: 'nodebuffer' }))

    await expect(extractCodexSessionArchive(
      await outer.generateAsync({ type: 'nodebuffer' }),
    )).resolves.toEqual(Buffer.from(jsonl))
  })

  it('increments the imported title without colliding with existing copies', () => {
    expect(nextImportedSessionTitle('发布排障', [
      '发布排障',
      '发布排障 (2)',
      '其他会话',
    ])).toBe('发布排障 (3)')
  })

  it('prefers the Codex app-server display name over the stale indexed title', () => {
    expect(resolveCodexSessionShareTitle(
      '# Files mentioned by the user:',
      '梳理 Daemon 现状与定义',
      '019fe169-8035-7022-837a-d150809a4219',
    )).toBe('梳理 Daemon 现状与定义')
  })

  it('replaces the sender cwd with the receiver shared-session directory', () => {
    const original = Buffer.from(`${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '019ff047-d01a-73e3-bea6-26d65f98d7a8',
        timestamp: '2026-08-11T10:04:26.000Z',
        cwd: '/sender/private/project',
      },
    })}\n{"type":"response_item"}\n`)

    const rewritten = rewriteCodexSessionCwd(original, '/receiver/Codex/Shared Sessions')
      .toString('utf8')
      .split('\n')

    expect(JSON.parse(rewritten[0]).payload.cwd).toBe('/receiver/Codex/Shared Sessions')
    expect(rewritten[1]).toBe('{"type":"response_item"}')
  })

  it('resolves a Codex project display name to its local directory', () => {
    expect(resolveCodexProjectSelection('TabTin', [
      { id: 'tabtin', name: 'TabTin', path: '/Users/example/Documents/GitHub/TabTin' },
      { id: 'pi', name: 'pi', path: '/Users/example/Documents/GitHub/pi' },
    ])).toBe('/Users/example/Documents/GitHub/TabTin')
  })

  it('reads Codex sidebar projects instead of historical thread directories', () => {
    expect(parseCodexGlobalProjects({
      'local-projects': {
        tabtin: {
          name: 'TabTin',
          rootPaths: ['/Users/example/TabTin', '/Users/example/tabtin-im'],
          createdAt: 2,
        },
        pi: {
          name: 'pi',
          rootPaths: ['/Users/example/pi'],
          createdAt: 3,
        },
      },
    })).toEqual([
      { id: 'pi', name: 'pi', rootPaths: ['/Users/example/pi'], createdAt: 3 },
      {
        id: 'tabtin',
        name: 'TabTin',
        rootPaths: ['/Users/example/TabTin', '/Users/example/tabtin-im'],
        createdAt: 2,
      },
    ])
  })

  it('assigns an imported thread to the selected Codex sidebar project', () => {
    expect(assignCodexThreadToProject({
      'local-projects': { tabtin: { name: 'TabTin', rootPaths: ['/tmp/TabTin'] } },
      'thread-project-assignments': { existing: { projectId: 'tabtin' } },
    }, '019ff0ea-5e5d-7ff2-aa63-1454f0ca3efc', 'tabtin', '/tmp/TabTin'))
      .toMatchObject({
        'thread-project-assignments': {
          existing: { projectId: 'tabtin' },
          '019ff0ea-5e5d-7ff2-aa63-1454f0ca3efc': {
            projectKind: 'local',
            projectId: 'tabtin',
            cwd: '/tmp/TabTin',
            pendingCoreUpdate: false,
          },
        },
      })
  })

  it('opens the imported thread through the Codex deep-link contract', async () => {
    spawnMock.mockImplementationOnce(() => createAppServerChild())
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })
    await openCodexSession(
      '019ff0ea-5e5d-7ff2-aa63-1454f0ca3efc',
      process.cwd(),
    )
    expect(shell.openExternal).toHaveBeenCalledWith(
      'codex://threads/019ff0ea-5e5d-7ff2-aa63-1454f0ca3efc',
    )
  })

  it('frames the Codex desktop session-list refresh notification', () => {
    const frame = createCodexSessionRefreshFrame('019ff0ea-5e5d-7ff2-aa63-1454f0ca3efc')
    const byteLength = frame.readUInt32LE(0)
    expect(byteLength).toBe(frame.byteLength - 4)
    expect(JSON.parse(frame.subarray(4).toString('utf8'))).toEqual({
      type: 'broadcast',
      method: 'thread-unarchived',
      sourceClientId: 'tabtin-session-import',
      version: 1,
      params: {
        hostId: 'local',
        conversationId: '019ff0ea-5e5d-7ff2-aa63-1454f0ca3efc',
      },
    })
  })
})
