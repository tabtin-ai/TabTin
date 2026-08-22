package com.tabtin.mobile.features.conversation

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.features.memo.voice.ASRException
import com.tabtin.mobile.features.memo.voice.ASRStreamClient
import com.tabtin.mobile.features.memo.voice.AudioRecordingService
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

public enum class TaskVoiceSessionPhase {
    IDLE,
    AWAITING_CONSENT,
    RECORDING,
    TRANSCRIBING,
    /** 松手后停采，等待 asr.stream.done / final / 有界超时 */
    PROCESSING,
    READY_TO_SEND,
    BLOCKED,
    ERROR,
}

public data class TaskVoiceUiState(
    val phase: TaskVoiceSessionPhase = TaskVoiceSessionPhase.IDLE,
    val transcript: String = "",
    val preservedTranscript: String? = null,
    val errorMessage: String? = null,
    val lastGate: CapsuleVoiceGate? = null,
    val frozenFocus: ConversationFocusContext? = null,
)

/**
 * Session 级 PTT owner：ASR、二次门禁、回执与可恢复 transcript。
 * 不读/不清 Composer 草稿。
 */
@HiltViewModel
public class TaskVoiceViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val webSocketService: WebSocketService,
    private val tokenManager: TokenManager,
) : ViewModel() {
    private val _uiState = MutableStateFlow(TaskVoiceUiState())
    public val uiState: StateFlow<TaskVoiceUiState> = _uiState.asStateFlow()

    private var asrClient: ASRStreamClient? = null
    private var recordingService: AudioRecordingService? = null
    private var recordJob: Job? = null
    private var finalJob: Job? = null

    /**
     * R2-4：每次 begin/cancel 递增。start 确认返回后若 generation 已失效，
     * 立即 stop+cleanup，避免服务端流无人持有。
     */
    private val holdGeneration = AtomicInteger(0)

    /** 测试缝：注入 Fake ASR / 跳过麦克风 / 缩短 final 超时。 */
    internal var clientFactory: () -> ASRStreamClient = {
        ASRStreamClient(webSocketService, tokenManager)
    }
    internal var audioFactory: ((File) -> AudioRecordingService)? = { dir ->
        AudioRecordingService(dir)
    }
    internal var finalTimeoutMs: Long = FINAL_TIMEOUT_MS

    /** 测试钩子：当前 hold generation。 */
    internal fun holdGenerationForTests(): Int = holdGeneration.get()

    public fun hasAiConsent(): Boolean = VoiceCapturePreflight.hasAiConsent(context)

    public fun grantAiConsent() {
        VoiceCapturePreflight.grantAiConsent(context)
        // 首次同意后不自动开录，要求用户重新按住。
        _uiState.value = _uiState.value.copy(
            phase = TaskVoiceSessionPhase.IDLE,
            errorMessage = null,
        )
    }

    public fun declineAiConsent() {
        _uiState.value = TaskVoiceUiState(phase = TaskVoiceSessionPhase.IDLE)
    }

    /** 未同意时只进同意态，不启动 ASR；抬起不得清掉本态（见 [cancelHold]）。 */
    public fun requestConsent(frozenFocus: ConversationFocusContext) {
        _uiState.value = TaskVoiceUiState(
            phase = TaskVoiceSessionPhase.AWAITING_CONSENT,
            frozenFocus = frozenFocus,
        )
    }

    /**
     * ≥520ms 且已同意后由胶囊调用：冻结 Focus 并 startAsr。
     * 阈值前不得调用（对齐 iOS pressHeld→recording）。
     */
    public fun beginHold(frozenFocus: ConversationFocusContext) {
        when (VoiceCapturePreflight.evaluate(context)) {
            VoiceCaptureBlockReason.NEEDS_AI_CONSENT -> {
                requestConsent(frozenFocus)
                return
            }
            VoiceCaptureBlockReason.NEEDS_MICROPHONE -> {
                _uiState.value = TaskVoiceUiState(
                    phase = TaskVoiceSessionPhase.ERROR,
                    errorMessage = "microphone permission required",
                    frozenFocus = frozenFocus,
                )
                return
            }
            VoiceCaptureBlockReason.ASR_OWNER_BUSY -> {
                _uiState.value = TaskVoiceUiState(
                    phase = TaskVoiceSessionPhase.ERROR,
                    errorMessage = "ASR owner busy",
                    frozenFocus = frozenFocus,
                )
                return
            }
            null -> Unit
        }
        finalJob?.cancel()
        finalJob = null
        val generation = holdGeneration.incrementAndGet()
        _uiState.value = TaskVoiceUiState(
            phase = TaskVoiceSessionPhase.RECORDING,
            frozenFocus = frozenFocus,
        )
        startAsr(generation)
    }

    public fun cancelHold() {
        // ：同意弹窗展示中，抬起 / 阈值 cancel 不得清回 IDLE
        if (_uiState.value.phase == TaskVoiceSessionPhase.AWAITING_CONSENT) {
            return
        }
        val client = asrClient
        if (client?.isStreamActive() != true) {
            // R2-4：ack 前勿 cancel recordJob，否则 start 协程被打断，服务端流无人 stop
            abortBeforeStreamReady(client)
            _uiState.value = TaskVoiceUiState(
                phase = TaskVoiceSessionPhase.IDLE,
                preservedTranscript = _uiState.value.transcript.takeIf { it.isNotBlank() },
            )
            return
        }
        holdGeneration.incrementAndGet()
        releaseCapture(cancelled = true)
        _uiState.value = TaskVoiceUiState(
            phase = TaskVoiceSessionPhase.IDLE,
            preservedTranscript = _uiState.value.transcript.takeIf { it.isNotBlank() },
        )
    }

    /**
     * 松手：停采集、发 stop，进入 PROCESSING，等 final / done / 超时后再 READY_TO_SEND。
     *
     * R2-4：若 ASR start 确认尚未返回，失效 generation + requestAbort，但**不** cancel
     * start 协程——等 ack 返回后由 startAsr / ASRStreamClient 立即 stop，避免孤儿流。
     */
    public fun completeHold() {
        val phase = _uiState.value.phase
        if (phase != TaskVoiceSessionPhase.RECORDING &&
            phase != TaskVoiceSessionPhase.TRANSCRIBING
        ) {
            return
        }
        val client = asrClient
        val streamReady = client?.isStreamActive() == true
        if (!streamReady) {
            abortBeforeStreamReady(client)
            _uiState.value = TaskVoiceUiState(
                phase = TaskVoiceSessionPhase.IDLE,
                preservedTranscript = _uiState.value.transcript.takeIf { it.isNotBlank() },
            )
            return
        }

        try {
            recordingService?.stopRecording()
        } catch (_: Exception) {
        }
        recordingService = null
        recordJob?.cancel()
        recordJob = null
        client!!.stop()
        _uiState.value = _uiState.value.copy(phase = TaskVoiceSessionPhase.PROCESSING)

        finalJob?.cancel()
        finalJob = viewModelScope.launch {
            val reachedTerminal = try {
                client.awaitDone(finalTimeoutMs) == true
            } catch (_: Exception) {
                false
            }
            if (_uiState.value.phase != TaskVoiceSessionPhase.PROCESSING) {
                releaseCapture(cancelled = true)
                return@launch
            }
            val text = _uiState.value.transcript.trim()
            releaseCapture(cancelled = false)
            if (!reachedTerminal && text.isEmpty()) {
                _uiState.value = TaskVoiceUiState(
                    phase = TaskVoiceSessionPhase.IDLE,
                    frozenFocus = _uiState.value.frozenFocus,
                    errorMessage = "ASR final timeout",
                )
                return@launch
            }
            if (text.isEmpty()) {
                _uiState.value = TaskVoiceUiState(phase = TaskVoiceSessionPhase.IDLE)
            } else {
                _uiState.value = _uiState.value.copy(
                    phase = TaskVoiceSessionPhase.READY_TO_SEND,
                    transcript = text,
                )
            }
        }
    }

    public fun consumeReadySubmission(): CapsuleVoiceSubmission? {
        val state = _uiState.value
        if (state.phase != TaskVoiceSessionPhase.READY_TO_SEND) return null
        val focus = state.frozenFocus ?: return null
        val text = state.transcript.trim()
        if (text.isEmpty()) return null
        val submission = CapsuleVoiceResultPolicy.buildSubmission(text, focus)
        _uiState.value = TaskVoiceUiState()
        return submission
    }

    public fun markBlocked(gate: CapsuleVoiceGate, transcript: String) {
        _uiState.value = _uiState.value.copy(
            phase = TaskVoiceSessionPhase.BLOCKED,
            lastGate = gate,
            preservedTranscript = transcript,
            transcript = transcript,
        )
    }

    private fun startAsr(generation: Int) {
        recordJob?.cancel()
        recordJob = viewModelScope.launch {
            var client: ASRStreamClient? = null
            try {
                client = clientFactory()
                asrClient = client
                client.onTranscript = { text, isFinal ->
                    if (holdGeneration.get() == generation) {
                        applyTranscript(text, isFinal)
                    }
                }
                client.onError = { msg ->
                    if (holdGeneration.get() == generation &&
                        _uiState.value.phase != TaskVoiceSessionPhase.IDLE
                    ) {
                        _uiState.value = _uiState.value.copy(
                            phase = TaskVoiceSessionPhase.ERROR,
                            errorMessage = msg,
                        )
                        releaseCapture(cancelled = true)
                    }
                }
                client.start()
                // R2-4：start 确认返回后若已松手/取消，立即 stop
                if (holdGeneration.get() != generation || client.consumeAbortIfRequested()) {
                    client.stop()
                    client.cleanup()
                    if (asrClient === client) asrClient = null
                    return@launch
                }
                val factory = audioFactory
                if (factory != null) {
                    val audio = factory(context.cacheDir)
                    recordingService = audio
                    audio.startRecording(onChunk = { chunk ->
                        if (holdGeneration.get() == generation) {
                            client.sendAudio(chunk)
                        }
                    })
                }
            } catch (error: ASRException) {
                if (holdGeneration.get() == generation) {
                    _uiState.value = _uiState.value.copy(
                        phase = TaskVoiceSessionPhase.ERROR,
                        errorMessage = error.message,
                    )
                    releaseCapture(cancelled = true)
                } else {
                    client?.cleanup()
                    if (asrClient === client) asrClient = null
                }
            } catch (error: Exception) {
                if (holdGeneration.get() == generation) {
                    _uiState.value = _uiState.value.copy(
                        phase = TaskVoiceSessionPhase.ERROR,
                        errorMessage = error.message ?: "voice failed",
                    )
                    releaseCapture(cancelled = true)
                } else {
                    client?.cleanup()
                    if (asrClient === client) asrClient = null
                }
            }
        }
    }

    private fun applyTranscript(text: String, isFinal: Boolean) {
        val phase = _uiState.value.phase
        when (phase) {
            TaskVoiceSessionPhase.IDLE,
            TaskVoiceSessionPhase.READY_TO_SEND,
            TaskVoiceSessionPhase.BLOCKED,
            TaskVoiceSessionPhase.ERROR,
            TaskVoiceSessionPhase.AWAITING_CONSENT,
            -> return
            TaskVoiceSessionPhase.PROCESSING -> {
                _uiState.value = _uiState.value.copy(transcript = text)
            }
            TaskVoiceSessionPhase.RECORDING,
            TaskVoiceSessionPhase.TRANSCRIBING,
            -> {
                _uiState.value = _uiState.value.copy(
                    transcript = text,
                    phase = TaskVoiceSessionPhase.TRANSCRIBING,
                )
            }
        }
    }

    /**
     * start 确认前中止：抬 generation + abort 标记 + 停麦。
     * 保留 [recordJob]，让 `client.start()` 跑完 ack 后自行 stop/cleanup。
     */
    private fun abortBeforeStreamReady(client: ASRStreamClient?) {
        holdGeneration.incrementAndGet()
        client?.requestAbort()
        finalJob?.cancel()
        finalJob = null
        try {
            recordingService?.stopRecording()
        } catch (_: Exception) {
        }
        recordingService = null
    }

    private fun stopMicOnly() {
        recordJob?.cancel()
        recordJob = null
        try {
            recordingService?.stopRecording()
        } catch (_: Exception) {
        }
        recordingService = null
    }

    private fun releaseCapture(cancelled: Boolean) {
        finalJob?.cancel()
        finalJob = null
        stopMicOnly()
        val client = asrClient
        asrClient = null
        if (client != null) {
            if (cancelled) {
                client.requestAbort()
            }
            client.cleanup()
        }
    }

    override fun onCleared() {
        holdGeneration.incrementAndGet()
        releaseCapture(cancelled = true)
        super.onCleared()
    }

    public companion object {
        public const val FINAL_TIMEOUT_MS: Long = 5_000L
    }
}
