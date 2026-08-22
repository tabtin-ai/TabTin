package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.R
import com.tabtin.mobile.util.ErrorClassifier
import java.net.UnknownHostException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImGroupCreationRecoveryTest {
    @Test
    fun `retry keeps the same client request id`() {
        var generated = 0
        val first = resolveImGroupCreationAttempt(
            previous = null,
            organizationId = "org-1",
            name = "项目群",
            memberIds = listOf("user-3", "user-2"),
        ) { "request-${++generated}" }
        val retry = resolveImGroupCreationAttempt(
            previous = first,
            organizationId = "org-1",
            name = "项目群",
            memberIds = listOf("user-2", "user-3"),
        ) { "request-${++generated}" }

        assertEquals(first.clientRequestId, retry.clientRequestId)
        assertEquals(1, generated)
    }

    @Test
    fun `changed group payload starts a new request`() {
        val first = resolveImGroupCreationAttempt(
            previous = null,
            organizationId = "org-1",
            name = "项目群",
            memberIds = listOf("user-2"),
        ) { "request-1" }

        val changed = resolveImGroupCreationAttempt(
            previous = first,
            organizationId = "org-1",
            name = "新项目群",
            memberIds = listOf("user-2"),
        ) { "request-2" }

        assertEquals("request-2", changed.clientRequestId)
    }

    @Test
    fun `changed external contacts start a new request`() {
        val first = resolveImGroupCreationAttempt(
            previous = null,
            organizationId = "org-1",
            name = "客户群",
            memberIds = emptyList(),
            externalContactIds = listOf("contact-1"),
        ) { "request-1" }

        val changed = resolveImGroupCreationAttempt(
            previous = first,
            organizationId = "org-1",
            name = "客户群",
            memberIds = emptyList(),
            externalContactIds = listOf("contact-2"),
        ) { "request-2" }

        assertEquals("request-2", changed.clientRequestId)
    }

    @Test
    fun `group failure uses localized error resource instead of server text`() {
        val resource = ErrorClassifier.classify(UnknownHostException("api-test.example.com"))

        assertEquals(R.string.error_network, resource)
    }

    @Test
    fun `created group is returned only after catalog refresh`() = runTest {
        val events = mutableListOf<String>()
        val attempt = ImGroupCreationAttempt(
            organizationId = "org-1",
            name = "项目群",
            memberIds = listOf("user-2"),
            clientRequestId = "44444444-4444-4444-8444-444444444444",
        )

        val target = completeImGroupCreation(
            attempt = attempt,
            createConversation = {
                events += "create:${it.clientRequestId}"
                "conversation-1"
            },
            refreshCatalog = {
                events += "refresh:$it"
                true
            },
        )
        events += "navigate:${target.conversationId}"

        assertEquals(
            listOf(
                "create:44444444-4444-4444-8444-444444444444",
                "refresh:org-1",
                "navigate:conversation-1",
            ),
            events,
        )
    }

    @Test
    fun `catalog refresh failure does not return a navigation target`() = runTest {
        var returned = false
        val attempt = ImGroupCreationAttempt(
            organizationId = "org-1",
            name = "项目群",
            memberIds = listOf("user-2"),
            clientRequestId = "44444444-4444-4444-8444-444444444444",
        )

        val result = runCatching {
            completeImGroupCreation(
                attempt = attempt,
                createConversation = { "conversation-1" },
                refreshCatalog = { false },
            ).also { returned = true }
        }

        assertTrue(result.isFailure)
        assertTrue(!returned)
    }
}
