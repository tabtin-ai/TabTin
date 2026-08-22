import { describe, expect, it } from 'vitest'

import { resolveCloudDriveBrowseFolderId } from '../cloudDriveFolderState'
import type { SpaceCollection } from '@/services/spaceApi'

const collections = [
  { id: 'parent', children: [] },
  { id: 'nested', children: [] },
] as SpaceCollection[]

describe('resolveCloudDriveBrowseFolderId ', () => {
  it('文件夹列表加载完成后恢复仍存在的嵌套文件夹', () => {
    expect(resolveCloudDriveBrowseFolderId('nested', collections, true)).toBe('nested')
  })

  it('首次加载未完成前保留偏好，加载后对已删除文件夹回退根目录', () => {
    expect(resolveCloudDriveBrowseFolderId('deleted', [], false)).toBe('deleted')
    expect(resolveCloudDriveBrowseFolderId('deleted', [], true)).toBeNull()
  })
})
