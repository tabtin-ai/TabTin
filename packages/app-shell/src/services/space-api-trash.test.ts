import { describe, expect, it } from 'vitest'

import { SpaceApiService } from './space-api.js'

const item = (item_type: string, overrides: Record<string, string> = {}) => ({
  id: overrides.id ?? 'context-item-1',
  item_type,
  resource_id: overrides.resource_id ?? 'resource-1',
  space_id: overrides.space_id ?? 'space-1',
  organization_id: overrides.organization_id ?? 'org-1',
})

describe('SpaceApiService.getTrashContextResourcePath', () => {
  it('routes document and table cloud resources to module trash endpoints', () => {
    expect(SpaceApiService.getTrashContextResourcePath(item('tabdoc'))).toBe(
      '/tabdoc/documents/resource-1/trash',
    )
    expect(SpaceApiService.getTrashContextResourcePath(item('tabdata'))).toBe(
      '/tabdata/tables/resource-1/trash',
    )
  })

  it('routes tabfiles cloud files to organization trash endpoint', () => {
    expect(SpaceApiService.getTrashContextResourcePath(item('tabfiles'))).toBe(
      '/context/organizations/org-1/files/resource-1/trash',
    )
  })

  it('routes normalized frontend file alias to the same organization trash endpoint', () => {
    // useUnifiedResources 会把后端 tabfiles 归一化为前端 file；删除路由必须兼容两者。
    expect(SpaceApiService.getTrashContextResourcePath(item('file'))).toBe(
      '/context/organizations/org-1/files/resource-1/trash',
    )
  })

  it('returns null for tabfiles/file without organization_id', () => {
    expect(
      SpaceApiService.getTrashContextResourcePath({
        id: 'context-item-1',
        item_type: 'tabfiles',
        resource_id: 'resource-1',
        space_id: 'space-1',
        organization_id: null,
      }),
    ).toBeNull()
    expect(
      SpaceApiService.getTrashContextResourcePath({
        id: 'context-item-1',
        item_type: 'file',
        resource_id: 'resource-1',
        space_id: 'space-1',
        organization_id: null,
      }),
    ).toBeNull()
  })

  it('returns null for resources without a module trash endpoint', () => {
    expect(SpaceApiService.getTrashContextResourcePath(item('unknown'))).toBeNull()
  })
})
