package com.tabtin.mobile.features.memo.voice

import android.util.Log
import io.mockk.every
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AudioRecordingServiceTest {
    @Before
    fun setUp() {
        mockkStatic(Log::class)
        every { Log.i(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>()) } returns 0
    }

    @After
    fun tearDown() {
        unmockkStatic(Log::class)
    }

    @Test
    fun `stopRecording releases the active microphone before the blocked recording job unwinds`() = runTest {
        val tempDir = Files.createTempDirectory("tabtin-audio-service-test").toFile()
        val recorder = BlockingFakeRecorder()
        val service = AudioRecordingService(
            cacheDir = tempDir,
            recorderFactory = FakeRecorderFactory(recorder),
            recordingDispatcher = StandardTestDispatcher(testScheduler),
        )

        try {
            val recordingJob = launch { service.startRecording(onChunk = {}) }
            runCurrent()

            assertTrue("录音 job 应已进入阻塞的 MIC read", recorder.readEntered.isCompleted)
            assertTrue("录音开始后应持有 MIC", recorder.holdsMicrophone)

            service.stopRecording()

            assertFalse("终止路径必须同步释放 MIC，不能等 job join", recorder.holdsMicrophone)
            assertTrue(
                "活动录音器 stop 必须发生在 recording job 结束前",
                recorder.events.indexOf("microphone-stopped") >= 0,
            )

            advanceUntilIdle()

            assertTrue("停止 MIC 后录音 job 应自然退出，不可卡住", recordingJob.isCompleted)
            assertTrue(
                "录音器释放必须晚于主动停止 MIC",
                recorder.events.indexOf("microphone-stopped") < recorder.events.indexOf("released"),
            )
        } finally {
            service.cleanupFile()
            tempDir.delete()
        }
    }

    private class FakeRecorderFactory(
        private val recorder: AudioRecorder,
    ) : AudioRecorderFactory {
        override fun minimumBufferSize(): Int = 32

        override fun create(bufferSize: Int): AudioRecorder = recorder
    }

    private class BlockingFakeRecorder : AudioRecorder {
        val events = mutableListOf<String>()
        val readEntered = CompletableDeferred<Unit>()
        private val stopSignal = CompletableDeferred<Unit>()
        var holdsMicrophone = false
            private set

        override val isInitialized: Boolean = true

        override fun startRecording() {
            holdsMicrophone = true
            events += "microphone-started"
        }

        override suspend fun read(buffer: ShortArray, offsetInShorts: Int, sizeInShorts: Int): Int {
            events += "read-blocked"
            readEntered.complete(Unit)
            stopSignal.await()
            return 0
        }

        override fun stop() {
            if (holdsMicrophone) {
                holdsMicrophone = false
                events += "microphone-stopped"
            }
            stopSignal.complete(Unit)
        }

        override fun release() {
            events += "released"
        }
    }
}
