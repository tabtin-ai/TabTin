package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResourceReferenceTest {

    @Test
    fun `TabMemo reference carries its memo id in the context block`() {
        val reference = ResourceReference.from(
            SpaceResource(
                id = "resource-1",
                itemType = "tabmemo",
                resourceId = "memo-20260723",
                spaceId = "workspace-1",
                title = "AndroidMemo20260723",
            ),
        )

        val block = reference.toMessageBlock()

        assertNotNull(block)
        assertEquals("memo", block?.type)
        assertEquals("memo-20260723", block?.memoId)
        assertEquals("AndroidMemo20260723", block?.preview)
    }

    @Test
    fun `TabFiles reference encodes FileRecordID as type file with file_id`() {
        val reference = ResourceReference.from(
            SpaceResource(
                id = "ci-tabfiles-1",
                itemType = "tabfiles",
                resourceId = "fr-084aa15a",
                title = "spec.pdf",
                spaceId = "workspace-1",
            ),
        )

        val block = reference.toMessageBlock()

        assertNotNull(block)
        assertEquals("file", block?.type)
        assertEquals("fr-084aa15a", block?.fileId)
        assertEquals("spec.pdf", block?.filename)
        assertEquals("spec.pdf", block?.preview)
        assertTrue(reference.canSendToConversation)
    }

    @Test
    fun `folder reference never produces a sendable message block`() {
        val reference = ResourceReference(
            id = "folder-1",
            resourceId = "folder-1",
            normalizedType = "folder",
            resourceType = "Folder",
            title = "Notes",
            emoji = "📁",
        )

        assertNull(reference.toMessageBlock())
        assertFalse(reference.canSendToConversation)
    }

    @Test
    fun `fromCloudDriveRow uses fileRecordId for tabfiles not contextItemId`() {
        val row = CloudDriveResourceRow(
            contextItemId = "ci-9",
            resourceId = "fr-9",
            fileRecordId = "fr-9",
            itemType = "tabfiles",
            title = "deck.pptx",
            preview = null,
            collectionId = null,
            organizationId = "org-1",
            spaceId = null,
            spaceName = null,
            owner = null,
            metadata = null,
            isPinned = false,
            lastVisitedAt = null,
            updatedAt = null,
            canView = true,
            canEdit = true,
            canMove = true,
            canShare = true,
            canTrash = true,
            canDelete = false,
        )

        val reference = ResourceReference.fromCloudDriveRow(row)
        assertNotNull(reference)
        assertEquals("ci-9", reference?.id)
        assertEquals("fr-9", reference?.resourceId)
        assertEquals("file", reference?.toMessageBlock()?.type)
        assertEquals("fr-9", reference?.toMessageBlock()?.fileId)
    }
}
