package com.tabtin.mobile.features.conversation

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.tabtin.mobile.features.memo.voice.ASRStreamClient
import com.tabtin.mobile.features.profile.AIDataSharingConsentStore

/**
 * Composer / 胶囊共用的语音启动门禁：AI 共享同意 + ASR 单 owner。
 * 麦克风权限由 UI 在同意之后、开录之前申请（见 [AgentStatusCapsule]）。
 */
public enum class VoiceCaptureBlockReason {
    NEEDS_AI_CONSENT,
    ASR_OWNER_BUSY,
    NEEDS_MICROPHONE,
}

public object VoiceCapturePreflight {
    /**
     * 同步门禁。麦克风权限不在此硬拦（需 Activity Result）；
     * 调用方可用 [hasMicrophonePermission] 决定是否先申请。
     */
    public fun evaluate(
        context: Context,
        requireMicrophone: Boolean = false,
    ): VoiceCaptureBlockReason? {
        if (!AIDataSharingConsentStore.hasGranted(context)) {
            return VoiceCaptureBlockReason.NEEDS_AI_CONSENT
        }
        if (requireMicrophone && !hasMicrophonePermission(context)) {
            return VoiceCaptureBlockReason.NEEDS_MICROPHONE
        }
        if (ASRStreamClient.isOwnerHeld()) {
            return VoiceCaptureBlockReason.ASR_OWNER_BUSY
        }
        return null
    }

    public fun hasAiConsent(context: Context): Boolean =
        AIDataSharingConsentStore.hasGranted(context)

    public fun grantAiConsent(context: Context) {
        AIDataSharingConsentStore.grant(context)
    }

    public fun hasMicrophonePermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
