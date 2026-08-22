package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
public data class NotificationItem(
    val id: String,
    val type: String = "system",
    val title: String = "",
    val body: String = "",
    val metadata: JsonObject = JsonObject(emptyMap()),
    @SerialName("organization_id") val organizationId: String = "",
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    /** 旧 wire `space_id` 语义多义，只在最终旧导航适配时作为未知宿主回退。 */
    @SerialName("space_id") val legacyHostId: String? = null,
    @SerialName("workspace_name") val workspaceName: String? = null,
    @SerialName("project_name") val projectName: String? = null,
    val priority: String? = null,
    val category: String? = null,
    @SerialName("source_extension_id") val sourceExtensionId: String? = null,
    @SerialName("navigate_to") val navigateTo: JsonObject? = null,
    @SerialName("is_read") val isRead: Boolean = false,
    @SerialName("read_at") val readAt: String? = null,
    @SerialName("created_at") val createdAt: String = "",
)

/** Agent 会话页的初始标题应使用通知副标题；通知标题描述的是事件本身。 */
public val NotificationItem.conversationTitle: String
    get() = body.trim().ifEmpty { title }

@Serializable
public data class NotificationListResponse(
    val items: List<NotificationItem> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val limit: Int = 20,
)

@Serializable public data class NotificationUnreadCountResponse(val count: Int = 0)
@Serializable public data class NotificationMarkAllResponse(val count: Int = 0)

public sealed interface MobileNotificationTarget {
    public val organizationId: String?

    public data class ChatSession(
        val id: String,
        val messageId: String? = null,
        override val organizationId: String? = null,
        val workspaceId: String? = null,
        val projectId: String? = null,
    ) : MobileNotificationTarget

    public data class Tracker(
        val id: String,
        val runId: String? = null,
        override val organizationId: String? = null,
        val workspaceId: String? = null,
        val projectId: String? = null,
    ) : MobileNotificationTarget

    /** TabChat IM 会话（`im.*` 通知），[id] 为 conversationId。 */
    public data class ImConversation(
        val id: String,
        val title: String? = null,
        val messageId: String? = null,
        override val organizationId: String? = null,
    ) : MobileNotificationTarget

    public data class AppResource(
        val appId: String,
        val resourceId: String? = null,
        val route: String? = null,
        override val organizationId: String? = null,
        val workspaceId: String? = null,
        val projectId: String? = null,
        val legacyHostId: String? = null,
    ) : MobileNotificationTarget

    public data class SharedResource(
        val id: String,
        val resourceType: String,
        val resourceTitle: String? = null,
        override val organizationId: String? = null,
        val workspaceId: String? = null,
        val projectId: String? = null,
        val legacyHostId: String? = null,
    ) : MobileNotificationTarget

    public data class ResourceAccessRequest(
        val requestId: String,
        val title: String,
        val body: String,
        override val organizationId: String? = null,
    ) : MobileNotificationTarget

    public data object Invitation : MobileNotificationTarget {
        override val organizationId: String? = null
    }

    public data object ProfileSettings : MobileNotificationTarget {
        override val organizationId: String? = null
    }

    public data object NotificationPanel : MobileNotificationTarget {
        override val organizationId: String? = null
    }

    public data object Unsupported : MobileNotificationTarget {
        override val organizationId: String? = null
    }
}

/**
 * 通知目标打开所需的最小上下文。资源宿主只是可选展示/导航提示；Chat 则必须拿到
 * 执行 Workspace，不能把 Project id 填进旧 Chat 路由的 `spaceId` 参数。
 */
public object MobileNotificationOpenScopePolicy {
    public fun hasRequiredScope(target: MobileNotificationTarget): Boolean = when (target) {
        is MobileNotificationTarget.ChatSession -> !target.workspaceId.isNullOrBlank()
        is MobileNotificationTarget.AppResource ->
            !target.organizationId.isNullOrBlank() && !target.resourceId.isNullOrBlank()
        is MobileNotificationTarget.SharedResource -> !target.organizationId.isNullOrBlank()
        else -> true
    }
}

