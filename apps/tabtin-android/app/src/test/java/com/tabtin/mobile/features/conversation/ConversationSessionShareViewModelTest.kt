package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.im.ImApi
import com.tabtin.mobile.data.im.ImConversationService
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.model.MemberUser
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.TokenManager
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConversationSessionShareViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `latest search wins even when cancelled request returns later`() = runTest(testDispatcher) {
        val repository = mockk<OrganizationRepository>()
        val oldResult = CompletableDeferred<List<OrganizationMember>>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("initial"))
        coEvery { repository.loadMembers("org-1", "old", "nickname") } coAnswers {
            withContext(NonCancellable) { oldResult.await() }
        }
        coEvery { repository.loadMembers("org-1", "new", "nickname") } returns listOf(member("new"))
        val viewModel = viewModel(repository)

        viewModel.activate("session-1", "org-1")
        advanceUntilIdle()
        viewModel.setQuery("old")
        advanceTimeBy(250)
        runCurrent()
        viewModel.setQuery("new")
        advanceTimeBy(250)
        runCurrent()

        assertEquals("new", viewModel.uiState.value.query)
        assertEquals(listOf("new"), viewModel.uiState.value.members.map { it.userId })

        oldResult.complete(listOf(member("old")))
        advanceUntilIdle()

        assertEquals("new", viewModel.uiState.value.query)
        assertEquals(listOf("new"), viewModel.uiState.value.members.map { it.userId })
        assertFalse(viewModel.uiState.value.isSearching)
    }

    @Test
    fun `search failure keeps query and searchable loaded state`() = runTest(testDispatcher) {
        val repository = mockk<OrganizationRepository>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("initial"))
        coEvery { repository.loadMembers("org-1", "hu", "nickname") } throws
            IllegalStateException("private transport detail")
        val viewModel = viewModel(repository)

        viewModel.activate("session-1", "org-1")
        advanceUntilIdle()
        viewModel.selectRecipient("initial")
        viewModel.setQuery("hu")
        advanceTimeBy(250)
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("hu", state.query)
        assertTrue(state.hasLoadedRecipients)
        assertFalse(state.isLoading)
        assertFalse(state.isSearching)
        assertEquals("搜索组织成员失败，请稍后重试。", state.searchError)
        assertTrue(state.members.isEmpty())
        assertEquals(null, state.selectedUserId)
    }

    @Test
    fun `search result never preserves a recipient hidden by the result`() = runTest(testDispatcher) {
        val repository = mockk<OrganizationRepository>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("initial"))
        coEvery { repository.loadMembers("org-1", "new", "nickname") } returns listOf(member("new"))
        val viewModel = viewModel(repository)

        viewModel.activate("session-1", "org-1")
        advanceUntilIdle()
        viewModel.selectRecipient("initial")
        viewModel.setQuery("new")
        advanceTimeBy(250)
        advanceUntilIdle()

        assertEquals(listOf("new"), viewModel.uiState.value.members.map { it.userId })
        assertEquals(null, viewModel.uiState.value.selectedUserId)
    }

    @Test
    fun `reset prevents an in flight search from restoring stale state`() = runTest(testDispatcher) {
        val repository = mockk<OrganizationRepository>()
        val slowResult = CompletableDeferred<List<OrganizationMember>>()
        coEvery { repository.loadMembers("org-1", null, null) } returns listOf(member("initial"))
        coEvery { repository.loadMembers("org-1", "slow", "nickname") } coAnswers {
            withContext(NonCancellable) { slowResult.await() }
        }
        val viewModel = viewModel(repository)

        viewModel.activate("session-1", "org-1")
        advanceUntilIdle()
        viewModel.setQuery("slow")
        advanceTimeBy(250)
        runCurrent()
        viewModel.reset()
        slowResult.complete(listOf(member("stale")))
        advanceUntilIdle()

        assertEquals(ConversationSessionShareUiState(), viewModel.uiState.value)
    }

    private fun viewModel(repository: OrganizationRepository): ConversationSessionShareViewModel {
        val tokenManager = mockk<TokenManager>()
        every { tokenManager.userId } returns "me"
        return ConversationSessionShareViewModel(
            organizationRepository = repository,
            imApi = mockk<ImApi>(relaxed = true),
            imConversationStore = mockk<ImConversationStore>(relaxed = true),
            imConversationService = mockk<ImConversationService>(relaxed = true),
            tokenManager = tokenManager,
        )
    }

    private fun member(userId: String): OrganizationMember = OrganizationMember(
        id = "member-$userId",
        userId = userId,
        role = OrganizationRole.VIEWER,
        user = MemberUser(
            id = userId,
            nickname = userId,
            username = userId,
        ),
    )
}
