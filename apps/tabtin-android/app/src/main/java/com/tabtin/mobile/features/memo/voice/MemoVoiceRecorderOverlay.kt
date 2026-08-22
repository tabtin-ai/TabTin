package com.tabtin.mobile.features.memo.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.tabtin.mobile.R
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.features.memo.TabMemoViewModel
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

private const val VOICE_DRAFT_KEY = "tabmemo_voice_draft_text"
private const val MAX_RECORDING_DURATION_SEC = 300

private enum class RecorderState {
    PREPARING, RECORDING, PROCESSING, DONE, ERROR,
}

@Composable
public fun MemoVoiceRecorderOverlay(
    viewModel: TabMemoViewModel,
    webSocketService: WebSocketService,
    tokenManager: TokenManager,
    backHandlingEnabled: Boolean = true,
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences("tabtin_memo", Context.MODE_PRIVATE) }

    var recorderState by remember { mutableStateOf(RecorderState.PREPARING) }
    var transcribedText by remember { mutableStateOf("") }
    var recordingDuration by remember { mutableLongStateOf(0L) }
    val audioLevels = remember { mutableStateListOf(*Array(30) { 0.05f }) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var saveErrorMessage by remember { mutableStateOf<String?>(null) }
    var uploadFailedWarning by remember { mutableStateOf<String?>(null) }
    var showSuccessFlash by remember { mutableStateOf(false) }
    var isUploading by remember { mutableStateOf(false) }
    var isEditingText by remember { mutableStateOf(false) }
    var hasUserEdited by remember { mutableStateOf(false) }
    var isPreviewPlaying by remember { mutableStateOf(false) }
    var showDiscardConfirm by remember { mutableStateOf(false) }
    var retryCount by remember { mutableIntStateOf(0) }
    var dragOffset by remember { mutableFloatStateOf(0f) }

    val recordingService = remember { AudioRecordingService(context.cacheDir) }
    var asrClient by remember { mutableStateOf<ASRStreamClient?>(null) }
    var asrTranscribedText by remember { mutableStateOf("") }
    var isASRDone by remember { mutableStateOf(false) }
    var asrError by remember { mutableStateOf<String?>(null) }
    var recordingFile by remember { mutableStateOf<File?>(null) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }
    var recordingJob by remember { mutableStateOf<Job?>(null) }
    var durationJob by remember { mutableStateOf<Job?>(null) }
    var storageWarning by remember { mutableStateOf(false) }
    var isRestartPending by remember { mutableStateOf(false) }
    val restartGate = remember { VoiceRestartGate() }
    val isDraftRestored = recorderState == RecorderState.DONE && recordingFile == null && transcribedText.isNotEmpty()
    val reduceMotion = rememberReduceMotion()

    val cardAlpha by animateFloatAsState(
        targetValue = 1f,
        animationSpec = if (reduceMotion) snap() else tween(400),
        label = "cardAlpha",
    )

    val effectiveText = if (recorderState == RecorderState.DONE || recorderState == RecorderState.ERROR) {
        transcribedText
    } else {
        transcribedText.ifEmpty { asrTranscribedText }
    }

    val canSave = effectiveText.trim().isNotEmpty()
        && recorderState != RecorderState.PROCESSING
        && !isUploading

    fun haptic(style: Int = VibrationEffect.EFFECT_CLICK) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        // 触觉反馈不能影响语音录制；受管设备可能禁用震动服务。
        try {
            if (vibrator?.hasVibrator() == true) {
                vibrator.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE))
            }
        } catch (_: SecurityException) {
            // 无声降级。
        }
    }

    fun stopPreviewPlayback() {
        mediaPlayer?.release()
        mediaPlayer = null
        isPreviewPlaying = false
    }

    fun clearVoiceDraft() {
        prefs.edit().remove(VOICE_DRAFT_KEY).apply()
    }

    fun saveVoiceDraft() {
        val text = transcribedText.trim()
        if (text.isNotEmpty()) {
            prefs.edit().putString(VOICE_DRAFT_KEY, text).apply()
        } else {
            clearVoiceDraft()
        }
    }

    val recordingAttempt = remember(recordingService, scope) {
        VoiceRecordingAttempt<ASRStreamClient>(
            scope = scope,
            canFinish = {
                recorderState == RecorderState.PREPARING || recorderState == RecorderState.RECORDING
            },
            markProcessing = { recorderState = RecorderState.PROCESSING },
            cancelDuration = { durationJob?.cancel() },
            stopMicrophone = { recordingService.stopRecording() },
            onRecordingJobFinished = {
                val result = recordingService.stopRecording()
                recordingFile = result?.file

                val deadline = System.currentTimeMillis() + 5000
                while (recorderState == RecorderState.PROCESSING && !isASRDone && System.currentTimeMillis() < deadline) {
                    delay(200)
                }
                transcribedText = asrTranscribedText

                if (asrError != null && transcribedText.isEmpty()) {
                    errorMessage = context.getString(R.string.memo_voice_asr_failed, asrError ?: "")
                    recorderState = RecorderState.ERROR
                } else {
                    recorderState = RecorderState.DONE
                    saveVoiceDraft()
                }
            },
        )
    }

    fun cleanup() {
        durationJob?.cancel()
        stopPreviewPlayback()
        asrClient?.cleanup()
        asrClient = null
        recordingService.cancelRecording()
        recordingAttempt.invalidate()
        recordingJob?.cancel()
    }

    fun dismissEditor() {
        clearVoiceDraft()
        cleanup()
        onDismiss()
    }

    fun cancelRecording() {
        asrClient?.stop()
        recordingFile = null
        transcribedText = ""
        dismissEditor()
    }

    fun attemptDismiss() {
        if (recorderState == RecorderState.DONE && effectiveText.trim().isNotEmpty()) {
            showDiscardConfirm = true
            return
        }
        if (recorderState == RecorderState.RECORDING) {
            asrClient?.stop()
        }
        dismissEditor()
    }

    fun finishRecording(cancelRecordingJob: Boolean = false) {
        recordingAttempt.finish(cancelRecordingJob)
    }

    fun stopRecordingAndProcess() {
        if (recorderState != RecorderState.RECORDING) return
        haptic()
        asrClient?.stop()
        finishRecording()
    }

    fun startRecording() {
        if (recorderState == RecorderState.RECORDING ||
            recorderState == RecorderState.PROCESSING ||
            (recorderState == RecorderState.PREPARING && asrClient != null)
        ) {
            return
        }

        durationJob?.cancel()
        asrClient?.cleanup()
        asrClient = null
        recordingAttempt.invalidate()
        recordingJob = null

        recorderState = RecorderState.PREPARING
        errorMessage = null
        transcribedText = ""
        asrTranscribedText = ""
        recordingDuration = 0L
        hasUserEdited = false
        isEditingText = false
        isASRDone = false
        asrError = null
        stopPreviewPlayback()

        recordingFile?.delete()
        recordingFile = null
        recordingService.cleanupFile()

        val client = ASRStreamClient(webSocketService, tokenManager)
        asrClient = client
        recordingAttempt.begin(client)

        client.onTranscript = { text, isFinal ->
            if (recordingAttempt.isCurrent(client)) {
                if (text.isNotEmpty()) {
                    asrTranscribedText = text
                }
                if (isFinal) {
                    isASRDone = true
                }
            }
        }
        client.onError = { msg ->
            scope.launch(Dispatchers.Main.immediate) {
                recordingAttempt.finishIfCurrent(client, cancelRecordingJob = true) {
                    asrError = msg
                    isASRDone = true
                }
            }
        }

        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                client.start(sampleRate = 16000)
                if (!recordingAttempt.isCurrent(client) ||
                    (recorderState != RecorderState.PREPARING && recorderState != RecorderState.RECORDING)
                ) {
                    return@launch
                }

                recordingService.startRecording(
                    onChunk = { data -> client.sendAudio(data) },
                    onLevel = { level ->
                        scope.launch(Dispatchers.Main.immediate) {
                            if (audioLevels.size >= 30) audioLevels.removeAt(0)
                            audioLevels.add(level)
                        }
                    },
                    onWriteError = {
                        scope.launch(Dispatchers.Main.immediate) {
                            storageWarning = true
                        }
                    },
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!recordingAttempt.isCurrent(client)) return@launch
                recordingService.cancelRecording()
                errorMessage = e.message ?: "录音失败"
                recorderState = RecorderState.ERROR
                client.cleanup()
                return@launch
            }
        }
        recordingJob = job
        recordingAttempt.attachRecordingJob(job)
        job.start()

        scope.launch {
            delay(500)
            if (recorderState == RecorderState.PREPARING) {
                recorderState = RecorderState.RECORDING
                retryCount = 0
                haptic()

                durationJob = scope.launch {
                    while (recorderState == RecorderState.RECORDING) {
                        delay(1000)
                        recordingDuration++
                        if (recordingDuration >= MAX_RECORDING_DURATION_SEC) {
                            stopRecordingAndProcess()
                            break
                        }
                    }
                }
            }
        }
    }

    fun requestRerecord(backoffMs: Long = 0L, countAsRetry: Boolean = false) {
        if (!restartGate.trySchedule()) return
        isRestartPending = true
        scope.launch {
            try {
                if (backoffMs > 0L) delay(backoffMs)
                if (countAsRetry) retryCount++
                startRecording()
            } finally {
                isRestartPending = false
                restartGate.release()
            }
        }
    }

    fun saveAsNote() {
        val trimmed = effectiveText.trim()
        if (trimmed.isEmpty()) return
        isUploading = true

        scope.launch {
            try {
                val memo = viewModel.createMemoSuspend(
                    contentMarkdown = trimmed,
                    source = "voice",
                )

                val audioResult = recordingFile?.let { file ->
                    viewModel.uploadAudioAttachment(memo.id, file)
                } ?: TabMemoViewModel.AudioUploadResult.Skipped

                haptic()
                showSuccessFlash = true
                val isSuccess = audioResult is TabMemoViewModel.AudioUploadResult.Success
                        || audioResult is TabMemoViewModel.AudioUploadResult.Skipped
                delay(if (isSuccess) 500 else 200)
                recordingService.cleanupFile()
                isUploading = false

                if (audioResult is TabMemoViewModel.AudioUploadResult.Failed) {
                    uploadFailedWarning = audioResult.errorMessage
                } else {
                    dismissEditor()
                    onCreated()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                isUploading = false
                saveErrorMessage = context.getString(R.string.memo_voice_save_failed) + ": ${e.message}"
            }
        }
    }

    fun togglePreviewPlayback() {
        if (isPreviewPlaying) {
            stopPreviewPlayback()
            return
        }
        val file = recordingFile ?: return
        if (!file.exists()) return

        try {
            val player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .build()
                )
                setDataSource(file.absolutePath)
                prepare()
                setOnCompletionListener {
                    isPreviewPlaying = false
                    mediaPlayer?.release()
                    mediaPlayer = null
                }
                start()
            }
            mediaPlayer = player
            isPreviewPlaying = true
        } catch (e: Exception) {
            Log.e("VoiceRecorder", "Preview playback failed: ${e.message}")
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startRecording()
        } else {
            errorMessage = context.getString(R.string.memo_voice_mic_denied)
            recorderState = RecorderState.ERROR
        }
    }

    LaunchedEffect(Unit) {
        val draft = prefs.getString(VOICE_DRAFT_KEY, null)
        if (!draft.isNullOrBlank()) {
            transcribedText = draft
            recorderState = RecorderState.DONE
            isEditingText = true
        } else {
            val hasPermission = ContextCompat.checkSelfPermission(
                context, Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
            if (hasPermission) {
                startRecording()
            } else {
                permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose { cleanup() }
    }

    BackHandler(enabled = backHandlingEnabled) { attemptDismiss() }

    val textPrimary = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val textSecondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val textTertiary = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val bgSubtle = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    val accentColor = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val surfaceColor = MaterialTheme.colorScheme.secondaryContainer

    Box(
        modifier = Modifier
            .fillMaxSize()
            .imePadding()
            .background(Color.Black.copy(alpha = 0.3f * cardAlpha))
            .clickable(enabled = recorderState != RecorderState.PROCESSING && !isUploading) {
                attemptDismiss()
            },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .shadow(16.dp, RoundedCornerShape(TTRadius.xl))
                .clip(RoundedCornerShape(TTRadius.xl))
                .background(MaterialTheme.colorScheme.surface)
                .clickable(enabled = false) { }
                .alpha(cardAlpha)
                .offset { IntOffset(0, dragOffset.roundToInt()) }
                .verticalScroll(rememberScrollState())
                .padding(TTSpacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Header
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .pointerInput(recorderState) {
                        if (recorderState == RecorderState.DONE || recorderState == RecorderState.ERROR) {
                            detectVerticalDragGestures(
                                onDragEnd = {
                                    if (dragOffset > 120f) attemptDismiss()
                                    dragOffset = 0f
                                },
                                onDragCancel = { dragOffset = 0f },
                                onVerticalDrag = { _, dragAmount ->
                                    dragOffset = (dragOffset + dragAmount).coerceAtLeast(0f)
                                },
                            )
                        }
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    if (recorderState == RecorderState.RECORDING) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(Color.Red),
                        )
                    }
                    Text(
                        text = when (recorderState) {
                            RecorderState.PREPARING -> stringResource(R.string.memo_voice_preparing)
                            RecorderState.RECORDING -> stringResource(R.string.memo_voice_recording)
                            RecorderState.PROCESSING -> stringResource(R.string.memo_voice_processing)
                            RecorderState.DONE -> stringResource(R.string.memo_voice_done)
                            RecorderState.ERROR -> stringResource(R.string.memo_voice_error)
                        },
                        style = TTFonts.captionSemibold,
                        color = textSecondary,
                    )
                }

                Spacer(Modifier.weight(1f))

                if (recorderState == RecorderState.RECORDING) {
                    val remaining = MAX_RECORDING_DURATION_SEC - recordingDuration
                    val mins = recordingDuration / 60
                    val secs = recordingDuration % 60
                    Text(
                        text = String.format("%d:%02d", mins, secs),
                        style = TTFonts.caption,
                        color = if (remaining <= 30) Color.Red else textTertiary,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.width(TTSpacing.sm))
                }

                IconButton(
                    onClick = { attemptDismiss() },
                    enabled = !isUploading && recorderState != RecorderState.PROCESSING,
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = null,
                        tint = textTertiary,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            if (storageWarning) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(TTRadius.sm))
                        .background(Color(0xFFF97316).copy(alpha = 0.1f))
                        .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                ) {
                    Icon(Icons.Filled.Warning, null, modifier = Modifier.size(11.dp), tint = Color(0xFFF97316))
                    Text(
                        stringResource(R.string.memo_voice_low_storage),
                        style = TTFonts.caption,
                        color = Color(0xFFF97316),
                    )
                }
                Spacer(Modifier.height(TTSpacing.sm))
            }

            Spacer(Modifier.height(TTSpacing.lg))

            // Transcription area
            when {
                recorderState == RecorderState.DONE -> {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        if (isDraftRestored) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(TTRadius.sm))
                                    .background(accentColor.copy(alpha = 0.06f))
                                    .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                            ) {
                                Icon(Icons.Filled.Edit, null, modifier = Modifier.size(10.dp), tint = accentColor.copy(alpha = 0.8f))
                                Text(
                                    stringResource(R.string.memo_voice_draft_restored),
                                    style = TTFonts.caption,
                                    color = accentColor.copy(alpha = 0.8f),
                                )
                            }
                            Spacer(Modifier.height(TTSpacing.xs))
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = stringResource(R.string.memo_voice_transcription),
                                style = TTFonts.caption,
                                color = textTertiary,
                            )
                            Spacer(Modifier.weight(1f))
                            TextButton(onClick = {
                                isEditingText = !isEditingText
                            }) {
                                Icon(
                                    if (isEditingText) Icons.Filled.Stop else Icons.Filled.Edit,
                                    contentDescription = null,
                                    modifier = Modifier.size(12.dp),
                                    tint = accentColor,
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    if (isEditingText) stringResource(R.string.common_done)
                                    else stringResource(R.string.memo_voice_edit),
                                    style = TTFonts.caption,
                                    color = accentColor,
                                )
                            }
                        }

                        if (isEditingText) {
                            OutlinedTextField(
                                value = transcribedText,
                                onValueChange = {
                                    transcribedText = it
                                    hasUserEdited = true
                                    saveVoiceDraft()
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 80.dp, max = 200.dp),
                                placeholder = {
                                    Text(
                                        stringResource(R.string.memo_voice_write_thoughts),
                                        color = textTertiary.copy(alpha = 0.5f),
                                    )
                                },
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = accentColor.copy(alpha = 0.3f),
                                    unfocusedBorderColor = bgSubtle,
                                ),
                            )
                        } else if (transcribedText.trim().isEmpty()) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 80.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.Center,
                            ) {
                                Text(
                                    stringResource(R.string.memo_voice_error),
                                    style = TTFonts.caption,
                                    color = textTertiary,
                                )
                                Text(
                                    stringResource(R.string.memo_voice_write_thoughts),
                                    style = TTFonts.caption,
                                    color = textTertiary.copy(alpha = 0.7f),
                                )
                            }
                        } else {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 160.dp)
                                    .verticalScroll(rememberScrollState()),
                            ) {
                                Text(
                                    text = transcribedText,
                                    style = TTFonts.body,
                                    color = textPrimary,
                                )
                            }
                        }
                    }
                }

                effectiveText.isNotEmpty() -> {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 160.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        Text(
                            text = effectiveText,
                            style = TTFonts.body,
                            color = textPrimary,
                        )
                    }
                }

                recorderState == RecorderState.RECORDING -> {
                    Text(
                        text = stringResource(R.string.memo_voice_listening),
                        style = TTFonts.body,
                        color = textTertiary.copy(alpha = 0.5f),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                recorderState == RecorderState.PREPARING -> {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Text(
                            stringResource(R.string.memo_voice_connecting_asr),
                            style = TTFonts.caption,
                            color = textTertiary,
                        )
                    }
                }
            }

            Spacer(Modifier.height(TTSpacing.lg))

            // Audio visualization
            if (recorderState == RecorderState.RECORDING) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(44.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    audioLevels.forEach { level ->
                        Box(
                            modifier = Modifier
                                .width(3.dp)
                                .height((3 + level * 40).dp)
                                .clip(RoundedCornerShape(1.5.dp))
                                .background(accentColor.copy(alpha = 0.6f)),
                        )
                    }
                }
                Spacer(Modifier.height(TTSpacing.lg))
            }

            // Controls
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when (recorderState) {
                    RecorderState.RECORDING -> {
                        ControlButton(
                            icon = { Icon(Icons.Filled.Delete, null, tint = textTertiary, modifier = Modifier.size(18.dp)) },
                            label = stringResource(R.string.common_cancel),
                            labelColor = textTertiary,
                            onClick = { cancelRecording() },
                        )
                        ControlButton(
                            icon = {
                                Box(
                                    modifier = Modifier
                                        .size(64.dp)
                                        .clip(CircleShape)
                                        .background(Color.Red),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Filled.Stop, null, tint = Color.White, modifier = Modifier.size(20.dp))
                                }
                            },
                            label = stringResource(R.string.common_done),
                            labelColor = textSecondary,
                            onClick = { stopRecordingAndProcess() },
                            showBackground = false,
                        )
                        Spacer(Modifier.size(48.dp))
                    }

                    RecorderState.DONE -> {
                        ControlButton(
                            icon = { Icon(Icons.Filled.Delete, null, tint = textTertiary, modifier = Modifier.size(18.dp)) },
                            label = stringResource(R.string.memo_discard),
                            labelColor = textTertiary,
                            onClick = { cancelRecording() },
                        )
                        if (recordingFile != null) {
                            ControlButton(
                                icon = {
                                    Icon(
                                        if (isPreviewPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                                        null,
                                        tint = accentColor,
                                        modifier = Modifier.size(16.dp),
                                    )
                                },
                                label = if (isPreviewPlaying) stringResource(R.string.memo_voice_pause)
                                else stringResource(R.string.memo_voice_preview),
                                labelColor = textTertiary,
                                bgColor = accentColor.copy(alpha = 0.12f),
                                size = 40.dp,
                                onClick = { togglePreviewPlayback() },
                            )
                        }
                        ControlButton(
                            icon = {
                                Box(
                                    modifier = Modifier
                                        .size(64.dp)
                                        .clip(CircleShape)
                                        .background(if (canSave) accentColor else accentColor.copy(alpha = 0.3f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (isUploading) {
                                        CircularProgressIndicator(
                                            modifier = Modifier.size(20.dp),
                                            strokeWidth = 2.dp,
                                            color = Color.White,
                                        )
                                    } else {
                                        Icon(Icons.Filled.ArrowUpward, null, tint = Color.White, modifier = Modifier.size(20.dp))
                                    }
                                }
                            },
                            label = stringResource(R.string.memo_voice_save),
                            labelColor = textSecondary,
                            onClick = { if (canSave) saveAsNote() },
                            showBackground = false,
                        )
                        ControlButton(
                            icon = { Icon(Icons.Filled.Refresh, null, tint = textTertiary, modifier = Modifier.size(18.dp)) },
                            label = stringResource(R.string.memo_voice_rerecord),
                            labelColor = textTertiary,
                            enabled = !isRestartPending,
                            onClick = { requestRerecord() },
                        )
                    }

                    RecorderState.PREPARING -> {
                        CircularProgressIndicator(modifier = Modifier.size(32.dp))
                    }

                    RecorderState.PROCESSING -> {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(modifier = Modifier.size(24.dp))
                            Spacer(Modifier.height(TTSpacing.sm))
                            Text(
                                stringResource(R.string.memo_voice_finishing_asr),
                                style = TTFonts.caption,
                                color = textTertiary,
                            )
                        }
                    }

                    RecorderState.ERROR -> {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
                        ) {
                            Icon(
                                Icons.Filled.Warning,
                                contentDescription = null,
                                modifier = Modifier.size(28.dp),
                                tint = Color(0xFFF97316),
                            )
                            errorMessage?.let { msg ->
                                Text(
                                    msg,
                                    style = TTFonts.caption,
                                    color = textSecondary,
                                    textAlign = TextAlign.Center,
                                    maxLines = 3,
                                )
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xl)) {
                                ControlButton(
                                    icon = { Icon(Icons.Filled.Close, null, tint = textTertiary, modifier = Modifier.size(16.dp)) },
                                    label = stringResource(R.string.common_close),
                                    labelColor = textTertiary,
                                    onClick = { dismissEditor() },
                                )
                                if (retryCount < 3) {
                                    ControlButton(
                                        icon = {
                                            Box(
                                                modifier = Modifier
                                                    .size(64.dp)
                                                    .clip(CircleShape)
                                                    .background(accentColor),
                                                contentAlignment = Alignment.Center,
                                            ) {
                                                Icon(Icons.Filled.Refresh, null, tint = Color.White, modifier = Modifier.size(20.dp))
                                            }
                                        },
                                        label = stringResource(R.string.memo_voice_rerecord),
                                        labelColor = textSecondary,
                                        enabled = !isRestartPending,
                                        onClick = {
                                            val backoff = minOf(
                                                Math.pow(2.0, retryCount.toDouble()),
                                                8.0,
                                            ).toLong() * 1000
                                            requestRerecord(backoffMs = backoff, countAsRetry = true)
                                        },
                                        showBackground = false,
                                    )
                                } else {
                                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                        Icon(Icons.Filled.WifiOff, null, tint = textTertiary, modifier = Modifier.size(20.dp))
                                        Text(
                                            stringResource(R.string.memo_voice_retry_failed),
                                            style = TTFonts.caption,
                                            color = textTertiary,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Success flash overlay
        if (showSuccessFlash) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg)
                    .clip(RoundedCornerShape(TTRadius.xl))
                    .background(TTColors.BgSuccess.copy(alpha = 0.15f))
                    .height(200.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.ArrowUpward,
                    contentDescription = null,
                    tint = TTColors.BgSuccess,
                    modifier = Modifier.size(36.dp),
                )
            }
        }
    }

    // Dialogs
    if (showDiscardConfirm) {
        AlertDialog(
            onDismissRequest = { showDiscardConfirm = false },
            title = { Text(stringResource(R.string.memo_voice_discard_title)) },
            text = { Text(stringResource(R.string.memo_voice_discard_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showDiscardConfirm = false
                    cancelRecording()
                }) {
                    Text(stringResource(R.string.memo_discard), color = TTColors.BgCritical)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardConfirm = false }) {
                    Text(stringResource(R.string.memo_continue_editing))
                }
            },
        )
    }

    saveErrorMessage?.let { msg ->
        AlertDialog(
            onDismissRequest = { saveErrorMessage = null },
            title = { Text(stringResource(R.string.memo_voice_save_failed)) },
            text = { Text(msg) },
            confirmButton = {
                TextButton(onClick = { saveErrorMessage = null }) {
                    Text(stringResource(R.string.memo_ok))
                }
            },
        )
    }

    if (uploadFailedWarning != null) {
        AlertDialog(
            onDismissRequest = { },
            title = { Text(stringResource(R.string.memo_voice_save_failed)) },
            text = {
                Column {
                    Text(stringResource(R.string.memo_voice_upload_failed_text_saved))
                    if (!uploadFailedWarning.isNullOrBlank()) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = uploadFailedWarning!!,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                            color = androidx.compose.material3.MaterialTheme.colorScheme.error,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    uploadFailedWarning = null
                    dismissEditor()
                    onCreated()
                }) {
                    Text(stringResource(R.string.memo_voice_understood))
                }
            },
        )
    }
}

@Composable
private fun ControlButton(
    icon: @Composable () -> Unit,
    label: String,
    labelColor: Color,
    onClick: () -> Unit,
    bgColor: Color = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
    size: androidx.compose.ui.unit.Dp = 48.dp,
    showBackground: Boolean = true,
    enabled: Boolean = true,
) {
    Column(
        modifier = Modifier.alpha(if (enabled) 1f else 0.45f),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = if (showBackground) {
                Modifier
                    .size(size)
                    .clip(CircleShape)
                    .background(bgColor)
                    .clickable(enabled = enabled, onClick = onClick)
            } else {
                Modifier.clickable(enabled = enabled, onClick = onClick)
            },
            contentAlignment = Alignment.Center,
        ) {
            icon()
        }
        Text(
            text = label,
            style = TTFonts.codeXS,
            color = labelColor,
        )
    }
}
