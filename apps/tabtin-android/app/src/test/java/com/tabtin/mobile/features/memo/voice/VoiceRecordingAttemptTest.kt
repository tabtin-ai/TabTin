package com.tabtin.mobile.features.memo.voice

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.TestScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceRecordingAttemptTest {
    @Test
    fun `repeated rerecord taps schedule only one restart until the first starts`() {
        val gate = VoiceRestartGate()

        assertTrue(gate.trySchedule())
        assertFalse("等待退避期间的重复点击必须被吞掉", gate.trySchedule())
        assertFalse("连续点击不能排入第三次启动", gate.trySchedule())

        gate.release()

        assertTrue("前一次启动结束后才允许再次重录", gate.trySchedule())
    }

    @Test
    fun `Chat ASR error stops microphone before cancelling recording job and reaches terminal error`() = runTest {
        val scenario = AttemptScenario(this)
        val chatAsr = FakeASRClient()
        scenario.start(chatAsr)
        runCurrent()

        val terminalJob = chatAsr.emitError("chat ASR unavailable")

        assertNotNull(terminalJob)
        assertFalse("ASR 失败时不能继续持有 MIC", scenario.microphone.holdsMicrophone)
        assertEquals(Phase.PROCESSING, scenario.phase)
        assertTrue(scenario.events.contains("microphone-stopped"))

        advanceUntilIdle()

        assertTrue("停止 MIC 后录音 job 应可取消退出", scenario.recordingJob!!.isCompleted)
        assertEquals(Phase.ERROR, scenario.phase)
        assertEquals("chat ASR unavailable", scenario.error)
        assertTrue(
            "必须先停 MIC，再让 recording job 结束",
            scenario.events.indexOf("microphone-stopped") < scenario.events.indexOf("recording-job-finished"),
        )
    }

    @Test
    fun `TabMemo ASR error stops microphone before cancelling recording job and reaches terminal error`() = runTest {
        val scenario = AttemptScenario(this)
        val memoAsr = FakeASRClient()
        scenario.start(memoAsr)
        runCurrent()

        val terminalJob = memoAsr.emitError("memo ASR unavailable")

        assertNotNull(terminalJob)
        assertFalse("ASR 失败时不能继续持有 MIC", scenario.microphone.holdsMicrophone)
        assertEquals(Phase.PROCESSING, scenario.phase)

        advanceUntilIdle()

        assertTrue("停止 MIC 后录音 job 应可取消退出", scenario.recordingJob!!.isCompleted)
        assertEquals(Phase.ERROR, scenario.phase)
        assertEquals("memo ASR unavailable", scenario.error)
        assertTrue(
            "必须先停 MIC，再让 recording job 结束",
            scenario.events.indexOf("microphone-stopped") < scenario.events.indexOf("recording-job-finished"),
        )
    }

    @Test
    fun `late Chat callbacks from a previous ASR client cannot alter a retry`() = runTest {
        assertLateCallbacksCannotAlterRetry()
    }

    @Test
    fun `late TabMemo callbacks from a previous ASR client cannot alter a retry`() = runTest {
        assertLateCallbacksCannotAlterRetry()
    }

    @Test
    fun `duplicate ASR error after processing cannot replace the resolved terminal error`() = runTest {
        val scenario = AttemptScenario(this)
        val client = FakeASRClient()
        scenario.start(client)
        runCurrent()

        client.emitError("first ASR failure")
        advanceUntilIdle()

        val duplicateTerminalJob = client.emitError("late ASR failure")

        assertNull("已进入终态后不应再次调度终止", duplicateTerminalJob)
        assertEquals("first ASR failure", scenario.error)
        assertEquals(Phase.ERROR, scenario.phase)
    }

    private suspend fun TestScope.assertLateCallbacksCannotAlterRetry() {
        val scenario = AttemptScenario(this)
        val oldClient = FakeASRClient()
        scenario.start(oldClient)
        runCurrent()
        oldClient.emitError("first attempt failed")
        advanceUntilIdle()

        val retryClient = FakeASRClient()
        scenario.start(retryClient)
        runCurrent()

        oldClient.emitTranscript("stale transcript")
        val staleTerminalJob = oldClient.emitError("stale error")

        assertNull("旧 ASR client 的 error 不得终止重试", staleTerminalJob)
        assertEquals("旧 transcript 不得覆盖重试", "", scenario.transcript)
        assertNull("旧 error 不得写入重试状态", scenario.error)
        assertEquals(Phase.RECORDING, scenario.phase)
        assertTrue("重试仍应持有自己的 MIC", scenario.microphone.holdsMicrophone)

        retryClient.emitTranscript("fresh transcript")
        val retryTerminalJob = retryClient.emitError("retry failed")
        assertNotNull(retryTerminalJob)
        advanceUntilIdle()

        assertEquals("fresh transcript", scenario.transcript)
        assertEquals("retry failed", scenario.error)
        assertEquals(Phase.ERROR, scenario.phase)
    }

    private enum class Phase {
        PREPARING,
        RECORDING,
        PROCESSING,
        ERROR,
    }

    private class AttemptScenario(scope: CoroutineScope) {
        val events = mutableListOf<String>()
        val microphone = FakeMicrophone(events)
        var phase = Phase.PREPARING
        var transcript = ""
        var error: String? = null
        var recordingJob: Job? = null

        private val attempt = VoiceRecordingAttempt<FakeASRClient>(
            scope = scope,
            canFinish = { phase == Phase.PREPARING || phase == Phase.RECORDING },
            markProcessing = { phase = Phase.PROCESSING },
            cancelDuration = { events += "duration-cancelled" },
            stopMicrophone = { microphone.stop() },
            onRecordingJobFinished = {
                events += "terminal-state-resolved"
                phase = Phase.ERROR
            },
        )
        private val scope = scope

        fun start(client: FakeASRClient) {
            phase = Phase.RECORDING
            transcript = ""
            error = null
            microphone.acquire()
            attempt.begin(client)

            val job = scope.launch {
                try {
                    awaitCancellation()
                } finally {
                    events += "recording-job-finished"
                }
            }
            recordingJob = job
            attempt.attachRecordingJob(job)

            client.onTranscript = { text ->
                if (attempt.isCurrent(client)) {
                    transcript = text
                }
            }
            client.onError = { message ->
                attempt.finishIfCurrent(client, cancelRecordingJob = true) {
                    error = message
                }
            }
        }
    }

    private class FakeMicrophone(private val events: MutableList<String>) {
        var holdsMicrophone = false
            private set

        fun acquire() {
            holdsMicrophone = true
        }

        fun stop() {
            if (holdsMicrophone) {
                holdsMicrophone = false
                events += "microphone-stopped"
            }
        }
    }

    private class FakeASRClient {
        var onTranscript: ((String) -> Unit)? = null
        var onError: ((String) -> Job?)? = null

        fun emitTranscript(text: String) {
            onTranscript?.invoke(text)
        }

        fun emitError(message: String): Job? = onError?.invoke(message)
    }
}
