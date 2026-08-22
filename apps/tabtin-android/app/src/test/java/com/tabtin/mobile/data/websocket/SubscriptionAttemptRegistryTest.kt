package com.tabtin.mobile.data.websocket

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SubscriptionAttemptRegistryTest {
    @Test
    fun `concurrent default workspace session subscriptions share one request`() = runTest {
        val registry = SubscriptionAttemptRegistry()
        val topic = "agent.stream.chat-session-12345678-1234-1234-1234-123456789abc"
        val first = registry.acquire(listOf(topic))
        val second = registry.acquire(listOf(topic))

        assertTrue(first.shouldSend)
        assertFalse(second.shouldSend)
        assertTrue(first.waiter === second.waiter)
        assertEquals(1, registry.attachRequest("request-1", listOf(topic)))

        val firstResult = async { first.waiter.deferred.await() }
        val secondResult = async { second.waiter.deferred.await() }
        assertEquals(1, registry.completeSuccess("request-1", listOf(topic)))
        assertEquals(SubscriptionResult.Success, firstResult.await())
        assertEquals(SubscriptionResult.Success, secondResult.await())
    }

    @Test
    fun `gateway rejection keeps code while redacting session id from diagnostic topic`() = runTest {
        val registry = SubscriptionAttemptRegistry()
        val topic = "agent.stream.chat-session-12345678-1234-1234-1234-123456789abc"
        val waiter = registry.acquire(listOf(topic)).waiter
        registry.attachRequest("request-2", listOf(topic))

        val result = async { waiter.deferred.await() }
        val prefixes = registry.completeRejected(
            requestId = "request-2",
            errorCode = "WS_1005_PERMISSION_DENIED",
            serverMessage = "thread access denied",
            rejectedTopic = topic,
        )

        assertEquals(setOf("agent.stream"), prefixes)
        assertEquals(
            SubscriptionResult.Rejected(
                errorCode = "WS_1005_PERMISSION_DENIED",
                serverMessage = "thread access denied",
                topicPrefixes = setOf("agent.stream"),
            ),
            result.await(),
        )
    }

    @Test
    fun `in flight topic without waiter prevents duplicate subscription request`() {
        val registry = SubscriptionAttemptRegistry()
        val topic = "billing.events.org-12345678"
        registry.attachRequest("request-3", listOf(topic))
        assertTrue(registry.hasInFlightRequest(topic))
        assertFalse(registry.hasInFlightRequest("agent.stream.chat-session-other"))
    }

    @Test
    fun `one caller timing out does not fail another caller waiting for the same topic`() = runTest {
        val registry = SubscriptionAttemptRegistry()
        val topic = "agent.stream.chat-session-12345678-1234-1234-1234-123456789abc"
        val first = registry.acquire(listOf(topic))
        val second = registry.acquire(listOf(topic))
        registry.attachRequest("request-4", listOf(topic))

        assertEquals(SubscriptionResult.TimedOut, registry.timeout(first.waiter))
        assertFalse(second.waiter.deferred.isCompleted)
        assertEquals(1, registry.completeSuccess("request-4", listOf(topic)))
        assertEquals(SubscriptionResult.Success, second.waiter.deferred.await())
    }

    @Test
    fun `a multi topic waiter completes only after every topic is confirmed`() = runTest {
        val registry = SubscriptionAttemptRegistry()
        val firstTopic = "agent.stream.chat-session-first"
        val secondTopic = "agent.stream.chat-session-second"
        val waiter = registry.acquire(listOf(firstTopic, secondTopic)).waiter

        registry.attachRequest("request-5", listOf(firstTopic))
        assertEquals(0, registry.completeSuccess("request-5", listOf(firstTopic)))
        assertFalse(waiter.deferred.isCompleted)

        registry.attachRequest("request-6", listOf(secondTopic))
        assertEquals(1, registry.completeSuccess("request-6", listOf(secondTopic)))
        assertEquals(SubscriptionResult.Success, waiter.deferred.await())
    }
}
