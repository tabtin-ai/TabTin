package com.tabtin.mobile.data.repository

import android.app.Application
import com.tabtin.mobile.data.api.NotificationApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.NotificationItem
import com.tabtin.mobile.data.model.NotificationListResponse
import com.tabtin.mobile.data.model.NotificationMarkAllResponse
import com.tabtin.mobile.data.model.NotificationUnreadCountResponse
import com.tabtin.mobile.data.model.WSEnvelope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class NotificationRepositoryTest {

    @Test
    fun `business failure rolls back optimistic read state and unread count`() = runTest {
        val item = unreadNotification()
        val api = FakeNotificationApi(
            notifications = listOf(item),
            unreadCount = 1,
            markReadResponse = ApiEnvelope(
                success = false,
                message = "notification not found",
            ),
        )
        val repository = NotificationRepository(api)
        repository.activate(ORGANIZATION_ID)

        repository.markRead(item)
        assertTrue(repository.state.value.notifications.single().isRead)
        assertEquals(0, repository.state.value.unreadCount)

        repository.persistRead(item)

        assertFalse(repository.state.value.notifications.single().isRead)
        assertEquals(1, repository.state.value.unreadCount)
        assertEquals(2, api.listCalls)
        assertEquals(2, api.unreadCountCalls)
    }

    @Test
    fun `successful empty response keeps optimistic read state`() = runTest {
        val item = unreadNotification()
        val api = FakeNotificationApi(
            notifications = listOf(item),
            unreadCount = 1,
            markReadResponse = ApiEnvelope(success = true),
        )
        val repository = NotificationRepository(api)
        repository.activate(ORGANIZATION_ID)

        repository.markRead(item)
        repository.persistRead(item)

        assertTrue(repository.state.value.notifications.single().isRead)
        assertEquals(0, repository.state.value.unreadCount)
        assertEquals(1, api.listCalls)
        assertEquals(1, api.unreadCountCalls)
    }

    @Test
    fun `unread list keeps mark all action available when count request fails`() = runTest {
        val item = unreadNotification()
        val api = FakeNotificationApi(
            notifications = listOf(item),
            unreadCount = 0,
            unreadCountResponse = ApiEnvelope(
                success = false,
                message = "unread count unavailable",
            ),
            markReadResponse = ApiEnvelope(success = true),
        )
        val repository = NotificationRepository(api)

        repository.activate(ORGANIZATION_ID)

        assertEquals(0, repository.state.value.unreadCount)
        assertTrue(repository.state.value.hasUnreadNotifications)
    }

    @Test
    fun `mark all failure restores unread state and exposes retry feedback`() = runTest {
        val item = unreadNotification()
        val api = FakeNotificationApi(
            notifications = listOf(item),
            unreadCount = 1,
            markReadResponse = ApiEnvelope(success = true),
            markAllReadResponse = ApiEnvelope(
                success = false,
                message = "mark all unavailable",
            ),
        )
        val repository = NotificationRepository(api)
        repository.activate(ORGANIZATION_ID)

        repository.markAllRead()

        assertFalse(repository.state.value.notifications.single().isRead)
        assertEquals(1, repository.state.value.unreadCount)
        assertTrue(repository.state.value.hasUnreadNotifications)
        assertTrue(repository.state.value.markAllReadFailed)
        assertFalse(repository.state.value.isMarkingAllRead)

        repository.consumeMarkAllReadFailure()
        assertFalse(repository.state.value.markAllReadFailed)
    }

    @Test
    fun `notification arriving during mark all remains unread`() = runTest {
        val markAllStarted = CompletableDeferred<Unit>()
        val releaseMarkAll = CompletableDeferred<Unit>()
        val api = FakeNotificationApi(
            notifications = listOf(unreadNotification()),
            unreadCount = 1,
            markReadResponse = ApiEnvelope(success = true),
            markAllReadStarted = markAllStarted,
            releaseMarkAll = releaseMarkAll,
        )
        val repository = NotificationRepository(api)
        repository.activate(ORGANIZATION_ID)

        val request = async { repository.markAllRead() }
        markAllStarted.await()
        repository.handleRealtimeEnvelope(notificationEnvelope(
            id = "notification-2",
            type = "agent.task.completed",
            organizationId = ORGANIZATION_ID,
        ))
        releaseMarkAll.complete(Unit)
        request.await()

        val itemsById = repository.state.value.notifications.associateBy(NotificationItem::id)
        assertTrue(itemsById.getValue("notification-1").isRead)
        assertFalse(itemsById.getValue("notification-2").isRead)
        assertEquals(1, repository.state.value.unreadCount)
        assertTrue(repository.state.value.hasUnreadNotifications)
        assertFalse(repository.state.value.isMarkingAllRead)
        assertEquals(1, api.listCalls)
        assertEquals(1, api.unreadCountCalls)
    }

    @Test
    fun `mark all completion from previous organization cannot mutate active organization`() = runTest {
        val markAllStarted = CompletableDeferred<Unit>()
        val releaseMarkAll = CompletableDeferred<Unit>()
        val api = FakeNotificationApi(
            notifications = listOf(unreadNotification()),
            unreadCount = 1,
            markReadResponse = ApiEnvelope(success = true),
            markAllReadResponse = ApiEnvelope(success = false, message = "mark all unavailable"),
            markAllReadStarted = markAllStarted,
            releaseMarkAll = releaseMarkAll,
        )
        val repository = NotificationRepository(api)
        repository.activate(ORGANIZATION_ID)

        val request = async { repository.markAllRead() }
        markAllStarted.await()
        repository.activate("organization-2")
        releaseMarkAll.complete(Unit)
        request.await()

        assertEquals("organization-2", repository.state.value.organizationId)
        assertFalse(repository.state.value.isMarkingAllRead)
        assertFalse(repository.state.value.markAllReadFailed)
    }

    @Test
    fun `cross organization invitation is accepted but other realtime notifications stay scoped`() = runTest {
        val api = FakeNotificationApi(
            notifications = emptyList(),
            unreadCount = 0,
            markReadResponse = ApiEnvelope(success = true),
        )
        val repository = NotificationRepository(api)
        repository.activate(ORGANIZATION_ID)

        repository.handleRealtimeEnvelope(notificationEnvelope(
            id = "invite-1",
            type = "organization.invitation",
            organizationId = "invited-org",
        ))
        repository.handleRealtimeEnvelope(notificationEnvelope(
            id = "other-1",
            type = "agent.task.completed",
            organizationId = "other-org",
        ))

        assertEquals(listOf("invite-1"), repository.state.value.notifications.map { it.id })
        assertEquals(1, repository.state.value.unreadCount)
        assertTrue(api.listIncludePersonalInvitations)
        assertTrue(api.unreadIncludePersonalInvitations)
    }

    @Test
    fun `resolved invitation replaces unread invitation and clears its unread count`() = runTest {
        val repository = NotificationRepository(
            FakeNotificationApi(
                notifications = emptyList(),
                unreadCount = 0,
                markReadResponse = ApiEnvelope(success = true),
            ),
        )
        repository.activate(ORGANIZATION_ID)

        repository.handleRealtimeEnvelope(
            notificationEnvelope(
                id = "invite-1",
                type = "organization.invitation",
                organizationId = "invited-org",
            ),
        )
        repository.handleRealtimeEnvelope(
            notificationEnvelope(
                id = "invite-1",
                type = "organization.invitation.cancelled",
                organizationId = "invited-org",
                isRead = true,
            ),
        )

        val notification = repository.state.value.notifications.single()
        assertEquals("organization.invitation.cancelled", notification.type)
        assertTrue(notification.isRead)
        assertEquals(0, repository.state.value.unreadCount)
        assertFalse(repository.state.value.hasUnreadNotifications)
    }

    @Test
    fun `desktop only realtime notification is ignored`() = runTest {
        val repository = NotificationRepository(
            FakeNotificationApi(
                notifications = emptyList(),
                unreadCount = 0,
                markReadResponse = ApiEnvelope(success = true),
            ),
        )
        repository.activate(ORGANIZATION_ID)

        repository.handleRealtimeEnvelope(
            notificationEnvelope(
                id = "desktop-only",
                type = "tabdata.comment.mention.desktop_only",
                organizationId = ORGANIZATION_ID,
                desktopOnly = true,
            ),
        )

        assertTrue(repository.state.value.notifications.isEmpty())
        assertEquals(0, repository.state.value.unreadCount)
    }

    @Test
    fun `realtime decoder keeps legacy wire host without overriding canonical scope`() = runTest {
        val repository = NotificationRepository(
            FakeNotificationApi(
                notifications = emptyList(),
                unreadCount = 0,
                markReadResponse = ApiEnvelope(success = true),
            ),
        )
        repository.activate(ORGANIZATION_ID)

        repository.handleRealtimeEnvelope(
            notificationEnvelope(
                id = "notification-canonical",
                type = "agent.task.completed",
                organizationId = ORGANIZATION_ID,
                workspaceId = "workspace-1",
                projectId = "project-1",
                legacyHostId = "ambiguous-legacy-host",
            ),
        )

        val notification = repository.state.value.notifications.single()
        assertEquals("workspace-1", notification.workspaceId)
        assertEquals("project-1", notification.projectId)
        assertEquals("ambiguous-legacy-host", notification.legacyHostId)
    }

    private fun notificationEnvelope(
        id: String,
        type: String,
        organizationId: String,
        workspaceId: String? = null,
        projectId: String? = null,
        legacyHostId: String? = null,
        desktopOnly: Boolean = false,
        isRead: Boolean = false,
    ): WSEnvelope = WSEnvelope(
        type = "agent.user.notification.new",
        payload = buildJsonObject {
            put("id", id)
            put("type", type)
            put("organization_id", organizationId)
            workspaceId?.let { put("workspace_id", it) }
            projectId?.let { put("project_id", it) }
            legacyHostId?.let { put("space_id", it) }
            if (desktopOnly) {
                put("metadata", buildJsonObject { put("desktop_only", true) })
            }
            put("is_read", isRead)
            put("created_at", "2026-07-17T10:00:00Z")
        },
    )

    private fun unreadNotification(): NotificationItem = NotificationItem(
        id = "notification-1",
        organizationId = ORGANIZATION_ID,
        isRead = false,
        createdAt = "2026-07-17T10:00:00Z",
    )

    private class FakeNotificationApi(
        private val notifications: List<NotificationItem>,
        private val unreadCount: Int,
        private val markReadResponse: ApiEnvelope<JsonObject>,
        private val unreadCountResponse: ApiEnvelope<NotificationUnreadCountResponse>? = null,
        private val markAllReadResponse: ApiEnvelope<NotificationMarkAllResponse> = ApiEnvelope(
            success = true,
            data = NotificationMarkAllResponse(),
        ),
        private val markAllReadStarted: CompletableDeferred<Unit>? = null,
        private val releaseMarkAll: CompletableDeferred<Unit>? = null,
    ) : NotificationApi {
        var listCalls: Int = 0
            private set
        var unreadCountCalls: Int = 0
            private set
        var listIncludePersonalInvitations: Boolean = false
            private set
        var unreadIncludePersonalInvitations: Boolean = false
            private set

        override suspend fun listNotifications(
            page: Int,
            limit: Int,
            organizationId: String?,
            includePersonalInvitations: Boolean,
        ): ApiEnvelope<NotificationListResponse> {
            listCalls += 1
            listIncludePersonalInvitations = includePersonalInvitations
            return ApiEnvelope(
                success = true,
                data = NotificationListResponse(items = notifications),
            )
        }

        override suspend fun getUnreadCount(
            organizationId: String?,
            includePersonalInvitations: Boolean,
        ): ApiEnvelope<NotificationUnreadCountResponse> {
            unreadCountCalls += 1
            unreadIncludePersonalInvitations = includePersonalInvitations
            return unreadCountResponse ?: ApiEnvelope(
                success = true,
                data = NotificationUnreadCountResponse(unreadCount),
            )
        }

        override suspend fun markRead(id: String): ApiEnvelope<JsonObject> = markReadResponse

        override suspend fun markAllRead(
            organizationId: String?,
            includePersonalInvitations: Boolean,
        ): ApiEnvelope<NotificationMarkAllResponse> {
            markAllReadStarted?.complete(Unit)
            releaseMarkAll?.await()
            return markAllReadResponse
        }
    }

    private companion object {
        private const val ORGANIZATION_ID = "organization-1"
    }
}
