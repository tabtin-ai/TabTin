package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertEquals
import org.junit.Test

class WorkbenchResourceUrlTest {

    @Test
    fun `embedded resource URL carries the native theme`() {
        assertEquals(
            "https://web.example/docs/doc-1?shell=embedded&client=android&theme=dark",
            buildEmbeddedWorkbenchUrl("https://web.example/docs/doc-1", isDarkTheme = true),
        )
        assertEquals(
            "https://web.example/docs/doc-1?view=outline&shell=embedded&client=android&theme=light#heading",
            buildEmbeddedWorkbenchUrl(
                "https://web.example/docs/doc-1?view=outline#heading",
                isDarkTheme = false,
            ),
        )
    }

    @Test
    fun `resource URL keeps the full Organization and Space context when present`() {
        assertEquals(
            "https://web.example/organizations/org-1/spaces/space-1/docs/doc-1",
            buildWorkbenchUrl(
                webBaseUrl = "https://web.example/",
                organizationId = "org-1",
                spaceId = "space-1",
                target = target("tabdoc", "doc-1"),
            ),
        )
    }

    @Test
    fun `resource URL falls back to a Space-only route when Organization is absent`() {
        assertEquals(
            "https://web.example/spaces/space-1/tables/table-1",
            buildWorkbenchUrl(
                webBaseUrl = "https://web.example",
                organizationId = "",
                spaceId = "space-1",
                target = target("tabdata", "table-1"),
            ),
        )
    }

    @Test
    fun `organization-only resource URL falls back to the root route`() {
        assertEquals(
            "https://web.example/docs/doc-1",
            buildWorkbenchUrl(
                webBaseUrl = "https://web.example",
                organizationId = "org-1",
                spaceId = null,
                target = target("tabdoc", "doc-1"),
            ),
        )
    }

    private fun target(type: String, id: String) = WorkbenchWebTarget(
        resourceType = type,
        resourceId = id,
        title = "Resource",
    )
}
