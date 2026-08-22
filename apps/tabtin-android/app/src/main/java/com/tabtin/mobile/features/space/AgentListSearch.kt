package com.tabtin.mobile.features.space

import com.tabtin.mobile.data.model.Agent

internal fun Agent.visibleName(): String =
    displayName?.trim()?.takeIf { it.isNotEmpty() } ?: name

internal fun <T> filterByVisibleAgentName(
    items: List<T>,
    query: String,
    visibleName: (T) -> String,
): List<T> {
    val needle = query.trim()
    if (needle.isEmpty()) return items
    return items.filter { visibleName(it).contains(needle, ignoreCase = true) }
}
