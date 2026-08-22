import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreFileFromUrl } from '../restore-file-from-url'

describe('restoreFileFromUrl symlink escape', () => {
  let workspaceRoot: string
  let outsideDir: string

  beforeEach(async () => {
    workspaceRoot = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabtin-restore-ws-')),
    )
    outsideDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabtin-restore-out-')),
    )
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true })
    await fsPromises.rm(outsideDir, { recursive: true, force: true })
  })

  function stubDownload(body: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    )
  }

  it('writes a new file under artifacts/', async () => {
    stubDownload('restored-bytes')
    const result = await restoreFileFromUrl({
      _working_dir: workspaceRoot,
      target_relative_path: 'artifacts/continuations/demo/note.txt',
      download_url: 'https://oss.example.test/signed',
      allowed_hosts: ['oss.example.test'],
      expected_size_bytes: Buffer.byteLength('restored-bytes'),
    })

    expect(result.success).toBe(true)
    const written = await fsPromises.readFile(
      path.join(workspaceRoot, 'artifacts/continuations/demo/note.txt'),
      'utf8',
    )
    expect(written).toBe('restored-bytes')
  })

  it('denies write when artifacts/ is a symlink leaving the workspace', async () => {
    await fsPromises.symlink(outsideDir, path.join(workspaceRoot, 'artifacts'))
    stubDownload('escaped')

    const result = await restoreFileFromUrl({
      _working_dir: workspaceRoot,
      target_relative_path: 'artifacts/continuations/demo/note.txt',
      download_url: 'https://oss.example.test/signed',
      allowed_hosts: ['oss.example.test'],
    })

    expect(result.success).toBe(false)
    expect(result.error_code).toBe('PATH_DENIED')
    expect(fs.existsSync(path.join(outsideDir, 'continuations/demo/note.txt'))).toBe(false)
  })

  it('denies write when the target file is a symlink leaving the workspace', async () => {
    const targetDir = path.join(workspaceRoot, 'artifacts/continuations/demo')
    await fsPromises.mkdir(targetDir, { recursive: true })
    const outsideFile = path.join(outsideDir, 'secret.txt')
    await fsPromises.writeFile(outsideFile, 'secret')
    await fsPromises.symlink(outsideFile, path.join(targetDir, 'note.txt'))
    stubDownload('escaped')

    const result = await restoreFileFromUrl({
      _working_dir: workspaceRoot,
      target_relative_path: 'artifacts/continuations/demo/note.txt',
      download_url: 'https://oss.example.test/signed',
      allowed_hosts: ['oss.example.test'],
    })

    expect(result.success).toBe(false)
    expect(result.error_code).toBe('PATH_DENIED')
    expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('secret')
  })
})
