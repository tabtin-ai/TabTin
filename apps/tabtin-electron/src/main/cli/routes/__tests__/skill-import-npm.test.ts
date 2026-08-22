import { describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { collectSkillImportFiles } from '../skill-import-npm'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-import-test-'))
  try {
    return await fn(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

describe('collectSkillImportFiles ', () => {
  it('reads a skill directory with SKILL.md', async () => {
    await withTempDir(async (dir) => {
      const skillDir = path.join(dir, 'hello-skill')
      await fsp.mkdir(skillDir)
      await fsp.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: hello\n---\n# Hello\n', 'utf-8')
      await fsp.writeFile(path.join(skillDir, 'notes.txt'), 'note', 'utf-8')

      const result = await collectSkillImportFiles(skillDir)
      expect(result.name).toBe('hello-skill')
      expect(result.files.some((f) => f.path === 'SKILL.md')).toBe(true)
      expect(result.files.some((f) => f.path === 'notes.txt' && f.content === 'note')).toBe(true)
    })
  })

  it('reads a lone SKILL.md file', async () => {
    await withTempDir(async (dir) => {
      const skillDir = path.join(dir, 'solo')
      await fsp.mkdir(skillDir)
      const skillMd = path.join(skillDir, 'SKILL.md')
      await fsp.writeFile(skillMd, '# Solo\n', 'utf-8')

      const result = await collectSkillImportFiles(skillMd)
      expect(result.name).toBe('solo')
      expect(result.files).toEqual([{ path: 'SKILL.md', content: '# Solo\n' }])
    })
  })

  it('rejects directory without SKILL.md', async () => {
    await withTempDir(async (dir) => {
      await expect(collectSkillImportFiles(dir)).rejects.toThrow(/未找到 SKILL\.md/)
    })
  })

  it.skipIf(process.platform === 'win32')('extracts zip containing SKILL.md', async () => {
    await withTempDir(async (dir) => {
      const skillDir = path.join(dir, 'zipped-skill')
      await fsp.mkdir(skillDir)
      await fsp.writeFile(path.join(skillDir, 'SKILL.md'), '# Zipped\n', 'utf-8')
      const zipPath = path.join(dir, 'zipped-skill.zip')

      await new Promise<void>((resolve, reject) => {
        const child = spawn('zip', ['-qr', zipPath, 'zipped-skill'], { cwd: dir })
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`zip exit ${code}`))))
      })

      const result = await collectSkillImportFiles(zipPath)
      expect(result.name).toBe('zipped-skill')
      expect(result.files.some((f) => f.path === 'SKILL.md')).toBe(true)
      await result.cleanup?.()
    })
  })
})
