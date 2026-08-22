package com.tabtin.mobile.features.profile

import com.tabtin.mobile.data.model.InvitationRespondResponse
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.data.repository.OrganizationRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
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
class OrganizationInvitationsViewModelTest {
    private val repository = mockk<OrganizationRepository>(relaxed = true)
    private val invitationUpdates = MutableSharedFlow<Unit>()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        every { repository.invitationUpdates } returns invitationUpdates
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `initial load exposes account invitations`() {
        coEvery { repository.getMyPendingInvitations() } returns
            Result.success(listOf(invitation()))

        val viewModel = OrganizationInvitationsViewModel(repository)

        assertFalse(viewModel.uiState.isLoading)
        assertEquals(listOf("invite-1"), viewModel.uiState.invitations.map { it.id })
        assertFalse(viewModel.uiState.loadFailed)
    }

    @Test
    fun `accept removes invitation and refreshes organizations`() {
        coEvery { repository.getMyPendingInvitations() } returns
            Result.success(listOf(invitation()))
        coEvery { repository.respondToInvitation("invite-1", true) } returns Result.success(
            InvitationRespondResponse(
                organizationId = "org-new",
                status = "accepted",
            ),
        )

        val viewModel = OrganizationInvitationsViewModel(repository)
        viewModel.respondToInvitation("invite-1", accept = true)

        assertEquals(emptyList<PendingInvitation>(), viewModel.uiState.invitations)
        assertNull(viewModel.uiState.respondingInvitationId)
        coVerify(exactly = 1) { repository.loadOrganizations() }
    }

    @Test
    fun `load failure exits loading into retryable failure state`() {
        coEvery { repository.getMyPendingInvitations() } returns
            Result.failure(IllegalStateException("Unable to resolve host api-test.example.com"))

        val viewModel = OrganizationInvitationsViewModel(repository)

        assertFalse(viewModel.uiState.isLoading)
        assertTrue(viewModel.uiState.loadFailed)
        assertEquals(emptyList<PendingInvitation>(), viewModel.uiState.invitations)
    }

    private fun invitation(): PendingInvitation = PendingInvitation(
        id = "invite-1",
        organizationId = "org-new",
        organizationName = "测试组织",
        invitedBy = "user-1",
        invitedByName = "邀请人",
        role = "editor",
        status = "pending",
        expiresAt = "2026-08-22T00:00:00Z",
        createdAt = "2026-08-21T00:00:00Z",
    )
}
