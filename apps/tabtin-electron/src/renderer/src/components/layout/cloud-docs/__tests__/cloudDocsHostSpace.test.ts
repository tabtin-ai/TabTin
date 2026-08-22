import { describe, expect, it } from 'vitest'
import {
  CLOUD_DOCS_PLACEHOLDER_ORG_ID,
  isLoadableResourceHostSpaceId,
  resolveCloudDocsHostSpaceId,
  resolveEffectiveCloudDocsOrganizationId,
} from '../cloudDocsHostSpace'

const spaces = [
  { id: 'space-1', organization_id: 'org-1' },
  { id: 'space-2', organization_id: 'org-2' },
]

describe('cloudDocsHostSpace', () => {
  it('resolves placeholder organization from store', () => {
    expect(resolveEffectiveCloudDocsOrganizationId(
      CLOUD_DOCS_PLACEHOLDER_ORG_ID,
      'org-1',
    )).toBe('org-1')
  })

  it('resolves host space by organization without using org id as space id', () => {
    expect(resolveCloudDocsHostSpaceId({
      organizationId: 'org-1',
      spaces,
    })).toBe('space-1')
    expect(resolveCloudDocsHostSpaceId({
      organizationId: CLOUD_DOCS_PLACEHOLDER_ORG_ID,
      spaces,
      storeOrganizationId: 'org-2',
    })).toBe('space-2')
    expect(resolveCloudDocsHostSpaceId({
      organizationId: CLOUD_DOCS_PLACEHOLDER_ORG_ID,
      spaces,
    })).toBeNull()
  })

  it('prefers explicit resource host space id', () => {
    expect(resolveCloudDocsHostSpaceId({
      organizationId: 'org-1',
      resourceHostSpaceId: 'space-2',
      spaces,
    })).toBe('space-2')
  })

  it('rejects placeholder ids for resource loads', () => {
    expect(isLoadableResourceHostSpaceId(CLOUD_DOCS_PLACEHOLDER_ORG_ID)).toBe(false)
    expect(isLoadableResourceHostSpaceId('space-1')).toBe(true)
    expect(isLoadableResourceHostSpaceId(null)).toBe(false)
  })
})
