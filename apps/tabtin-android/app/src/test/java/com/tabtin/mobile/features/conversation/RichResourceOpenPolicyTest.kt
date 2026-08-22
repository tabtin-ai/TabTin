package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RichResourceOpenPolicyTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `canonical nested resource resolves to a workbench request`() {
        val block = json.decodeFromString<BlockItem>(
            """
            {
              "type": "tabtin_rich_content",
              "kind": "resource_ref",
              "summary": "项目周报",
              "payload": {
                "artifact_kind": "platform_resource",
                "resource_type": "document",
                "resource_id": "doc-001",
                "resource_name": "项目周报",
                "location_hint": "产品空间"
              }
            }
            """.trimIndent(),
        )

        assertEquals(
            WorkbenchResourceOpenRequest(
                resourceType = "tabdoc",
                resourceId = "doc-001",
                title = "项目周报",
                locationHint = "产品空间",
            ),
            resolveRichResourceOpenRequest(block),
        )
    }

    @Test
    fun `task workbench sink wins over external deep link fallback`() {
        val request = WorkbenchResourceOpenRequest(
            resourceType = "tabdata",
            resourceId = "table-001",
            title = "发布清单",
        )
        var openedInWorkbench: WorkbenchResourceOpenRequest? = null
        var openedAsDeepLink = false

        dispatchRichResourceOpen(
            request = request,
            onOpenInWorkbench = { openedInWorkbench = it },
            onOpenWithDeepLink = { openedAsDeepLink = true },
        )

        assertEquals(request, openedInWorkbench)
        assertFalse(openedAsDeepLink)
    }

    @Test
    fun `cross organization falls back while same organization shared space stays in workbench`() {
        val block = BlockItem(
            type = "tabtin_rich_content",
            kind = "resource_ref",
            resourceType = "tabdoc",
            resourceId = "doc-001",
            spaceId = "other-space",
            organizationId = "other-org",
        )

        assertFalse(
            canOpenRichResourceInCurrentTask(
                block = block,
                currentSpaceId = "current-space",
                currentOrganizationId = "current-org",
            ),
        )
        assertTrue(
            canOpenRichResourceInCurrentTask(
                block = block.copy(organizationId = "current-org"),
                currentSpaceId = "current-space",
                currentOrganizationId = "current-org",
            ),
        )
        assertFalse(
            canOpenRichResourceInCurrentTask(
                block = block.copy(organizationId = null, workspaceId = "other-org"),
                currentSpaceId = "current-space",
                currentOrganizationId = "current-org",
            ),
        )
    }

    @Test
    fun `non native resource keeps the external deep link path`() {
        val block = BlockItem(
            type = "tabtin_rich_content",
            kind = "resource_ref",
            resourceType = "tabfiles",
            resourceId = "file-001",
            organizationId = "current-org",
        )

        assertFalse(
            canOpenRichResourceInCurrentTask(
                block = block,
                currentSpaceId = "current-space",
                currentOrganizationId = "current-org",
            ),
        )
    }
}
