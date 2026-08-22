package com.tabtin.mobile.features.tabchat

/**
 * 共享会话通道只能在个人历史水位建立后订阅，避免迟到旧事件越过“清空聊天记录”。
 */
internal suspend fun initializeImRealtimeAfterHistoryVisibility(
    initializeHistoryVisibility: suspend () -> Boolean,
    subscribe: (onSubscriptionAvailable: () -> Unit) -> Unit,
    reconcileLatest: () -> Unit,
): Boolean {
    if (!initializeHistoryVisibility()) return false
    subscribe(reconcileLatest)
    return true
}
