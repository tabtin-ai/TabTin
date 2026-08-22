/** 云文档 scope 占位 org，在 store 水合前可能出现；不可当作 Space API 的 spaceId。 */
export const CLOUD_DOCS_PLACEHOLDER_ORG_ID = 'unknown-organization'

const INVALID_RESOURCE_HOST_SPACE_IDS = new Set([
  CLOUD_DOCS_PLACEHOLDER_ORG_ID,
  'anonymous',
])

export function resolveEffectiveCloudDocsOrganizationId(
  organizationId: string,
  storeOrganizationId: string | null | undefined,
): string {
  if (organizationId !== CLOUD_DOCS_PLACEHOLDER_ORG_ID) return organizationId
  return storeOrganizationId ?? organizationId
}

export function resolveCloudDocsHostSpaceId(input: {
  organizationId: string
  resourceHostSpaceId?: string | null
  spaces: ReadonlyArray<{ id: string; organization_id: string }>
  storeOrganizationId?: string | null
}): string | null {
  const {
    organizationId,
    resourceHostSpaceId = null,
    spaces,
    storeOrganizationId,
  } = input

  if (resourceHostSpaceId) return resourceHostSpaceId

  const effectiveOrganizationId = resolveEffectiveCloudDocsOrganizationId(
    organizationId,
    storeOrganizationId,
  )
  if (effectiveOrganizationId === CLOUD_DOCS_PLACEHOLDER_ORG_ID) return null

  return spaces.find(item => item.organization_id === effectiveOrganizationId)?.id ?? null
}

export function isLoadableResourceHostSpaceId(spaceId: string | null | undefined): spaceId is string {
  if (!spaceId?.trim()) return false
  if (INVALID_RESOURCE_HOST_SPACE_IDS.has(spaceId)) return false
  return true
}
