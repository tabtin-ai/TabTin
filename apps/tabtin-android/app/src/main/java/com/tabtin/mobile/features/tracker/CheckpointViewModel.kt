package com.tabtin.mobile.features.tracker

import androidx.lifecycle.ViewModel
import com.tabtin.mobile.data.repository.TrackerRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
public class CheckpointViewModel @Inject constructor(
    private val repository: TrackerRepository,
) : ViewModel() {

    public suspend fun continueCheckpoint(stepRunId: String) {
        repository.checkpointContinue(stepRunId)
    }

    public suspend fun provide(stepRunId: String, userInput: String) {
        repository.checkpointProvide(stepRunId, userInput)
    }

    public suspend fun abort(stepRunId: String) {
        repository.checkpointAbort(stepRunId)
    }
}
