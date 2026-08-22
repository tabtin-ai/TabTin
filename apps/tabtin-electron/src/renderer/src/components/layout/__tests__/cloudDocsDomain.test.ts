import { describe, expect, it } from 'vitest'
import {
  buildCloudDocsScopeKey,
  CLOUD_DOCS_HOME_TAB_KEY,
  isCloudDocsScopeKey,
  parseCloudDocsScopeKey,
  resolveCloudDocsTabScopeKey,
  shouldEnsureCloudDocsHomeTab,
} from '../cloudDocsDomain'

describe('cloudDocsDomain scope keys', () => {
  it('builds organization+user cloud-docs scope key', () => {
    expect(buildCloudDocsScopeKey({ organizationId: 'org-1', userId: 'user-1' }))
      .toBe('cloud-docs:organization:org-1:user:user-1')
  })

  it('falls back like desktop scope when org/user missing', () => {
    expect(buildCloudDocsScopeKey({}))
      .toBe('cloud-docs:organization:unknown-organization:user:anonymous')
  })

  it('resolveCloudDocsTabScopeKey matches buildCloudDocsScopeKey', () => {
    expect(resolveCloudDocsTabScopeKey({ organizationId: 'org-2', userId: 'u-2' }))
      .toBe('cloud-docs:organization:org-2:user:u-2')
  })

  it('recognizes legacy and new cloud-docs prefixes', () => {
    expect(isCloudDocsScopeKey('cloud-docs:space-1')).toBe(true)
    expect(isCloudDocsScopeKey('cloud-docs:organization:org-1:user:user-1')).toBe(true)
    expect(isCloudDocsScopeKey('desktop:organization:org-1:user:user-1')).toBe(false)
  })

  it('parses organization and user from cloud-docs scope key', () => {
    expect(parseCloudDocsScopeKey('cloud-docs:organization:org-1:user:user-1')).toEqual({
      organizationId: 'org-1',
      userId: 'user-1',
    })
    expect(parseCloudDocsScopeKey('desktop:organization:org-1:user:user-1')).toBeNull()
  })
})

describe('shouldEnsureCloudDocsHomeTab', () => {
  it('forces home tab when nothing or a non-cloud-docs tab is active', () => {
    expect(shouldEnsureCloudDocsHomeTab(null)).toBe(true)
    expect(shouldEnsureCloudDocsHomeTab('home')).toBe(true)
    expect(shouldEnsureCloudDocsHomeTab('desktop:')).toBe(true)
    expect(shouldEnsureCloudDocsHomeTab('tabweb:view-1')).toBe(true)
  })

  it('keeps existing tabdoc/tabdata/file resource tabs open ( adds file)', () => {
    expect(shouldEnsureCloudDocsHomeTab(CLOUD_DOCS_HOME_TAB_KEY)).toBe(false)
    expect(shouldEnsureCloudDocsHomeTab('tabdoc:doc-1')).toBe(false)
    expect(shouldEnsureCloudDocsHomeTab('tabdata:table-1')).toBe(false)
    expect(shouldEnsureCloudDocsHomeTab('file:file-1')).toBe(false)
  })
})
