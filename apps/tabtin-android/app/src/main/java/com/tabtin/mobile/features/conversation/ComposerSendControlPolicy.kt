package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.AttachmentType

internal object ComposerSendControlPolicy {
    fun shouldShowSend(
        text: String,
        attachmentStatuses: List<AttachmentStatus>,
    ): Boolean = text.isNotBlank() || attachmentStatuses.any { it == AttachmentStatus.READY }

    /** 图片仍走视觉能力；这里只拦 Electron 同口径的普通文件附件。 */
    fun hasUnsupportedDocumentAttachment(
        attachmentTypes: List<AttachmentType>,
        supportsDocumentInput: Boolean,
    ): Boolean = !supportsDocumentInput && attachmentTypes.any { it == AttachmentType.FILE }
}
