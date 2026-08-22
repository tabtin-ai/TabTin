package com.tabtin.mobile.features.conversation

/** 列表级判定，对齐 iOS `TaskHomeListPolicy`。 */
internal object TaskHomeListPolicy {
    fun sanitizedWorkspaceId(selected: String?, availableIds: Set<String>): String? {
        if (selected == null) return null
        return if (selected in availableIds) selected else null
    }
}
