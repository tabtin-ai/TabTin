export interface UserDisplayMember {
  id: string
  name: string
  email?: string
  avatarUrl?: string
}

export interface HistoricalUserDisplayIdentity {
  user_id: string
  display_name: string
}

export interface VersionedUserDisplayProfile {
  nickname?: string
  username?: string
  revision?: number
}

/**
 * 启动时由旧登录资料预填的 revision=0 不能压过刚拉取的成员目录。
 * 只有服务端递增版本确认过的实时资料才有资格覆盖当前成员姓名。
 */
export function buildRealtimeUserDisplayNameById(
  profiles: Readonly<Record<string, VersionedUserDisplayProfile>>,
  authoritativeIds: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const userId of authoritativeIds) {
    const profile = profiles[userId]
    if (!profile || (profile.revision ?? 0) <= 0) continue
    const displayName = profile.nickname || profile.username
    if (displayName?.trim()) result.set(userId, displayName.trim())
  }
  return result
}

/**
 * 成员字段编辑器直接按候选项的 name 搜索，因此也要应用实时权威昵称。
 * 保留稳定 ID 与邮箱、头像；没有更新时复用原对象，避免无意义重渲染。
 */
export function mergeUserDisplayNamesIntoMembers<T extends UserDisplayMember>(
  members: readonly T[],
  authoritativeProfileNames: ReadonlyMap<string, string>,
): T[] {
  return members.map((member) => {
    const resolvedName = authoritativeProfileNames.get(String(member.id))?.trim()
    if (!resolvedName || resolvedName === member.name) return member
    return { ...member, name: resolvedName }
  })
}

/** 历史快照只补展示名称；当前成员与实时资料依次覆盖同一用户的旧名称。 */
export function buildUserDisplayNameById(
  currentMembers: readonly UserDisplayMember[],
  identitySnapshots: readonly HistoricalUserDisplayIdentity[],
  authoritativeProfileNames: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const snapshot of identitySnapshots) {
    result.set(String(snapshot.user_id), snapshot.display_name)
  }
  for (const member of currentMembers) {
    result.set(String(member.id), member.name)
  }
  for (const [userId, displayName] of authoritativeProfileNames) {
    const normalizedName = displayName.trim()
    if (normalizedName) result.set(String(userId), normalizedName)
  }
  return result
}
