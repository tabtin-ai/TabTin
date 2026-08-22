package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.TabFilesApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.SpaceResourceListResponse
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveCollectionListResponse
import com.tabtin.mobile.data.model.files.CloudDriveContracts
import com.tabtin.mobile.data.model.files.CloudDriveFileMountRequest
import com.tabtin.mobile.data.model.files.CloudDriveMoveItemsRequest
import com.tabtin.mobile.data.model.files.CloudDriveMoveItemsResponse
import com.tabtin.mobile.data.model.files.CloudDrivePendingMountTask
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveSearchResponse
import com.tabtin.mobile.data.model.files.CloudDriveSharedFeedItem
import com.tabtin.mobile.data.model.files.CloudDriveSharedFeedResponse
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.data.model.files.CloudFileDownloadUrlResponse
import com.tabtin.mobile.data.model.files.CloudFilePreviewPolicy
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CloudDriveRepositoryTest {

    private fun makeRepo(
        contextApi: ContextApi = mockk(relaxed = true),
        tabFilesApi: TabFilesApi = mockk(relaxed = true),
        pendingMountStore: CloudDrivePendingMountStore = mockk(relaxed = true),
    ): CloudDriveRepository = CloudDriveRepository(
        contextApi = contextApi,
        tabFilesApi = tabFilesApi,
        tabDataApi = mockk(relaxed = true),
        docRepository = mockk(relaxed = true),
        ossUploadService = mockk(relaxed = true),
        pendingMountStore = pendingMountStore,
    )

    @Test
    fun `mountConfirmedFile persists pendingMount when mount fails`() = runTest {
        val tabFilesApi = mockk<TabFilesApi>()
        val pendingMountStore = mockk<CloudDrivePendingMountStore>(relaxed = true)
        coEvery {
            tabFilesApi.mountFileToOrganization("org-1", any())
        } throws RuntimeException("network down")
        val repository = makeRepo(tabFilesApi = tabFilesApi, pendingMountStore = pendingMountStore)

        try {
            repository.mountConfirmedFile(
                organizationId = "org-1",
                fileRecordId = "fr-9",
                collectionId = "c1",
                title = "a.pdf",
            )
            fail("expected mount failure")
        } catch (error: com.tabtin.mobile.data.model.files.CloudDriveMountPendingException) {
            assertEquals("fr-9", error.fileRecordId)
            assertEquals("org-1", error.organizationId)
        }

        verify {
            pendingMountStore.upsert(
                match<CloudDrivePendingMountTask> {
                    it.fileRecordId == "fr-9" &&
                        it.organizationId == "org-1" &&
                        it.collectionId == "c1"
                },
            )
        }
    }

    @Test
    fun `mountConfirmedFile clears pendingMount on success`() = runTest {
        val tabFilesApi = mockk<TabFilesApi>()
        val pendingMountStore = mockk<CloudDrivePendingMountStore>(relaxed = true)
        coEvery {
            tabFilesApi.mountFileToOrganization(
                "org-1",
                CloudDriveFileMountRequest(
                    fileRecordId = "fr-9",
                    collectionId = "c1",
                    title = "a.pdf",
                ),
            )
        } returns ApiEnvelope(success = true, data = resource("9", "tabfiles"))
        val repository = makeRepo(tabFilesApi = tabFilesApi, pendingMountStore = pendingMountStore)

        val row = repository.mountConfirmedFile(
            organizationId = "org-1",
            fileRecordId = "fr-9",
            collectionId = "c1",
            title = "a.pdf",
        )

        assertEquals("item-9", row.contextItemId)
        verify { pendingMountStore.remove("org-1", "fr-9") }
    }

    @Test
    fun `listFolderPage forwards item_types and collection_id before paging`() = runTest {
        val contextApi = mockk<ContextApi>()
        val tabFilesApi = mockk<TabFilesApi>(relaxed = true)
        coEvery {
            contextApi.getOrganizationContextItems(
                organizationId = "org-1",
                isArchived = "false",
                page = 1,
                pageSize = 50,
                itemTypes = "tabdoc,tabdata,tabfiles",
                collectionId = "root",
                visitedOnly = null,
                sort = null,
            )
        } returns ApiEnvelope(
            success = true,
            data = SpaceResourceListResponse(
                items = listOf(resource("1", "tabdoc")),
                total = 1,
                page = 1,
                pageSize = 50,
            ),
        )
        val repository = makeRepo(contextApi, tabFilesApi)

        val page = repository.listFolderPage(
            organizationId = "org-1",
            collectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
            childFolders = listOf(CloudDriveCollection(id = "c1", name = "Notes")),
        )

        assertEquals(listOf("c1"), page.folders.map { it.id })
        assertEquals(listOf("item-1"), page.resources.map { it.contextItemId })
        assertEquals("doc-1", page.resources.first().resourceId)
        assertFalse(page.hasMore)
    }

    @Test
    fun `listRecentPage uses visited_only and server sort`() = runTest {
        val contextApi = mockk<ContextApi>()
        val tabFilesApi = mockk<TabFilesApi>(relaxed = true)
        coEvery {
            contextApi.getOrganizationContextItems(
                organizationId = "org-1",
                isArchived = "false",
                page = 1,
                pageSize = 50,
                itemTypes = "tabfiles",
                collectionId = null,
                visitedOnly = "true",
                sort = "-last_visited_at",
            )
        } returns ApiEnvelope(
            success = true,
            data = SpaceResourceListResponse(
                items = listOf(resource("9", "tabfiles")),
                total = 1,
                page = 1,
                pageSize = 50,
            ),
        )
        val repository = makeRepo(contextApi, tabFilesApi)

        val page = repository.listRecentPage(
            organizationId = "org-1",
            typeFilter = CloudDriveTypeFilter.TABFILES,
        )

        assertEquals("item-9", page.resources.single().contextItemId)
        assertEquals("doc-9", page.resources.single().fileRecordId)
    }

    @Test
    fun `listSharedFeedPage maps context_item_id and file_record_id`() = runTest {
        val contextApi = mockk<ContextApi>()
        val tabFilesApi = mockk<TabFilesApi>(relaxed = true)
        coEvery {
            contextApi.getCloudDriveSharedFeed(
                organizationId = "org-1",
                itemTypes = "tabdoc,tabdata,tabfiles",
                cursor = null,
                limit = 30,
            )
        } returns ApiEnvelope(
            success = true,
            data = CloudDriveSharedFeedResponse(
                items = listOf(
                    CloudDriveSharedFeedItem(
                        contextItemId = "ci-1",
                        resourceId = "fr-1",
                        fileRecordId = "fr-1",
                        itemType = "tabfiles",
                        title = "Brief",
                        permission = "viewer",
                    ),
                ),
                nextCursor = "cursor-2",
                limit = 30,
            ),
        )
        val repository = makeRepo(contextApi, tabFilesApi)

        val page = repository.listSharedFeedPage("org-1")

        assertEquals("ci-1", page.resources.single().contextItemId)
        assertEquals("fr-1", page.resources.single().fileRecordId)
        assertEquals("viewer", page.resources.single().permission)
        assertEquals(CloudDriveContracts.LOCATION_SHARED_WITH_ME, page.resources.single().locationLabel)
        assertEquals("cursor-2", page.nextCursor)
        assertTrue(page.hasMore)
    }

    @Test
    fun `resolveSearchLocationLabel maps folder name root and shared origin`() {
        val repository = makeRepo(mockk(relaxed = true), mockk(relaxed = true))
        val tree = listOf(
            CloudDriveCollection(
                id = "a",
                name = "Alpha",
                children = listOf(CloudDriveCollection(id = "b", name = "Beta Notes")),
            ),
        )
        assertEquals("Beta Notes", repository.resolveSearchLocationLabel(tree, "b"))
        assertEquals(CloudDriveContracts.LOCATION_ROOT, repository.resolveSearchLocationLabel(tree, null))
        assertEquals(
            CloudDriveContracts.LOCATION_ROOT,
            repository.resolveSearchLocationLabel(tree, CloudDriveContracts.ROOT_COLLECTION_ID),
        )
        assertEquals(
            CloudDriveContracts.LOCATION_SHARED_WITH_ME,
            repository.resolveSearchLocationLabel(tree, "foreign-uuid"),
        )
    }

    @Test
    fun `search resolves locationLabel via collections tree not raw uuid`() = runTest {
        val contextApi = mockk<ContextApi>()
        val tabFilesApi = mockk<TabFilesApi>(relaxed = true)
        coEvery {
            contextApi.searchOrganizationCloudDrive("org-1", "brief", "tabdoc,tabdata,tabfiles", 1, 30)
        } returns ApiEnvelope(
            success = true,
            data = CloudDriveSearchResponse(
                items = listOf(
                    resource("2", "tabdoc").copy(collectionId = "folder-a"),
                    resource("3", "tabdoc").copy(collectionId = "foreign-share"),
                    resource("4", "tabdoc").copy(collectionId = null),
                ),
                total = 3,
            ),
        )
        val repository = makeRepo(contextApi, tabFilesApi)
        val tree = listOf(CloudDriveCollection(id = "folder-a", name = "Notes"))

        val page = repository.search("org-1", "brief", collections = tree)

        assertEquals(
            listOf("Notes", CloudDriveContracts.LOCATION_SHARED_WITH_ME, CloudDriveContracts.LOCATION_ROOT),
            page.resources.map { it.locationLabel },
        )
    }

    @Test
    fun `search and download-url keep preview and download requests separate`() = runTest {
        val contextApi = mockk<ContextApi>()
        val tabFilesApi = mockk<TabFilesApi>()
        coEvery {
            contextApi.searchOrganizationCloudDrive("org-1", "brief", "tabdoc,tabdata,tabfiles", 1, 30)
        } returns ApiEnvelope(
            success = true,
            data = CloudDriveSearchResponse(items = listOf(resource("2", "tabdoc")), total = 1),
        )
        coEvery {
            tabFilesApi.getDownloadUrl("org-1", "ci-file", 5 * 1024 * 1024)
        } returns ApiEnvelope(
            success = true,
            data = CloudFileDownloadUrlResponse(
                url = "https://example.test/preview",
                fileName = "a.pdf",
                mimeType = "application/pdf",
                previewEligible = true,
                mimePreviewSafe = true,
            ),
        )
        coEvery {
            tabFilesApi.getDownloadUrl("org-1", "ci-file", null)
        } returns ApiEnvelope(
            success = true,
            data = CloudFileDownloadUrlResponse(
                url = "https://example.test/download",
                fileName = "a.pdf",
                mimeType = "application/pdf",
                previewEligible = false,
                mimePreviewSafe = true,
            ),
        )
        val repository = makeRepo(contextApi, tabFilesApi)

        val search = repository.search("org-1", "brief")
        val preview = repository.getPreviewUrl("org-1", "ci-file")
        val download = repository.getDownloadUrl("org-1", "ci-file")

        assertEquals(listOf("item-2"), search.resources.map { it.contextItemId })
        assertEquals("https://example.test/preview", preview.url)
        assertEquals("https://example.test/download", download.url)
        coVerify(exactly = 1) { tabFilesApi.getDownloadUrl("org-1", "ci-file", 5 * 1024 * 1024) }
        coVerify(exactly = 1) { tabFilesApi.getDownloadUrl("org-1", "ci-file", null) }
    }

    @Test
    fun `breadcrumb and local folder search walk collection tree`() = runTest {
        val repository = makeRepo(mockk(relaxed = true), mockk(relaxed = true))
        val tree = listOf(
            CloudDriveCollection(
                id = "a",
                name = "Alpha",
                children = listOf(
                    CloudDriveCollection(id = "b", name = "Beta Notes"),
                ),
            ),
        )

        assertEquals(listOf("a", "b"), repository.breadcrumbPath(tree, "b").map { it.id })
        assertEquals(listOf("b"), repository.searchCollectionsLocally(tree, "notes").map { it.id })
        assertEquals(
            listOf("b"),
            repository.childFoldersOf(tree, "a").map { it.id },
        )
    }

    @Test
    fun `collections list unwraps organization tree`() = runTest {
        val contextApi = mockk<ContextApi>()
        coEvery { contextApi.getOrganizationCollections("org-1") } returns ApiEnvelope(
            success = true,
            data = CloudDriveCollectionListResponse(
                collections = listOf(CloudDriveCollection(id = "c1", name = "Inbox")),
                total = 1,
            ),
        )
        val repository = makeRepo(contextApi, mockk(relaxed = true))
        assertEquals("Inbox", repository.listCollections("org-1").single().name)
    }

    @Test
    fun `preview policy rejects html svg zip`() {
        assertTrue(CloudFilePreviewPolicy.isInlinePreviewSafe("application/pdf"))
        assertTrue(CloudFilePreviewPolicy.isInlinePreviewSafe("image/png"))
        assertTrue(CloudFilePreviewPolicy.isInlinePreviewSafe("text/plain"))
        assertFalse(CloudFilePreviewPolicy.isInlinePreviewSafe("text/html"))
        assertFalse(CloudFilePreviewPolicy.isInlinePreviewSafe("image/svg+xml"))
        assertFalse(CloudFilePreviewPolicy.isInlinePreviewSafe("application/zip"))
        assertFalse(CloudFilePreviewPolicy.isInlinePreviewSafe(null))
    }

    @Test
    fun `resource row reads mime and size from metadata`() {
        val row = CloudDriveResourceRow.fromSpaceResource(
            resource(
                "f",
                "tabfiles",
            ).copy(
                metadata = buildJsonObject {
                    put("mime_type", "application/pdf")
                    put("size_bytes", 42L)
                },
            ),
        )
        assertEquals("application/pdf", row.mimeType)
        assertEquals(42L, row.fileSizeBytes)
        assertEquals("可查看", CloudDriveResourceRow.formatSharePermission("viewer"))
        assertNull(CloudDriveResourceRow.formatSharePermission(null))
    }

    @Test
    fun `recordAccess uses context item id`() = runTest {
        val contextApi = mockk<ContextApi>()
        coEvery { contextApi.recordContextItemAccess("ci-1") } returns ApiEnvelope(
            success = true,
            data = JsonObject(emptyMap()),
        )
        val repository = makeRepo(contextApi, mockk(relaxed = true))
        repository.recordAccess("ci-1")
        coVerify(exactly = 1) { contextApi.recordContextItemAccess("ci-1") }
    }

    @Test
    fun `moveResource refuses when canMove is not true`() = runTest {
        val repository = makeRepo()
        try {
            repository.moveResource("org-1", "ci-1", "c-2", canMove = false)
            fail("expected MOVE_DENIED")
        } catch (error: IllegalStateException) {
            assertEquals("MOVE_DENIED", error.message)
        }
    }

    @Test
    fun `moveResource posts ContextItemIDs to organization move-items`() = runTest {
        val contextApi = mockk<ContextApi>()
        val bodySlot = slot<CloudDriveMoveItemsRequest>()
        coEvery {
            contextApi.moveOrganizationCollectionItems("org-1", capture(bodySlot))
        } returns ApiEnvelope(success = true, data = CloudDriveMoveItemsResponse(updated = 1))
        val repository = makeRepo(contextApi = contextApi)

        val updated = repository.moveResource(
            organizationId = "org-1",
            contextItemId = "ci-77",
            targetCollectionId = null,
            canMove = true,
        )

        assertEquals(1, updated)
        assertEquals(listOf("ci-77"), bodySlot.captured.itemIds)
        assertNull(bodySlot.captured.collectionId)
    }

    @Test
    fun `trash and restore use FileRecordID endpoints`() = runTest {
        val tabFilesApi = mockk<TabFilesApi>()
        coEvery {
            tabFilesApi.trashOrganizationFile("org-1", "fr-22")
        } returns ApiEnvelope(success = true, data = JsonObject(emptyMap()))
        coEvery {
            tabFilesApi.restoreOrganizationFile("org-1", "fr-22")
        } returns ApiEnvelope(
            success = true,
            data = SpaceResource(
                id = "ci-22",
                itemType = "tabfiles",
                title = "restored.pdf",
                resourceId = "fr-22",
                organizationId = "org-1",
            ),
        )
        coEvery {
            tabFilesApi.permanentDeleteOrganizationFile("org-1", "fr-22")
        } returns ApiEnvelope(success = true, data = JsonObject(emptyMap()))
        val repository = makeRepo(tabFilesApi = tabFilesApi)

        repository.trashTabFile("org-1", "fr-22")
        val restored = repository.restoreTabFile("org-1", "fr-22")
        repository.permanentDeleteTabFile("org-1", "fr-22")

        assertEquals("fr-22", restored.fileRecordId)
        assertEquals("ci-22", restored.contextItemId)
        coVerify(exactly = 1) { tabFilesApi.trashOrganizationFile("org-1", "fr-22") }
        coVerify(exactly = 1) { tabFilesApi.restoreOrganizationFile("org-1", "fr-22") }
        coVerify(exactly = 1) { tabFilesApi.permanentDeleteOrganizationFile("org-1", "fr-22") }
    }

    @Test
    fun `moveFolder to root sends explicit null parent_id`() = runTest {
        val contextApi = mockk<ContextApi>()
        val bodySlot = slot<JsonObject>()
        coEvery {
            contextApi.updateCollection("c-1", capture(bodySlot))
        } returns ApiEnvelope(
            success = true,
            data = CloudDriveCollection(id = "c-1", name = "Notes"),
        )
        val repository = makeRepo(contextApi = contextApi)

        repository.moveFolder("c-1", parentCollectionId = null)

        assertTrue(bodySlot.captured.containsKey("parent_id"))
        assertEquals(JsonNull, bodySlot.captured["parent_id"])
    }

    private fun resource(suffix: String, type: String): SpaceResource = SpaceResource(
        id = "item-$suffix",
        itemType = type,
        title = "Title $suffix",
        resourceId = "doc-$suffix",
        organizationId = "org-1",
    )
}
