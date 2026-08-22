package com.tabtin.mobile.data.model

import android.net.Uri

// ---------------------------------------------------------------------------
// 附件相关（本地状态，不参与网络序列化）
// ---------------------------------------------------------------------------

public enum class AttachmentStatus { PENDING, UPLOADING, READY, ERROR }
public enum class AttachmentType { IMAGE, FILE }

public data class ChatAttachment(
    val id: String,
    val uri: Uri,
    val filename: String,
    val mimeType: String,
    val size: Long,
    val type: AttachmentType,
    val status: AttachmentStatus = AttachmentStatus.PENDING,
    val progress: Float = 0f,
    val fileId: String? = null,
    val remoteUrl: String? = null,
    val error: String? = null,
)
