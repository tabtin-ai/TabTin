package com.tabtin.mobile.features.clouddocs

import android.content.Context
import android.util.Log
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.KnowledgeTreeNode
import com.tabtin.mobile.data.model.KnowledgeTreeNodeType
import com.tabtin.mobile.data.model.KnowledgeTreeResponse
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.SharedResourceItem
import com.tabtin.mobile.data.model.SharedResourceType
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.model.files.CreateTableResponse
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SharedResourcesRepository
import com.tabtin.mobile.data.repository.SpaceResourceRepository
import com.tabtin.mobile.data.repository.CloudDriveRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.UnknownHostException

@OptIn(ExperimentalCoroutinesApi::class)
class CloudDocsViewModelTest {

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        mockkStatic(Log::class)
        every { Log.e(any(), any(), any()) } returns 0
        every { Log.w(any(), any(), any()) } returns 0
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(Log::class)
    }

    @Test
    fun `organization switch clears lists and expansion before next org loads`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()
        val secondTree = CompletableDeferred<KnowledgeTreeResponse>()
        val secondRecent = CompletableDeferred<List<SpaceResource>>()
        val secondShared = CompletableDeferred<List<SharedResourceItem>>()

        coEvery { spaceRepo.getKnowledgeTree("org-a", any(), any()) } returns treeResponse("a")
        coEvery { spaceRepo.getRecentOrganizationResources("org-a") } returns listOf(
            recentResource("a", lastVisitedAt = "2026-07-20T00:00:00Z"),
        )
        coEvery { sharedRepo.listSharedWithMe("org-a") } returns listOf(sharedItem("a"))

        coEvery { spaceRepo.getKnowledgeTree("org-b", any(), any()) } coAnswers { secondTree.await() }
        coEvery { spaceRepo.getRecentOrganizationResources("org-b") } coAnswers { secondRecent.await() }
        coEvery { sharedRepo.listSharedWithMe("org-b") } coAnswers { secondShared.await() }

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-a")
        viewModel.toggleExpansion(viewModel.uiState.value.treeRoots.first())

        assertEquals(listOf("n-a"), viewModel.uiState.value.treeRoots.map { it.id })
        assertTrue(viewModel.uiState.value.expandedNodeIds.isNotEmpty())

        viewModel.load("org-b")

        assertTrue(viewModel.uiState.value.isLoading)
        assertTrue(viewModel.uiState.value.treeRoots.isEmpty())
        assertTrue(viewModel.uiState.value.allRecentItems.isEmpty())
        assertTrue(viewModel.uiState.value.sharedItems.isEmpty())
        assertTrue(viewModel.uiState.value.expandedNodeIds.isEmpty())

        secondTree.complete(treeResponse("b"))
        secondRecent.complete(listOf(recentResource("b", lastVisitedAt = "2026-07-21T00:00:00Z")))
        secondShared.complete(listOf(sharedItem("b")))

        assertEquals(listOf("n-b"), viewModel.uiState.value.treeRoots.map { it.id })
        assertEquals(listOf("item-b"), viewModel.uiState.value.recentItems.map { it.id })
        assertEquals(listOf("shared:doc:doc-b"), viewModel.uiState.value.sharedItems.map { it.id })
    }

    @Test
    fun `pull to refresh keeps lists visible and only sets isRefreshing`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()
        val refreshTree = CompletableDeferred<KnowledgeTreeResponse>()
        val refreshRecent = CompletableDeferred<List<SpaceResource>>()
        val refreshShared = CompletableDeferred<List<SharedResourceItem>>()

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } returns treeResponse("1")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } returns listOf(
            recentResource("1", lastVisitedAt = "2026-07-20T00:00:00Z"),
        )
        coEvery { sharedRepo.listSharedWithMe("org-1") } returns listOf(sharedItem("1"))

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-1")

        assertEquals(listOf("n-1"), viewModel.uiState.value.treeRoots.map { it.id })
        assertFalse(viewModel.uiState.value.treeRows.isEmpty())
        assertFalse(viewModel.uiState.value.isLoading)
        assertFalse(viewModel.uiState.value.isRefreshing)

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } coAnswers { refreshTree.await() }
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } coAnswers { refreshRecent.await() }
        coEvery { sharedRepo.listSharedWithMe("org-1") } coAnswers { refreshShared.await() }

        viewModel.load("org-1", isPullToRefresh = true)

        assertFalse(viewModel.uiState.value.isLoading)
        assertTrue(viewModel.uiState.value.isRefreshing)
        assertEquals(listOf("n-1"), viewModel.uiState.value.treeRoots.map { it.id })
        assertFalse(viewModel.uiState.value.treeRows.isEmpty())
        assertEquals(listOf("item-1"), viewModel.uiState.value.allRecentItems.map { it.id })
        assertEquals(listOf("shared:doc:doc-1"), viewModel.uiState.value.sharedItems.map { it.id })

        refreshTree.complete(treeResponse("2"))
        refreshRecent.complete(listOf(recentResource("2", lastVisitedAt = "2026-07-21T00:00:00Z")))
        refreshShared.complete(listOf(sharedItem("2")))

        assertFalse(viewModel.uiState.value.isLoading)
        assertFalse(viewModel.uiState.value.isRefreshing)
        assertEquals(listOf("n-2"), viewModel.uiState.value.treeRoots.map { it.id })
    }

    @Test
    fun `shared segment error does not wipe browse data or set page error`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } returns treeResponse("1")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } returns listOf(
            recentResource("1", lastVisitedAt = "2026-07-20T00:00:00Z"),
        )
        coEvery { sharedRepo.listSharedWithMe("org-1") } throws RuntimeException("shared down")

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-1")

        assertEquals(listOf("n-1"), viewModel.uiState.value.treeRoots.map { it.id })
        assertEquals(listOf("item-1"), viewModel.uiState.value.recentItems.map { it.id })
        assertTrue(viewModel.uiState.value.sharedItems.isEmpty())
        assertNull(viewModel.uiState.value.errorRes)
        assertEquals(R.string.error_unknown, viewModel.uiState.value.sharedErrorRes)
    }

    @Test
    fun `tree failure does not clear successful shared items`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } throws RuntimeException("tree down")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } throws RuntimeException("recent down")
        coEvery { sharedRepo.listSharedWithMe("org-1") } returns listOf(sharedItem("1"))

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-1")

        assertTrue(viewModel.uiState.value.treeRoots.isEmpty())
        assertEquals(listOf("shared:doc:doc-1"), viewModel.uiState.value.sharedItems.map { it.id })
        assertEquals(R.string.error_unknown, viewModel.uiState.value.errorRes)
        assertNull(viewModel.uiState.value.sharedErrorRes)
    }

    @Test
    fun `pin failure rolls back optimistic isPinned on recent item`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } returns treeResponse("1")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } returns listOf(
            recentResource("1", lastVisitedAt = "2026-07-20T00:00:00Z", isPinned = false),
        )
        coEvery { sharedRepo.listSharedWithMe("org-1") } returns emptyList()
        coEvery { spaceRepo.togglePin("item-1", true) } throws RuntimeException("pin failed")

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-1")

        viewModel.togglePin(contextItemId = "item-1", currentlyPinned = false)

        assertEquals(false, viewModel.uiState.value.allRecentItems.single().isPinned)
        assertEquals(R.string.error_unknown, viewModel.uiState.value.errorRes)
        assertTrue(viewModel.uiState.value.pinningIds.isEmpty())
        coVerify(exactly = 1) { spaceRepo.togglePin("item-1", true) }
    }

    @Test
    fun `dns failures expose localized network resources instead of hostnames`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()
        val dnsFailure = UnknownHostException("api-test.example.com")

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } throws dnsFailure
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } throws dnsFailure
        coEvery { sharedRepo.listSharedWithMe("org-1") } throws dnsFailure

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-1")

        assertEquals(R.string.error_network, viewModel.uiState.value.errorRes)
        assertEquals(R.string.error_network, viewModel.uiState.value.sharedErrorRes)
    }

    @Test
    fun `recent items exclude never-visited and non cloud-doc types`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } returns treeResponse("1")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } returns listOf(
            recentResource("visited", lastVisitedAt = "2026-07-22T00:00:00Z"),
            recentResource("never", lastVisitedAt = null),
            SpaceResource(
                id = "item-slide",
                itemType = "tabslide",
                title = "幻灯片",
                resourceId = "slide-1",
                organizationId = "org-1",
                lastVisitedAt = "2026-07-23T00:00:00Z",
            ),
        )
        coEvery { sharedRepo.listSharedWithMe("org-1") } returns emptyList()

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-1")

        assertEquals(listOf("item-visited"), viewModel.uiState.value.recentItems.map { it.id })
    }

    @Test
    fun `recordAccess updates local lastVisitedAt and skips shared ids`() {
        val spaceRepo = mockk<SpaceResourceRepository>(relaxed = true)
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } returns treeResponse("1")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } returns listOf(
            recentResource("1", lastVisitedAt = "2026-01-01T00:00:00Z"),
        )
        coEvery { sharedRepo.listSharedWithMe("org-1") } returns emptyList()

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        viewModel.load("org-1")

        viewModel.recordAccess("shared:doc:x")
        coVerify(exactly = 0) { spaceRepo.recordAccess(any()) }

        viewModel.recordAccess("item-1")
        val visited = viewModel.uiState.value.allRecentItems.single().lastVisitedAt
        assertTrue(!visited.isNullOrEmpty())
        assertTrue(visited != "2026-01-01T00:00:00Z")
        coVerify(exactly = 1) { spaceRepo.recordAccess("item-1") }
    }

    @Test
    fun `create resources use nonblank localized default names`() {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository()
        val cloudDriveRepo = mockk<CloudDriveRepository>()
        val context = mockk<Context>()

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } returns treeResponse("1")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } returns emptyList()
        coEvery { sharedRepo.listSharedWithMe("org-1") } returns emptyList()
        every { context.getString(R.string.cloud_drive_untitled_doc) } returns "未命名文档"
        every { context.getString(R.string.cloud_drive_untitled_table) } returns "未命名表格"
        coEvery {
            cloudDriveRepo.createDocument("org-1", "未命名文档", null)
        } returns DocDetailResponse(
            document = Doc(id = "doc-1", organizationId = "org-1", title = "未命名文档"),
        )
        coEvery {
            cloudDriveRepo.createTable("org-1", "未命名表格", null)
        } returns CreateTableResponse(id = "table-1", name = "未命名表格")

        val viewModel = CloudDocsViewModel(spaceRepo, sharedRepo, orgRepo, cloudDriveRepo, context)
        viewModel.load("org-1")
        viewModel.create(CloudDocsCreateKind.DOCUMENT)
        viewModel.create(CloudDocsCreateKind.TABLE)

        coVerify(exactly = 1) {
            cloudDriveRepo.createDocument("org-1", "未命名文档", null)
        }
        coVerify(exactly = 1) {
            cloudDriveRepo.createTable("org-1", "未命名表格", null)
        }
    }

    @Test
    fun `submitPendingOpen navigates after selecting organization`() = runTest {
        val spaceRepo = mockk<SpaceResourceRepository>(relaxed = true)
        val sharedRepo = mockk<SharedResourcesRepository>()
        val org = Organization(id = "org-1", name = "Org")
        val orgs = MutableStateFlow(listOf(org))
        val selected = MutableStateFlow<Organization?>(null)
        val orgRepo = mockk<OrganizationRepository>()
        every { orgRepo.organizations } returns orgs
        every { orgRepo.selectedOrganization } returns selected
        coEvery { orgRepo.loadOrganizations() } returns Unit
        coEvery { orgRepo.selectOrganization(org) } answers { selected.value = org }

        coEvery { spaceRepo.getKnowledgeTree("org-1", any(), any()) } returns treeResponse("1")
        coEvery { spaceRepo.getRecentOrganizationResources("org-1") } returns listOf(
            recentResource("1", lastVisitedAt = "2026-07-20T00:00:00Z"),
        )
        coEvery { sharedRepo.listSharedWithMe("org-1") } returns emptyList()

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        val eventDeferred = CompletableDeferred<CloudDocsOpenEvent>()
        val collectJob = launch {
            eventDeferred.complete(viewModel.openEvents.first())
        }

        viewModel.submitPendingOpen(
            CloudDocsPendingOpen(
                organizationId = "org-1",
                spaceId = "space-1",
                resourceType = "tabdoc",
                resourceId = "doc-1",
                title = "Doc",
            ),
        )

        val event = eventDeferred.await()
        collectJob.cancel()
        assertTrue(event is CloudDocsOpenEvent.Navigate)
        event as CloudDocsOpenEvent.Navigate
        assertEquals("doc-1", event.resource.resourceId)
        assertEquals("org-1", selected.value?.id)
        coVerify(exactly = 1) { orgRepo.selectOrganization(org) }
    }

    @Test
    fun `submitPendingOpen reports organization unavailable`() = runTest {
        val spaceRepo = mockk<SpaceResourceRepository>()
        val sharedRepo = mockk<SharedResourcesRepository>()
        val orgRepo = mockOrganizationRepository(organizations = emptyList())

        val viewModel = CloudDocsViewModel(
            spaceRepo, sharedRepo, orgRepo, mockk(relaxed = true), mockk(relaxed = true),
        )
        val eventDeferred = CompletableDeferred<CloudDocsOpenEvent>()
        val collectJob = launch {
            eventDeferred.complete(viewModel.openEvents.first())
        }

        viewModel.submitPendingOpen(
            CloudDocsPendingOpen(
                organizationId = "missing-org",
                spaceId = "space-1",
                resourceType = "tabdoc",
                resourceId = "doc-1",
            ),
        )

        val event = eventDeferred.await()
        collectJob.cancel()
        assertTrue(event is CloudDocsOpenEvent.Notice)
        assertEquals(
            CloudDocsOpenNotice.OrganizationUnavailable,
            (event as CloudDocsOpenEvent.Notice).notice,
        )
    }

    private fun mockOrganizationRepository(
        organizations: List<Organization> = listOf(Organization(id = "org-1", name = "Org")),
        selected: Organization? = organizations.firstOrNull(),
    ): OrganizationRepository {
        val orgRepo = mockk<OrganizationRepository>()
        every { orgRepo.organizations } returns MutableStateFlow(organizations)
        every { orgRepo.selectedOrganization } returns MutableStateFlow(selected)
        coEvery { orgRepo.loadOrganizations() } returns Unit
        coEvery { orgRepo.selectOrganization(any()) } returns Unit
        return orgRepo
    }

    private fun treeResponse(suffix: String): KnowledgeTreeResponse = KnowledgeTreeResponse(
        organizationId = "org-$suffix",
        roots = listOf(
            KnowledgeTreeNode(
                id = "n-$suffix",
                nodeType = KnowledgeTreeNodeType.TABDOC,
                resourceId = "doc-$suffix",
                contextItemId = "item-$suffix",
                title = "文档 $suffix",
                childCount = 0,
                children = emptyList(),
            ),
        ),
    )

    private fun recentResource(
        suffix: String,
        lastVisitedAt: String?,
        isPinned: Boolean = false,
    ): SpaceResource = SpaceResource(
        id = "item-$suffix",
        itemType = "tabdoc",
        title = "文档 $suffix",
        resourceId = "doc-$suffix",
        organizationId = "org-$suffix",
        lastVisitedAt = lastVisitedAt,
        isPinned = isPinned,
        canShare = null,
    )

    private fun sharedItem(suffix: String): SharedResourceItem = SharedResourceItem(
        resourceType = SharedResourceType.DOC,
        resourceId = "doc-$suffix",
        title = "分享 $suffix",
        organizationId = "org-$suffix",
        spaceId = null,
        permission = "viewer",
        updatedAt = "2026-07-20T00:00:00Z",
        sharedBy = null,
    )
}
