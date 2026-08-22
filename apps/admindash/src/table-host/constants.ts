export const TABLE_HOST_CONTEXT_STORAGE_KEY = 'table-host-web:context'

export const buildTableHostRoutePath = (organizationId: string, spaceId: string): string => {
  const normalizedOrganizationId = organizationId.trim()
  const normalizedSpaceId = spaceId.trim()

  if (!normalizedOrganizationId || !normalizedSpaceId) {
    return '/table-host-web'
  }

  return `/table-host-web/${encodeURIComponent(normalizedOrganizationId)}/${encodeURIComponent(normalizedSpaceId)}`
}
