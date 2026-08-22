package com.tabtin.mobile.features.conversation

/**
 * 新会话草稿的 Agent 选择规则。
 *
 * 路由显式指定的 Agent 优先；否则选择默认且可用的 Agent，再回落首个可用 Agent。
 * 正式会话只使用服务端冻结的 Agent，不应用此默认值。
 */
public object ConversationDraftAgentSelectionPolicy {
    public fun resolve(
        selectedAgentId: String?,
        startsNewSession: Boolean,
        options: List<ComposerTaskAgentOption>,
    ): String? {
        selectedAgentId?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        if (!startsNewSession) return null
        return options.firstOrNull { it.isAvailable && it.isDefault }?.id
            ?: options.firstOrNull { it.isAvailable }?.id
    }
}
