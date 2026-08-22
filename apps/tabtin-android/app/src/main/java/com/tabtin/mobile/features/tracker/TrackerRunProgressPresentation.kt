package com.tabtin.mobile.features.tracker

import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunStatus

internal data class TrackerRunProgressPresentation(
    val percent: Int?,
    val fraction: Float?,
    val message: String?,
) {
    companion object {
        fun from(run: TrackerRun): TrackerRunProgressPresentation {
            val isRunning = run.status == TrackerRunStatus.RUNNING
            val percent = run.progressPct
                .coerceIn(0, 100)
                .takeIf { isRunning && it > 0 }
            return TrackerRunProgressPresentation(
                percent = percent,
                fraction = percent?.div(100f),
                message = run.progressMessage
                    .trim()
                    .takeIf { percent != null && it.isNotEmpty() },
            )
        }
    }
}
