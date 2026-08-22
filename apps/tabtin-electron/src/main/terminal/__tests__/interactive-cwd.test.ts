import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveInteractiveTerminalCwd } from '../interactive-cwd'

const createdDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-terminal-cwd-'))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveInteractiveTerminalCwd', () => {
  it('uses home when no cwd is provided', () => {
    const home = makeTempDir()

    expect(resolveInteractiveTerminalCwd(undefined, home)).toEqual({ cwd: home })
  })

  it('keeps an existing cwd', () => {
    const home = makeTempDir()
    const cwd = makeTempDir()

    expect(resolveInteractiveTerminalCwd(cwd, home)).toEqual({ cwd: path.resolve(cwd) })
  })

  it('falls back to home when cwd does not exist', () => {
    const home = makeTempDir()
    const missing = path.join(makeTempDir(), 'deleted')

    expect(resolveInteractiveTerminalCwd(missing, home)).toEqual({
      cwd: home,
      fallbackFrom: path.resolve(missing),
      fallbackReason: 'missing',
    })
  })

  it('falls back to home when cwd is not a directory', () => {
    const home = makeTempDir()
    const dir = makeTempDir()
    const filePath = path.join(dir, 'not-a-dir.txt')
    fs.writeFileSync(filePath, 'not a directory')

    expect(resolveInteractiveTerminalCwd(filePath, home)).toEqual({
      cwd: home,
      fallbackFrom: path.resolve(filePath),
      fallbackReason: 'not_a_directory',
    })
  })
})
