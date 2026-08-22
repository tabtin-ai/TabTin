package com.tabtin.mobile.features.conversation

internal fun shouldShareInFlightChatCatalogLoad(
    forceRefresh: Boolean,
    jobActive: Boolean,
    jobOrganizationId: String?,
    jobExpectedSessionId: String?,
    organizationId: String,
    expectedSessionId: String?,
): Boolean =
    !forceRefresh &&
        jobActive &&
        jobOrganizationId == organizationId &&
        jobExpectedSessionId == expectedSessionId

internal fun shouldApplyChatCatalogLoadResult(
    requestGeneration: Long,
    currentGeneration: Long,
    expectedSessionId: String?,
    activeSessionId: String?,
    loadOrganizationId: String?,
    organizationId: String,
): Boolean =
    requestGeneration == currentGeneration &&
        expectedSessionId == activeSessionId &&
        loadOrganizationId == organizationId

internal fun resolveChatCatalogLoadFailed(
    apiFailed: Boolean,
    sendableModelCount: Int,
): Boolean = apiFailed || sendableModelCount == 0
