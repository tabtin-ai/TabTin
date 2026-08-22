import { describe, expect, it } from 'vitest'
import { isCloudFileResourceType } from './cloudResourceTypes'

describe('cloud file resource types', () => {
  it('covers backend tabfiles and normalized file only ( excludes local tabfolder)', () => {
    expect(isCloudFileResourceType('tabfiles')).toBe(true)
    expect(isCloudFileResourceType('file')).toBe(true)
    expect(isCloudFileResourceType('tabfolder')).toBe(false)
  })

  it('does not classify other cloud resources as files', () => {
    expect(isCloudFileResourceType('tabdoc')).toBe(false)
    expect(isCloudFileResourceType('tabdata')).toBe(false)
  })
})
