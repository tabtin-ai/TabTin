import { describe, expect, it, vi } from 'vitest'
import {
  collectMaterializeDirChain,
  groupFilesBySkill,
  isIgnoredSkillImportPath,
  materializeImportedSkill,
  enableAllImportedSkills,
} from '../skillImport'

describe('groupFilesBySkill', () => {
  it('returns empty groups for markdown without SKILL.md', () => {
    const groups = groupFilesBySkill([
      { path: 'README.md', content: '# not a skill' },
      { path: 'docs/guide.md', content: 'text' },
    ], 'repo')
    expect(groups).toEqual([])
  })

  it('keeps a valid SKILL.md group with relative file paths', () => {
    const groups = groupFilesBySkill([
      { path: 'skills/demo/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
      { path: 'skills/demo/references/style.md', content: '# style' },
      { path: 'README.md', content: '# ignored' },
    ], 'repo')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('demo')
    expect(groups[0]?.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'references/style.md'])
  })

  it('drops node_modules / __pycache__ / hidden paths (TC-041 publish filter parity)', () => {
    const groups = groupFilesBySkill([
      { path: 'SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
      { path: 'scripts/hello.js', content: 'console.log(1)' },
      { path: 'node_modules/pkg/index.js', content: 'module.exports = 1' },
      { path: '__pycache__/x.pyc', content: 'bin', encoding: 'base64' },
      { path: '.DS_Store', content: 'bin', encoding: 'base64' },
    ], 'demo')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/hello.js'])
  })

  it('keeps imported SKILL.md content unchanged instead of adding metadata.version', () => {
    const skillMd = [
      '---',
      'name: demo',
      'description: d',
      'metadata:',
      '  tabtin:',
      '    displayName: Demo',
      'allowed-tools:',
      '  browser:',
      '    version: "2024-01"',
      '---',
      '# Demo',
    ].join('\n')

    const groups = groupFilesBySkill([
      { path: 'skills/demo/SKILL.md', content: skillMd },
    ], 'repo')

    expect(groups[0]?.files[0]?.content).toBe(skillMd)
    expect(groups[0]?.files[0]?.content).not.toContain('metadata:\n  version:')
  })
})

describe('isIgnoredSkillImportPath / collectMaterializeDirChain', () => {
  it('flags dependency and hidden path segments', () => {
    expect(isIgnoredSkillImportPath('node_modules/pkg/index.js')).toBe(true)
    expect(isIgnoredSkillImportPath('__pycache__/x.pyc')).toBe(true)
    expect(isIgnoredSkillImportPath('.DS_Store')).toBe(true)
    expect(isIgnoredSkillImportPath('scripts/hello.js')).toBe(false)
  })

  it('expands nested parents under skill root for non-recursive createDir', () => {
    expect(
      collectMaterializeDirChain(
        '/data/skills/demo',
        'vendor/pkg/lib/index.js',
      ),
    ).toEqual([
      '/data/skills/demo/vendor',
      '/data/skills/demo/vendor/pkg',
      '/data/skills/demo/vendor/pkg/lib',
    ])
  })
})

describe('materializeImportedSkill', () => {
  it('creates the skill root before writing a single imported SKILL.md', async () => {
    const fs = {
      createDir: vi.fn().mockResolvedValue({ success: true }),
      writeFile: vi.fn().mockResolvedValue({ success: true }),
      writeBinaryFile: vi.fn().mockResolvedValue({ success: true }),
    }

    await materializeImportedSkill(fs, '/platform/wt-1/spaces/sp-1/skills/demo', [
      { path: 'SKILL.md', content: '---\nname: demo\ndescription: d\n---\n\n# Demo' },
    ])

    expect(fs.createDir).toHaveBeenCalledWith('/platform/wt-1/spaces/sp-1/skills/demo')
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/platform/wt-1/spaces/sp-1/skills/demo/SKILL.md',
      '---\nname: demo\ndescription: d\n---\n\n# Demo',
    )
  })

  it('creates intermediate dirs before nested writes and skips ignored deps', async () => {
    const created: string[] = []
    const fs = {
      createDir: vi.fn(async (dir: string) => {
        created.push(dir)
        return { success: true }
      }),
      writeFile: vi.fn().mockResolvedValue({ success: true }),
      writeBinaryFile: vi.fn().mockResolvedValue({ success: true }),
    }

    await materializeImportedSkill(fs, '/data/skills/demo', [
      { path: 'SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
      { path: 'vendor/pkg/lib/index.js', content: 'export {}' },
      { path: 'node_modules/pkg/index.js', content: 'should-skip' },
    ])

    expect(created).toEqual([
      '/data/skills/demo',
      '/data/skills/demo/vendor',
      '/data/skills/demo/vendor/pkg',
      '/data/skills/demo/vendor/pkg/lib',
    ])
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/data/skills/demo/vendor/pkg/lib/index.js',
      'export {}',
    )
    expect(fs.writeFile).not.toHaveBeenCalledWith(
      '/data/skills/demo/node_modules/pkg/index.js',
      'should-skip',
    )
  })

  it('throws when createDir fails instead of writing into missing parents', async () => {
    const fs = {
      createDir: vi.fn()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'parent directory does not exist' }),
      writeFile: vi.fn().mockResolvedValue({ success: true }),
      writeBinaryFile: vi.fn().mockResolvedValue({ success: true }),
    }

    await expect(
      materializeImportedSkill(fs, '/data/skills/demo', [
        { path: 'vendor/pkg/index.js', content: 'x' },
      ]),
    ).rejects.toThrow(/parent directory does not exist|创建目录失败/)
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('rewrites SKILL.md name to unique directory slug on collision imports', async () => {
    const fs = {
      createDir: vi.fn().mockResolvedValue({ success: true }),
      writeFile: vi.fn().mockResolvedValue({ success: true }),
      writeBinaryFile: vi.fn().mockResolvedValue({ success: true }),
    }

    await materializeImportedSkill(
      fs,
      '/platform/wt-1/spaces/sp-1/skills/algorithmic-art-2',
      [{
        path: 'SKILL.md',
        content: '---\nname: algorithmic-art\ndescription: art\n---\n\n# Art',
      }],
    )

    expect(fs.writeFile).toHaveBeenCalledWith(
      '/platform/wt-1/spaces/sp-1/skills/algorithmic-art-2/SKILL.md',
      '---\nname: algorithmic-art-2\ndescription: art\n---\n\n# Art',
    )
  })
})

describe('enableAllImportedSkills', () => {
  it('enables every imported skill, not only the first ', async () => {
    const enableOne = vi.fn(async () => {})
    await enableAllImportedSkills(
      [
        { key: 'user:alpha', payload: { name: 'alpha' } },
        { key: 'user:beta', payload: { name: 'beta' } },
        { key: 'user:gamma', payload: { name: 'gamma' } },
      ],
      enableOne,
    )
    expect(enableOne).toHaveBeenCalledTimes(3)
    expect(enableOne.mock.calls.map((c) => c[1])).toEqual([
      'user:alpha',
      'user:beta',
      'user:gamma',
    ])
  })

  it('skips empty keys', async () => {
    const enableOne = vi.fn(async () => {})
    await enableAllImportedSkills(
      [
        { key: '', payload: { name: 'skip' } },
        { key: 'user:keep', payload: { name: 'keep' } },
      ],
      enableOne,
    )
    expect(enableOne).toHaveBeenCalledTimes(1)
    expect(enableOne).toHaveBeenCalledWith({ name: 'keep' }, 'user:keep')
  })
})
