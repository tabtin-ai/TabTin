package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.features.files.CloudDriveFileCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskWorkbenchFilePresentationTest {

    @Test
    fun `tabfiles card follows cloud drive file category`() {
        val snapshot = TaskWorkbenchProjector.project(
            messages = listOf(
                ChatMessage(
                    id = "m-files",
                    role = "assistant",
                    blocksJson = listOf(
                        BlockItem(
                            type = "rich_content",
                            kind = "file",
                            filename = "周报.pdf",
                            fileId = "file-pdf",
                            artifactKind = "oss_file",
                            mimeType = "application/pdf",
                        ),
                        BlockItem(
                            type = "rich_content",
                            kind = "image",
                            filename = "封面.pdf",
                            fileId = "file-image",
                            artifactKind = "oss_file",
                            mimeType = "image/png",
                        ),
                        BlockItem(
                            type = "rich_content",
                            kind = "file",
                            filename = "notes.md",
                            fileId = "file-text",
                            artifactKind = "oss_file",
                        ),
                    ),
                    createdAt = "2026-08-20T04:00:00Z",
                ),
            ),
            resources = emptyList(),
        )

        assertEquals(
            CloudDriveFileCategory.PDF,
            TaskWorkbenchFilePresentation.category(snapshot.outputs.first { it.resourceId == "file-pdf" }),
        )
        assertEquals(
            CloudDriveFileCategory.IMAGE,
            TaskWorkbenchFilePresentation.category(snapshot.outputs.first { it.resourceId == "file-image" }),
        )
        assertEquals(
            CloudDriveFileCategory.TEXT,
            TaskWorkbenchFilePresentation.category(snapshot.outputs.first { it.resourceId == "file-text" }),
        )
        assertEquals("application/pdf", snapshot.outputs.first { it.resourceId == "file-pdf" }.mimeType)
        val imageRow = TaskWorkbenchFilePresentation.viewportRow(
            snapshot.outputs.first { it.resourceId == "file-image" },
            organizationId = "org-1",
        )
        assertEquals("file-image", imageRow.fileRecordId)
        assertEquals("image/png", imageRow.mimeType)
        assertEquals("org-1", imageRow.organizationId)
    }

    @Test
    fun `non file outputs stay on app icons`() {
        val output = TaskWorkbenchOutput(
            id = "tabdoc:doc-1",
            resourceType = "tabdoc",
            resourceId = "doc-1",
            title = "计划",
            preview = null,
            timestampMs = 0L,
            resource = null,
            openRequest = WorkbenchResourceOpenRequest(
                resourceType = "tabdoc",
                resourceId = "doc-1",
                title = "计划",
            ),
        )
        assertNull(TaskWorkbenchFilePresentation.category(output))
    }
}
