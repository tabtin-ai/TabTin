package com.tabtin.mobile.navigation

import com.tabtin.mobile.data.im.ImConversation
import com.tabtin.mobile.data.im.ImConversationDataPlane
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.repository.OrganizationRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppNavigationViewModelTest {
    @Test
    fun `im notification resolves receiver directory before selecting organization`() = runTest {
        val current = organization("current")
        val hinted = organization("sender-hint")
        val receiver = organization("receiver")
        val selected = MutableStateFlow<Organization?>(current)
        val repository = repository(listOf(current, hinted, receiver), selected)
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.listConversations("current") } returns emptyList()
        coEvery { dataPlane.listConversations("sender-hint") } returns emptyList()
        coEvery { dataPlane.listConversations("receiver") } returns listOf(ImConversation(id = "conversation-7"))
        coEvery { repository.selectOrganization(receiver) } coAnswers { selected.value = receiver }
        val viewModel = AppNavigationViewModel(repository, dataPlane)

        assertTrue(viewModel.selectImNotificationOrganization("conversation-7", "sender-hint"))

        assertEquals("receiver", selected.value?.id)
        coVerify(ordering = io.mockk.Ordering.ORDERED) {
            dataPlane.listConversations("current")
            dataPlane.listConversations("sender-hint")
            dataPlane.listConversations("receiver")
        }
    }

    @Test
    fun `im notification candidate organizations are de duplicated`() = runTest {
        val current = organization("current")
        val other = organization("other")
        val selected = MutableStateFlow<Organization?>(current)
        val repository = repository(listOf(current, other), selected)
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.listConversations("current") } returns emptyList()
        coEvery { dataPlane.listConversations("other") } returns listOf(ImConversation(id = "conversation-7"))
        coEvery { repository.selectOrganization(other) } coAnswers { selected.value = other }
        val viewModel = AppNavigationViewModel(repository, dataPlane)

        assertTrue(viewModel.selectImNotificationOrganization("conversation-7", "current"))

        coVerify(exactly = 1) { dataPlane.listConversations("current") }
        coVerify(exactly = 1) { dataPlane.listConversations("other") }
    }

    @Test
    fun `im notification lookup failure does not select sender hint`() = runTest {
        val current = organization("current")
        val hinted = organization("sender-hint")
        val selected = MutableStateFlow<Organization?>(current)
        val repository = repository(listOf(current, hinted), selected)
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.listConversations("current") } throws IllegalStateException("offline")
        val viewModel = AppNavigationViewModel(repository, dataPlane)

        assertFalse(viewModel.selectImNotificationOrganization("conversation-7", "sender-hint"))

        assertEquals("current", selected.value?.id)
        coVerify(exactly = 0) { repository.selectOrganization(any()) }
    }

    @Test
    fun `im notification lookup preserves navigation cancellation`() = runTest {
        val current = organization("current")
        val selected = MutableStateFlow<Organization?>(current)
        val repository = repository(listOf(current), selected)
        val dataPlane = mockk<ImConversationDataPlane>(relaxed = true)
        coEvery { dataPlane.listConversations("current") } throws
            CancellationException("new notification superseded this route")
        val viewModel = AppNavigationViewModel(repository, dataPlane)

        try {
            viewModel.selectImNotificationOrganization("conversation-7", "current")
            throw AssertionError("expected navigation cancellation")
        } catch (_: CancellationException) {
            // Cancellation must reach LaunchedEffect so a stale route cannot
            // consume a newer target.
        }

        assertEquals("current", selected.value?.id)
        coVerify(exactly = 0) { repository.selectOrganization(any()) }
    }

    private fun repository(
        organizations: List<Organization>,
        selected: MutableStateFlow<Organization?>,
    ): OrganizationRepository = mockk<OrganizationRepository> {
        every { this@mockk.organizations } returns MutableStateFlow(organizations)
        every { selectedOrganization } returns selected
        every { error } returns MutableStateFlow(null)
        every { organizationAccessRevokedNotice } returns MutableStateFlow(null)
        coEvery { loadOrganizations() } returns Unit
    }

    private fun organization(id: String): Organization = Organization(id = id, name = id)
}