public object MobileNotificationTargetResolver {
    public fun resolve(item: NotificationItem): MobileNotificationTarget? {
        val scope = itemScope(item)
        trackerTarget(item, scope)?.let { return it }
        val explicit = item.navigateTo ?: item.metadata.objectValue("navigate_to")
        if (explicit != null) {
            explicitTarget(explicit, scope, item.type)?.let { return it }
        }

        if (item.type == "organization.invitation") return MobileNotificationTarget.Invitation

        if (item.type == "resource_access_request") {
            if (
                item.metadata.boolean("resolved") == true ||
                item.metadata.string("behavior")?.lowercase() == "notification_only"
            ) {
                return MobileNotificationTarget.Unsupported
            }
            val requestId = item.metadata.string("request_id", "requestId")
            if (requestId != null) {
                return MobileNotificationTarget.ResourceAccessRequest(
                    requestId = requestId,
                    title = item.title,
                    body = item.body,
                    organizationId = scope.organizationId,
                )
            }
            return MobileNotificationTarget.Unsupported
        }

        // TabChat IM：navigate_to 缺失时按 metadata.conversation_id 回落（对齐 iOS）。
        if (item.type.startsWith("im.")) {
            val conversationId = item.metadata.string("conversation_id", "conversationId")
            if (conversationId != null) {
                return MobileNotificationTarget.ImConversation(
                    id = conversationId,
                    title = item.metadata.string("conversation_name", "title"),
                    messageId = item.metadata.string("message_id", "messageId"),
                    organizationId = scope.organizationId,
                )
            }
        }

        val sessionId = item.metadata.string("session_id", "sessionId")
        if (sessionId != null && item.type.startsWith("agent.")) {
            val chatScope = scope.asWorkspaceBacked()
            return MobileNotificationTarget.ChatSession(
                id = sessionId,
                messageId = item.metadata.string("message_id", "messageId"),
                organizationId = chatScope.organizationId,
                workspaceId = chatScope.workspaceId,
                projectId = chatScope.projectId,
            )
        }

        if (item.type == "tabmail.received" ||
            item.type == "tabinbox.route" ||
            item.type == "tabinbox.received"
        ) {
            val messageId = item.metadata.string("message_id", "messageId")
            val threadId = item.metadata.string("thread_id", "threadId")
            val route = when {
                messageId != null -> "message/$messageId"
                threadId != null -> "thread/$threadId"
                else -> null
            }
            return MobileNotificationTarget.AppResource(
                appId = "tabmail",
                route = route,
                organizationId = scope.organizationId,
                workspaceId = scope.workspaceId,
                projectId = scope.projectId,
                legacyHostId = scope.legacyHostId,
            )
        }

        if (item.type == "resource_shared") {
            val action = item.metadata.string("action")
            if (action in setOf("removed", "auto_removed", "auto_removed_summary", "owner_reassigned_summary")) {
                return MobileNotificationTarget.Unsupported
            }
            val resourceType = item.metadata.string("resource_type") ?: return MobileNotificationTarget.Unsupported
            val resourceId = item.metadata.string("resource_id") ?: return MobileNotificationTarget.Unsupported
            return MobileNotificationTarget.SharedResource(
                id = resourceId,
                resourceType = resourceType,
                resourceTitle = item.metadata.string("resource_title"),
                organizationId = scope.organizationId,
                workspaceId = scope.workspaceId,
                projectId = scope.projectId,
                legacyHostId = scope.legacyHostId,
            )
        }

        if (item.type == "extension_event") return MobileNotificationTarget.ProfileSettings
        return MobileNotificationTarget.Unsupported
    }

