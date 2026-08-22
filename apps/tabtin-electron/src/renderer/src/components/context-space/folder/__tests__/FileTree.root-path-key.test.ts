import { describe, expect, it } from 'vitest'

import { normalizePathSeparators } from '@components/shared/file-utils'

/**
 * FileTree.loadDirectory 把条目存到 normalize 后的正斜杠键下。
 * 若 flatten / isEmpty 仍用 Windows 反斜杠 rootPath 查找，会永远 miss → 空白树。
 * 回归：入口 normalize 后查找键必须一致。
 */
describe('FileTree rootPath key normalization', () => {
  function fileTreeRootKey(rootPath: string): string {
    const normalized = normalizePathSeparators(rootPath)
    if (normalized === '/') return normalized
    if (/^[A-Za-z]:\/+$/.test(normalized)) return normalized.slice(0, 3)
    return normalized.replace(/\/+$/, '')
  }

  it('maps Windows backslash skill dirs to the same key loadDirectory stores', () => {
    const windowsRoot = 'C:\\Users\\demo\\TabTin\\skills\\brainstorming-3'
    const storedByLoadDirectory = fileTreeRootKey(windowsRoot)
    expect(storedByLoadDirectory).toBe('C:/Users/demo/TabTin/skills/brainstorming-3')
    // 未 normalize 时 flatten(entriesByDir[windowsRoot]) 会 miss
    expect(windowsRoot === storedByLoadDirectory).toBe(false)
    expect(fileTreeRootKey(windowsRoot)).toBe(storedByLoadDirectory)
  })

  it('keeps POSIX roots stable', () => {
    expect(fileTreeRootKey('/Users/demo/skills/foo/')).toBe('/Users/demo/skills/foo')
    expect(fileTreeRootKey('/')).toBe('/')
  })

  it('keeps Windows drive roots stable', () => {
    expect(fileTreeRootKey('C:\\')).toBe('C:/')
    expect(fileTreeRootKey('C:/')).toBe('C:/')
  })
})
