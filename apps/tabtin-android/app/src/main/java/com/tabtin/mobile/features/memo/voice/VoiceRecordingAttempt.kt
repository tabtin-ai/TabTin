package com.tabtin.mobile.features.memo.voice

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** Prevents repeated taps from scheduling overlapping delayed rerecord attempts. */
internal class VoiceRestartGate {
    private val scheduled = AtomicBoolean(false)

    fun trySchedule(): Boolean = scheduled.compareAndSet(false, true)

    fun release() {
        scheduled.set(false)
    }
}

/**
 * Owns the terminal transition for one ASR + microphone attempt.
 *
 * Chat and TabMemo both use the same ordering contract: release the exclusive microphone first,
 * then cancel or join the recording job. A client identity gate prevents a late callback from an
 * abandoned ASR attempt from changing the state of a retry.
 */
internal class VoiceRecordingAttempt<Client : Any>(
    private val scope: CoroutineScope,
    private val canFinish: () -> Boolean,
    private val markProcessing: () -> Unit,
    private val cancelDuration: () -> Unit,
    private val stopMicrophone: () -> Unit,
    private val onRecordingJobFinished: suspend () -> Unit,
) {
    private var activeClient: Client? = null
    private var recordingJob: Job? = null

    fun begin(client: Client) {
        activeClient = client
        recordingJob = null
    }

    fun attachRecordingJob(job: Job) {
        recordingJob = job
    }

    fun isCurrent(client: Client): Boolean = activeClient === client

    /**
     * Runs a terminal transition only when [client] still owns this attempt.
     *
     * [beforeFinish] intentionally executes after the identity guard and before the state
     * transition, so an ASR error is visible to the terminal result resolver.
     */
    fun finishIfCurrent(
        client: Client,
        cancelRecordingJob: Boolean,
        beforeFinish: () -> Unit,
    ): Job? {
        if (!isCurrent(client) || !canFinish()) return null
        beforeFinish()
        return finish(cancelRecordingJob)
    }

    /**
     * Stops the microphone synchronously before the recording job can be cancelled or awaited.
     * This is the ordering that breaks a blocked [android.media.AudioRecord.read] call.
     */
    fun finish(cancelRecordingJob: Boolean = false): Job? {
        if (!canFinish()) return null

        markProcessing()
        cancelDuration()
        stopMicrophone()

        val job = recordingJob
        if (cancelRecordingJob) job?.cancel()

        return scope.launch {
            job?.join()
            onRecordingJobFinished()
        }
    }

    fun invalidate() {
        activeClient = null
        recordingJob = null
    }
}
