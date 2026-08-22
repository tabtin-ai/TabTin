package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatCatalogLoadSupportTest {

    @Test
    fun `share in-flight job only when org and session match`() {
        assertTrue(
            shouldShareInFlightChatCatalogLoad(
                forceRefresh = false,
                jobActive = true,
                jobOrganizationId = "org-1",
                jobExpectedSessionId = "session-1",
                organizationId = "org-1",
                expectedSessionId = "session-1",
            ),
        )
        assertFalse(
            shouldShareInFlightChatCatalogLoad(
                forceRefresh = true,
                jobActive = true,
                jobOrganizationId = "org-1",
                jobExpectedSessionId = "session-1",
                organizationId = "org-1",
                expectedSessionId = "session-1",
            ),
        )
        assertFalse(
            shouldShareInFlightChatCatalogLoad(
                forceRefresh = false,
                jobActive = true,
                jobOrganizationId = "org-1",
                jobExpectedSessionId = "session-1",
                organizationId = "org-1",
                expectedSessionId = "session-2",
            ),
        )
    }

    @Test
    fun `stale generation or session does not apply catalog result`() {
        assertFalse(
            shouldApplyChatCatalogLoadResult(
                requestGeneration = 1,
                currentGeneration = 2,
                expectedSessionId = "session-1",
                activeSessionId = "session-1",
                loadOrganizationId = "org-1",
                organizationId = "org-1",
            ),
        )
        assertFalse(
            shouldApplyChatCatalogLoadResult(
                requestGeneration = 2,
                currentGeneration = 2,
                expectedSessionId = "session-1",
                activeSessionId = "session-2",
                loadOrganizationId = "org-1",
                organizationId = "org-1",
            ),
        )
        assertTrue(
            shouldApplyChatCatalogLoadResult(
                requestGeneration = 2,
                currentGeneration = 2,
                expectedSessionId = "session-1",
                activeSessionId = "session-1",
                loadOrganizationId = "org-1",
                organizationId = "org-1",
            ),
        )
    }

    @Test
    fun `load failed when api fails or catalog has no sendable models`() {
        assertTrue(resolveChatCatalogLoadFailed(apiFailed = true, sendableModelCount = 3))
        assertTrue(resolveChatCatalogLoadFailed(apiFailed = false, sendableModelCount = 0))
        assertFalse(resolveChatCatalogLoadFailed(apiFailed = false, sendableModelCount = 2))
    }
}