    /**
     * Tracker 运行的底层 Agent 也会发出 done/error。服务端会在这种通知上写入
     * notification_target=tracker；它必须压过历史 chat-session navigate_to，
     * 否则用户会进入仅供审计的运行 transcript，而不是任务详情。
     */
    private fun trackerTarget(
        item: NotificationItem,
        scope: NotificationScope,
    ): MobileNotificationTarget? {
        val trackerId = item.metadata.string("tracker_id", "trackerId") ?: return null
        val isTrackerNotification = item.type.startsWith("tracker.run.") ||
            item.metadata.string("notification_target") == "tracker"
        if (!isTrackerNotification) return null

        if (item.type.startsWith("tracker.run.")) {
            val status = item.metadata.string("tracker_event_status")
                ?: if (item.type == "tracker.run.completed") "completed" else null
            val artifact = item.metadata.objectValue("artifact_ref") ?: item.metadata.objectValue("artifactRef")
            val appId = artifactAppId(item.metadata.string("skill_key"))
            val resourceId = artifactResourceId(artifact)
            if (status == "completed" && appId != null && resourceId != null) {
                return MobileNotificationTarget.AppResource(
                    appId = appId,
                    resourceId = resourceId,
                    organizationId = scope.organizationId,
                    workspaceId = scope.workspaceId,
                    projectId = scope.projectId,
                    legacyHostId = scope.legacyHostId,
                )
            }
        }
        val trackerScope = scope.asWorkspaceBacked()
        return MobileNotificationTarget.Tracker(
            id = trackerId,
            runId = item.metadata.string("run_id", "runId"),
            organizationId = trackerScope.organizationId,
            workspaceId = trackerScope.workspaceId,
            projectId = trackerScope.projectId,
        )
    }

    private fun explicitTarget(
        raw: JsonObject,
        fallbackScope: NotificationScope,
        notificationType: String,
    ): MobileNotificationTarget? {
        val type = raw.string("type") ?: return null
        val id = raw.string("id") ?: return null
        val rawScope = explicitScope(raw, fallbackScope)
        return when (type) {
            "chat-session" -> {
                val scope = if (notificationType.normalized()?.startsWith("agent.") == true) {
                    rawScope.asWorkspaceBacked()
                } else {
                    rawScope
                }
                MobileNotificationTarget.ChatSession(
                    id = id,
                    messageId = raw.string("messageId", "message_id"),
                    organizationId = scope.organizationId,
                    workspaceId = scope.workspaceId,
                    projectId = scope.projectId,
                )
            }
            "tracker" -> rawScope.asWorkspaceBacked().let { scope ->
                MobileNotificationTarget.Tracker(
                    id = id,
                    runId = raw.string("runId", "run_id"),
                    organizationId = scope.organizationId,
                    workspaceId = scope.workspaceId,
                    projectId = scope.projectId,
                )
            }
            "im-conversation" -> MobileNotificationTarget.ImConversation(
                id = id,
                title = raw.string("title"),
                messageId = raw.string("messageId", "message_id"),
                organizationId = rawScope.organizationId,
            )
            "agentspace-app", "extension" -> MobileNotificationTarget.AppResource(
                appId = id,
                resourceId = artifactResourceId(raw.objectValue("artifactRef") ?: raw.objectValue("artifact_ref")),
                route = raw.string("route"),
                organizationId = rawScope.organizationId,
                workspaceId = rawScope.workspaceId,
                projectId = rawScope.projectId,
                legacyHostId = rawScope.legacyHostId,
            )
            "resource-shared" -> {
                val resourceType = raw.string("resourceType", "resource_type") ?: return null
                MobileNotificationTarget.SharedResource(
                    id = id,
                    resourceType = resourceType,
                    resourceTitle = raw.string("resourceTitle", "resource_title"),
                    organizationId = rawScope.organizationId,
                    workspaceId = rawScope.workspaceId,
                    projectId = rawScope.projectId,
                    legacyHostId = rawScope.legacyHostId,
                )
            }
            "settings" -> MobileNotificationTarget.ProfileSettings
            // 通知中心内点击 notification-panel 没有新的页面可打开，按信息通知反馈。
            "notification-panel" -> MobileNotificationTarget.Unsupported
            else -> MobileNotificationTarget.Unsupported
        }
    }

