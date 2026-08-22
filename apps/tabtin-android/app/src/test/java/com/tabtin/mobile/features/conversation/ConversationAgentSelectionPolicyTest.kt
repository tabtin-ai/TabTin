package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationAgentSelectionPolicyTest {
    @Test
    fun personalWorkspaceFormalSessionCanChangeAgent() {
        assertTrue(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace = false,
                isFirstSendInFlight = false,
                isUpdating = false,
            ),
        )
    }

    @Test
    fun teamSpaceAndTransitionStatesAreLocked() {
        assertFalse(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace = true,
                isFirstSendInFlight = false,
                isUpdating = false,
            ),
        )
        assertFalse(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace = false,
                isFirstSendInFlight = true,
                isUpdating = false,
            ),
        )
        assertFalse(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace = false,
                isFirstSendInFlight = false,
                isUpdating = true,
            ),
        )
    }
}
