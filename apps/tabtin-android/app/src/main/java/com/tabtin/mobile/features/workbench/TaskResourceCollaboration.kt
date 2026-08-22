package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.CloudDocsCollaboratorsResponse

internal data class TaskResourceCollaborationPerson(
    val id: String,
    val name: String,
    val avatarUrl: String?,
)

internal sealed interface TaskResourceCollaborationState {
    data object Idle : TaskResourceCollaborationState
    data object Loading : TaskResourceCollaborationState
    data class Loaded(val people: List<TaskResourceCollaborationPerson>) : TaskResourceCollaborationState
    data object Unavailable : TaskResourceCollaborationState
}

internal object TaskResourceCollaborationProjector {
    fun project(response: CloudDocsCollaboratorsResponse): List<TaskResourceCollaborationPerson> {
        val seen = mutableSetOf<String>()
        return buildList {
            response.owner.userId.trim().takeIf { it.isNotEmpty() }?.let { userId ->
                seen += userId
                add(
                    TaskResourceCollaborationPerson(
                        id = userId,
                        name = displayName(response.owner.nickname, response.owner.email),
                        avatarUrl = response.owner.avatar,
                    ),
                )
            }
            response.collaborators.forEach { collaborator ->
                val permission = collaborator.permission.trim().lowercase()
                val userId = collaborator.userId.trim()
                if (permission !in EDITABLE_PERMISSIONS || userId.isEmpty() || !seen.add(userId)) {
                    return@forEach
                }
                add(
                    TaskResourceCollaborationPerson(
                        id = userId,
                        name = displayName(collaborator.nickname, collaborator.email),
                        avatarUrl = collaborator.avatar,
                    ),
                )
            }
        }
    }

    private fun displayName(nickname: String, email: String): String =
        nickname.trim().takeIf { it.isNotEmpty() }
            ?: email.trim().takeIf { it.isNotEmpty() }
            ?: ""

    private val EDITABLE_PERMISSIONS: Set<String> = setOf("admin", "editor", "edit")
}

internal fun taskResourceCollaborationKey(kind: WorkbenchAppHomeKind, resourceId: String): String =
    "${kind.appId}:${resourceId.trim()}"
