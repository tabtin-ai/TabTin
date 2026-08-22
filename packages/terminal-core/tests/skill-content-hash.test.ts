/**
 * D11 内容 hash 算法测试（PRD V3.3 / W0 决策 4 V2）。
 *
 * 与 Python 端 `apps/tabtin_django/apps/skills/services/content_hash.py` 字面对齐。
 * 黄金测试：构造已知 skill 文件夹 → 期望 hash 与 Python 端 ``compute_skill_content_hash``
 * 完全一致。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  computeSkillContentHash,
  computeSkillContentHashSync,
} from '../src/skill-content-hash'

let workDir = ''

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'skill-hash-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function shaHex(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
  return createHash('sha256').update(buf).digest('hex')
}

function expectedMerkleRoot(entries: Array<[string, string]>): string {
  const sorted = [...entries].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )
  const hasher = createHash('sha256')
  for (const [path, sha] of sorted) {
    hasher.update(`${path}:${sha}`)
  }
  return hasher.digest('hex')
}

describe('computeSkillContentHash', () => {
  it('empty dir 稳定 hash', async () => {
    const h1 = await computeSkillContentHash(workDir)
    const h2 = await computeSkillContentHash(workDir)
    expect(h1).toBe(h2)
  })

  it('single file', async () => {
    await writeFile(join(workDir, 'SKILL.md'), 'hello\n')
    const h = await computeSkillContentHash(workDir)
    const expected = expectedMerkleRoot([['SKILL.md', shaHex('hello\n')]])
    expect(h).toBe(expected)
  })

  it('CRLF 归一化为 LF', async () => {
    await writeFile(join(workDir, 'SKILL.md'), 'hello\r\nworld\r\n')
    const h1 = await computeSkillContentHash(workDir)
    await writeFile(join(workDir, 'SKILL.md'), 'hello\nworld\n')
    const h2 = await computeSkillContentHash(workDir)
    expect(h1).toBe(h2)
  })

  it('剥离 UTF-8 BOM', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await writeFile(
      join(workDir, 'SKILL.md'),
      Buffer.concat([bom, Buffer.from('hello\n', 'utf-8')]),
    )
    const h1 = await computeSkillContentHash(workDir)
    await writeFile(join(workDir, 'SKILL.md'), 'hello\n')
    const h2 = await computeSkillContentHash(workDir)
    expect(h1).toBe(h2)
  })

  it('忽略 vim swap / emacs backup', async () => {
    await writeFile(join(workDir, 'SKILL.md'), 'hello\n')
    await writeFile(join(workDir, '.SKILL.md.swp'), 'vim swap')
    await writeFile(join(workDir, 'SKILL.md~'), 'emacs backup')
    const h1 = await computeSkillContentHash(workDir)
    await rm(join(workDir, '.SKILL.md.swp'))
    await rm(join(workDir, 'SKILL.md~'))
    const h2 = await computeSkillContentHash(workDir)
    expect(h1).toBe(h2)
  })

  it('忽略 ignore 目录（.git / .vscode）', async () => {
    await writeFile(join(workDir, 'SKILL.md'), 'hello\n')
    await mkdir(join(workDir, '.git'))
    await writeFile(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await mkdir(join(workDir, '.vscode'))
    await writeFile(join(workDir, '.vscode', 'settings.json'), '{}\n')
    const h1 = await computeSkillContentHash(workDir)

    await rm(join(workDir, '.git'), { recursive: true })
    await rm(join(workDir, '.vscode'), { recursive: true })
    const h2 = await computeSkillContentHash(workDir)
    expect(h1).toBe(h2)
  })

  it('subdir 用 POSIX `/` 分隔', async () => {
    await writeFile(join(workDir, 'SKILL.md'), 'hello\n')
    await mkdir(join(workDir, 'scripts'))
    await writeFile(join(workDir, 'scripts', 'main.py'), "print('hi')\n")
    const h = await computeSkillContentHash(workDir)
    const expected = expectedMerkleRoot([
      ['SKILL.md', shaHex('hello\n')],
      ['scripts/main.py', shaHex("print('hi')\n")],
    ])
    expect(h).toBe(expected)
  })

  it('sync 与 async 结果一致', async () => {
    await writeFile(join(workDir, 'SKILL.md'), 'hello\n')
    await mkdir(join(workDir, 'scripts'))
    await writeFile(join(workDir, 'scripts', 'main.py'), "print('hi')\n")
    const hAsync = await computeSkillContentHash(workDir)
    const hSync = computeSkillContentHashSync(workDir)
    expect(hSync).toBe(hAsync)
  })
})
