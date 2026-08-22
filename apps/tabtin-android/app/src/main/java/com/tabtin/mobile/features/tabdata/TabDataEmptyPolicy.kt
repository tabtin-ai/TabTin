package com.tabtin.mobile.features.tabdata

public enum class TabDataEmptyKind {
    NO_VIEWS,
    NO_RECORDS,
    NO_MATCHES,
    EMPTY_KANBAN,
}

public object TabDataEmptyPolicy {
    public fun kind(
        hasViews: Boolean,
        isKanban: Boolean,
        recordCount: Int,
        hasActiveQuery: Boolean,
    ): TabDataEmptyKind? {
        if (!hasViews) return TabDataEmptyKind.NO_VIEWS
        if (recordCount > 0) return null
        if (isKanban) return TabDataEmptyKind.EMPTY_KANBAN
        return if (hasActiveQuery) TabDataEmptyKind.NO_MATCHES else TabDataEmptyKind.NO_RECORDS
    }
}
