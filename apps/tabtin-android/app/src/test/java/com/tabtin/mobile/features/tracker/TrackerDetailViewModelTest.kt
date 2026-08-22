package com.tabtin.mobile.features.tracker

import androidx.lifecycle.SavedStateHandle
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunExecutionPolicy
import com.tabtin.mobile.data.model.tracker.TrackerRunStatus
import com.tabtin.mobile.data.repository.TrackerRepository
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.R
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
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
class TrackerDetailViewModelTest {

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `detail loads one tracker without organization list lookup`() {
        val repository = mockk<TrackerRepository>()
        val tracker = Tracker(
            id = "tracker-1",
            name = "日报",
            spaceId = "workspace-1",
        )
        coEvery { repository.getEvent("tracker-1") } returns tracker
        coEvery { repository.getRuns("tracker-1") } returns emptyList()

        val viewModel = TrackerDetailViewModel(
            savedStateHandle = SavedStateHandle(mapOf("trackerId" to "tracker-1")),
            repository = repository,
            webSocketService = mockk(relaxed = true),
        )

        assertEquals(tracker, viewModel.uiState.value.tracker)
        coVerify(exactly = 1) { repository.getEvent("tracker-1") }
        coVerify(exactly = 0) { repository.getEvents(any()) }
    }

    @Test
    fun `active latest run blocks trigger before it reaches repository`() {
        val repository = mockk<TrackerRepository>()
        coEvery { repository.getEvent("tracker-1") } returns Tracker(id = "tracker-1", name = "日报")
        coEvery { repository.getRuns("tracker-1") } returns listOf(run(status = TrackerRunStatus.WAITING_DEVICE))

        val viewModel = TrackerDetailViewModel(
            savedStateHandle = SavedStateHandle(mapOf("trackerId" to "tracker-1")),
            repository = repository,
            webSocketService = mockk(relaxed = true),
        )

        viewModel.triggerTracker()

        coVerify(exactly = 0) { repository.triggerEvent("tracker-1") }
        assertEquals(R.string.tracker_trigger_blocked_active_run, viewModel.uiState.value.toastRes)
    }

    @Test
    fun `execution policy blocks every non terminal status and restores terminal statuses`() {
        listOf(
            TrackerRunStatus.PENDING,
            TrackerRunStatus.RUNNING,
            TrackerRunStatus.WAITING_DEVICE,
            TrackerRunStatus.WAITING_CHECKPOINT,
            TrackerRunStatus.UNKNOWN,
        ).forEach { status ->
            assertFalse(TrackerRunExecutionPolicy.canTrigger(run(status)))
        }
        listOf(
            TrackerRunStatus.COMPLETED,
            TrackerRunStatus.PARTIAL_FAILED,
            TrackerRunStatus.FAILED,
            TrackerRunStatus.CANCELLED,
        ).forEach { status ->
            assertTrue(TrackerRunExecutionPolicy.canTrigger(run(status)))
        }
    }

    @Test
    fun `terminal latest run restores trigger`() {
        val repository = mockk<TrackerRepository>()
        coEvery { repository.getEvent("tracker-1") } returns Tracker(id = "tracker-1", name = "日报")
        coEvery { repository.getRuns("tracker-1") } returns listOf(run(status = TrackerRunStatus.COMPLETED))
        coEvery { repository.triggerEvent("tracker-1") } returns run(status = TrackerRunStatus.PENDING)
        val viewModel = detailViewModel(repository)

        viewModel.triggerTracker()

        coVerify(exactly = 1) { repository.triggerEvent("tracker-1") }
    }

    @Test
    fun `active latest run keeps its cancellation action available`() {
        val repository = mockk<TrackerRepository>()
        coEvery { repository.getEvent("tracker-1") } returns Tracker(id = "tracker-1", name = "日报")
        coEvery { repository.getRuns("tracker-1") } returns listOf(run(status = TrackerRunStatus.RUNNING))
        coEvery { repository.cancelRun("tracker-1", "run-1") } returns Unit
        val viewModel = detailViewModel(repository)

        viewModel.cancelRun("run-1")

        coVerify(exactly = 1) { repository.cancelRun("tracker-1", "run-1") }
    }

    @Test
    fun `server active run rejection remains understandable after a stale terminal state`() {
        val repository = mockk<TrackerRepository>()
        coEvery { repository.getEvent("tracker-1") } returns Tracker(id = "tracker-1", name = "日报")
        coEvery { repository.getRuns("tracker-1") } returns listOf(run(status = TrackerRunStatus.COMPLETED))
        coEvery { repository.triggerEvent("tracker-1") } throws AppError.RequestFailed(
            "已达到最大并发运行数（单 Tracker 同时仅允许 1 个执行中 Run）",
        )
        val viewModel = detailViewModel(repository)

        viewModel.triggerTracker()

        assertEquals(R.string.tracker_trigger_blocked_active_run, viewModel.uiState.value.toastRes)
    }

    private fun detailViewModel(repository: TrackerRepository): TrackerDetailViewModel = TrackerDetailViewModel(
        savedStateHandle = SavedStateHandle(mapOf("trackerId" to "tracker-1")),
        repository = repository,
        webSocketService = mockk(relaxed = true),
    )

    private fun run(status: TrackerRunStatus): TrackerRun = TrackerRun(
        id = "run-1",
        trackerId = "tracker-1",
        status = status,
    )
}
