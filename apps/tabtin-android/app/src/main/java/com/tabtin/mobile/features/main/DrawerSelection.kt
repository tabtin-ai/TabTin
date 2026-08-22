package com.tabtin.mobile.features.main

/**
 * drawer 当前选中项。带 String rawValue codec 用于 SharedPreferences 持久化
 * （与 iOS 端 `DrawerSelection.swift` rawValue 编码方案保持一致：
 *   `all` / `profile` / `agent:<spaceId>`）。
 */
public sealed class DrawerSelection {
    public data object AllConversations : DrawerSelection()
    public data class Agent(val spaceId: String) : DrawerSelection()
    public data object Profile : DrawerSelection()

    public val rawValue: String
        get() = when (this) {
            is AllConversations -> "all"
            is Profile -> "profile"
            is Agent -> "agent:$spaceId"
        }

    public companion object {
        public fun fromRawValue(raw: String?): DrawerSelection {
            if (raw.isNullOrBlank()) return AllConversations
            return when {
                raw == "all" -> AllConversations
                raw == "profile" -> Profile
                raw.startsWith("agent:") -> {
                    val id = raw.removePrefix("agent:")
                    if (id.isBlank()) AllConversations else Agent(id)
                }
                else -> AllConversations
            }
        }
    }
}
