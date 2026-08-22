package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

class ConversationRuntimeConfigurationTest {

    @Test
    fun `legacy yolo becomes agent with automatic approval when relaxed approval is allowed`() {
        val configuration = ConversationRuntimeConfiguration.resolving(
            rawAgentMode = "yolo",
            rawApprovalMode = null,
            permitsRelaxedApproval = true,
        )

        assertEquals(ConversationAgentMode.AGENT, configuration.agentMode)
        assertEquals(ConversationApprovalMode.AUTO, configuration.approvalMode)
    }

    @Test
    fun `legacy study and disallowed approval resolve to safe agent configuration`() {
        val configuration = ConversationRuntimeConfiguration.resolving(
            rawAgentMode = "study",
            rawApprovalMode = "full_access",
            permitsRelaxedApproval = false,
        )

        assertEquals(ConversationAgentMode.AGENT, configuration.agentMode)
        assertEquals(ConversationApprovalMode.ALWAYS_ASK, configuration.approvalMode)
    }

    @Test
    fun `storage normalization preserves a relaxed preference until runtime policy applies`() {
        val stored = ConversationRuntimeConfiguration.normalizedForStorage(
            rawAgentMode = "yolo",
            rawApprovalMode = null,
        )

        assertEquals(ConversationAgentMode.AGENT, stored.agentMode)
        assertEquals(ConversationApprovalMode.AUTO, stored.approvalMode)
    }
}
