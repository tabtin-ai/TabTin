package com.tabtin.mobile.features.conversation

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.tabtin.mobile.R
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.features.memo.voice.ASRStreamClient
import com.tabtin.mobile.features.memo.voice.AudioRecordingService
import com.tabtin.mobile.features.memo.voice.VoiceRestartGate
import com.tabtin.mobile.features.memo.voice.VoiceRecordingAttempt
import com.tabtin.mobile.features.profile.AIDataSharingConsentDialog
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.rememberReduceMotion
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.TokenManager
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val MAX_RECORDING_DURATION_SEC = 120

private enum class VoiceState {
    PREPARING, RECORDING, PROCESSING, DONE, ERROR,
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
internal fun ChatVoiceInputOverlay(
    webSocketService: WebSocketService,
    tokenManager: TokenManager,
    onResult: (ChatVoiceResult) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var voiceState by remember { mutableStateOf(VoiceState.PREPARING) }
    var transcribedText by remember { mutableStateOf("") }
    var recordingDuration by remember { mutableLongStateOf(0L) }
    val audioLevels = remember { mutableStateListOf(*Array(30) { 0.05f }) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var microphonePermissionDenied by remember { mutableStateOf(false) }
    var microphonePermissionPermanentlyDenied by remember { mutableStateOf(false) }
    var retryCount by remember { mutableIntStateOf(0) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    var showAiConsent by remember { mutableStateOf(false) }
    var pendingStartAfterConsent by remember { mutableStateOf(false) }

    val recordingService = remember { AudioRecordingService(context.cacheDir) }
    var asrClient by remember { mutableStateOf<ASRStreamClient?>(null) }
    var asrTranscribedText by remember { mutableStateOf("") }
    var isASRDone by remember { mutableStateOf(false) }
    var asrError by remember { mutableStateOf<String?>(null) }
    var recordingJob by remember { mutableStateOf<Job?>(null) }
    var durationJob by remember { mutableStateOf<Job?>(null) }
    var isRestartPending by remember { mutableStateOf(false) }
    val restartGate = remember { VoiceRestartGate() }

    val reduceMotion = rememberReduceMotion()
    val cardAlpha by animateFloatAsState(
        targetValue = 1f,
        animationSpec = if (reduceMotion) snap() else tween(400),
        label = "cardAlpha",
    )

    val effectiveText = if (voiceState == VoiceState.DONE || voiceState == VoiceState.ERROR) {
        transcribedText
    } else {
        transcribedText.ifEmpty { asrTranscribedText }
    }

    val recordingAttempt = remember(recordingService, scope) {
        VoiceRecordingAttempt<ASRStreamClient>(
            scope = scope,
            canFinish = {
                voiceState == VoiceState.PREPARING || voiceState == VoiceState.RECORDING
            },
            markProcessing = { voiceState = VoiceState.PROCESSING },
            cancelDuration = { durationJob?.cancel() },
            stopMicrophone = { recordingService.stopRecording() },
            onRecordingJobFinished = {
                val deadline = System.currentTimeMillis() + 5000
                while (voiceState == VoiceState.PROCESSING && !isASRDone && System.currentTimeMillis() < deadline) {
                    delay(200)
                }
                transcribedText = asrTranscribedText

                if (asrError != null && transcribedText.isEmpty()) {
                    errorMessage = context.getString(R.string.chat_voice_error) + (asrError?.let { ": $it" } ?: "")
                    voiceState = VoiceState.ERROR
                } else if (transcribedText.isBlank()) {
                    errorMessage = context.getString(R.string.chat_voice_empty_result)
                    voiceState = VoiceState.ERROR
                } else {
                    voiceState = VoiceState.DONE
                }
            },
        )
    }

    fun haptic() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        // 触觉反馈只是辅助，设备策略或 Manifest 异常都不能中断录音/ASR 主流程。
        try {
            if (vibrator?.hasVibrator() == true) {
                vibrator.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE))
            }
        } catch (_: SecurityException) {
            // 某些受管设备会禁止震动；无声降级即可。
        }
    }

    fun cleanup() {
        durationJob?.cancel()
        asrClient?.cleanup()
        asrClient = null
        recordingService.cancelRecording()
        recordingAttempt.invalidate()
        recordingJob?.cancel()
    }

