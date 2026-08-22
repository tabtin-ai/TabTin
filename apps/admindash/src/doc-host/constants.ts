export const DOC_HOST_CONTEXT_STORAGE_KEY = 'doc-host-web:context'

export const buildDocHostRoutePath = (organizationId: string, spaceId: string): string => {
  const normalizedOrganizationId = organizationId.trim()
  const normalizedSpaceId = spaceId.trim()

  if (!normalizedOrganizationId || !normalizedSpaceId) {
    return '/doc-host-web'
  }

  return `/doc-host-web/${encodeURIComponent(normalizedOrganizationId)}/${encodeURIComponent(normalizedSpaceId)}`
}
