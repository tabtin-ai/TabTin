import type { ReadReceiptMember } from '@/services/im/contracts'

type ProductUserProfile = {
  nickname?: string
  username?: string
  avatar?: string
}

export function resolveReadReceiptMemberPresentation(
  member: ReadReceiptMember,
  profile?: ProductUserProfile,
): { name: string; avatar: string } {
  return {
    name: profile?.nickname
      || profile?.username
      || member.name
      || member.username
      || member.user_id.slice(0, 8),
    avatar: profile?.avatar || member.avatar,
  }
}
