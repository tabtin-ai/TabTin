package com.tabtin.mobile.data.im

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class ImCardDetailRequestCoalescerTest {
    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `disposing one card observer does not cancel the shared request`() = runTest {
        val requestCount = AtomicInteger(0)
        val response = CompletableDeferred<String>()
        val ownerScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val coalescer = ImCardDetailRequestCoalescer<String>(ownerScope)

        val disposedObserver = async {
            coalescer.load("card-1") {
                requestCount.incrementAndGet()
                response.await()
            }
        }
        runCurrent()
        disposedObserver.cancelAndJoin()

        val visibleObserver = async {
            coalescer.load("card-1") {
                requestCount.incrementAndGet()
                response.await()
            }
        }
        runCurrent()
        response.complete("已加载")

        assertEquals("已加载", visibleObserver.await().getOrThrow())
        assertEquals(1, requestCount.get())
        ownerScope.cancel()
    }
}
