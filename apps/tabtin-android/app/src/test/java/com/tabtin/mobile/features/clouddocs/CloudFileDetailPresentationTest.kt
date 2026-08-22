package com.tabtin.mobile.features.clouddocs

import com.tabtin.mobile.features.files.CloudDriveFileCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudFileDetailPresentationTest {
    @Test
    fun imageUsesLivePreviewAndHidesInternalIds() {
        assertTrue(CloudFileDetailPresentation.showsLiveImage(CloudDriveFileCategory.IMAGE))
        assertFalse(CloudFileDetailPresentation.showsLiveImage(CloudDriveFileCategory.PDF))
        val metadata = CloudFileDetailPresentation.metadata(
            mimeType = "image/jpeg",
            typeLabel = "TabFiles",
            sizeBytes = 57_241L,
            spaceName = null,
            organizationCloudLabel = "组织云端",
        )
        assertEquals("image/jpeg", metadata.mimeType)
        assertEquals("组织云端", metadata.location)
        assertEquals(57_241L, metadata.sizeBytes)
    }

    @Test
    fun actionOrderMatchesSharedDetailContract() {
        assertEquals(
            listOf(
                CloudFileDetailAction.PREVIEW,
                CloudFileDetailAction.OPEN_EXTERNALLY,
                CloudFileDetailAction.DOWNLOAD,
                CloudFileDetailAction.COPY_LINK,
                CloudFileDetailAction.SHARE,
                CloudFileDetailAction.COLLABORATORS,
                CloudFileDetailAction.TRASH,
            ),
            CloudFileDetailPresentation.actions(
                canPreview = true,
                hasShareableLink = true,
                canManageCollaborators = true,
                canTrash = true,
            ),
        )
        assertEquals(
            listOf(CloudFileDetailAction.DOWNLOAD),
            CloudFileDetailPresentation.actions(
                canPreview = false,
                hasShareableLink = false,
                canManageCollaborators = false,
                canTrash = false,
            ),
        )
    }
}
