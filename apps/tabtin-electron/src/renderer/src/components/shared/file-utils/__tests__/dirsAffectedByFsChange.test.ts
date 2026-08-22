import { describe, expect, it } from 'vitest'
import { dirsAffectedByFsChange } from '../path-ops'

describe('dirsAffectedByFsChange', () => {
  const tabTin = '/space/Support/TabTin'
  const organizations = '/space/Support/TabTin/organizations'

  it('parent 在 expanded 中时刷新 parent', () => {
    expect(dirsAffectedByFsChange(tabTin, [tabTin])).toContain(tabTin)
  })

  it('只展开子目录时，parent 变更也应刷新 parent', () => {
    const dirs = dirsAffectedByFsChange(tabTin, [organizations])
    expect(dirs).toContain(tabTin)
    expect(dirs).toContain(organizations)
  })

  it('变更发生在展开目录内部时刷新该目录', () => {
    const dirs = dirsAffectedByFsChange(organizations, [organizations])
    expect(dirs).toContain(organizations)
  })

  it('normalizes Windows separators for watch refresh keys', () => {
    const dirs = dirsAffectedByFsChange(
      'C:\\space\\Support\\TabTin',
      ['C:\\space\\Support\\TabTin\\organizations'],
    )

    expect(dirs).toContain('C:/space/Support/TabTin')
    expect(dirs).toContain('C:/space/Support/TabTin/organizations')
  })
})
