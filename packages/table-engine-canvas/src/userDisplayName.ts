export interface ResolveUserDisplayNameOptions {
  embeddedName?: unknown
  currentMemberName?: string
  historicalNameById?: ReadonlyMap<string, string>
  /** 已由成员目录归一化的最终显示名；命中时可安全覆盖记录里的旧姓名快照。 */
  resolvedNameById?: ReadonlyMap<string, string>
}

/** 已识别成员跟随目录最新姓名；未识别的导入用户保留对象自带的来源姓名。 */
export function resolveUserDisplayName(
  userId: string,
  options: ResolveUserDisplayNameOptions,
): string | undefined {
  return resolveUserDisplay(userId, options).displayName || undefined
}

/**
 * 姓名的来源归属。决定展示层要不要加状态后缀，以及能不能借用组织目录里的头像。
 * - member   在职成员，姓名取自组织目录
 * - departed 已离开组织，姓名只能取自离组快照
 * - external 跨组织/导入用户，两个目录都不认识他，姓名取自字段值内嵌
 * - unknown  四层都没命中，没有任何可显示的姓名
 */
export type UserDisplayKind = 'member' | 'departed' | 'external' | 'unknown'

export interface UserDisplayResolution {
  /** 解析到的姓名；unknown 态为空串，由展示层决定占位文案 */
  displayName: string
  kind: UserDisplayKind
  /** 仅在职成员可借用组织目录头像；离组/外部/未知一律不借，避免张冠李戴 */
  canUseDirectoryAvatar: boolean
}

export interface ResolveUserDisplayOptions extends ResolveUserDisplayNameOptions {
  /**
   * 该 ID 是否仍在当前组织成员列表里。这是区分 member 与 departed 的唯一依据 ——
   * resolvedNameById 把在职成员和离组快照合并进了同一张表（buildUserDisplayNameById
   * 先写 snapshots 再用 currentMembers 覆盖），单看它命中与否分不出这人还在不在。
   */
  isCurrentMember?: boolean
}

/**
 * 解析用户 ID 的显示姓名并带回归属态。
 *
 * 优先级与 resolveUserDisplayName 完全同序（resolvedNameById → embeddedName →
 * currentMemberName → historicalNameById），改动只是额外回报姓名来自哪一层。
 * 目录现名压过值内嵌姓名是有意的：内嵌姓名往往是导入当时的旧快照。
 *
 * 不返回任何面向用户的文案，也不回落成用户 ID —— 「（已离职）」「未知」这类措辞属于
 * 展示层，ID 更是一律不允许上屏。
 */
export function resolveUserDisplay(
  userId: string,
  options: ResolveUserDisplayOptions,
): UserDisplayResolution {
  const isCurrentMember = options.isCurrentMember ?? Boolean(options.currentMemberName?.trim())

  const resolvedName = options.resolvedNameById?.get(userId)?.trim()
  if (resolvedName) {
    return {
      displayName: resolvedName,
      kind: isCurrentMember ? 'member' : 'departed',
      canUseDirectoryAvatar: isCurrentMember,
    }
  }

  const embeddedName = String(options.embeddedName ?? '').trim()
  if (embeddedName) {
    return {
      displayName: embeddedName,
      kind: isCurrentMember ? 'member' : 'external',
      canUseDirectoryAvatar: isCurrentMember,
    }
  }

  const currentMemberName = options.currentMemberName?.trim()
  if (currentMemberName) {
    return { displayName: currentMemberName, kind: 'member', canUseDirectoryAvatar: true }
  }

  const historicalName = options.historicalNameById?.get(userId)?.trim()
  if (historicalName) {
    return { displayName: historicalName, kind: 'departed', canUseDirectoryAvatar: false }
  }

  return { displayName: '', kind: 'unknown', canUseDirectoryAvatar: false }
}
