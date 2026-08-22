package com.tabtin.mobile.features.clouddocs

import com.tabtin.mobile.data.model.CloudDocShare
import com.tabtin.mobile.data.model.CloudDocsShareError
import com.tabtin.mobile.data.model.CloudSharePermission
import com.tabtin.mobile.data.model.CloudShareResourceType
import com.tabtin.mobile.data.model.CloudShareScope
import com.tabtin.mobile.data.repository.CloudDocsShareService
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CloudDocsShareSheetViewModelTest {

    private val shareService = mockk<CloudDocsShareService>()
    private val organizationRepository = mockk<OrganizationRepository>(relaxed = true)
    private val tokenManager = mockk<TokenManager>(relaxed = true)
    private lateinit var viewModel: CloudDocsShareSheetViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        every { shareService.publicUrl(any(), any()) } answers {
            "https://web.example/shared/docs/${firstArg<String>()}"
        }
        every { tokenManager.organizationId } returns null
        viewModel = CloudDocsShareSheetViewModel(shareService, organizationRepository, tokenManager)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `loadPhaseForError maps 401-like Other to failed not forbidden`() {
        assertEquals(
            CloudDocsShareLoadPhase.FAILED,
            CloudDocsShareSheetLogic.loadPhaseForError(CloudDocsShareError.Other("unauthorized")),
        )
        assertEquals(
            CloudDocsShareLoadPhase.FORBIDDEN,
            CloudDocsShareSheetLogic.loadPhaseForError(CloudDocsShareError.Forbidden),
        )
    }

    @Test
    fun `scope and permission helpers prefer server snapshot`() {
        val share = sampleShare(shareType = "public", permission = "edit", visitCount = 3)
        assertEquals(
            CloudShareScope.ANYONE,
            CloudDocsShareSheetLogic.scopeFromShare(share, CloudShareResourceType.DOCUMENT),
        )
        assertEquals(
            CloudSharePermission.EDIT,
            CloudDocsShareSheetLogic.permissionFromShare(share, CloudShareResourceType.DOCUMENT),
        )
        // table 无 comment → 退回可用首位 view
        assertEquals(
            CloudSharePermission.VIEW,
            CloudDocsShareSheetLogic.permissionFromShare(
                sampleShare(shareType = "organization", permission = "comment"),
                CloudShareResourceType.TABLE,
            ),
        )
    }

    @Test
    fun `load forbidden keeps phase distinct from failed`() {
        coEvery { shareService.fetch(CloudShareResourceType.DOCUMENT, "doc-1") } throws
            CloudDocsShareError.Forbidden

        viewModel.load(target("doc-1"))

        assertEquals(CloudDocsShareLoadPhase.FORBIDDEN, viewModel.uiState.value.loadPhase)
        assertNull(viewModel.uiState.value.share)
    }

    @Test
    fun `load other error including unauthorized is failed not forbidden`() {
        coEvery { shareService.fetch(CloudShareResourceType.DOCUMENT, "doc-1") } throws
            CloudDocsShareError.Other("token expired")

        viewModel.load(target("doc-1"))

        assertEquals(CloudDocsShareLoadPhase.FAILED, viewModel.uiState.value.loadPhase)
    }

    @Test
    fun `enable link defaults to organization view`() {
        coEvery { shareService.fetch(any(), any()) } returns null
        coEvery {
            shareService.upsert(
                type = CloudShareResourceType.DOCUMENT,
                resourceId = "doc-1",
                scope = CloudShareScope.ORGANIZATION,
                permission = CloudSharePermission.VIEW,
                password = null,
                acknowledgePublicExposure = false,
            )
        } returns sampleShare()

        viewModel.load(target("doc-1"))
        viewModel.setLinkEnabled(true)

        assertTrue(viewModel.uiState.value.isLinkEnabled)
        assertEquals(CloudShareScope.ORGANIZATION, viewModel.uiState.value.currentScope)
        assertEquals(CloudSharePermission.VIEW, viewModel.uiState.value.currentPermission)
        coVerify(exactly = 1) {
            shareService.upsert(
                type = CloudShareResourceType.DOCUMENT,
                resourceId = "doc-1",
                scope = CloudShareScope.ORGANIZATION,
                permission = CloudSharePermission.VIEW,
                password = null,
                acknowledgePublicExposure = false,
            )
        }
    }

    @Test
    fun `select anyone only shows confirm and does not upsert`() {
        coEvery { shareService.fetch(any(), any()) } returns sampleShare()

        viewModel.load(target("doc-1"))
        viewModel.selectScope(CloudShareScope.ANYONE)

        assertTrue(viewModel.uiState.value.showAnyoneConfirm)
        assertEquals(CloudShareScope.ORGANIZATION, viewModel.uiState.value.currentScope)
        coVerify(exactly = 0) {
            shareService.upsert(any(), any(), any(), any(), any(), any())
        }
    }

    @Test
    fun `confirm anyone upserts with acknowledge flag`() {
        coEvery { shareService.fetch(any(), any()) } returns sampleShare()
        coEvery {
            shareService.upsert(
                type = CloudShareResourceType.DOCUMENT,
                resourceId = "doc-1",
                scope = CloudShareScope.ANYONE,
                permission = CloudSharePermission.VIEW,
                password = null,
                acknowledgePublicExposure = true,
            )
        } returns sampleShare(shareType = "public")

        viewModel.load(target("doc-1"))
        viewModel.confirmAnyoneScope()

        assertFalse(viewModel.uiState.value.showAnyoneConfirm)
        assertEquals(CloudShareScope.ANYONE, viewModel.uiState.value.currentScope)
        coVerify(exactly = 1) {
            shareService.upsert(
                type = CloudShareResourceType.DOCUMENT,
                resourceId = "doc-1",
                scope = CloudShareScope.ANYONE,
                permission = CloudSharePermission.VIEW,
                password = null,
                acknowledgePublicExposure = true,
            )
        }
    }

    @Test
    fun `apply password sends non-null value clear sends empty string`() {
        coEvery { shareService.fetch(any(), any()) } returns sampleShare(hasPassword = false)
        val passwordSlot = slot<String?>()
        coEvery {
            shareService.upsert(any(), any(), any(), any(), captureNullable(passwordSlot), any())
        } returns sampleShare(hasPassword = true)

        viewModel.load(target("doc-1"))
        viewModel.setPasswordDraft("secret")
        viewModel.applyPassword()
        assertEquals("secret", passwordSlot.captured)

        coEvery { shareService.fetch(any(), any()) } returns sampleShare(hasPassword = true)
        viewModel.load(target("doc-1"))
        coEvery {
            shareService.upsert(any(), any(), any(), any(), captureNullable(passwordSlot), any())
        } returns sampleShare(hasPassword = false)
        viewModel.clearPassword()
        assertEquals("", passwordSlot.captured)
    }

    @Test
    fun `refresh failure reconciles with fetch`() {
        coEvery { shareService.fetch(any(), any()) } returnsMany listOf(
            sampleShare(shareId = "old"),
            null, // reconcile after failure → share cleared
        )
        coEvery {
            shareService.refresh(any(), any(), any(), any())
        } throws CloudDocsShareError.Other("refresh blew up")

        viewModel.load(target("doc-1"))
        assertEquals("old", viewModel.uiState.value.share?.shareId)

        viewModel.confirmRefreshLink()

        assertNull(viewModel.uiState.value.share)
        assertEquals(CloudDocsShareMutationError.UPDATE_FAILED, viewModel.uiState.value.updateError)
        coVerify(exactly = 2) { shareService.fetch(CloudShareResourceType.DOCUMENT, "doc-1") }
        coVerify(exactly = 1) {
            shareService.refresh(
                CloudShareResourceType.DOCUMENT,
                "doc-1",
                CloudShareScope.ORGANIZATION,
                CloudSharePermission.VIEW,
            )
        }
    }

    @Test
    fun `public exposure ack required reopens anyone confirm without changing share`() {
        coEvery { shareService.fetch(any(), any()) } returns sampleShare()
        coEvery {
            shareService.upsert(
                type = any(),
                resourceId = any(),
                scope = CloudShareScope.ANYONE,
                permission = any(),
                password = any(),
                acknowledgePublicExposure = true,
            )
        } throws CloudDocsShareError.PublicExposureNotAcknowledged

        viewModel.load(target("doc-1"))
        viewModel.confirmAnyoneScope()

        assertTrue(viewModel.uiState.value.showAnyoneConfirm)
        assertEquals(CloudShareScope.ORGANIZATION, viewModel.uiState.value.currentScope)
        assertNull(viewModel.uiState.value.updateError)
    }

    @Test
    fun `table permission picker excludes comment`() {
        assertEquals(
            listOf(CloudSharePermission.VIEW, CloudSharePermission.EDIT),
            CloudShareResourceType.TABLE.availablePermissions,
        )
        assertTrue(
            CloudSharePermission.COMMENT in CloudShareResourceType.DOCUMENT.availablePermissions,
        )
    }

    private fun target(id: String) = CloudDocsShareTarget(
        resourceId = id,
        type = CloudShareResourceType.DOCUMENT,
        title = "Doc",
    )

    private fun sampleShare(
        shareId: String = "share-1",
        shareType: String = "organization",
        permission: String = "view",
        hasPassword: Boolean = false,
        visitCount: Int? = null,
    ) = CloudDocShare(
        shareId = shareId,
        shareType = shareType,
        permission = permission,
        hasPassword = hasPassword,
        visitCount = visitCount,
    )
}
