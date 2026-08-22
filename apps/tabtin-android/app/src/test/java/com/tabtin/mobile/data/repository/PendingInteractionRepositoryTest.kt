package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.PendingInteraction
import com.tabtin.mobile.data.model.PendingInteractionListResponse
import com.tabtin.mobile.data.model.WSEnvelope
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class PendingInteractionRepositoryTest {
    @Test
    fun `refreshAll emits requested only for interactions newly recovered after reconnect`() = runTest {
        val interaction = pendingInteraction()
        val chatApi = mockk<ChatApi>()
        coEvery { chatApi.getPendingInteractions(any()) } returns ApiEnvelope(
            success = true,
            data = PendingInteractionListResponse(interactions = listOf(interaction)),
        )
        val repository = PendingInteractionRepository(chatApi)

        val update = async { repository.updates.first() }
        runCurrent()
        repository.refreshAll()

        assertEquals(PendingInteractionUpdate.Requested(interaction), update.await())
    }

    @Test
    fun `refreshAll does not emit duplicate requested for known interaction`() = runTest {
        val interaction = pendingInteraction()
        val chatApi = mockk<ChatApi>()
        coEvery { chatApi.getPendingInteractions(any()) } returns ApiEnvelope(
            success = true,
            data = PendingInteractionListResponse(interactions = listOf(interaction)),
        )
        val repository = PendingInteractionRepository(chatApi)

        val initialUpdate = async { repository.updates.first() }
        runCurrent()
        repository.refreshAll()
        initialUpdate.await()

        val duplicateUpdate = async {
            withTimeoutOrNull(1) { repository.updates.first() }
        }
        runCurrent()
        repository.refreshAll()
        advanceUntilIdle()

        assertNull(duplicateUpdate.await())
        assertEquals(listOf(interaction), repository.pendingForSession(SESSION_ID))
    }

    @Test
    fun `handleUserEvent does not re-emit requested for already known interaction`() = runTest {
        val interaction = pendingInteraction(kind = "ask_choice")
        val chatApi = mockk<ChatApi>()
        coEvery { chatApi.getPendingInteractions(any()) } returns ApiEnvelope(
            success = true,
            data = PendingInteractionListResponse(interactions = listOf(interaction)),
        )
        val repository = PendingInteractionRepository(chatApi)

        val initialUpdate = async { repository.updates.first() }
        runCurrent()
        repository.refreshAll()
        initialUpdate.await()

        val duplicateUpdate = async {
            withTimeoutOrNull(1) { repository.updates.first() }
        }
        runCurrent()
        repository.handleUserEvent(requestedEnvelope(interaction))
        advanceUntilIdle()

        assertNull(duplicateUpdate.await())
        assertEquals(listOf(interaction), repository.pendingForSession(SESSION_ID))
    }

    @Test
    fun `handleUserEvent emits requested for first sight of interaction`() = runTest {
        val interaction = pendingInteraction(kind = "ask_choice")
        val chatApi = mockk<ChatApi>(relaxed = true)
        val repository = PendingInteractionRepository(chatApi)

        val update = async { repository.updates.first() }
        runCurrent()
        repository.handleUserEvent(requestedEnvelope(interaction))

        assertEquals(PendingInteractionUpdate.Requested(interaction), update.await())
        assertEquals(listOf(interaction), repository.pendingForSession(SESSION_ID))
    }

    private fun pendingInteraction(kind: String = "tool_approval"): PendingInteraction = PendingInteraction(
        id = "interaction-1",
        kind = kind,
        status = "pending",
        threadId = "chat-session-$SESSION_ID",
        sessionId = SESSION_ID,
        requestKey = "request-1",
        source = "agent_stream",
    )

    private fun requestedEnvelope(interaction: PendingInteraction): WSEnvelope {
        val interactionJson = Json.encodeToJsonElement(PendingInteraction.serializer(), interaction).jsonObject
        return WSEnvelope(
            type = "agent.user.interaction_requested",
            payload = buildJsonObject {
                put("interaction", interactionJson)
            },
        )
    }

    private companion object {
        private const val SESSION_ID = "session-1"
    }
}
