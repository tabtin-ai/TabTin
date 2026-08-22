package com.tabtin.mobile.features.tracker

import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TrackerRunProgressPresentationTest {

    @Test
    fun `zero progress shows only the run status`() {
        val presentation = TrackerRunProgressPresentation.from(
            run(status = TrackerRunStatus.RUNNING, progressPct = 0, message = "正在准备"),
        )

        assertNull(presentation.percent)
        assertNull(presentation.fraction)
        assertNull(presentation.message)
    }

    @Test
    fun `running progress uses the real percentage and clamps it for rendering`() {
        val presentation = TrackerRunProgressPresentation.from(
            run(status = TrackerRunStatus.RUNNING, progressPct = 140, message = "正在整理"),
        )

        assertEquals(100, presentation.percent)
        assertEquals(1f, presentation.fraction)
        assertEquals("正在整理", presentation.message)
    }

    @Test
    fun `terminal runs do not keep live progress chrome`() {
        val presentation = TrackerRunProgressPresentation.from(
            run(status = TrackerRunStatus.COMPLETED, progressPct = 100, message = "完成"),
        )

        assertNull(presentation.percent)
        assertNull(presentation.fraction)
        assertNull(presentation.message)
    }

    private fun run(
        status: TrackerRunStatus,
        progressPct: Int,
        message: String,
    ): TrackerRun = TrackerRun(
        id = "run-1",
        trackerId = "tracker-1",
        status = status,
        progressPct = progressPct,
        progressMessage = message,
    )
}
