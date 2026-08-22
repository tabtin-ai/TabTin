package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.Space
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NewTaskWorkspacePolicyTest {

    private fun workspace(id: String, isDefault: Boolean? = null) = Space(
        id = id,
        organizationId = "org-1",
        name = id,
        type = "workspace",
        isDefault = isDefault,
    )

    @Test
    fun `selected workspace wins over recent and default`() {
        val selected = workspace("selected")
        val recent = workspace("recent")
        val fallback = workspace("default", isDefault = true)

        assertEquals(
            "selected",
            NewTaskWorkspacePolicy.resolve(
                workspaces = listOf(recent, fallback, selected),
                selectedWorkspaceId = "selected",
                recentWorkspaceId = "recent",
            )?.id,
        )
    }

    @Test
    fun `recent then default then first are used as stable fallbacks`() {
        val first = workspace("first")
        val recent = workspace("recent")
        val fallback = workspace("default", isDefault = true)

        assertEquals(
            "recent",
            NewTaskWorkspacePolicy.resolve(
                workspaces = listOf(first, fallback, recent),
                selectedWorkspaceId = null,
                recentWorkspaceId = "recent",
            )?.id,
        )
        assertEquals(
            "default",
            NewTaskWorkspacePolicy.resolve(
                workspaces = listOf(first, fallback),
                selectedWorkspaceId = null,
                recentWorkspaceId = null,
            )?.id,
        )
        assertEquals(
            "first",
            NewTaskWorkspacePolicy.resolve(
                workspaces = listOf(first),
                selectedWorkspaceId = null,
                recentWorkspaceId = null,
            )?.id,
        )
    }

    @Test
    fun `no execution workspace does not produce a target`() {
        assertNull(
            NewTaskWorkspacePolicy.resolve(
                workspaces = emptyList(),
                selectedWorkspaceId = null,
                recentWorkspaceId = null,
            ),
        )
    }

    @Test
    fun `launch without an execution workspace dispatches user feedback`() {
        var openedWorkspaceId: String? = null
        var unavailableCount = 0

        NewTaskWorkspacePolicy.dispatchLaunch(
            requestedWorkspace = null,
            workspaces = emptyList(),
            onResolved = { openedWorkspaceId = it.id },
            onUnavailable = { unavailableCount += 1 },
        )

        assertNull(openedWorkspaceId)
        assertEquals(1, unavailableCount)
    }
}
