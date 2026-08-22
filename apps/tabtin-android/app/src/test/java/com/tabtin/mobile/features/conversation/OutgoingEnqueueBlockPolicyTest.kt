package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingEnqueueBlockPolicyTest {
    @Test
    fun `HITL blocks auto drain`() {
        assertEquals(
            OutgoingEnqueueBlock.HITL,
            OutgoingEnqueueBlockPolicy.evaluate(
                OutgoingEnqueueBlockInput(
                    pendingApproval = true,
                    pendingAnswer = false,
                    paused = false,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                ),
            ),
        )
        assertFalse(
            OutgoingEnqueueBlockPolicy.canAutoDrain(
                OutgoingEnqueueBlockInput(
                    pendingApproval = false,
                    pendingAnswer = true,
                    paused = false,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                ),
            ),
        )
    }

    @Test
    fun `paused and billing block`() {
        assertEquals(
            OutgoingEnqueueBlock.PAUSED,
            OutgoingEnqueueBlockPolicy.evaluate(
                OutgoingEnqueueBlockInput(
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = true,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                ),
            ),
        )
        assertEquals(
            OutgoingEnqueueBlock.BILLING,
            OutgoingEnqueueBlockPolicy.evaluate(
                OutgoingEnqueueBlockInput(
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = false,
                    billingBlocked = true,
                    memberLimitBlocked = false,
                ),
            ),
        )
    }

    @Test
    fun `clear state allows drain`() {
        assertNull(
            OutgoingEnqueueBlockPolicy.evaluate(
                OutgoingEnqueueBlockInput(
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = false,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                ),
            ),
        )
        assertTrue(
            OutgoingEnqueueBlockPolicy.canAutoDrain(
                OutgoingEnqueueBlockInput(
                    pendingApproval = false,
                    pendingAnswer = false,
                    paused = false,
                    billingBlocked = false,
                    memberLimitBlocked = false,
                ),
            ),
        )
    }
}
