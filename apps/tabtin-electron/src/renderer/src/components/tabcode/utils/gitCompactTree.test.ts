import { describe, expect, it } from 'vitest'
import { buildCompactGitChangeTree, flattenCompactGitChangeTree } from './gitCompactTree'

describe('gitCompactTree', () => {
  const rootPath = 'C:/workspace/TabTin-feature/TabTin'

  it('compresses a single-directory chain into one expandable folder row', () => {
    const tree = buildCompactGitChangeTree(rootPath, [
      {
        path: 'C:\\workspace\\TabTin-feature\\TabTin\\.cursor\\skills\\linux-commit-discipline\\SKILL.md',
        status: 'M',
      },
    ])

    expect(tree).toEqual([
      {
        type: 'directory',
        id: '.cursor/skills/linux-commit-discipline',
        name: '.cursor/skills/linux-commit-discipline',
        children: [
          {
            type: 'file',
            id: 'C:\\workspace\\TabTin-feature\\TabTin\\.cursor\\skills\\linux-commit-discipline\\SKILL.md',
            path: 'C:\\workspace\\TabTin-feature\\TabTin\\.cursor\\skills\\linux-commit-discipline\\SKILL.md',
            name: 'SKILL.md',
            status: 'M',
          },
        ],
      },
    ])
  })

  it('stops compression at branches so changed folders remain navigable', () => {
    const rows = flattenCompactGitChangeTree(buildCompactGitChangeTree(rootPath, [
      { path: 'C:/workspace/TabTin-feature/TabTin/apps/tabtin-electron/src/main/git-ipc.ts', status: 'M' },
      { path: 'C:/workspace/TabTin-feature/TabTin/apps/tabtin-electron/src/renderer/src/components/tabcode/TabCodePaneHost.tsx', status: 'M' },
    ]), new Set())

    expect(rows.map(row => ({
      type: row.type,
      name: row.name,
      depth: row.depth,
    }))).toEqual([
      { type: 'directory', name: 'apps/tabtin-electron/src', depth: 0 },
      { type: 'directory', name: 'main', depth: 1 },
      { type: 'file', name: 'git-ipc.ts', depth: 2 },
      { type: 'directory', name: 'renderer/src/components/tabcode', depth: 1 },
      { type: 'file', name: 'TabCodePaneHost.tsx', depth: 2 },
    ])
  })

  it('hides children for collapsed compact folders', () => {
    const tree = buildCompactGitChangeTree(rootPath, [
      {
        path: 'C:/workspace/TabTin-feature/TabTin/.cursor/skills/linux-commit-discipline/SKILL.md',
        status: 'M',
      },
    ])

    expect(flattenCompactGitChangeTree(
      tree,
      new Set(['.cursor/skills/linux-commit-discipline']),
    ).map(row => row.name)).toEqual(['.cursor/skills/linux-commit-discipline'])
  })
})
