package com.tabtin.mobile.features.files

import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveContracts
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudDriveResumeSelectorTest {
    @Test
    fun `selects the resource with the newest real visit timestamp`() {
        val selected = selectCloudDriveResumeItem(
            listOf(
                row("updated-only", lastVisitedAt = null, updatedAt = "2026-08-12T09:00:00Z"),
                row("older", lastVisitedAt = "2026-08-10T09:00:00Z"),
                row("newer", lastVisitedAt = "2026-08-11T09:00:00Z"),
            ),
        )

        assertEquals("newer", selected?.resourceId)
    }

    @Test
    fun `returns null when no valid visit timestamp exists`() {
        assertNull(
            selectCloudDriveResumeItem(
                listOf(
                    row("missing", lastVisitedAt = null),
                    row("invalid", lastVisitedAt = "yesterday"),
                ),
            ),
        )
    }

    @Test
    fun `ignores a newer resource that is no longer viewable`() {
        val selected = selectCloudDriveResumeItem(
            listOf(
                row("viewable", lastVisitedAt = "2026-08-11T09:00:00Z"),
                row(
                    "revoked",
                    lastVisitedAt = "2026-08-12T09:00:00Z",
                    canView = false,
                ),
            ),
        )

        assertEquals("viewable", selected?.resourceId)
    }

    @Test
    fun `ignores unrouteable resource types even when they are newer`() {
        val selected = selectCloudDriveResumeItem(
            listOf(
                row("file", lastVisitedAt = "2026-08-11T09:00:00Z"),
                row(
                    "unknown",
                    itemType = "tabslide",
                    lastVisitedAt = "2026-08-12T09:00:00Z",
                ),
            ),
        )

        assertEquals("file", selected?.resourceId)
    }

    @Test
    fun `landing context only allows all scope blank search and root collection`() {
        assertTrue(
            isCloudDriveLandingContext(
                scope = CloudDriveBrowseScope.ALL,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveLandingContext(
                scope = CloudDriveBrowseScope.ALL,
                searchQuery = "roadmap",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveLandingContext(
                scope = CloudDriveBrowseScope.RECENT,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveLandingContext(
                scope = CloudDriveBrowseScope.SHARED,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveLandingContext(
                scope = CloudDriveBrowseScope.ALL,
                searchQuery = "",
                currentCollectionId = "folder-1",
            ),
        )
    }

    @Test
    fun `quick actions remain visible in recent but hide in shared search and folders`() {
        assertTrue(
            isCloudDriveQuickActionContext(
                scope = CloudDriveBrowseScope.RECENT,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertTrue(
            isCloudDriveQuickActionContext(
                scope = CloudDriveBrowseScope.ALL,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveQuickActionContext(
                scope = CloudDriveBrowseScope.SHARED,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveQuickActionContext(
                scope = CloudDriveBrowseScope.RECENT,
                searchQuery = "roadmap",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveQuickActionContext(
                scope = CloudDriveBrowseScope.RECENT,
                searchQuery = "",
                currentCollectionId = "folder-1",
            ),
        )
    }

    @Test
    fun `resume hero remains visible in recent but hides in shared search and folders`() {
        assertTrue(
            isCloudDriveResumeHeroContext(
                scope = CloudDriveBrowseScope.RECENT,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertTrue(
            isCloudDriveResumeHeroContext(
                scope = CloudDriveBrowseScope.ALL,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveResumeHeroContext(
                scope = CloudDriveBrowseScope.SHARED,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveResumeHeroContext(
                scope = CloudDriveBrowseScope.RECENT,
                searchQuery = "roadmap",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            ),
        )
        assertFalse(
            isCloudDriveResumeHeroContext(
                scope = CloudDriveBrowseScope.ALL,
                searchQuery = "",
                currentCollectionId = "folder-1",
            ),
        )
    }

    private fun row(
        id: String,
        itemType: String = "tabfiles",
        lastVisitedAt: String?,
        updatedAt: String? = null,
        canView: Boolean? = true,
    ): CloudDriveResourceRow = CloudDriveResourceRow(
        contextItemId = "context-$id",
        resourceId = id,
        fileRecordId = null,
        itemType = itemType,
        title = id,
        preview = null,
        collectionId = null,
        organizationId = "org-1",
        spaceId = null,
        spaceName = null,
        owner = null,
        metadata = null,
        isPinned = false,
        lastVisitedAt = lastVisitedAt,
        updatedAt = updatedAt,
        canView = canView,
        canEdit = false,
        canMove = false,
        canShare = false,
        canTrash = false,
        canDelete = false,
    )
}
