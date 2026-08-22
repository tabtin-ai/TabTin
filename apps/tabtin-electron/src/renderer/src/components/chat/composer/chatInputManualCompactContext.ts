export interface CompactionSessionScope {
  organization_id?: string | null
  space_id?: string | null
}

export interface CompactionSpaceScope {
  id: string
  organization_id?: string | null
}

/**
 * 压缩属于既有会话，不属于当前前台。会话自身的组织与 Space 必须优先于组件
 * 传参和当前选择，避免切组织后把 A 会话请求拼成 A 组织 + B Space。
 */
export function resolveManualCompactContext(
  session: CompactionSessionScope | null | undefined,
  requestedSpaceId: string | null | undefined,
  selectedSpace: CompactionSpaceScope | null | undefined,
  spaces: CompactionSpaceScope[],
): { organizationId: string | undefined; spaceId: string | undefined } | null {
  const spaceId = session?.space_id ?? requestedSpaceId ?? selectedSpace?.id
  const matchingSpace = spaceId
    ? spaces.find(space => space.id === spaceId)
    : undefined
  const selectedSpaceOrganizationId = selectedSpace?.id === spaceId
    ? selectedSpace?.organization_id
    : undefined
  const spaceOrganizationId = matchingSpace?.organization_id ?? selectedSpaceOrganizationId
  const sessionOrganizationId = session?.organization_id

  // 会话声明的组织必须与传入 Space 的归属一致；未知归属也不能乐观拼接。
  if (sessionOrganizationId && spaceId && spaceOrganizationId !== sessionOrganizationId) {
    return null
  }

  return {
    organizationId: sessionOrganizationId ?? spaceOrganizationId ?? undefined,
    spaceId: spaceId ?? undefined,
  }
}
