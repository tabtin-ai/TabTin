package com.tabtin.mobile.features.memo.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Android microphone primitive behind [AudioRecordingService].
 *
 * Keeping this seam small lets lifecycle tests exercise the ordering between stopping the
 * microphone and cancelling the owning recording coroutine without needing a physical MIC.
 */
internal interface AudioRecorder {
    val isInitialized: Boolean

    fun startRecording()

    suspend fun read(buffer: ShortArray, offsetInShorts: Int, sizeInShorts: Int): Int

    fun stop()

    fun release()
}

/** Factory for the platform recorder, replaceable by deterministic test doubles. */
internal interface AudioRecorderFactory {
    fun minimumBufferSize(): Int

    fun create(bufferSize: Int): AudioRecorder
}

/**
 * PCM 16-bit mono 录音服务，通过 Android AudioRecord 实时采集音频块。
 * 同时将完整音频写入临时 WAV 文件，供后续 OSS 上传。
 */
public class AudioRecordingService internal constructor(
    private val cacheDir: File,
    private val recorderFactory: AudioRecorderFactory = AndroidAudioRecorderFactory,
    private val recordingDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {

    public companion object {
        private const val TAG = "AudioRecording"
        private const val SAMPLE_RATE = 16000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val BUFFER_SIZE_FACTOR = 2
        private const val WRITE_ERROR_THRESHOLD = 5
    }

    public data class RecordingResult(
        val file: File,
        val durationMs: Long,
        val fileSize: Long,
    )

    @Volatile
    private var isRecording = false
    @Volatile
    private var activeRecorder: AudioRecorder? = null
    @Volatile
    private var audioFile: File? = null

    private object AndroidAudioRecorderFactory : AudioRecorderFactory {
        override fun minimumBufferSize(): Int =
            AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)

        @SuppressLint("MissingPermission")
        override fun create(bufferSize: Int): AudioRecorder = AndroidAudioRecorder(
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize,
            ),
        )
    }

    private class AndroidAudioRecorder(private val delegate: AudioRecord) : AudioRecorder {
        override val isInitialized: Boolean
            get() = delegate.state == AudioRecord.STATE_INITIALIZED

        override fun startRecording() {
            delegate.startRecording()
        }

        override suspend fun read(buffer: ShortArray, offsetInShorts: Int, sizeInShorts: Int): Int =
            delegate.read(buffer, offsetInShorts, sizeInShorts)

        override fun stop() {
            delegate.stop()
        }

        override fun release() {
            delegate.release()
        }
    }

    /**
     * 开始录音。在 IO 协程中持续读取音频数据。
     * @param onChunk PCM 16-bit LE 数据块回调
     * @param onLevel 归一化音量（0.0~1.0）回调
     * @param onWriteError 磁盘写入连续失败超阈值时回调
     */
    @SuppressLint("MissingPermission")
    public suspend fun startRecording(
        onChunk: (ByteArray) -> Unit,
        onLevel: ((Float) -> Unit)? = null,
        onWriteError: (() -> Unit)? = null,
    ): Unit = withContext(recordingDispatcher) {
        if (!isActive) return@withContext
        if (isRecording) return@withContext

        val minBufSize = recorderFactory.minimumBufferSize()
        if (minBufSize == AudioRecord.ERROR || minBufSize == AudioRecord.ERROR_BAD_VALUE) {
            throw AudioRecordingException("Audio format not supported on this device")
        }
        val bufferSize = minBufSize * BUFFER_SIZE_FACTOR

        val recorder = recorderFactory.create(bufferSize)

        if (!recorder.isInitialized) {
            recorder.release()
            throw AudioRecordingException("AudioRecord initialization failed")
        }

        val wavFile = File(cacheDir, "memo_voice_${System.currentTimeMillis()}.wav")
        audioFile = wavFile
        val fos = FileOutputStream(wavFile)

        writeWavHeader(fos, 0)

        var recorderStarted = false
        isRecording = true
        activeRecorder = recorder

        val buffer = ShortArray(bufferSize / 2)
        var totalBytesWritten = 0L
        var writeErrorCount = 0

        try {
            if (!isActive || !isRecording) return@withContext

            recorder.startRecording()
            recorderStarted = true
            if (!isActive || !isRecording) return@withContext

            Log.i(TAG, "Recording started: ${wavFile.name}")

            while (isRecording && isActive) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read <= 0) continue

                val byteArray = shortArrayToByteArray(buffer, read)
                onChunk(byteArray)

                if (onLevel != null) {
                    val level = calculateRMSLevel(buffer, read)
                    onLevel(level)
                }

                try {
                    fos.write(byteArray)
                    totalBytesWritten += byteArray.size
                    writeErrorCount = 0
                } catch (e: Exception) {
                    writeErrorCount++
                    Log.e(TAG, "Audio file write failed (${writeErrorCount}x): ${e.message}")
                    if (writeErrorCount == WRITE_ERROR_THRESHOLD) {
                        onWriteError?.invoke()
                    }
                }
            }
        } finally {
            if (activeRecorder === recorder) activeRecorder = null
            if (recorderStarted) {
                try {
                    recorder.stop()
                } catch (_: IllegalStateException) {
                    // stopRecording() may have already stopped this recorder from another thread.
                }
            }
            recorder.release()
            isRecording = false
            fos.close()

            if (totalBytesWritten > 0 && wavFile.exists()) {
                updateWavHeader(wavFile, totalBytesWritten)
            }

            Log.i(TAG, "Recording stopped, size: $totalBytesWritten bytes")
        }
    }

    public fun stopRecording(): RecordingResult? {
        isRecording = false
        stopActiveRecorder()
        val file = audioFile ?: return null
        if (!file.exists() || file.length() <= 44) return null

        val dataSize = file.length() - 44
        val durationMs = dataSize * 1000 / (SAMPLE_RATE * 2)

        return RecordingResult(
            file = file,
            durationMs = durationMs,
            fileSize = file.length(),
        )
    }

    public fun cancelRecording() {
        isRecording = false
        stopActiveRecorder()
        audioFile?.let {
            if (it.exists()) it.delete()
        }
        audioFile = null
        Log.i(TAG, "Recording cancelled")
    }

    private fun stopActiveRecorder() {
        try {
            activeRecorder?.stop()
        } catch (_: IllegalStateException) {
            // The recorder can already be stopped while its read loop is unwinding.
        }
    }

    public fun cleanupFile() {
        audioFile?.let {
            if (it.exists()) it.delete()
        }
        audioFile = null
    }

    private fun shortArrayToByteArray(shorts: ShortArray, count: Int): ByteArray {
        val bytes = ByteArray(count * 2)
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until count) {
            buffer.putShort(shorts[i])
        }
        return bytes
    }

    private fun calculateRMSLevel(buffer: ShortArray, count: Int): Float {
        if (count <= 0) return 0.05f
        var sumOfSquares = 0.0
        for (i in 0 until count) {
            val normalized = buffer[i].toFloat() / Short.MAX_VALUE
            sumOfSquares += normalized * normalized
        }
        val rms = sqrt(sumOfSquares / count).toFloat()
        val db = 20 * kotlin.math.log10(max(rms, 1e-7f))
        val minDb = -60f
        val normalized = max(0f, (db - minDb) / -minDb)
        return min(normalized, 1f)
    }

    private fun writeWavHeader(fos: FileOutputStream, dataSize: Long) {
        val header = ByteArray(44)
        val buffer = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)

        // RIFF chunk
        buffer.put('R'.code.toByte())
        buffer.put('I'.code.toByte())
        buffer.put('F'.code.toByte())
        buffer.put('F'.code.toByte())
        buffer.putInt((36 + dataSize).toInt()) // file size - 8
        buffer.put('W'.code.toByte())
        buffer.put('A'.code.toByte())
        buffer.put('V'.code.toByte())
        buffer.put('E'.code.toByte())

        // fmt sub-chunk
        buffer.put('f'.code.toByte())
        buffer.put('m'.code.toByte())
        buffer.put('t'.code.toByte())
        buffer.put(' '.code.toByte())
        buffer.putInt(16)            // sub-chunk size
        buffer.putShort(1)           // PCM format
        buffer.putShort(1)           // mono
        buffer.putInt(SAMPLE_RATE)   // sample rate
        buffer.putInt(SAMPLE_RATE * 2) // byte rate
        buffer.putShort(2)           // block align
        buffer.putShort(16)          // bits per sample

        // data sub-chunk
        buffer.put('d'.code.toByte())
        buffer.put('a'.code.toByte())
        buffer.put('t'.code.toByte())
        buffer.put('a'.code.toByte())
        buffer.putInt(dataSize.toInt())

        fos.write(header)
    }

    private fun updateWavHeader(file: File, dataSize: Long) {
        try {
            RandomAccessFile(file, "rw").use { raf ->
                raf.seek(4)
                raf.write(intToByteArrayLE((36 + dataSize).toInt()))
                raf.seek(40)
                raf.write(intToByteArrayLE(dataSize.toInt()))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to update WAV header: ${e.message}")
        }
    }

    private fun intToByteArrayLE(value: Int): ByteArray {
        return byteArrayOf(
            (value and 0xFF).toByte(),
            ((value shr 8) and 0xFF).toByte(),
            ((value shr 16) and 0xFF).toByte(),
            ((value shr 24) and 0xFF).toByte(),
        )
    }
}

public class AudioRecordingException(message: String) : Exception(message)
