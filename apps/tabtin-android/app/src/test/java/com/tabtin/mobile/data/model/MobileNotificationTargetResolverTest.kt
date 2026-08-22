package com.tabtin.mobile.data.model

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileNotificationTargetResolverTest {

    @Test
    fun `wire decoding keeps canonical scope separate from the legacy host`() {
        val decoded = Json.decodeFromString<NotificationItem>(
            """
            {
              "id": "notification-1",
              "workspace_id": "workspace-1",
              "project_id": "project-1",
              "space_id": "ambiguous-legacy-host"
            }
            """.trimIndent(),
        )

        assertEquals("workspace-1", decoded.workspaceId)
        assertEquals("project-1", decoded.projectId)
        assertEquals("ambiguous-legacy-host", decoded.legacyHostId)
    }

    @Test
    fun `conversation title prefers notification subtitle`() {
        assertEquals(
            "会话标题",
            item(title = "任务已完成", body = "会话标题").conversationTitle,
        )
    }

    @Test
    fun `conversation title falls back to notification title when subtitle is blank`() {
        assertEquals(
            "任务已完成",
            item(title = "任务已完成", body = "  \n ").conversationTitle,
        )
    }

    @Test
    fun `explicit chat target inherits canonical notification scope`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "agent.task.completed",
                organizationId = "org-1",
                workspaceId = "workspace-1",
                projectId = "project-1",
                navigateTo = buildJsonObject {
                    put("type", "chat-session")
                    put("id", "session-1")
                    put("messageId", "message-1")
                },
            ),
        ) as MobileNotificationTarget.ChatSession

        assertEquals("session-1", target.id)
        assertEquals("message-1", target.messageId)
        assertEquals("org-1", target.organizationId)
        assertEquals("workspace-1", target.workspaceId)
        assertEquals("project-1", target.projectId)
    }

    @Test
    fun `chat notification missing scope uses authoritative session workspace`() {
        val target = MobileNotificationChatSessionTargetResolver.resolve(
            target = MobileNotificationTarget.ChatSession(
                id = "session-1",
                messageId = "message-1",
            ),
            session = ChatSession(
                id = "session-1",
                organizationId = "org-session",
                workspaceId = "workspace-session",
                projectId = "project-session",
            ),
        ) as MobileNotificationTarget.ChatSession

        assertEquals("session-1", target.id)
        assertEquals("message-1", target.messageId)
        assertEquals("org-session", target.organizationId)
        assertEquals("workspace-session", target.workspaceId)
        assertEquals("project-session", target.projectId)
    }

    @Test
    fun `chat project id never substitutes for its required workspace`() {
        assertTrue(
            MobileNotificationChatSessionTargetResolver.requiresSessionScope(
                MobileNotificationTarget.ChatSession(id = "session-1", projectId = "project-1"),
            ),
        )
        assertFalse(
            MobileNotificationChatSessionTargetResolver.requiresSessionScope(
                MobileNotificationTarget.ChatSession(
                    id = "session-1",
                    workspaceId = "workspace-1",
                    projectId = "project-1",
                ),
            ),
        )
    }

    @Test
    fun `notification open scope allows resources without a legacy host`() {
        assertTrue(
            MobileNotificationOpenScopePolicy.hasRequiredScope(
                MobileNotificationTarget.AppResource(
                    appId = "tabdoc",
                    resourceId = "doc-1",
                    organizationId = "org-1",
                ),
            ),
        )
        assertTrue(
            MobileNotificationOpenScopePolicy.hasRequiredScope(
                MobileNotificationTarget.SharedResource(
                    id = "doc-1",
                    resourceType = "tabdoc",
                    organizationId = "org-1",
                ),
            ),
        )
    }

    @Test
    fun `notification open scope requires a workspace for chat even when project is present`() {
        assertFalse(
            MobileNotificationOpenScopePolicy.hasRequiredScope(
                MobileNotificationTarget.ChatSession(
                    id = "session-1",
                    projectId = "project-1",
                ),
            ),
        )
    }

    @Test
    fun `old chat space field is normalized only for the known workspace-backed target`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "agent.task.completed",
                legacyHostId = "legacy-workspace",
                metadata = buildJsonObject { put("session_id", "session-1") },
            ),
        ) as MobileNotificationTarget.ChatSession

        assertEquals("legacy-workspace", target.workspaceId)
        assertEquals(null, target.projectId)
    }

    @Test
    fun `non agent explicit chat legacy host never impersonates a workspace`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "tabdoc.comment.mention",
                legacyHostId = "legacy-project-host",
                navigateTo = buildJsonObject {
                    put("type", "chat-session")
                    put("id", "session-1")
                },
            ),
        ) as MobileNotificationTarget.ChatSession

        assertEquals(null, target.workspaceId)
        assertEquals(null, target.projectId)
        assertTrue(MobileNotificationChatSessionTargetResolver.requiresSessionScope(target))
    }

    @Test
    fun `tracker-origin agent notification overrides legacy chat target`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "agent.task.completed",
                organizationId = "org-1",
                workspaceId = "workspace-1",
                metadata = buildJsonObject {
                    put("notification_target", "tracker")
                    put("tracker_id", "tracker-1")
                    put("run_id", "run-1")
                },
                navigateTo = buildJsonObject {
                    put("type", "chat-session")
                    put("id", "run-transcript")
                },
            ),
        ) as MobileNotificationTarget.Tracker

        assertEquals("tracker-1", target.id)
        assertEquals("run-1", target.runId)
    }

    @Test
    fun `tracker notification derives tracker target from metadata`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "tracker.run.failed",
                metadata = buildJsonObject {
                    put("tracker_id", "tracker-1")
                    put("run_id", "run-1")
                    put("space_id", "space-2")
                },
            ),
        ) as MobileNotificationTarget.Tracker

        assertEquals("tracker-1", target.id)
        assertEquals("run-1", target.runId)
        assertEquals("space-2", target.workspaceId)
    }

    @Test
    fun `canonical tracker scope wins over conflicting legacy host`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "tracker.run.failed",
                legacyHostId = "legacy-host",
                metadata = buildJsonObject {
                    put("tracker_id", "tracker-1")
                    put("workspace_id", "workspace-1")
                    put("project_id", "project-1")
                    put("space_id", "metadata-legacy-host")
                },
            ),
        ) as MobileNotificationTarget.Tracker

        assertEquals("workspace-1", target.workspaceId)
        assertEquals("project-1", target.projectId)
    }

    @Test
    fun `removed shared resource is informational instead of navigating stale object`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "resource_shared",
                metadata = buildJsonObject {
                    put("action", "removed")
                    put("resource_type", "doc")
                    put("resource_id", "doc-1")
                },
            ),
        )

        assertSame(MobileNotificationTarget.Unsupported, target)
    }

    @Test
    fun `resource access request opens approval target`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "resource_access_request",
                title = "syt 申请查看资源",
                body = "syt 申请查看（viewer）《P0》",
                organizationId = "org-1",
                metadata = buildJsonObject {
                    put("request_id", "req-1")
                },
            ),
        ) as MobileNotificationTarget.ResourceAccessRequest

        assertEquals("req-1", target.requestId)
        assertEquals("syt 申请查看资源", target.title)
        assertEquals("syt 申请查看（viewer）《P0》", target.body)
        assertEquals("org-1", target.organizationId)
    }

    @Test
    fun `unknown notification without navigation metadata becomes informational`() {
        assertEquals(
            MobileNotificationTarget.Unsupported,
            MobileNotificationTargetResolver.resolve(item(type = "future.event")),
        )
    }

    @Test
    fun `notification panel target becomes informational`() {
        assertSame(
            MobileNotificationTarget.Unsupported,
            MobileNotificationTargetResolver.resolve(
                item(
                    type = "system",
                    navigateTo = buildJsonObject {
                        put("type", "notification-panel")
                        put("id", "bell")
                    },
                ),
            ),
        )
    }

    @Test
    fun `organization invitation opens the personal invitation inbox`() {
        assertSame(
            MobileNotificationTarget.Invitation,
            MobileNotificationTargetResolver.resolve(
                item(type = "organization.invitation", organizationId = "invited-org"),
            ),
        )
    }

    @Test
    fun `explicit im-conversation target carries title and message id`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "im.message.created",
                organizationId = "org-1",
                navigateTo = buildJsonObject {
                    put("type", "im-conversation")
                    put("id", "conv-1")
                    put("title", "产品讨论组")
                    put("messageId", "42")
                },
            ),
        ) as MobileNotificationTarget.ImConversation

        assertEquals("conv-1", target.id)
        assertEquals("产品讨论组", target.title)
        assertEquals("42", target.messageId)
        assertEquals("org-1", target.organizationId)
    }

    @Test
    fun `im notification falls back to conversation id from metadata`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "im.message.mention",
                organizationId = "org-2",
                metadata = buildJsonObject {
                    put("conversation_id", "conv-2")
                    put("conversation_name", "研发群")
                    put("message_id", "99")
                },
            ),
        ) as MobileNotificationTarget.ImConversation

        assertEquals("conv-2", target.id)
        assertEquals("研发群", target.title)
        assertEquals("99", target.messageId)
        assertEquals("org-2", target.organizationId)
    }

    @Test
    fun `im notification without conversation id is informational`() {
        assertSame(
            MobileNotificationTarget.Unsupported,
            MobileNotificationTargetResolver.resolve(item(type = "im.message.created")),
        )
    }

    @Test
    fun `tab inbox production and legacy notifications resolve the same app route`() {
        listOf("tabinbox.route", "tabinbox.received").forEach { type ->
            val target = MobileNotificationTargetResolver.resolve(
                item(
                    type = type,
                    organizationId = "org-1",
                    metadata = buildJsonObject { put("message_id", "message-1") },
                ),
            ) as MobileNotificationTarget.AppResource

            assertEquals("tabmail", target.appId)
            assertEquals("message/message-1", target.route)
            assertEquals("org-1", target.organizationId)
        }
    }

    @Test
    fun `completed tracker opens concrete artifact when app is supported`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "tracker.run.completed",
                organizationId = "org-1",
                workspaceId = "workspace-1",
                metadata = buildJsonObject {
                    put("tracker_id", "tracker-1")
                    put("skill_key", "tabdoc.summarize")
                    put("artifact_ref", buildJsonObject { put("docId", "doc-1") })
                },
            ),
        ) as MobileNotificationTarget.AppResource

        assertEquals("tabdoc", target.appId)
        assertEquals("doc-1", target.resourceId)
    }

    @Test
    fun `completed tracker artifact preserves an ambiguous legacy resource host`() {
        val target = MobileNotificationTargetResolver.resolve(
            item(
                type = "tracker.run.completed",
                organizationId = "org-1",
                legacyHostId = "legacy-resource-host",
                metadata = buildJsonObject {
                    put("tracker_id", "tracker-1")
                    put("tracker_event_status", "completed")
                    put("skill_key", "tabdoc.summarize")
                    put("artifact_ref", buildJsonObject { put("docId", "doc-1") })
                },
            ),
        ) as MobileNotificationTarget.AppResource

        assertEquals(null, target.workspaceId)
        assertEquals(null, target.projectId)
        assertEquals("legacy-resource-host", target.legacyHostId)
    }

    private fun item(
        type: String = "system",
        title: String = "title",
        body: String = "body",
        metadata: kotlinx.serialization.json.JsonObject = buildJsonObject {},
        organizationId: String = "",
        workspaceId: String? = null,
        projectId: String? = null,
        legacyHostId: String? = null,
        navigateTo: kotlinx.serialization.json.JsonObject? = null,
    ): NotificationItem = NotificationItem(
        id = "notification-1",
        type = type,
        title = title,
        body = body,
        metadata = metadata,
        organizationId = organizationId,
        workspaceId = workspaceId,
        projectId = projectId,
        legacyHostId = legacyHostId,
        navigateTo = navigateTo,
        createdAt = "2026-07-17T10:00:00Z",
    )
}
