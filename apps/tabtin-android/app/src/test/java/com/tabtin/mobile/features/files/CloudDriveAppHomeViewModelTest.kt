package com.tabtin.mobile.features.files

import android.content.Context
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SpaceResourceOwner
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveFolderPage
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveSharedPage
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.data.repository.CloudDriveRepository
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CloudDriveAppHomeViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private val context = mockk<Context>(relaxed = true)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        every { context.getString(any()) } returns "err"
        every { context.getString(R.string.cloud_drive_untitled_table) } returns "未命名表格"
        every { context.getString(R.string.cloud_drive_untitled_doc) } returns "未命名文档"
        every { context.getString(R.string.cloud_drive_mount_pending_hint) } returns "pending hint"
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun newVm(repository: CloudDriveRepository) =
        CloudDriveAppHomeViewModel(repository, context)

    @Test
    fun `bindOrganization loads folder page with collections`() = runTest {
        val repository = mockk<CloudDriveRepository>()
        every { repository.pendingMountCount() } returns 0
        coEvery { repository.retryPendingMounts() } returns 0
        coEvery { repository.listCollections("org-1") } returns listOf(
            CloudDriveCollection(id = "c1", name = "Notes"),
        )
        every { repository.childFoldersOf(any(), any()) } returns listOf(
            CloudDriveCollection(id = "c1", name = "Notes"),
        )
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery {
            repository.listFolderPage(any(), any(), any(), any(), any(), any())
        } returns CloudDriveFolderPage(
            folders = listOf(CloudDriveCollection(id = "c1", name = "Notes")),
            resources = listOf(row("ci-1", "tabdoc")),
            total = 1,
            page = 1,
            pageSize = 50,
            hasMore = false,
        )
        val vm = newVm(repository)

        vm.bindOrganization("org-1")

        assertEquals(1, vm.uiState.value.folders.size)
        assertEquals("ci-1", vm.uiState.value.resources.single().contextItemId)
    }

    @Test
    fun `shared scope uses unified feed not client merge`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        coEvery { repository.retryPendingMounts() } returns 0
        coEvery { repository.listCollections(any()) } returns emptyList()
        coEvery {
            repository.listSharedFeedPage(
                organizationId = "org-1",
                typeFilter = CloudDriveTypeFilter.ALL,
                cursor = null,
            )
        } returns CloudDriveSharedPage(
            resources = listOf(row("ci-s", "tabfiles")),
            nextCursor = null,
            hasMore = false,
        )
        val vm = newVm(repository)
        vm.bindOrganization("org-1")

        vm.setScope(CloudDriveBrowseScope.SHARED)

        assertEquals(CloudDriveBrowseScope.SHARED, vm.uiState.value.scope)
        assertEquals("ci-s", vm.uiState.value.resources.single().contextItemId)
        coVerify(exactly = 1) {
            repository.listSharedFeedPage(
                organizationId = "org-1",
                typeFilter = CloudDriveTypeFilter.ALL,
                cursor = null,
                limit = any(),
            )
        }
    }

    @Test
    fun `onResourceOpened optimistically updates and records access`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        coEvery { repository.retryPendingMounts() } returns 0
        every { repository.optimisticVisitedAtNow() } returns "2026-07-31T10:00:00Z"
        coEvery { repository.listCollections(any()) } returns emptyList()
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery {
            repository.listFolderPage(any(), any(), any(), any(), any(), any())
        } returns CloudDriveFolderPage(
            folders = emptyList(),
            resources = listOf(row("ci-1", "tabdoc")),
            total = 1,
            page = 1,
            pageSize = 50,
            hasMore = false,
        )
        val vm = newVm(repository)
        vm.bindOrganization("org-1")

        vm.onResourceOpened(row("ci-1", "tabdoc"))

        assertEquals("2026-07-31T10:00:00Z", vm.uiState.value.resources.single().lastVisitedAt)
        assertEquals("ci-1", vm.uiState.value.resumeItem?.contextItemId)
        coVerify(exactly = 1) { repository.recordAccess("ci-1") }
    }

    @Test
    fun `stale folder load is ignored after scope switch`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        coEvery { repository.retryPendingMounts() } returns 0
        coEvery { repository.listCollections(any()) } returns emptyList()
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        coEvery {
            repository.listFolderPage(any(), any(), any(), any(), any(), any())
        } returns CloudDriveFolderPage(
            folders = emptyList(),
            resources = listOf(row("folder-row", "tabdoc")),
            total = 1,
            page = 1,
            pageSize = 50,
            hasMore = false,
        )
        coEvery {
            repository.listRecentPage(any(), any(), any(), any())
        } returns CloudDriveFolderPage(
            folders = emptyList(),
            resources = listOf(row("recent-row", "tabdoc")),
            total = 1,
            page = 1,
            pageSize = 50,
            hasMore = false,
        )
        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        vm.setScope(CloudDriveBrowseScope.RECENT)

        assertEquals("recent-row", vm.uiState.value.resources.single().contextItemId)
        assertTrue(vm.uiState.value.folders.isEmpty())
    }

    @Test
    fun `loadMore failure pauses auto pagination until retryLoadMore`() = runTest {
        val repository = mockk<CloudDriveRepository>(relaxed = true)
        every { repository.pendingMountCount() } returns 0
        coEvery { repository.retryPendingMounts() } returns 0
        coEvery { repository.listCollections(any()) } returns emptyList()
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
        var page2Attempts = 0
        coEvery {
            repository.listFolderPage(any(), any(), any(), any(), any(), any())
        } coAnswers {
            val page = invocation.args[3] as Int
            if (page == 1) {
                CloudDriveFolderPage(
                    folders = emptyList(),
                    resources = listOf(row("ci-1", "tabdoc")),
                    total = 100,
                    page = 1,
                    pageSize = 50,
                    hasMore = true,
                )
            } else {
                page2Attempts += 1
                if (page2Attempts == 1) throw RuntimeException("page 2 boom")
                CloudDriveFolderPage(
                    folders = emptyList(),
                    resources = listOf(row("ci-2", "tabdoc")),
                    total = 100,
                    page = 2,
                    pageSize = 50,
                    hasMore = true,
                )
            }
        }
        val vm = newVm(repository)
        vm.bindOrganization("org-1")

        vm.loadMore()
        assertTrue(vm.uiState.value.paginationPaused)
        assertTrue(vm.uiState.value.hasMore)
        assertEquals(1, vm.uiState.value.resources.size)
        assertEquals(1, page2Attempts)

        // Auto path must stay paused
        vm.loadMore()
        assertEquals(1, page2Attempts)
        assertEquals(1, vm.uiState.value.resources.size)

        vm.retryLoadMore()
        assertFalse(vm.uiState.value.paginationPaused)
        assertEquals(2, page2Attempts)
        assertEquals(listOf("ci-1", "ci-2"), vm.uiState.value.resources.map { it.contextItemId })
    }

    @Test
    fun `shared subtitle includes sharer and permission`() {
        val parts = cloudDriveResourceSubtitleParts(
            row("ci-s", "tabfiles").copy(
                sharedBy = SpaceResourceOwner(id = "u1", displayName = "Alice"),
                permission = "editor",
                locationLabel = "分享给我",
            ),
        )
        assertEquals(
            listOf("文件", "来自 Alice", "可编辑", "分享给我"),
            parts,
        )
    }

    @Test
    fun `openCloudDriveResource passes mime and size from metadata`() {
        var opened: com.tabtin.mobile.features.clouddocs.CloudFileInfo? = null
        openCloudDriveResource(
            row = row("ci-f", "tabfiles").copy(
                metadata = buildJsonObject {
                    put("mime_type", "application/pdf")
                    put("file_size", 99L)
                },
            ),
            organizationId = "org-1",
            onOpenWeb = {},
            onOpenFile = { opened = it },
        )
        assertEquals("application/pdf", opened?.mimeType)
        assertEquals(99L, opened?.fileSizeBytes)
    }

    @Test
    fun `bindOrganization same org still silent retries pending mounts`() = runTest {
        val repository = mockk<CloudDriveRepository>()
        every { repository.pendingMountCount() } returnsMany listOf(1, 1, 0)
        coEvery { repository.retryPendingMounts() } returns 0
        coEvery { repository.listCollections("org-1") } returns listOf(
            CloudDriveCollection(id = "c1", name = "Notes"),
        )
        every { repository.childFoldersOf(any(), any()) } returns emptyList()
        every { repository.breadcrumbPath(any(), any()) } returns emptyList()
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

        val vm = newVm(repository)
        vm.bindOrganization("org-1")
        advanceUntilIdle()
        vm.bindOrganization("org-1")
        advanceUntilIdle()

        coVerify(atLeast = 2) { repository.retryPendingMounts() }
    }

    private fun row(contextItemId: String, type: String): CloudDriveResourceRow = CloudDriveResourceRow(
        contextItemId = contextItemId,
        resourceId = "res-$contextItemId",
        fileRecordId = if (type == "tabfiles") "res-$contextItemId" else null,
        itemType = type,
        title = "Title",
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
}
