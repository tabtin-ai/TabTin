package com.tabtin.mobile.features.tabdata

public enum class TabDataSurfaceKind { CARDS, KANBAN, SUMMARY }

public object TabDataSurfacePolicy {
    public fun kind(viewType: String): TabDataSurfaceKind = when (
        viewType.trim().lowercase()
    ) {
        "grid", "list" -> TabDataSurfaceKind.CARDS
        "kanban" -> TabDataSurfaceKind.KANBAN
        else -> TabDataSurfaceKind.SUMMARY
    }

    public fun supportsNativeCards(viewType: String): Boolean {
        val kind = kind(viewType)
        return kind == TabDataSurfaceKind.CARDS || kind == TabDataSurfaceKind.KANBAN
    }
}
