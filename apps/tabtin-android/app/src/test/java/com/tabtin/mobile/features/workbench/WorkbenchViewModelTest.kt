package com.tabtin.mobile.features.workbench

import android.content.Context
import android.util.Log
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.CloudDocsCollaboratorsResponse
import com.tabtin.mobile.data.model.CloudDocsOwner
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.model.doc.DocDetailResponse
import com.tabtin.mobile.data.model.files.CreateTableResponse
import com.tabtin.mobile.data.repository.CloudDriveRepository
import com.tabtin.mobile.data.repository.CloudDocsShareService
import com.tabtin.mobile.data.repository.DocRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SharedResourcesRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.SpaceResourceRepository
import com.tabtin.mobile.data.websocket.StreamManager
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkbenchViewModelTest {

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        mockkStatic(Log::class)
        every { Log.w(any(), any<String>(), any<Throwable>()) } returns 0
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(Log::class)
    }

    @Test
    fun `failed document creation shows a retryable error instead of silently completing`() {
        val docRepository = mockk<DocRepository>()
        coEvery { docRepository.createDocument("", null) } throws
            AppError.RequestFailed("Document quota exceeded")
        val viewModel = WorkbenchViewModel(
            repository = mockk<SpaceResourceRepository>(relaxed = true),
            spaceRepository = mockk<SpaceRepository>(relaxed = true),
            docRepository = docRepository,
            cloudDriveRepository = mockk<CloudDriveRepository>(relaxed = true),
            cloudDocsShareService = mockk<CloudDocsShareService>(relaxed = true),
            sharedResourcesRepository = mockk<SharedResourcesRepository>(relaxed = true),
            contextApi = mockk<ContextApi>(relaxed = true),
            organizationRepository = mockk<OrganizationRepository>(relaxed = true),
            embeddedWebAuthCoordinator = mockk(relaxed = true),
            streamManager = mockk<StreamManager>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
            context = mockk(relaxed = true),
        )
        var createdDocumentId: String? = null

        viewModel.createDocument("space-1") { createdDocumentId = it }

        assertFalse(viewModel.uiState.value.isCreatingDoc)
        assertEquals(R.string.doc_error_create_failed, viewModel.uiState.value.createDocumentErrorRes)
        assertEquals(null, createdDocumentId)
        coVerify(exactly = 1) { docRepository.createDocument("", null) }

        viewModel.consumeCreateDocumentError()

        assertEquals(null, viewModel.uiState.value.createDocumentErrorRes)

        viewModel.createDocument("space-1") { createdDocumentId = it }

        assertFalse(viewModel.uiState.value.isCreatingDoc)
        coVerify(exactly = 2) { docRepository.createDocument("", null) }
    }

    @Test
    fun `blank tabdata creation sends a localized non-empty table name`() {
        val cloudDriveRepository = mockk<CloudDriveRepository>()
        val context = mockk<Context>()
        every { context.getString(R.string.cloud_drive_untitled_table) } returns "未命名表格"
        coEvery {
            cloudDriveRepository.createTable("org-1", any(), null)
        } returns CreateTableResponse(
            id = "table-1",
            name = "未命名表格",
            organizationId = "org-1",
        )
        val viewModel = WorkbenchViewModel(
            repository = mockk<SpaceResourceRepository>(relaxed = true),
            spaceRepository = mockk<SpaceRepository>(relaxed = true),
            docRepository = mockk<DocRepository>(relaxed = true),
            cloudDriveRepository = cloudDriveRepository,
            cloudDocsShareService = mockk<CloudDocsShareService>(relaxed = true),
            sharedResourcesRepository = mockk<SharedResourcesRepository>(relaxed = true),
            contextApi = mockk<ContextApi>(relaxed = true),
            organizationRepository = mockk<OrganizationRepository>(relaxed = true),
            embeddedWebAuthCoordinator = mockk(relaxed = true),
            streamManager = mockk<StreamManager>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
            context = context,
        )
        var created: Triple<String, String, String>? = null

        viewModel.createBlankTaskResource(WorkbenchAppHomeKind.TABDATA, "org-1") { type, id, title ->
            created = Triple(type, id, title)
        }

        coVerify(exactly = 1) {
            cloudDriveRepository.createTable("org-1", "未命名表格", null)
        }
        assertEquals(Triple("tabdata", "table-1", "未命名表格"), created)
        assertFalse(viewModel.uiState.value.isCreatingBlank)
    }

    @Test
    fun `failed tabdata creation reports a table-specific error`() {
        val cloudDriveRepository = mockk<CloudDriveRepository>()
        val context = mockk<Context>()
        every { context.getString(R.string.cloud_drive_untitled_table) } returns "未命名表格"
        coEvery {
            cloudDriveRepository.createTable("org-1", "未命名表格", null)
        } throws AppError.RequestFailed("HTTP 400")
        val viewModel = WorkbenchViewModel(
            repository = mockk<SpaceResourceRepository>(relaxed = true),
            spaceRepository = mockk<SpaceRepository>(relaxed = true),
            docRepository = mockk<DocRepository>(relaxed = true),
            cloudDriveRepository = cloudDriveRepository,
            cloudDocsShareService = mockk<CloudDocsShareService>(relaxed = true),
            sharedResourcesRepository = mockk<SharedResourcesRepository>(relaxed = true),
            contextApi = mockk<ContextApi>(relaxed = true),
            organizationRepository = mockk<OrganizationRepository>(relaxed = true),
            embeddedWebAuthCoordinator = mockk(relaxed = true),
            streamManager = mockk<StreamManager>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
            context = context,
        )

        viewModel.createBlankTaskResource(WorkbenchAppHomeKind.TABDATA, "org-1") { _, _, _ -> }

        assertEquals(
            R.string.workbench_tabdata_create_failed,
            viewModel.uiState.value.createDocumentErrorRes,
        )
        assertFalse(viewModel.uiState.value.isCreatingBlank)
    }

    @Test
    fun `app home loads real collaborator snapshot for the continue resource`() {
        val shareService = mockk<CloudDocsShareService>()
        coEvery {
            shareService.collaborators(CloudShareResourceType.TABLE, "table-1")
        } returns CloudDocsCollaboratorsResponse(
            owner = CloudDocsOwner(userId = "owner-1", nickname = "Owner"),
        )
        val viewModel = WorkbenchViewModel(
            repository = mockk<SpaceResourceRepository>(relaxed = true),
            spaceRepository = mockk<SpaceRepository>(relaxed = true),
            docRepository = mockk<DocRepository>(relaxed = true),
            cloudDriveRepository = mockk<CloudDriveRepository>(relaxed = true),
            cloudDocsShareService = shareService,
            sharedResourcesRepository = mockk<SharedResourcesRepository>(relaxed = true),
            contextApi = mockk<ContextApi>(relaxed = true),
            organizationRepository = mockk<OrganizationRepository>(relaxed = true),
            embeddedWebAuthCoordinator = mockk(relaxed = true),
            streamManager = mockk<StreamManager>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
            context = mockk(relaxed = true),
        )

        viewModel.loadAppHomeCollaboration(WorkbenchAppHomeKind.TABDATA, "table-1")

        val state = viewModel.uiState.value.appHomeCollaborations["tabdata:table-1"]
        assertTrue(state is TaskResourceCollaborationState.Loaded)
        assertEquals(
            listOf("owner-1"),
            (state as TaskResourceCollaborationState.Loaded).people.map { it.id },
        )
        coVerify(exactly = 1) {
            shareService.collaborators(CloudShareResourceType.TABLE, "table-1")
        }
    }

    @Test
    fun `document quota error keeps usage details for the dedicated prompt`() {
        val docRepository = mockk<DocRepository>()
        coEvery { docRepository.createDocument("", null) } throws
            AppError.DocumentQuotaExceeded(used = 10, limit = 10)
        val viewModel = WorkbenchViewModel(
            repository = mockk<SpaceResourceRepository>(relaxed = true),
            spaceRepository = mockk<SpaceRepository>(relaxed = true),
            docRepository = docRepository,
            cloudDriveRepository = mockk<CloudDriveRepository>(relaxed = true),
            cloudDocsShareService = mockk<CloudDocsShareService>(relaxed = true),
            sharedResourcesRepository = mockk<SharedResourcesRepository>(relaxed = true),
            contextApi = mockk<ContextApi>(relaxed = true),
            organizationRepository = mockk<OrganizationRepository>(relaxed = true),
            embeddedWebAuthCoordinator = mockk(relaxed = true),
            streamManager = mockk<StreamManager>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
            context = mockk(relaxed = true),
        )

        viewModel.createDocument("space-1") {}

        assertEquals(null, viewModel.uiState.value.createDocumentErrorRes)
        assertEquals(
            AppError.DocumentQuotaExceeded(used = 10, limit = 10),
            viewModel.uiState.value.createDocumentQuotaExceeded,
        )

        viewModel.dismissCreateDocumentQuotaExceeded()

        assertEquals(null, viewModel.uiState.value.createDocumentQuotaExceeded)
    }

    @Test
    fun `organization-owned document creation opens the document and refreshes workbench resources`() {
        val docRepository = mockk<DocRepository>()
        val resourceRepository = mockk<SpaceResourceRepository>()
        coEvery { resourceRepository.getResources("space-1") } returns emptyList()
        coEvery { docRepository.createDocument("", null) } returns DocDetailResponse(
            document = Doc(
                id = "doc-1",
                organizationId = "org-1",
                spaceId = null,
                title = "未命名文档",
            ),
        )
        val viewModel = WorkbenchViewModel(
            repository = resourceRepository,
            spaceRepository = mockk<SpaceRepository>(relaxed = true),
            docRepository = docRepository,
            cloudDriveRepository = mockk<CloudDriveRepository>(relaxed = true),
            cloudDocsShareService = mockk<CloudDocsShareService>(relaxed = true),
            sharedResourcesRepository = mockk<SharedResourcesRepository>(relaxed = true),
            contextApi = mockk<ContextApi>(relaxed = true),
            organizationRepository = mockk<OrganizationRepository>(relaxed = true),
            embeddedWebAuthCoordinator = mockk(relaxed = true),
            streamManager = mockk<StreamManager>(relaxed = true),
            tokenManager = mockk<TokenManager>(relaxed = true),
            context = mockk(relaxed = true),
        )
        var createdDocumentId: String? = null

        viewModel.loadResources("space-1")
        viewModel.createDocument("space-1") { createdDocumentId = it }

        assertEquals("doc-1", createdDocumentId)
        assertFalse(viewModel.uiState.value.isCreatingDoc)
        assertEquals(null, viewModel.uiState.value.createDocumentErrorRes)
        coVerify(exactly = 2) { resourceRepository.getResources("space-1") }
    }
}
