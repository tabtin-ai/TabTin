package com.tabtin.mobile.push

import android.content.Context
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.navigation.DeepLinkHandler
import com.tabtin.mobile.util.TokenManager
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushServiceTest {
    @Test
    fun `im push routes snake case payload to im conversation`() {
        val deepLinkHandler = deepLinkHandler()
        val service = service(deepLinkHandler)

        service.handleNotificationExt(
            """{"scene":"im_message","organization_id":"sender-org","conversation_id":"conversation-7"}""",
        )

        assertEquals("conversation-7", deepLinkHandler.pendingImConversationNavigation.value?.conversationId)
        assertEquals("sender-org", deepLinkHandler.pendingImConversationNavigation.value?.organizationId)
        assertNull(deepLinkHandler.pendingConversationNavigation.value)
    }

    @Test
    fun `im push accepts camel case compatibility fields`() {
        val deepLinkHandler = deepLinkHandler()
        val service = service(deepLinkHandler)

        service.handleNotificationExt(
            """{"scene":"im_message","organizationId":"sender-org","conversationId":"conversation-7"}""",
        )

        assertEquals("conversation-7", deepLinkHandler.pendingImConversationNavigation.value?.conversationId)
        assertEquals("sender-org", deepLinkHandler.pendingImConversationNavigation.value?.organizationId)
    }

    @Test
    fun `agent push keeps existing conversation route`() {
        val deepLinkHandler = deepLinkHandler()
        val service = service(deepLinkHandler)

        service.handleNotificationExt(
            """{"scene":"agent_done","organization_id":"org-1","workspace_id":"workspace-2","session_id":"session-3"}""",
        )

        assertEquals("workspace-2", deepLinkHandler.pendingConversationNavigation.value?.workspaceId)
        assertEquals("session-3", deepLinkHandler.pendingConversationNavigation.value?.sessionId)
        assertNull(deepLinkHandler.pendingImConversationNavigation.value)
    }

    @Test
    fun `non string route fields are ignored without crashing`() {
        val deepLinkHandler = deepLinkHandler()
        val service = service(deepLinkHandler)
        val malformedPayloads = listOf(
            """{"scene":{"value":"im_message"},"organization_id":"org-1","conversation_id":"conversation-7"}""",
            """{"scene":"im_message","organization_id":{"id":"org-1"},"conversation_id":"conversation-7"}""",
            """{"scene":"im_message","organization_id":"org-1","conversation_id":7}""",
        )

        malformedPayloads.forEach(service::handleNotificationExt)

        assertNull(deepLinkHandler.pendingImConversationNavigation.value)
        assertNull(deepLinkHandler.pendingConversationNavigation.value)
    }

    private fun deepLinkHandler(): DeepLinkHandler {
        val tokenManager = mockk<TokenManager>()
        every { tokenManager.pendingInviteToken } returns null
        return DeepLinkHandler(tokenManager)
    }

    private fun service(deepLinkHandler: DeepLinkHandler): PushService = PushService(
        context = mockk<Context>(relaxed = true),
        contextApi = mockk<ContextApi>(relaxed = true),
        tokenManager = mockk<TokenManager>(relaxed = true),
        pushSdkClient = mockk<PushSdkClient>(relaxed = true),
        deepLinkHandler = deepLinkHandler,
    )
}
