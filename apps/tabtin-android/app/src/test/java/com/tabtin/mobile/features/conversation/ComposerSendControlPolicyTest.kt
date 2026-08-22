package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AttachmentStatus
import com.tabtin.mobile.data.model.AttachmentType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerSendControlPolicyTest {
    @Test
    fun `ready attachment can be sent without text`() {
        assertTrue(
            ComposerSendControlPolicy.shouldShowSend(
                text = "",
                attachmentStatuses = listOf(AttachmentStatus.READY),
            ),
        )
    }

    @Test
    fun `pending or failed attachment alone cannot be sent`() {
        assertFalse(
            ComposerSendControlPolicy.shouldShowSend(
                text = "",
                attachmentStatuses = listOf(AttachmentStatus.PENDING),
            ),
        )
        assertFalse(
            ComposerSendControlPolicy.shouldShowSend(
                text = "",
                attachmentStatuses = listOf(AttachmentStatus.ERROR),
            ),
        )
    }

    @Test
    fun `unsupported document model blocks file before send but allows image`() {
        assertTrue(
            ComposerSendControlPolicy.hasUnsupportedDocumentAttachment(
                attachmentTypes = listOf(AttachmentType.FILE),
                supportsDocumentInput = false,
            ),
        )
        assertFalse(
            ComposerSendControlPolicy.hasUnsupportedDocumentAttachment(
                attachmentTypes = listOf(AttachmentType.IMAGE),
                supportsDocumentInput = false,
            ),
        )
        assertFalse(
            ComposerSendControlPolicy.hasUnsupportedDocumentAttachment(
                attachmentTypes = listOf(AttachmentType.FILE),
                supportsDocumentInput = true,
            ),
        )
    }
}