    fun dismiss() {
        cleanup()
        onResult(ChatVoiceResult.Cancelled)
    }

    /** 下拉未过关闭阈值：弹簧回弹到原位。 */
    fun springBackDragOffset() {
        val from = dragOffset
        if (from <= 0f) return
        scope.launch {
            animate(
                initialValue = from,
                targetValue = 0f,
                animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
            ) { value, _ ->
                dragOffset = value
            }
        }
    }

    fun cancelRecording() {
        asrClient?.stop()
        dismiss()
    }

    fun finishRecording(cancelRecordingJob: Boolean = false) {
        recordingAttempt.finish(cancelRecordingJob)
    }

    fun stopRecordingAndProcess() {
        if (voiceState != VoiceState.RECORDING) return
        haptic()
        asrClient?.stop()
        finishRecording()
    }

    fun startRecording() {
        if (voiceState == VoiceState.RECORDING ||
            voiceState == VoiceState.PROCESSING ||
            (voiceState == VoiceState.PREPARING && asrClient != null)
        ) {
            return
        }

        durationJob?.cancel()
        asrClient?.cleanup()
        asrClient = null
        recordingAttempt.invalidate()
        recordingJob = null

        when (VoiceCapturePreflight.evaluate(context)) {
            VoiceCaptureBlockReason.NEEDS_AI_CONSENT -> {
                pendingStartAfterConsent = false
                showAiConsent = true
                voiceState = VoiceState.ERROR
                errorMessage = context.getString(R.string.ai_data_sharing_consent_title)
                return
            }
            VoiceCaptureBlockReason.NEEDS_MICROPHONE,
            null,
            -> Unit
            VoiceCaptureBlockReason.ASR_OWNER_BUSY -> {
                voiceState = VoiceState.ERROR
                errorMessage = context.getString(R.string.chat_voice_error) + ": busy"
                return
            }
        }

        voiceState = VoiceState.PREPARING
        errorMessage = null
        microphonePermissionDenied = false
        microphonePermissionPermanentlyDenied = false
        transcribedText = ""
        asrTranscribedText = ""
        recordingDuration = 0L
        isASRDone = false
        asrError = null

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
                    (voiceState != VoiceState.PREPARING && voiceState != VoiceState.RECORDING)
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
                    onWriteError = { },
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!recordingAttempt.isCurrent(client)) return@launch
                recordingService.cancelRecording()
                errorMessage = e.message ?: context.getString(R.string.chat_voice_error)
                voiceState = VoiceState.ERROR
                client.cleanup()
                return@launch
            }
        }
        recordingJob = job
        recordingAttempt.attachRecordingJob(job)
        job.start()

        scope.launch {
            delay(500)
            if (voiceState == VoiceState.PREPARING) {
                voiceState = VoiceState.RECORDING
                retryCount = 0
                haptic()

                durationJob = scope.launch {
                    while (voiceState == VoiceState.RECORDING) {
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

    fun requestRerecord(backoffMs: Long, countAsRetry: Boolean = true) {
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

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startRecording()
        } else {
            microphonePermissionDenied = true
            microphonePermissionPermanentlyDenied = context.findActivity()?.shouldShowRequestPermissionRationale(
                Manifest.permission.RECORD_AUDIO,
            ) != true
            errorMessage = context.getString(R.string.chat_voice_permission_required)
            voiceState = VoiceState.ERROR
        }
    }

    fun requestMicrophonePermission() {
        voiceState = VoiceState.PREPARING
        errorMessage = null
        permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun openAppSettings() {
        context.startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", context.packageName, null),
            ),
        )
    }

    fun beginAfterGates() {
        val hasPermission = ContextCompat.checkSelfPermission(
            context, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (hasPermission) {
            startRecording()
        } else {
            requestMicrophonePermission()
        }
    }

    LaunchedEffect(Unit) {
        when (VoiceCapturePreflight.evaluate(context)) {
            VoiceCaptureBlockReason.NEEDS_AI_CONSENT -> {
                // 首次必须同意；同意后需用户再次触发（不自动开录）。
                showAiConsent = true
                voiceState = VoiceState.ERROR
                errorMessage = context.getString(R.string.ai_data_sharing_consent_message)
            }
            VoiceCaptureBlockReason.NEEDS_MICROPHONE -> beginAfterGates()
            VoiceCaptureBlockReason.ASR_OWNER_BUSY -> {
                voiceState = VoiceState.ERROR
                errorMessage = context.getString(R.string.chat_voice_error) + ": busy"
            }
            null -> beginAfterGates()
        }
    }

    if (showAiConsent) {
        AIDataSharingConsentDialog(
            onAgree = {
                VoiceCapturePreflight.grantAiConsent(context)
                showAiConsent = false
                pendingStartAfterConsent = false
                // 首次同意后不自动开录，关闭 overlay 让用户重新按住/点开。
                dismiss()
            },
            onDisagree = {
                showAiConsent = false
                dismiss()
            },
        )
    }

    DisposableEffect(Unit) {
        onDispose { cleanup() }
    }

    BackHandler { dismiss() }

    val textPrimary = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
    val textSecondary = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    val textTertiary = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val accentColor = ttColor(TTColors.Primary, TTColors.Dark.Primary)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.3f * cardAlpha))
            .clickable(enabled = voiceState != VoiceState.PROCESSING) { dismiss() },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                // 下拉拖拽的实时位移：1:1 跟手，松手未过阈值由弹簧回弹归零。
                .offset { IntOffset(0, dragOffset.roundToInt()) }
                .shadow(16.dp, RoundedCornerShape(TTRadius.xl))
                .clip(RoundedCornerShape(TTRadius.xl))
                .background(MaterialTheme.colorScheme.surface)
                .clickable(enabled = false) { }
                .alpha(cardAlpha)
                .pointerInput(voiceState) {
                    if (voiceState == VoiceState.DONE || voiceState == VoiceState.ERROR) {
                        detectVerticalDragGestures(
                            onDragEnd = {
                                if (dragOffset > 120f) {
                                    dismiss()
                                } else {
                                    springBackDragOffset()
                                }
                            },
                            onDragCancel = { springBackDragOffset() },
                            onVerticalDrag = { _, dragAmount ->
                                dragOffset = (dragOffset + dragAmount).coerceAtLeast(0f)
                            },
                        )
                    }
                }
                .padding(TTSpacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    if (voiceState == VoiceState.RECORDING) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(Color.Red),
                        )
                    }
                    Text(
                        text = when (voiceState) {
                            VoiceState.PREPARING -> stringResource(R.string.memo_voice_preparing)
                            VoiceState.RECORDING -> stringResource(R.string.chat_voice_recording)
                            VoiceState.PROCESSING -> stringResource(R.string.chat_voice_processing)
                            VoiceState.DONE -> stringResource(R.string.chat_voice_done)
                            VoiceState.ERROR -> if (microphonePermissionDenied) {
                                stringResource(R.string.chat_voice_permission_title)
                            } else {
                                stringResource(R.string.chat_voice_error)
                            }
                        },
                        style = TTFonts.captionSemibold,
                        color = textSecondary,
                    )
                }

                Spacer(Modifier.weight(1f))

                if (voiceState == VoiceState.RECORDING) {
                    val mins = recordingDuration / 60
                    val secs = recordingDuration % 60
                    val remaining = MAX_RECORDING_DURATION_SEC - recordingDuration
                    Text(
                        text = String.format("%d:%02d", mins, secs),
                        style = TTFonts.caption,
                        color = if (remaining <= 30) Color.Red else textTertiary,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.width(TTSpacing.sm))
                }

                IconButton(
                    onClick = { dismiss() },
                    enabled = voiceState != VoiceState.PROCESSING,
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = stringResource(R.string.common_close),
                        tint = textTertiary,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            Spacer(Modifier.height(TTSpacing.lg))

            when {
                voiceState == VoiceState.DONE -> {
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

                voiceState == VoiceState.RECORDING -> {
                    Text(
                        text = stringResource(R.string.chat_voice_listening),
                        style = TTFonts.body,
                        color = textTertiary.copy(alpha = 0.5f),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                voiceState == VoiceState.PREPARING -> {
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

            if (voiceState == VoiceState.RECORDING) {
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

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when (voiceState) {
                    VoiceState.RECORDING -> {
                        VoiceControlButton(
                            icon = { Icon(Icons.Filled.Delete, null, tint = textTertiary, modifier = Modifier.size(18.dp)) },
                            label = stringResource(R.string.chat_voice_cancel),
                            labelColor = textTertiary,
                            onClick = { cancelRecording() },
                        )
                        VoiceControlButton(
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

                    VoiceState.DONE -> {
                        VoiceControlButton(
                            icon = { Icon(Icons.Filled.Close, null, tint = textTertiary, modifier = Modifier.size(18.dp)) },
                            label = stringResource(R.string.chat_voice_cancel),
                            labelColor = textTertiary,
                            onClick = { dismiss() },
                        )
                        VoiceControlButton(
                            icon = { Icon(Icons.Filled.Edit, null, tint = accentColor, modifier = Modifier.size(18.dp)) },
                            label = stringResource(R.string.chat_voice_fill_draft),
                            labelColor = textSecondary,
                            bgColor = accentColor.copy(alpha = 0.12f),
                            onClick = {
                                cleanup()
                                onResult(ChatVoiceResult.FillDraft(transcribedText.trim()))
                            },
                        )
                        VoiceControlButton(
                            icon = {
                                Box(
                                    modifier = Modifier
                                        .size(64.dp)
                                        .clip(CircleShape)
                                        .background(accentColor),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Filled.ArrowUpward, null, tint = Color.White, modifier = Modifier.size(20.dp))
                                }
                            },
                            label = stringResource(R.string.chat_voice_send_directly),
                            labelColor = textSecondary,
                            onClick = {
                                cleanup()
                                onResult(ChatVoiceResult.SendDirectly(transcribedText.trim()))
                            },
                            showBackground = false,
                        )
                    }

                    VoiceState.PREPARING -> {
                        CircularProgressIndicator(modifier = Modifier.size(32.dp))
                    }

                    VoiceState.PROCESSING -> {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(modifier = Modifier.size(24.dp))
                            Spacer(Modifier.height(TTSpacing.sm))
                            Text(
                                stringResource(R.string.chat_voice_processing),
                                style = TTFonts.caption,
                                color = textTertiary,
                            )
                        }
                    }

                    VoiceState.ERROR -> {
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
                                VoiceControlButton(
                                    icon = { Icon(Icons.Filled.Close, null, tint = textTertiary, modifier = Modifier.size(16.dp)) },
                                    label = stringResource(R.string.common_close),
                                    labelColor = textTertiary,
                                    onClick = { dismiss() },
                                    size = 56.dp,
                                )
                                if (microphonePermissionDenied) {
                                    VoiceControlButton(
                                        icon = {
                                            Icon(
                                                if (microphonePermissionPermanentlyDenied) {
                                                    Icons.Filled.Settings
                                                } else {
                                                    Icons.Filled.Refresh
                                                },
                                                null,
                                                tint = Color.White,
                                                modifier = Modifier.size(20.dp),
                                            )
                                        },
                                        label = stringResource(
                                            if (microphonePermissionPermanentlyDenied) {
                                                R.string.chat_voice_open_settings
                                            } else {
                                                R.string.chat_voice_request_permission
                                            },
                                        ),
                                        labelColor = textSecondary,
                                        onClick = {
                                            if (microphonePermissionPermanentlyDenied) {
                                                openAppSettings()
                                                dismiss()
                                            } else {
                                                requestMicrophonePermission()
                                            }
                                        },
                                        bgColor = accentColor,
                                        size = 56.dp,
                                    )
                                } else if (retryCount < 3) {
                                    VoiceControlButton(
                                        icon = { Icon(Icons.Filled.Refresh, null, tint = Color.White, modifier = Modifier.size(20.dp)) },
                                        label = stringResource(R.string.memo_voice_rerecord),
                                        labelColor = textSecondary,
                                        enabled = !isRestartPending,
                                        onClick = {
                                            val backoff = minOf(
                                                Math.pow(2.0, retryCount.toDouble()),
                                                8.0,
                                            ).toLong() * 1000
                                            requestRerecord(backoffMs = backoff)
                                        },
                                        bgColor = accentColor,
                                        size = 56.dp,
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
    }
}

@Composable
private fun VoiceControlButton(
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
