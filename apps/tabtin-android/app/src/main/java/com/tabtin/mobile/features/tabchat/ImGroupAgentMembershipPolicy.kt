package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImConversationDetail

/** 群聊 Agent 成员管理权限，对齐桌面端：普通群成员可操作，外部群 / 项目频道禁用。 */
internal object ImGroupAgentMembershipPolicy {
    fun canAddAgent(
        detail: ImConversationDetail,
        currentUserId: String?,
        catalogIsExternal: Boolean?,
    ): Boolean = detail.isGroup &&
        !detail.isExternal &&
        !detail.isTeamSpaceChannel &&
        catalogIsExternal != true &&
        !currentUserId.isNullOrBlank() &&
        detail.members.any { member ->
            !member.isAgent && member.userId == currentUserId
        }
}
