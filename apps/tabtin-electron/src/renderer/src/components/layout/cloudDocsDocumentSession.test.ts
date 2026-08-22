import { describe, expect, it } from 'vitest'
import {
  buildCloudDocsDocumentSessionScopeKey,
  isCloudDocsDocumentSessionScopeKey,
  parseCloudDocsDocumentSessionScopeKey,
} from './cloudDocsDocumentSession'

describe('cloudDocsDocumentSession', () => {
  const cloudScope = 'cloud-docs:organization:org-1:user:user-1'

  it('builds document session scope key', () => {
    expect(buildCloudDocsDocumentSessionScopeKey(cloudScope, 'doc-123')).toBe(
      `${cloudScope}:tabdoc-session:doc-123`,
    )
  })

  it('parses document session scope key', () => {
    const scope = buildCloudDocsDocumentSessionScopeKey(cloudScope, 'doc-123')
    expect(isCloudDocsDocumentSessionScopeKey(scope)).toBe(true)
    expect(parseCloudDocsDocumentSessionScopeKey(scope)).toEqual({
      cloudDocsScopeKey: cloudScope,
      documentId: 'doc-123',
    })
  })
})
