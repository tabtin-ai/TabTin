package com.tabtin.mobile.features.notification

import com.tabtin.mobile.data.model.NotificationItem
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

internal enum class NotificationCategory {
    AGENT,
    COLLABORATION,
    ORGANIZATION,
    SYSTEM,
}

internal enum class NotificationFilter {
    ALL,
    PENDING,
    AGENT,
    COLLABORATION,
    ORGANIZATION,
    SYSTEM,
}

internal enum class NotificationSource {
    AGENT,
    TRACKER,
    CHAT,
    DOC,
    DATA,
    MAIL,
    INBOX,
    SHARED_RESOURCE,
    ORGANIZATION,
    EXTENSION,
    SYSTEM,
}

internal enum class NotificationContextKind {
    PROJECT,
    WORKSPACE,
}

internal data class NotificationContext(
    val kind: NotificationContextKind,
    val name: String,
)

internal object NotificationPresentationPolicy {
    private val actionableTypes = setOf(
        "agent.hitl.waiting",
        "agent.task.error",
        "tracker.run.failed",
        "resource_access_request",
        "organization.invitation",
        "invite_received",
    )

    fun category(item: NotificationItem): NotificationCategory {
        val type = item.type.trim().lowercase()
        return when {
            type.startsWith("agent.") || type.startsWith("tracker.") -> NotificationCategory.AGENT
            type.startsWith("im.") ||
                type.startsWith("tabdoc.") ||
                type.startsWith("tabdata.") ||
                type == "resource_shared" ||
                type == "resource_access_request" ||
                type == "tabmail.received" ||
                type == "tabinbox.route" ||
                type == "tabinbox.received" -> NotificationCategory.COLLABORATION
            type.startsWith("organization.") ||
                type.startsWith("team_space.") ||
                type.startsWith("invite_") ||
                type.startsWith("member_") ||
                type == "role_changed" ||
                type == "ownership_transfer" -> NotificationCategory.ORGANIZATION
            else -> NotificationCategory.SYSTEM
        }
    }

    fun needsAction(item: NotificationItem): Boolean {
        val type = item.type.trim().lowercase()
        return !isResolved(item) &&
            (type in actionableTypes || item.priority?.trim()?.lowercase() == "urgent")
    }

    fun hasPendingResourceAccessRequest(items: List<NotificationItem>, requestId: String): Boolean =
        items.any { item ->
            item.type.trim().lowercase() == "resource_access_request" &&
                item.metadata.string("request_id", "requestId") == requestId &&
                !isResolved(item)
        }

    fun filter(items: List<NotificationItem>, filter: NotificationFilter): List<NotificationItem> =
        items.filter { item ->
            when (filter) {
                NotificationFilter.ALL -> true
                NotificationFilter.PENDING -> needsAction(item)
                NotificationFilter.AGENT -> category(item) == NotificationCategory.AGENT
                NotificationFilter.COLLABORATION -> category(item) == NotificationCategory.COLLABORATION
                NotificationFilter.ORGANIZATION -> category(item) == NotificationCategory.ORGANIZATION
                NotificationFilter.SYSTEM -> category(item) == NotificationCategory.SYSTEM
            }
        }

    fun source(item: NotificationItem): NotificationSource {
        val type = item.type.trim().lowercase()
        return when {
            type.startsWith("agent.") -> NotificationSource.AGENT
            type.startsWith("tracker.") -> NotificationSource.TRACKER
            type.startsWith("im.") -> NotificationSource.CHAT
            type.startsWith("tabdoc.") -> NotificationSource.DOC
            type.startsWith("tabdata.") -> NotificationSource.DATA
            type == "tabmail.received" -> NotificationSource.MAIL
            type == "tabinbox.route" || type == "tabinbox.received" -> NotificationSource.INBOX
            type == "resource_shared" || type == "resource_access_request" -> when (
                item.metadata.string("resource_type", "resourceType")?.lowercase()
            ) {
                "doc", "document", "tabdoc" -> NotificationSource.DOC
                "table", "tabdata" -> NotificationSource.DATA
                else -> NotificationSource.SHARED_RESOURCE
            }
            category(item) == NotificationCategory.ORGANIZATION -> NotificationSource.ORGANIZATION
            type == "extension_event" || !item.sourceExtensionId.isNullOrBlank() -> NotificationSource.EXTENSION
            else -> NotificationSource.SYSTEM
        }
    }

    fun context(
        item: NotificationItem,
        projectNamesById: Map<String, String> = emptyMap(),
        workspaceNamesById: Map<String, String> = emptyMap(),
    ): NotificationContext? {
        (item.projectName.normalized() ?: item.metadata.string("project_name", "projectName"))?.let { name ->
            return NotificationContext(NotificationContextKind.PROJECT, name)
        }
        if (item.type.trim().lowercase().startsWith("team_space.")) {
            item.metadata.string("space_name", "spaceName")?.let { name ->
                return NotificationContext(NotificationContextKind.PROJECT, name)
            }
        }
        (item.workspaceName.normalized() ?: item.metadata.string("workspace_name", "workspaceName"))?.let { name ->
            return NotificationContext(NotificationContextKind.WORKSPACE, name)
        }
        val projectId = item.projectId.normalized()
            ?: item.metadata.string("project_id", "projectId")
        projectId?.let(projectNamesById::get).normalized()?.let { name ->
            return NotificationContext(NotificationContextKind.PROJECT, name)
        }
        val workspaceId = item.workspaceId.normalized()
            ?: item.metadata.string("workspace_id", "workspaceId")
        workspaceId?.let(workspaceNamesById::get).normalized()?.let { name ->
            return NotificationContext(NotificationContextKind.WORKSPACE, name)
        }
        return null
    }

    fun displayTitle(item: NotificationItem): String = normalizeLegacyProjectCopy(item, item.title)

    fun displayBody(item: NotificationItem): String = normalizeLegacyProjectCopy(item, item.body)

    private fun isResolved(item: NotificationItem): Boolean =
        item.metadata.boolean("resolved") == true ||
            item.metadata.string("behavior")?.lowercase() == "notification_only"

    private fun normalizeLegacyProjectCopy(item: NotificationItem, value: String): String {
        if (!item.type.trim().lowercase().startsWith("team_space.")) return value
        return value
            .replace("团队 Space", "项目")
            .replace("团队空间", "项目")
            .replace("项目房间", "项目")
            .replace("Team Space", "Project", ignoreCase = true)
            .replace("project room", "project", ignoreCase = true)
    }
}

private fun String?.normalized(): String? = this?.trim()?.takeIf(String::isNotEmpty)

private fun kotlinx.serialization.json.JsonObject.string(vararg keys: String): String? {
    for (key in keys) {
        val value = this[key]?.jsonPrimitive?.contentOrNull?.trim()
        if (!value.isNullOrEmpty()) return value
    }
    return null
}

private fun kotlinx.serialization.json.JsonObject.boolean(vararg keys: String): Boolean? {
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
