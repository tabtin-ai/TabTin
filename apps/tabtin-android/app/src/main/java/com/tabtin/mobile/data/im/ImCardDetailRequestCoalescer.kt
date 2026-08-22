package com.tabtin.mobile.data.im

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Keeps card-detail requests owned by a conversation scope instead of a lazy-list item.
 *
 * A card leaving Compose only cancels that observer's await. The underlying request keeps running,
 * so a card that re-enters the viewport joins the same request instead of issuing another one.
 */
internal class ImCardDetailRequestCoalescer<T>(
    private val scope: CoroutineScope,
) {
    private val mutex = Mutex()
    private val inFlight = mutableMapOf<String, Deferred<Result<T>>>()

    suspend fun load(key: String, request: suspend () -> T): Result<T> {
        val deferred = mutex.withLock {
            inFlight[key]?.takeUnless { it.isCancelled } ?: scope.async {
                try {
                    Result.success(request())
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    Result.failure(error)
                }
            }.also { created ->
                inFlight[key] = created
                created.invokeOnCompletion {
                    scope.launch {
                        mutex.withLock {
                            if (inFlight[key] === created) inFlight.remove(key)
                        }
                    }
                }
            }
        }
        return deferred.await()
    }
}
