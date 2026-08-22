package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.OrchestrationApi
import com.tabtin.mobile.data.api.PlanApi
import com.tabtin.mobile.data.local.MessageDao
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.MessageListResponse
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Test

class ChatRepositoryHitlFactsTest {
    @Test
    fun `agent history explicitly opts in to persisted facts and artifact cards`() = runTest {
        val chatApi = mockk<ChatApi>()
        coEvery {
            chatApi.getMessages(
                sessionId = any(),
                limit = any(),
                offset = any(),
                before = any(),
                updatedAfter = any(),
                updatedBefore = any(),
                around = any(),
                shareId = any(),
                expandArtifacts = any(),
                includeHitlFacts = any(),
            )
        } returns ApiEnvelope(
            success = true,
            data = MessageListResponse(messages = emptyList(), total = 0),
        )
        val repository = ChatRepository(
            chatApi = chatApi,
            contextApi = mockk<ContextApi>(),
            orchestrationApi = mockk<OrchestrationApi>(),
            planApi = mockk<PlanApi>(),
            tokenManager = mockk<TokenManager>(),
            messageDao = mockk<MessageDao>(relaxed = true),
            webSocketService = mockk<WebSocketService>(),
            sessionRunStateStore = SessionRunStateStore(),
            sessionReadStateStore = SessionReadStateStore(),
        )

        repository.getMessages(SESSION_ID)

        coVerify(exactly = 1) {
            chatApi.getMessages(
                sessionId = SESSION_ID,
                limit = 50,
                offset = null,
                before = any(),
                updatedAfter = null,
                updatedBefore = null,
                around = null,
                shareId = null,
                expandArtifacts = true,
                includeHitlFacts = true,
            )
        }
    }

    private companion object {
        private const val SESSION_ID = "session-ask-result"
    }
}
