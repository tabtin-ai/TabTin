package com.tabtin.mobile.features.conversation

/**
 * 消息 / 列表展示用的 Agent 身份快照：显示名 + 头像 key / URL。
 * 对齐 iOS `ComposerTaskAgentOption` 在气泡身份行的最小子集。
 */
public data class AgentFace(
    val name: String,
    val avatarKey: String? = null,
    val avatarUrl: String? = null,
)
