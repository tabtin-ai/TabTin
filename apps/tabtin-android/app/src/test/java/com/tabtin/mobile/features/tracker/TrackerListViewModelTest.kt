package com.tabtin.mobile.features.tracker

import androidx.lifecycle.SavedStateHandle
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.TrackerRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
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
class TrackerListViewModelTest {

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `project list and create use their distinct scopes`() {
        val trackerRepository = mockk<TrackerRepository>()
        val chatRepository = mockk<ChatRepository>()
        val webSocketService = mockk<WebSocketService>(relaxed = true)
        coEvery { chatRepository.getSession("session-1") } returns projectSession()
        coEvery { trackerRepository.getEvents("workspace-1") } returns emptyList()
        coEvery {
            trackerRepository.createEvent(
                name = "日报",
                description = "汇总今天的工作",
                hostSpaceId = "project-1",
                workspaceId = "workspace-1",
                agentId = "agent-1",
            )
        } returns Tracker(id = "tracker-1", name = "日报")

        val viewModel = TrackerListViewModel(
            savedStateHandle = SavedStateHandle(
                mapOf(
                    "spaceId" to "project-1",
                    "sessionId" to "session-1",
                ),
            ),
            repository = trackerRepository,
            chatRepository = chatRepository,
            webSocketService = webSocketService,
        )

        coVerify(exactly = 1) { trackerRepository.getEvents("workspace-1") }
        verify(exactly = 1) { webSocketService.subscribe(listOf("tracker.events.workspace-1")) }

        viewModel.showCreateDialog()
        viewModel.setCreateName("日报")
        viewModel.setCreateDescription("汇总今天的工作")
        viewModel.createTracker()

        coVerify(exactly = 1) {
            trackerRepository.createEvent(
                name = "日报",
                description = "汇总今天的工作",
                hostSpaceId = "project-1",
                workspaceId = "workspace-1",
                agentId = "agent-1",
            )
        }
        assertFalse(viewModel.uiState.value.showCreateDialog)
        assertFalse(viewModel.uiState.value.isCreating)
        assertEquals(R.string.tracker_create_success, viewModel.uiState.value.toastRes)
    }

    @Test
    fun `create failure remains visible inside the open dialog`() {
        val trackerRepository = mockk<TrackerRepository>()
        val chatRepository = mockk<ChatRepository>()
        coEvery { chatRepository.getSession("session-1") } returns projectSession()
        coEvery { trackerRepository.getEvents("workspace-1") } returns emptyList()
        coEvery {
            trackerRepository.createEvent(any(), any(), any(), any(), any())
        } throws IllegalStateException("create failed")
        val viewModel = TrackerListViewModel(
            savedStateHandle = SavedStateHandle(
                mapOf(
                    "spaceId" to "project-1",
                    "sessionId" to "session-1",
                ),
            ),
            repository = trackerRepository,
            chatRepository = chatRepository,
            webSocketService = mockk(relaxed = true),
        )

        viewModel.showCreateDialog()
        viewModel.setCreateName("日报")
        viewModel.createTracker()

        assertTrue(viewModel.uiState.value.showCreateDialog)
        assertFalse(viewModel.uiState.value.isCreating)
        assertEquals(R.string.tracker_create_failed, viewModel.uiState.value.createErrorRes)
    }

    @Test
    fun `returning to the list refreshes tracker status without duplicating initial load`() {
        val trackerRepository = mockk<TrackerRepository>()
        val chatRepository = mockk<ChatRepository>()
        coEvery { chatRepository.getSession("session-1") } returns projectSession()
        coEvery { trackerRepository.getEvents("workspace-1") } returnsMany listOf(
            listOf(Tracker(id = "tracker-1", name = "日报")),
            listOf(Tracker(id = "tracker-1", name = "日报")),
        )
        val viewModel = TrackerListViewModel(
            savedStateHandle = SavedStateHandle(
                mapOf(
                    "spaceId" to "project-1",
                    "sessionId" to "session-1",
                ),
            ),
            repository = trackerRepository,
            chatRepository = chatRepository,
            webSocketService = mockk(relaxed = true),
        )

        viewModel.onScreenResumed()
        coVerify(exactly = 1) { trackerRepository.getEvents("workspace-1") }

        viewModel.onScreenResumed()
        coVerify(exactly = 2) { trackerRepository.getEvents("workspace-1") }
    }

    private fun projectSession(): ChatSession = ChatSession(
        id = "session-1",
        projectId = "project-1",
        spaceId = "project-1",
        workspaceId = "workspace-1",
        agentId = "agent-1",
    )
}
