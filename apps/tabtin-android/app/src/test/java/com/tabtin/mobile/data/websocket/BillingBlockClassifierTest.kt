package com.tabtin.mobile.data.websocket

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BillingBlockClassifierTest {
    @Test
    fun explicitRequestShortfallDoesNotBlockOrganization() {
        assertFalse(
            BillingBlockClassifier.isOrganizationGuard(
                blockType = "request_insufficient_credits",
                reason = "billing_guard_anomaly",
                code = null,
                errorCode = "BILLING_BLOCKED",
            ),
        )
    }

    @Test
    fun organizationGuardBlocksAndLegacyRequestCodesRemainUnblocked() {
        assertTrue(
            BillingBlockClassifier.isOrganizationGuard(
                blockType = "organization_billing_guard",
                reason = "ORGANIZATION_INSUFFICIENT_CREDITS",
                code = null,
                errorCode = null,
            ),
        )
        assertFalse(
            BillingBlockClassifier.isOrganizationGuard(
                blockType = null,
                reason = null,
                code = "BILLING_WALLET_INSUFFICIENT",
                errorCode = null,
            ),
        )
    }

    @Test
    fun unknownLegacyEventStaysConservativelyBlocked() {
        assertTrue(
            BillingBlockClassifier.isOrganizationGuard(
                blockType = null,
                reason = "billing_guard_anomaly",
                code = null,
                errorCode = null,
            ),
        )
    }
}
