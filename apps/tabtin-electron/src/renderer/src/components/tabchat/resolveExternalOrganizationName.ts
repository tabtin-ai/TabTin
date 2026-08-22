interface ExternalOrganizationMember {
  user_id: string | null
  is_external?: boolean
  organization_name?: string
  participant_organization_id?: string
}

export function resolveExternalOrganizationName(input: {
  isExternal?: boolean
  isGroup: boolean
  peerUserId?: string | null
  peerOrganizationId?: string | null
  members?: readonly ExternalOrganizationMember[] | null
  localOrganizationName?: string
}): string {
  if (!input.isExternal) return ''

  const names = [...new Set(
    (input.members ?? [])
      .filter((member) => member.is_external && member.organization_name?.trim())
      .filter((member) => {
        if (input.isGroup) return true
        if (input.peerUserId && member.user_id !== input.peerUserId) return false
        if (
          input.peerOrganizationId
          && member.participant_organization_id
          && member.participant_organization_id !== input.peerOrganizationId
        ) {
          return false
        }
        return true
      })
      .map((member) => member.organization_name!.trim()),
  )]
  if (names.length === 1) return names[0]
  return input.localOrganizationName?.trim() || ''
}
