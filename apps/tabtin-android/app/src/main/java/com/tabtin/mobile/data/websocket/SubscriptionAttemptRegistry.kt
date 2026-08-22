package com.tabtin.mobile.data.websocket

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** 会话流订阅的确定性结果，避免把拒绝、断链和超时压成 Boolean。 */
public sealed class SubscriptionResult {
    public data object Success : SubscriptionResult()
    public data class Rejected(
        val errorCode: String,
        val serverMessage: String?,
        val topicPrefixes: Set<String>,
    ) : SubscriptionResult()
    public data object TimedOut : SubscriptionResult()
    public data object Disconnected : SubscriptionResult()
}

/** 将同一 topic 的并发订阅合并为单个在途请求，并按 request id 归因回包。 */
internal class SubscriptionAttemptRegistry {
    internal class Waiter(
        val key: String,
        val topics: Set<String>,
        val deferred: CompletableDeferred<SubscriptionResult> = CompletableDeferred(),
    ) {
        val consumerCount = AtomicInteger(1)
        val confirmedTopics = ConcurrentHashMap.newKeySet<String>()
    }

    internal data class AcquireResult(
        val waiter: Waiter,
        val shouldSend: Boolean,
    )

    private data class RequestAttempt(
        val topics: Set<String>,
        val waiters: Set<Waiter>,
    )

    private val waiters = ConcurrentHashMap<String, Waiter>()
    private val requestsById = ConcurrentHashMap<String, RequestAttempt>()

    fun acquire(topics: Collection<String>): AcquireResult {
        val normalizedTopics = topics.asSequence().filter { it.isNotBlank() }.toSortedSet()
        val key = normalizedTopics.joinToString(",")
        val candidate = Waiter(key = key, topics = normalizedTopics)
        val existing = waiters.putIfAbsent(key, candidate)
        return if (existing == null) {
            AcquireResult(candidate, shouldSend = true)
        } else {
            existing.consumerCount.incrementAndGet()
            AcquireResult(existing, shouldSend = false)
        }
    }

    fun hasInFlightRequest(topic: String): Boolean = requestsById.values.any { topic in it.topics }

    fun topicPrefixes(topics: Collection<String>): Set<String> = topics
        .filter { it.isNotBlank() }
        .map(::topicPrefix)
        .toSet()

    fun attachRequest(requestId: String, requestedTopics: Collection<String>): Int {
        val requested = requestedTopics.filter { it.isNotBlank() }.toSet()
        val matched = waiters.values.filter { waiter -> waiter.topics.any { it in requested } }.toSet()
        requestsById[requestId] = RequestAttempt(requested, matched)
        return matched.size
    }

    fun completeSuccess(requestId: String?, confirmedTopics: Collection<String>): Int {
        val request = requestId?.let { requestsById.remove(it) } ?: return 0
        val confirmed = confirmedTopics.filter { it.isNotBlank() }.toSet()
        return request.waiters.count { waiter ->
            val acknowledgedTopics = confirmed.ifEmpty { request.topics }
            waiter.confirmedTopics.addAll(acknowledgedTopics.filter { it in waiter.topics })
            val complete = waiter.confirmedTopics.containsAll(waiter.topics)
            complete && finish(waiter, SubscriptionResult.Success)
        }
    }

    fun completeRejected(
        requestId: String?,
        errorCode: String,
        serverMessage: String?,
        rejectedTopic: String?,
    ): Set<String> {
        val request = requestId?.let { requestsById.remove(it) } ?: return emptySet()
        val prefixes = rejectedTopic?.let(::topicPrefix)?.let(::setOf) ?: topicPrefixes(request.topics)
        request.waiters.forEach { waiter ->
            finish(waiter, SubscriptionResult.Rejected(errorCode, serverMessage, prefixes))
        }
        return prefixes
    }

    fun completeRejectedForTopics(
        topics: Collection<String>,
        errorCode: String,
        serverMessage: String,
    ): Set<String> {
        val rejected = topics.filter { it.isNotBlank() }.toSet()
        val matched = waiters.values.filter { waiter -> waiter.topics.all { it in rejected } }
        val prefixes = matched.flatMap { waiter -> waiter.topics.map(::topicPrefix) }.toSet()
        matched.forEach { waiter ->
            finish(waiter, SubscriptionResult.Rejected(errorCode, serverMessage, prefixes))
        }
        return prefixes
    }

    suspend fun timeout(waiter: Waiter): SubscriptionResult {
        if (waiter.consumerCount.decrementAndGet() == 0) {
            finish(waiter, SubscriptionResult.TimedOut)
        }
        return SubscriptionResult.TimedOut
    }

    fun completeAll(result: SubscriptionResult) {
        waiters.values.toList().forEach { finish(it, result) }
        requestsById.clear()
    }

    private fun finish(waiter: Waiter, result: SubscriptionResult): Boolean {
        if (!waiters.remove(waiter.key, waiter)) return false
        requestsById.entries.forEach { (requestId, request) ->
            if (waiter !in request.waiters) return@forEach
            val remainingWaiters = request.waiters - waiter
            if (remainingWaiters.isEmpty()) {
                requestsById.remove(requestId, request)
            } else {
                requestsById.replace(requestId, request, request.copy(waiters = remainingWaiters))
            }
        }
        return waiter.deferred.complete(result)
    }

    private fun topicPrefix(topic: String): String = topic.substringBeforeLast('.', missingDelimiterValue = topic)
}
