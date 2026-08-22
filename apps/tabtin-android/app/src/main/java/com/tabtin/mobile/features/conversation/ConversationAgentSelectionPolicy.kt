package com.tabtin.mobile.features.conversation

/**
 * 与 Electron / iOS 一致的会话执行 Agent 可变性边界。
 *
 * 个人 Workspace 的草稿和正式会话都可切换；团队 Space 的执行归属不由单会话改写。
 * Project 成员自己的执行 Workspace 仍属于个人 Workspace，因此保持可切换。
 */
public object ConversationAgentSelectionPolicy {
    public fun canChange(
        isTeamSpace: Boolean,
        isFirstSendInFlight: Boolean,
        isUpdating: Boolean,
    ): Boolean = !isTeamSpace && !isFirstSendInFlight && !isUpdating
}
