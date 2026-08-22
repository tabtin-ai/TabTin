package com.tabtin.mobile.features.tabchat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class ImRealtimeInitializationTest {
    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    public fun `chat subscription waits for history visibility`() = runTest {
        val watermarkReady = CompletableDeferred<Unit>()
        val events = mutableListOf("watermark-started")

        val result = async {
            initializeImRealtimeAfterHistoryVisibility(
                initializeHistoryVisibility = {
                    watermarkReady.await()
                    events += "watermark-ready"
                    true
                },
                subscribe = { events += "subscribed" },
                reconcileLatest = { events += "reconciled" },
            )
        }
        runCurrent()

        assertEquals(listOf("watermark-started"), events)
        watermarkReady.complete(Unit)
        assertTrue(result.await())
        assertEquals(listOf("watermark-started", "watermark-ready", "subscribed"), events)
    }

    @Test
    public fun `chat subscription stays disabled when history visibility fails`() = runTest {
        var subscribed = false

        val initialized = initializeImRealtimeAfterHistoryVisibility(
            initializeHistoryVisibility = { false },
            subscribe = { subscribed = true },
            reconcileLatest = {},
        )

        assertFalse(initialized)
        assertFalse(subscribed)
    }

    @Test
    public fun `chat subscription closes the history to realtime gap with a catch up`() = runTest {
        val events = mutableListOf<String>()
        var onSubscriptionAvailable: (() -> Unit)? = null

        val initialized = initializeImRealtimeAfterHistoryVisibility(
            initializeHistoryVisibility = {
                events += "watermark-ready"
                true
            },
            subscribe = { callback ->
                events += "subscribed"
                onSubscriptionAvailable = callback
            },
            reconcileLatest = { events += "reconciled" },
        )

        assertTrue(initialized)
        assertEquals(listOf("watermark-ready", "subscribed"), events)
        onSubscriptionAvailable?.invoke()
        assertEquals(
            listOf("watermark-ready", "subscribed", "reconciled"),
            events,
        )
    }
}
