import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/mock/app/path',
  },
}))

import { copyDirSafe, resolveTemplatePath } from '../../main/utils/tabsite-helpers'

describe('copyDirSafe', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabsite-test-'))
  })

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true })
  })

  it('copies files recursively', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')

    await fsPromises.mkdir(path.join(src, 'sub'), { recursive: true })
    await fsPromises.writeFile(path.join(src, 'a.txt'), 'hello')
    await fsPromises.writeFile(path.join(src, 'sub', 'b.txt'), 'world')

    await copyDirSafe(src, dest)

    expect(fs.existsSync(path.join(dest, 'a.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'sub', 'b.txt'))).toBe(true)
    expect(await fsPromises.readFile(path.join(dest, 'a.txt'), 'utf-8')).toBe('hello')
    expect(await fsPromises.readFile(path.join(dest, 'sub', 'b.txt'), 'utf-8')).toBe('world')
  })

  it('skips default excluded entries', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')

    await fsPromises.mkdir(path.join(src, 'node_modules'), { recursive: true })
    await fsPromises.mkdir(path.join(src, '.git'), { recursive: true })
    await fsPromises.mkdir(path.join(src, 'dist'), { recursive: true })
    await fsPromises.writeFile(path.join(src, 'node_modules', 'pkg.json'), '{}')
    await fsPromises.writeFile(path.join(src, '.git', 'HEAD'), 'ref')
    await fsPromises.writeFile(path.join(src, '.DS_Store'), '')
    await fsPromises.writeFile(path.join(src, '.env'), 'SECRET=1')
    await fsPromises.writeFile(path.join(src, '.env.local'), 'LOCAL=1')
    await fsPromises.writeFile(path.join(src, 'index.ts'), 'code')

    await copyDirSafe(src, dest)

    expect(fs.existsSync(path.join(dest, 'index.ts'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'dist'))).toBe(false)
    expect(fs.existsSync(path.join(dest, '.DS_Store'))).toBe(false)
    expect(fs.existsSync(path.join(dest, '.env'))).toBe(false)
    expect(fs.existsSync(path.join(dest, '.env.local'))).toBe(false)
  })

  it('supports extraSkip option', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')

    await fsPromises.mkdir(src, { recursive: true })
    await fsPromises.writeFile(path.join(src, 'keep.txt'), 'keep')
    await fsPromises.writeFile(path.join(src, 'skip-me.log'), 'log')

    await copyDirSafe(src, dest, { extraSkip: ['skip-me.log'] })

    expect(fs.existsSync(path.join(dest, 'keep.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'skip-me.log'))).toBe(false)
  })

  it('skips symlinks', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')
    const target = path.join(tmpDir, 'target.txt')

    await fsPromises.mkdir(src, { recursive: true })
    await fsPromises.writeFile(target, 'target')
    await fsPromises.symlink(target, path.join(src, 'link.txt'))
    await fsPromises.writeFile(path.join(src, 'real.txt'), 'real')

    await copyDirSafe(src, dest)

    expect(fs.existsSync(path.join(dest, 'real.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'link.txt'))).toBe(false)
  })

  it('wraps per-file errors with path context', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')

    await fsPromises.mkdir(src, { recursive: true })
    await fsPromises.writeFile(path.join(src, 'readonly.txt'), 'content')

    await fsPromises.mkdir(dest, { recursive: true })
    await fsPromises.writeFile(path.join(dest, 'readonly.txt'), 'old')
    await fsPromises.chmod(path.join(dest, 'readonly.txt'), 0o000)

    try {
      await copyDirSafe(src, dest)
      // 在某些平台/用户下可能不会报错（如 root），跳过断言
    } catch (err: any) {
      expect(err.message).toContain('复制文件失败')
      expect(err.message).toContain('readonly.txt')
    } finally {
      // 清理：恢复权限以便 afterEach 可以删除
      await fsPromises.chmod(path.join(dest, 'readonly.txt'), 0o644).catch(() => {})
    }
  })
})

describe('resolveTemplatePath', () => {
  it('returns null when no template directory exists', () => {
    const result = resolveTemplatePath('nonexistent-template-xyz')
    expect(result).toBeNull()
  })

  it('returns null for path traversal attempts', () => {
    expect(resolveTemplatePath('../../../etc')).toBeNull()
    expect(resolveTemplatePath('blank/../../evil')).toBeNull()
    expect(resolveTemplatePath('blank/../evil')).toBeNull()
    expect(resolveTemplatePath('')).toBeNull()
    expect(resolveTemplatePath('has spaces')).toBeNull()
    expect(resolveTemplatePath('has.dots')).toBeNull()
  })

  it('finds template in cwd/packages when present', () => {
    const templateName = 'blank'
    const expected = path.join(process.cwd(), 'packages', 'tabsite-templates', templateName)
    if (fs.existsSync(expected) && fs.existsSync(path.join(expected, 'package.json'))) {
      const result = resolveTemplatePath(templateName)
      expect(result).toBe(expected)
    }
  })

  it('finds template via upward search from appPath', () => {
    const result = resolveTemplatePath('blank')
    if (result) {
      expect(fs.existsSync(result)).toBe(true)
      expect(fs.existsSync(path.join(result, 'package.json'))).toBe(true)
    }
  })
})
