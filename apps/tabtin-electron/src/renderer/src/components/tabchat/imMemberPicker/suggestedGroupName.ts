import type { IMMemberItem } from './types'
import { memberDisplayName } from './types'

/** 与 CreateConversationDialog 一致：已选成员昵称/用户名用顿号拼接。 */
export function suggestedGroupNameFromMembers(
  members: IMMemberItem[],
  selectedIds: ReadonlySet<string>,
): string {
  return members
    .filter((member) => selectedIds.has(member.user_id))
    .map((member) => memberDisplayName(member))
    .slice(0, 5)
    .join('、')
}
