package com.tabtin.mobile.features.files

import android.content.Context
import android.net.Uri
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveFolderPage
import com.tabtin.mobile.data.model.files.CloudDriveMountPendingException
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveUploadPhase
import com.tabtin.mobile.data.model.files.CreateTableResponse
import com.tabtin.mobile.data.repository.CloudDriveRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CloudDriveWriteViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private val context = mockk<Context>(relaxed = true)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        every { context.getString(any()) } returns "err"
        every { context.getString(R.string.cloud_drive_untitled_table) } returns "未命名表格"
        every { context.getString(R.string.cloud_drive_untitled_doc) } returns "未命名文档"
        every { context.getString(R.string.cloud_drive_mount_pending_hint) } returns "pending hint"
        every { context.getString(R.string.cloud_drive_create_failed) } returns "create failed"
        every { context.getString(R.string.cloud_drive_upload_failed) } returns "upload failed"
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun newVm(repository: CloudDriveRepository) =
        CloudDriveAppHomeViewModel(repository, context)

    @Test
    fun `createFolder refreshes collections and folder page`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery { repository.listCollections("org-1") } returns listOf(
            CloudDriveCollection(id = "c-new", name = "Notes"),
        )
        coEvery {
            repository.listFolderPage(any(), any(), any(), any(), any(), any())
        } returns CloudDriveFolderPage(
            folders = listOf(CloudDriveCollection(id = "c-new", name = "Notes")),
            resources = emptyList(),
            total = 0,
            page = 1,
            pageSize = 50,
            hasMore = false,
        )
        coEvery {
            repository.createFolder("org-1", "Notes", "root")
        } returns CloudDriveCollection(id = "c-new", name = "Notes")

        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        vm.createFolder("Notes")
        advanceUntilIdle()

        coVerify(exactly = 1) { repository.createFolder("org-1", "Notes", "root") }
        assertEquals("c-new", vm.uiState.value.folders.single().id)
        assertFalse(vm.uiState.value.isWriting)
    }

    @Test
    fun `createDocument and createTable pass current collection_id`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery { repository.listCollections(any()) } returns emptyList()
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
        coEvery {
            repository.createDocument("org-1", "", "folder-1")
        } returns DocDetailResponse(
            document = Doc(id = "doc-1", title = "Untitled", organizationId = "org-1"),
        )
        coEvery {
            repository.createTable("org-1", "未命名表格", "folder-1")
        } returns CreateTableResponse(id = "table-1", name = "未命名表格")

        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        advanceUntilIdle()
        vm.openFolder(CloudDriveCollection(id = "folder-1", name = "Work"))
        advanceUntilIdle()

        vm.createDocument()
        advanceUntilIdle()
        vm.createTable()
        advanceUntilIdle()

        coVerify { repository.createDocument("org-1", "", "folder-1") }
        coVerify { repository.createTable("org-1", "未命名表格", "folder-1") }
    }

    @Test
    fun `recent keeps create enabled while shared disables it`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery { repository.listCollections(any()) } returns emptyList()
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
        coEvery { repository.listSharedFeedPage(any(), any(), any(), any()) } returns
            com.tabtin.mobile.data.model.files.CloudDriveSharedPage(
                resources = emptyList(),
                nextCursor = null,
                hasMore = false,
            )
        coEvery { repository.listRecentPage(any(), any(), any(), any()) } returns
            CloudDriveFolderPage(
                folders = emptyList(),
                resources = emptyList(),
                total = 0,
                page = 1,
                pageSize = 50,
                hasMore = false,
            )
        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canWrite)

        vm.setScope(CloudDriveBrowseScope.RECENT)
        assertTrue(vm.uiState.value.canWrite)

        vm.setScope(CloudDriveBrowseScope.SHARED)
        assertFalse(vm.uiState.value.canWrite)

        vm.navigateBreadcrumb(null)
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canWrite)
    }

    @Test
    fun `upload mount pending uses this file phase not org-wide pending`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 1
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery { repository.listCollections(any()) } returns emptyList()
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
        // 组织里已有别的 pending，但本次失败是 OSS 级（非 MountPending）→ FAILED
        every { repository.listPendingMounts() } returns emptyList()
        coEvery {
            repository.uploadAndMount(any(), any(), any(), any(), any(), any(), any(), any())
        } throws RuntimeException("oss boom")

        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        advanceUntilIdle()
        val uri = mockk<Uri>(relaxed = true)
        vm.uploadFiles(
            listOf(
                CloudDrivePickedFile(
                    uri = uri,
                    fileName = "a.pdf",
                    contentType = "application/pdf",
                    fileSize = 12L,
                ),
            ),
        )
        advanceUntilIdle()

        assertEquals(CloudDriveUploadPhase.FAILED, vm.uiState.value.uploadItems.single().phase)
    }

    @Test
    fun `upload MountPendingException marks PENDING_MOUNT for this file`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 1
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery { repository.listCollections(any()) } returns emptyList()
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
        coEvery {
            repository.uploadAndMount(any(), any(), any(), any(), any(), any(), any(), any())
        } throws CloudDriveMountPendingException(
            fileRecordId = "fr-b",
            organizationId = "org-1",
            cause = RuntimeException("mount down"),
        )

        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        vm.uploadFiles(
            listOf(
                CloudDrivePickedFile(
                    uri = mockk<Uri>(relaxed = true),
                    fileName = "b.pdf",
                    contentType = "application/pdf",
                    fileSize = 8L,
                ),
            ),
        )
        advanceUntilIdle()
        assertEquals(
            CloudDriveUploadPhase.PENDING_MOUNT,
            vm.uiState.value.uploadItems.single().phase,
        )
        assertEquals("pending hint", vm.uiState.value.writeErrorMessage)
    }

    @Test
    fun `upload ready opens via pendingOpenResource`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery { repository.listCollections(any()) } returns emptyList()
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
        val ready = CloudDriveResourceRow(
            contextItemId = "ci-ready",
            resourceId = "res-1",
            fileRecordId = "fr-1",
            itemType = "tabfiles",
            title = "a.pdf",
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
            canEdit = false,
            canMove = false,
            canShare = false,
            canTrash = false,
            canDelete = false,
        )
        coEvery {
            repository.uploadAndMount(any(), any(), any(), any(), any(), any(), any(), any())
        } returns ready

        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        val opened = mutableListOf<CloudDriveResourceRow>()
        val collectJob = launch { vm.pendingOpenResource.collect { opened += it } }
        advanceUntilIdle() // 先挂上 collector，再 emit（SharedFlow 无 replay）
        vm.uploadFiles(
            listOf(
                CloudDrivePickedFile(
                    uri = mockk<Uri>(relaxed = true),
                    fileName = "a.pdf",
                    contentType = "application/pdf",
                    fileSize = 12L,
                ),
            ),
        )
        advanceUntilIdle()
        assertEquals(CloudDriveUploadPhase.READY, vm.uiState.value.uploadItems.single().phase)
        assertEquals(listOf("ci-ready"), opened.map { it.contextItemId })
        assertFalse(vm.uiState.value.isWriting)
        collectJob.cancel()
    }
}
