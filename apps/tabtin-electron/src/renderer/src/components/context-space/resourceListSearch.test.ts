import { describe, expect, it } from 'vitest'
import {
  filterFoldersBySearch,
  filterResourcesBySearch,
  getResourceDisplayName,
  matchesResourceSearchQuery,
  selectResourceSearchScope,
} from './resourceListSearch'

describe('resourceListSearch', () => {
  it('matches title case-insensitively', () => {
    expect(matchesResourceSearchQuery('规划', '规划文档')).toBe(true)
    expect(matchesResourceSearchQuery('PLAN', 'plan-doc')).toBe(true)
    expect(matchesResourceSearchQuery('xyz', '规划文档')).toBe(false)
  })

  it('empty query keeps all items', () => {
    const items = [{ title: 'A' }, { title: 'B' }]
    expect(filterResourcesBySearch(items, '  ')).toEqual(items)
  })

  it('filters by display name, not raw resource_id when title exists', () => {
    const items = [
      { title: '规划文档', resource_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      { title: '未命名表格', resource_id: 'table-2' },
      { title: '', resource_id: 'orphan-report' },
    ]
    expect(filterResourcesBySearch(items, '规划')).toEqual([items[0]])
    // 展示名是「未命名表格」，不应因 resource_id=table-2 被扫中
    expect(filterResourcesBySearch(items, 'table-2')).toEqual([])
    expect(filterResourcesBySearch(items, '未命名')).toEqual([items[1]])
    // 无 title 时与 UI 一致，用 resource_id 作展示名
    expect(filterResourcesBySearch(items, 'orphan')).toEqual([items[2]])
  })

  it('digit query fuzzy-matches title prefixes and ignores UUID display names', () => {
    const items = [
      { title: '年度规划', resource_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      { title: '6138-live-data.csv', resource_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
      { title: '6138-live-notes.md', resource_id: '11111111-1111-1111-1111-111111111111' },
      { title: '1号方案', resource_id: '22222222-2222-2222-2222-222222222222' },
      { title: '', resource_id: '44444444-4444-4444-4444-444444444444' },
    ]

    // 模糊：613 应命中 6138-...
    expect(filterResourcesBySearch(items, '613')).toEqual([items[1], items[2]])
    expect(filterResourcesBySearch(items, '6138')).toEqual([items[1], items[2]])
    // 有 title 时不因 UUID resource_id 噪声命中
    expect(filterResourcesBySearch(items, '1')).toEqual([items[1], items[2], items[3]])
    // UUID 展示名（无 title）不参与纯数字匹配
    expect(filterResourcesBySearch(items, '4')).toEqual([])
  })

  it('getResourceDisplayName prefers title', () => {
    expect(getResourceDisplayName({ title: 'A', resource_id: 'id-1' })).toBe('A')
    expect(getResourceDisplayName({ title: '  ', resource_id: 'id-1' })).toBe('id-1')
    expect(getResourceDisplayName({ title: null, resource_id: 'id-1' })).toBe('id-1')
  })

  it('filters folders by name', () => {
    const folders = [{ name: '产品' }, { name: '研发' }]
    expect(filterFoldersBySearch(folders, '研')).toEqual([folders[1]])
  })

  it('switches from visible items to the full searchable pool while searching', () => {
    const visibleItems = [{ title: '当前文件夹文档' }]
    const searchableItems = [...visibleItems, { title: '其他文件夹文档' }]

    expect(selectResourceSearchScope(visibleItems, searchableItems, '  ')).toBe(visibleItems)
    expect(selectResourceSearchScope(visibleItems, searchableItems, '其他')).toBe(searchableItems)
  })
})
