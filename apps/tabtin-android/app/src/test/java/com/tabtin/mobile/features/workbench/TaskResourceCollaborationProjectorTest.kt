package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.CloudDocsCollaborator
import com.tabtin.mobile.data.model.CloudDocsCollaboratorsResponse
import com.tabtin.mobile.data.model.CloudDocsOwner
import org.junit.Assert.assertEquals
import org.junit.Test

class TaskResourceCollaborationProjectorTest {
    @Test
    fun `counts owner and editable collaborators without viewers or duplicates`() {
        val people = TaskResourceCollaborationProjector.project(
            CloudDocsCollaboratorsResponse(
                owner = CloudDocsOwner(
                    userId = "owner-1",
                    nickname = "Owner",
                ),
                collaborators = listOf(
                    CloudDocsCollaborator(
                        userId = "editor-1",
                        nickname = "Editor",
                        permission = "editor",
                    ),
                    CloudDocsCollaborator(
                        userId = "admin-1",
                        nickname = "Admin",
                        permission = "admin",
                    ),
                    CloudDocsCollaborator(
                        userId = "legacy-edit-1",
                        nickname = "Legacy",
                        permission = "edit",
                    ),
                    CloudDocsCollaborator(
                        userId = "viewer-1",
                        nickname = "Viewer",
                        permission = "viewer",
                    ),
                    CloudDocsCollaborator(
                        userId = "owner-1",
                        nickname = "Duplicate owner",
                        permission = "editor",
                    ),
                ),
            ),
        )

        assertEquals(listOf("owner-1", "editor-1", "admin-1", "legacy-edit-1"), people.map { it.id })
    }

    @Test
    fun `falls back to email and then collaborator label`() {
        val people = TaskResourceCollaborationProjector.project(
            CloudDocsCollaboratorsResponse(
                owner = CloudDocsOwner(userId = "owner-1", email = "owner@example.com"),
                collaborators = listOf(
                    CloudDocsCollaborator(userId = "editor-1", permission = "editor"),
                ),
            ),
        )

        assertEquals("owner@example.com", people[0].name)
        assertEquals("", people[1].name)
    }
}