    private fun itemScope(item: NotificationItem): NotificationScope {
        val workspaceId = item.workspaceId.normalized()
            ?: item.metadata.string("workspace_id", "workspaceId")
        val projectId = item.projectId.normalized()
            ?: item.metadata.string("project_id", "projectId")
        val legacyHostId = if (workspaceId == null && projectId == null) {
            item.legacyHostId.normalized() ?: item.metadata.string("space_id", "spaceId")
        } else {
            null
        }
        return NotificationScope(
            organizationId = item.organizationId.normalized()
                ?: item.metadata.string("organization_id", "organizationId"),
            workspaceId = workspaceId,
            projectId = projectId,
            legacyHostId = legacyHostId,
        )
    }

    private fun explicitScope(raw: JsonObject, fallback: NotificationScope): NotificationScope {
        val workspaceId = raw.string("workspaceId", "workspace_id") ?: fallback.workspaceId
        val projectId = raw.string("projectId", "project_id") ?: fallback.projectId
        val legacyHostId = if (workspaceId == null && projectId == null) {
            raw.string("spaceId", "space_id") ?: fallback.legacyHostId
        } else {
            null
        }
        return NotificationScope(
            organizationId = raw.string("organizationId", "organization_id") ?: fallback.organizationId,
            workspaceId = workspaceId,
            projectId = projectId,
            legacyHostId = legacyHostId,
        )
    }

    private fun artifactResourceId(raw: JsonObject?): String? {
        if (raw == null) return null
        for (key in listOf("artifactId", "memoId", "docId", "slideId", "tableId", "codePath")) {
            raw.string(key)?.let { return it }
        }
        return null
    }

    private fun artifactAppId(skillKey: String?): String? {
        val normalized = skillKey?.trim()?.lowercase()?.takeIf(String::isNotEmpty) ?: return null
        val candidate = normalized.substringBefore('.').substringBefore('-')
        return candidate.takeIf {
            it in setOf("tabdoc", "tabdata", "tabslide", "tabmemo", "tabsite", "tabfiles")
        }
    }
}

/**
 * 旧 Agent 通知可能没有保存执行 Workspace。已有会话的详情是冻结执行范围的
 * 权威来源，因此仅在通知缺 scope 时以 `workspace_id` 补齐聊天路由。
 */
public object MobileNotificationChatSessionTargetResolver {
    public fun resolve(
        target: MobileNotificationTarget.ChatSession,
        session: ChatSession,
    ): MobileNotificationTarget.ChatSession? {
        val workspaceId = session.workspaceId?.trim()?.takeIf(String::isNotEmpty) ?: return null
        return target.copy(
            organizationId = session.organizationId?.trim()?.takeIf(String::isNotEmpty)
                ?: target.organizationId,
            workspaceId = workspaceId,
            projectId = session.projectId?.trim()?.takeIf(String::isNotEmpty) ?: target.projectId,
        )
    }

    public fun requiresSessionScope(target: MobileNotificationTarget.ChatSession): Boolean =
        target.workspaceId.isNullOrBlank()
}

private data class NotificationScope(
    val organizationId: String?,
    val workspaceId: String?,
    val projectId: String?,
    val legacyHostId: String?,
)

private fun NotificationScope.asWorkspaceBacked(): NotificationScope =
    if (workspaceId == null && projectId == null && legacyHostId != null) {
        copy(workspaceId = legacyHostId, legacyHostId = null)
    } else {
        this
    }

private fun String?.normalized(): String? = this?.trim()?.takeIf(String::isNotEmpty)

private fun JsonObject.string(vararg keys: String): String? {
    for (key in keys) {
        val value = this[key]?.jsonPrimitive?.contentOrNull?.trim()
        if (!value.isNullOrEmpty()) return value
    }
    return null
}

private fun JsonObject.boolean(vararg keys: String): Boolean? {
    for (key in keys) {
        val primitive = this[key]?.jsonPrimitive ?: continue
        primitive.booleanOrNull?.let { return it }
        when (primitive.contentOrNull?.trim()?.lowercase()) {
            "true" -> return true
            "false" -> return false
        }
    }
    return null
}

private fun JsonObject.objectValue(key: String): JsonObject? =
    this[key]?.let { runCatching { it.jsonObject }.getOrNull() }
