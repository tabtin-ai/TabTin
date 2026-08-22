/**
 * 协作区头像堆：按接收人折叠，避免同人多卡叠多个相同头像。
 */

export interface ShareAvatarSource {
  id: string
  grantee_user_id: string
  status: string
  created_at?: string | null
}

export function shouldShowSessionShareManager(shares: ShareAvatarSource[]): boolean {
  return shares.length > 0
}

/** 同一 grantee 只认最新一条记录；历史授权只保留审计，不参与当前权限。 */
export function collapseLatestSharesByGrantee<T extends ShareAvatarSource>(
  shares: T[],
): T[] {
  const byGrantee = new Map<string, T>()
  for (const share of shares) {
    const key = share.grantee_user_id
    const existing = byGrantee.get(key)
    if (!existing) {
      byGrantee.set(key, share)
      continue
    }
    const existingTs = Date.parse(existing.created_at ?? '') || 0
    const nextTs = Date.parse(share.created_at ?? '') || 0
    if (nextTs > existingTs || (nextTs === existingTs && share.id > existing.id)) {
      byGrantee.set(key, share)
    }
  }
  return Array.from(byGrantee.values())
}

/** 协作头像只展示最新且已经生效的授权。 */
export function collapseActiveSharesByGrantee<T extends ShareAvatarSource>(shares: T[]): T[] {
  return collapseLatestSharesByGrantee(
    shares.filter(share => share.status !== 'pending'),
  ).filter(share => share.status === 'active')
}
