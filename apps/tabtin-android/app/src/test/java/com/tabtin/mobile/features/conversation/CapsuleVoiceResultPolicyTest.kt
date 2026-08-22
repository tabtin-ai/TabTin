package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.FocusTabSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CapsuleVoiceResultPolicyTest {

    @Test
    fun `capsule submission never includes composer attachments`() {
        val submission = CapsuleVoiceResultPolicy.buildSubmission(
            transcript = "hello",
            frozenFocus = focus("doc-a"),
        )
        assertEquals(AttachmentPolicy.NONE, submission.attachmentPolicy)
        assertEquals("doc-a", submission.frozenFocus.openTabs?.single()?.id)
    }

    @Test
    fun `draft and surface stay unchanged after voice send`() {
        val draft = ComposerDraftSnapshot(
            text = "draft text",
            attachmentIds = listOf("att-1"),
            referenceIds = listOf("ref-1"),
        )
        val surface = SurfaceNavigationSnapshot(
            viewMode = "detail",
            resourcePath = "detail/tabdoc/doc-a",
            scrollOffset = 420,
        )
        assertTrue(CapsuleVoiceResultPolicy.draftsUnchanged(draft, draft.copy()))
        assertTrue(CapsuleVoiceResultPolicy.surfaceUnchanged(surface, surface.copy()))
        assertFalse(
            CapsuleVoiceResultPolicy.surfaceUnchanged(
                surface,
                surface.copy(resourcePath = "detail/tabdoc/doc-b"),
            ),
        )
    }

    @Test
    fun `HITL paused billing and missing model block while busy allows queue`() {
        assertEquals(
            CapsuleVoiceGate.BLOCK_HITL,
            CapsuleVoiceResultPolicy.evaluateGate(
                CapsuleVoiceGateInput(
                    sessionPresent = true,
                    modelPresent = true,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                    pendingApproval = true,
                    pendingAnswer = false,
                    paused = false,
                    busy = true,
                ),
            ),
        )
        assertEquals(
            CapsuleVoiceGate.BLOCK_PAUSED,
            CapsuleVoiceResultPolicy.evaluateGate(
                CapsuleVoiceGateInput(
                    sessionPresent = true,
                    modelPresent = true,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = true,
                ),
            ),
        )
        assertEquals(
            CapsuleVoiceGate.BLOCK_BILLING,
            CapsuleVoiceResultPolicy.evaluateGate(
                CapsuleVoiceGateInput(
                    sessionPresent = true,
                    modelPresent = true,
                    billingBlocked = true,
                    memberLimitBlocked = false,
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = false,
                ),
            ),
        )
        assertEquals(
            CapsuleVoiceGate.BLOCK_MODEL_MISSING,
            CapsuleVoiceResultPolicy.evaluateGate(
                CapsuleVoiceGateInput(
                    sessionPresent = true,
                    modelPresent = false,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = false,
                ),
            ),
        )
        assertEquals(
            CapsuleVoiceGate.ALLOW_QUEUE,
            CapsuleVoiceResultPolicy.evaluateGate(
                CapsuleVoiceGateInput(
                    sessionPresent = true,
                    modelPresent = true,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = false,
                    busy = true,
                ),
            ),
        )
        assertTrue(
            CapsuleVoiceResultPolicy.shouldPreserveTranscript(CapsuleVoiceGate.BLOCK_HITL),
        )
    }

    @Test
    fun `A enqueue then B workbench still retries frozen A`() {
        val focusA = focus("doc-a")
        val focusB = focus("doc-b")
        val resolved = CapsuleVoiceResultPolicy.resolveRetryFocus(
            queuedFocus = focusA,
            currentWorkbenchFocus = focusB,
        )
        assertEquals("doc-a", resolved?.openTabs?.single()?.id)
        assertEquals(focusA, resolved)
    }

    private fun focus(docId: String) = ConversationFocusContext(
        appType = "tabdoc",
        spaceId = "space-1",
        openTabs = listOf(FocusTabSnapshot(type = "tabdoc", id = docId, active = true)),
    )
}
