export interface IMMemberItem {
  user_id: string
  user?: {
    nickname?: string
    username?: string
    email?: string
    avatar?: string
  }
}

export function memberDisplayName(member: IMMemberItem): string {
  return member.user?.nickname || member.user?.username || member.user_id
}
