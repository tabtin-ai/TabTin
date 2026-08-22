/**
 * 用户未上传头像时的跨端视觉身份。
 *
 * 颜色只由不可变身份 ID 决定；显示名称只决定首字，二者都不需要持久化。
 */
export function identityAvatarHue(identity: string | null | undefined): number {
  const value = identity?.trim() || '?'
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash) % 360
}

export function identityAvatarColor(identity: string | null | undefined): string {
  return `hsl(${identityAvatarHue(identity)}, 55%, 55%)`
}

export function identityAvatarInitial(name: string | null | undefined): string {
  return Array.from(name?.trim() || '?')[0]?.toUpperCase() || '?'
}
