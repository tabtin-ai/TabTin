package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.SpaceResource
import org.junit.Assert.assertEquals
import org.junit.Test

class TaskResourceLibraryProjectorTest {
    private val recent = resource(id = "recent", title = "最近表", lastVisitedAt = "2026-08-12T02:00:00Z")
    private val owned = resource(id = "owned", title = "全部表")
    private val shared = resource(id = "shared", title = "共享表")
    private val resources = listOf(recent, owned, shared)

    @Test
    fun `recent only contains visited resources`() {
        assertEquals(
            listOf("recent"),
            project(TaskResourceLibraryScope.RECENT).map { it.resourceId },
        )
    }

    @Test
    fun `all contains every resource except current continue item`() {
        assertEquals(
            setOf("owned", "shared"),
            project(
                scope = TaskResourceLibraryScope.ALL,
                excludingResourceId = "recent",
            ).map { it.resourceId }.toSet(),
        )
    }

    @Test
    fun `shared only contains resources from shared feed`() {
        assertEquals(
            listOf("shared"),
            project(TaskResourceLibraryScope.SHARED).map { it.resourceId },
        )
    }

    @Test
    fun `search can match all resources regardless of visible scope`() {
        assertEquals(
            listOf("owned"),
            project(
                scope = TaskResourceLibraryScope.ALL,
                searchQuery = "全部",
            ).map { it.resourceId },
        )
    }

    private fun project(
        scope: TaskResourceLibraryScope,
        searchQuery: String = "",
        excludingResourceId: String? = null,
    ): List<SpaceResource> = TaskResourceLibraryProjector.project(
        resources = resources,
        sharedResourceIds = setOf("shared"),
        scope = scope,
        searchQuery = searchQuery,
        excludingResourceId = excludingResourceId,
    )

    private fun resource(
        id: String,
        title: String,
        lastVisitedAt: String? = null,
    ) = SpaceResource(
        id = "context-$id",
        itemType = "tabdata",
        title = title,
        resourceId = id,
        lastVisitedAt = lastVisitedAt,
        updatedAt = "2026-08-11T02:00:00Z",
    )
}
