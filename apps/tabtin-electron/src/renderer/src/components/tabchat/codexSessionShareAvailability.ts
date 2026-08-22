export function isCodexSessionShareOrganization(organizationId?: string | null): boolean {
  return Boolean(organizationId?.trim())
}

export function isCodexSessionShareAvailable(
  organizationId: string | null | undefined,
): boolean {
  return isCodexSessionShareOrganization(organizationId)
}
