package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.api.UploadScope

internal object ConversationAttachmentScopePolicy {
    fun resolve(
        sessionId: String,
        startsNewSession: Boolean,
        organizationId: String?,
        workspaceId: String?,
        projectId: String?,
    ): UploadScope? {
        val organization = organizationId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val contextId = if (!startsNewSession) {
            sessionId.trim().takeIf { it.isNotEmpty() } ?: return null
        } else {
            val workspace = workspaceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val project = projectId?.trim()?.takeIf { it.isNotEmpty() }
            listOfNotNull("draft", workspace, project).joinToString(":")
        }
        return UploadScope(
            module = "chat",
            contextType = "message",
            contextId = contextId,
            organizationId = organization,
            isPublic = false,
        )
    }
}
