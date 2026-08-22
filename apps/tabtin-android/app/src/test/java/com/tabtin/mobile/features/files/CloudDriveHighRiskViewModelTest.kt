package com.tabtin.mobile.features.files

import android.content.Context
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveFolderPage
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.repository.CloudDriveRepository
import com.tabtin.mobile.features.workbench.ResourceReference
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CloudDriveHighRiskViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private val context = mockk<Context>(relaxed = true)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        every { context.getString(any()) } returns "err"
        every { context.getString(R.string.cloud_drive_root) } returns "根目录"
        every { context.getString(R.string.cloud_drive_move_owner_only) } returns "owner only"
        every { context.getString(R.string.cloud_drive_action_failed) } returns "failed"
        every { context.getString(R.string.cloud_drive_trash_denied) } returns "trash denied"
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun row(
        contextItemId: String = "ci-1",
        type: String = "tabfiles",
        canMove: Boolean? = true,
        canTrash: Boolean? = true,
        fileRecordId: String? = "fr-1",
    ): CloudDriveResourceRow = CloudDriveResourceRow(
        contextItemId = contextItemId,
        resourceId = fileRecordId ?: "res-1",
        fileRecordId = fileRecordId,
        itemType = type,
        title = "file.pdf",
        preview = null,
        collectionId = "c-1",
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
        canMove = canMove,
        canShare = true,
        canTrash = canTrash,
        canDelete = false,
    )

    private fun primedRepository(): CloudDriveRepository {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        every { repository.findCollection(any(), any()) } returns null
        coEvery { repository.listCollections("org-1") } returns listOf(
            CloudDriveCollection(id = "c-1", name = "Notes"),
        )
        coEvery {
            repository.listFolderPage(any(), any(), any(), any(), any(), any())
        } returns CloudDriveFolderPage(
            folders = emptyList(),
            resources = emptyList(),
            total = 0,
            page = 1,
            pageSize = 50,
            hasMore = false,
        )
        return repository
    }

    @Test
    fun `moveResource blocked when canMove is not true`() = runTest {
        val repository = primedRepository()
        val vm = CloudDriveAppHomeViewModel(repository, context)
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        vm.moveResource(row(canMove = false), "c-2")
        advanceUntilIdle()

        coVerify(exactly = 0) { repository.moveResource(any(), any(), any(), any()) }
        assertEquals("owner only", vm.uiState.value.writeErrorMessage)
    }

    @Test
    fun `moveResource uses ContextItemID and owner-only canMove`() = runTest {
        val repository = primedRepository()
        coEvery {
            repository.moveResource("org-1", "ci-1", "c-2", true)
        } returns 1
        val vm = CloudDriveAppHomeViewModel(repository, context)
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        vm.moveResource(row(canMove = true), "c-2")
        advanceUntilIdle()

        coVerify(exactly = 1) {
            repository.moveResource("org-1", "ci-1", "c-2", true)
        }
        assertNull(vm.uiState.value.writeErrorMessage)
    }

    @Test
    fun `trashTabFile uses FileRecordID not ContextItemID`() = runTest {
        val repository = primedRepository()
        coEvery { repository.trashTabFile("org-1", "fr-9") } returns Unit
        val vm = CloudDriveAppHomeViewModel(repository, context)
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        vm.trashTabFile(row(contextItemId = "ci-9", fileRecordId = "fr-9"))
        advanceUntilIdle()

        coVerify(exactly = 1) { repository.trashTabFile("org-1", "fr-9") }
        coVerify(exactly = 0) { repository.trashTabFile("org-1", "ci-9") }
    }

    @Test
    fun `sendable cloud drive row encodes file_id for conversation sink`() {
        val ref = ResourceReference.fromCloudDriveRow(row(fileRecordId = "fr-42"))
        assertTrue(ref!!.canSendToConversation)
        assertEquals("file", ref.toMessageBlock()?.type)
        assertEquals("fr-42", ref.toMessageBlock()?.fileId)
    }

    @Test
    fun `folder is never sendable`() {
        assertNull(ResourceReference.fromCloudDriveRow(row(type = "folder", fileRecordId = null)))
        val folderRef = ResourceReference(
            id = "f1",
            resourceId = "f1",
            normalizedType = "folder",
            resourceType = "Folder",
            title = "Notes",
            emoji = "📁",
        )
        assertFalse(folderRef.canSendToConversation)
    }

    @Test
    fun `moveTargetFolders excludes subtree of moved folder`() = runTest {
        val repository = primedRepository()
        val child = CloudDriveCollection(id = "c-child", name = "Child")
        val parent = CloudDriveCollection(id = "c-parent", name = "Parent", children = listOf(child))
        coEvery { repository.listCollections("org-1") } returns listOf(parent)
        every { repository.findCollection(any(), "c-parent") } returns parent
        val vm = CloudDriveAppHomeViewModel(repository, context)
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        val targets = vm.moveTargetFolders(excludeCollectionId = "c-parent")
        assertTrue(targets.any { it.id == "root" })
        assertFalse(targets.any { it.id == "c-parent" })
        assertFalse(targets.any { it.id == "c-child" })
        assertEquals(CloudDriveBrowseScope.ALL, vm.uiState.value.scope)
    }
}
