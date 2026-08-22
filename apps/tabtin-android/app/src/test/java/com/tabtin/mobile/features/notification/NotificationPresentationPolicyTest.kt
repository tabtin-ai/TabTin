package com.tabtin.mobile.features.notification

import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.NotificationItem
import com.tabtin.mobile.data.model.MobileNotificationTarget
import com.tabtin.mobile.data.model.MobileNotificationTargetResolver
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPresentationPolicyTest {

    @Test
    fun `notification types map to the shared mobile categories`() {
        val expectations = mapOf(
            "agent.task.completed" to NotificationCategory.AGENT,
            "tracker.run.completed" to NotificationCategory.AGENT,
            "im.message.mention" to NotificationCategory.COLLABORATION,
            "tabdoc.comment.mention" to NotificationCategory.COLLABORATION,
            "tabdata.row.updated" to NotificationCategory.COLLABORATION,
            "resource_shared" to NotificationCategory.COLLABORATION,
            "resource_access_request" to NotificationCategory.COLLABORATION,
            "tabmail.received" to NotificationCategory.COLLABORATION,
            "tabinbox.route" to NotificationCategory.COLLABORATION,
            "tabinbox.received" to NotificationCategory.COLLABORATION,
            "organization.invitation" to NotificationCategory.ORGANIZATION,
            "invite_received" to NotificationCategory.ORGANIZATION,
            "member_removed" to NotificationCategory.ORGANIZATION,
            "role_changed" to NotificationCategory.ORGANIZATION,
            "ownership_transfer" to NotificationCategory.ORGANIZATION,
            "team_space.member_added" to NotificationCategory.ORGANIZATION,
            "quota_warning" to NotificationCategory.SYSTEM,
            "future.event" to NotificationCategory.SYSTEM,
        )

        assertEquals(
            expectations,
            expectations.keys.associateWith { type ->
                NotificationPresentationPolicy.category(NotificationItem(id = type, type = type))
            },
        )
    }

    @Test
    fun `pending filter contains actionable types and every urgent notification`() {
        val actionableTypes = listOf(
            "agent.hitl.waiting",
            "agent.task.error",
            "tracker.run.failed",
            "resource_access_request",
            "organization.invitation",
            "invite_received",
        )

        actionableTypes.forEach { type ->
            assertTrue(type, NotificationPresentationPolicy.needsAction(NotificationItem(id = type, type = type)))
        }
        assertTrue(
            NotificationPresentationPolicy.needsAction(
                NotificationItem(id = "urgent-system", type = "quota_warning", priority = "urgent"),
            ),
        )
        assertFalse(
            NotificationPresentationPolicy.needsAction(
                NotificationItem(id = "completed", type = "agent.task.completed", priority = "normal"),
            ),
        )
    }

    @Test
    fun `resolved resource access leaves pending and cannot reopen approval`() {
        val requestId = "request-1"
        val pending = NotificationItem(
            id = "access-1",
            type = "resource_access_request",
            metadata = buildJsonObject {
                put("request_id", requestId)
                put("behavior", "action_required")
            },
        )
        val resolved = pending.copy(
            metadata = buildJsonObject {
                put("request_id", requestId)
                put("resolved", true)
                put("request_status", "approved")
                put("behavior", "notification_only")
            },
            isRead = true,
        )

        assertTrue(NotificationPresentationPolicy.needsAction(pending))
        assertFalse(NotificationPresentationPolicy.needsAction(resolved))
        assertTrue(
            NotificationPresentationPolicy.hasPendingResourceAccessRequest(
                listOf(pending),
                requestId,
            ),
        )
        assertFalse(
            NotificationPresentationPolicy.hasPendingResourceAccessRequest(
                listOf(resolved),
                requestId,
            ),
        )
        assertEquals(
            MobileNotificationTarget.Unsupported,
            MobileNotificationTargetResolver.resolve(resolved),
        )
    }

    @Test
    fun `scheme A filters have fixed order and preserve the time stream`() {
        assertEquals(
            listOf(
                NotificationFilter.ALL,
                NotificationFilter.PENDING,
                NotificationFilter.AGENT,
                NotificationFilter.COLLABORATION,
                NotificationFilter.ORGANIZATION,
                NotificationFilter.SYSTEM,
            ),
            NotificationFilter.entries,
        )
        val notifications = listOf(
            NotificationItem(id = "latest-system", type = "quota_warning"),
            NotificationItem(id = "task", type = "agent.task.completed"),
            NotificationItem(id = "older-system", type = "system"),
        )

        assertEquals(
            listOf("latest-system", "older-system"),
            NotificationPresentationPolicy.filter(notifications, NotificationFilter.SYSTEM).map(NotificationItem::id),
        )
    }

    @Test
    fun `source and canonical context stay separate from category`() {
        val trackerBackedAgent = NotificationItem(
            id = "tracker-agent",
            type = "agent.task.completed",
            metadata = buildJsonObject {
                put("notification_target", "tracker")
                put("project_name", "增长实验")
                put("workspace_name", "小林的 Workspace")
            },
        )
        val sharedDoc = NotificationItem(
            id = "shared-doc",
            type = "resource_shared",
            metadata = buildJsonObject { put("resource_type", "tabdoc") },
        )
        val tabDataWithDocumentTarget = NotificationItem(
            id = "tabdata-document-target",
            type = "tabdata.row.updated",
            metadata = buildJsonObject { put("resource_type", "tabdoc") },
        )

        assertEquals(NotificationSource.AGENT, NotificationPresentationPolicy.source(trackerBackedAgent))
        assertEquals(NotificationSource.DOC, NotificationPresentationPolicy.source(sharedDoc))
        assertEquals(NotificationSource.DATA, NotificationPresentationPolicy.source(tabDataWithDocumentTarget))
        assertEquals(
            NotificationSource.INBOX,
            NotificationPresentationPolicy.source(NotificationItem(id = "inbox", type = "tabinbox.route")),
        )
        assertEquals(
            NotificationContext(NotificationContextKind.PROJECT, "增长实验"),
            NotificationPresentationPolicy.context(trackerBackedAgent),
        )
    }

    @Test
    fun `canonical ids resolve context names with project before workspace`() {
        val notification = NotificationItem(
            id = "notification-context",
            type = "agent.task.completed",
            metadata = buildJsonObject {
                put("project_id", "project-1")
                put("workspace_id", "workspace-1")
            },
        )

        assertEquals(
            NotificationContext(NotificationContextKind.PROJECT, "增长项目"),
            NotificationPresentationPolicy.context(
                item = notification,
                projectNamesById = mapOf("project-1" to "增长项目"),
                workspaceNamesById = mapOf("workspace-1" to "小林的 Workspace"),
            ),
        )
        assertEquals(
            NotificationContext(NotificationContextKind.WORKSPACE, "小林的 Workspace"),
            NotificationPresentationPolicy.context(
                item = notification.copy(
                    metadata = buildJsonObject { put("workspace_id", "workspace-1") },
                ),
                projectNamesById = emptyMap(),
                workspaceNamesById = mapOf("workspace-1" to "小林的 Workspace"),
            ),
        )
    }

    @Test
    fun `team space legacy shell presents as project without mutating wire text`() {
        val notification = NotificationItem(
            id = "team-space-member",
            type = "team_space.member_added",
            title = "你已加入团队 Space",
            body = "现在可以进入项目房间协作",
            metadata = buildJsonObject { put("space_name", "增长项目") },
        )

        assertEquals(NotificationCategory.ORGANIZATION, NotificationPresentationPolicy.category(notification))
        assertEquals(NotificationSource.ORGANIZATION, NotificationPresentationPolicy.source(notification))
        assertEquals(
            NotificationContext(NotificationContextKind.PROJECT, "增长项目"),
            NotificationPresentationPolicy.context(notification),
        )
        assertEquals("你已加入项目", NotificationPresentationPolicy.displayTitle(notification))
        assertEquals("现在可以进入项目协作", NotificationPresentationPolicy.displayBody(notification))
        assertEquals("你已加入团队 Space", notification.title)
        assertEquals("现在可以进入项目房间协作", notification.body)
    }

    @Test
    fun `notification bell accessibility selects unread count or empty state`() {
        assertEquals(
            R.string.notification_unread_count,
            notificationBellStateDescriptionResource(unreadCount = 3),
        )
        assertEquals(
            R.string.notification_no_unread,
            notificationBellStateDescriptionResource(unreadCount = 0),
        )
    }
}
