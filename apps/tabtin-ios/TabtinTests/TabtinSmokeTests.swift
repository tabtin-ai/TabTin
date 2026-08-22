import XCTest
@testable import Tabtin

/// Phase 0 冒烟测试占位，确保测试 target 可编译可跑。
final class TabtinSmokeTests: XCTestCase {
    func testPhase0ScaffoldCompiles() {
        XCTAssertTrue(true)
    }

    func testBillingBlockClassificationPrefersExplicitBlockType() {
        XCTAssertFalse(BillingBlockClassification.isOrganizationGuard(
            blockType: "request_insufficient_credits",
            reason: "billing_guard_anomaly",
            code: nil,
            errorCode: "BILLING_BLOCKED"
        ))
        XCTAssertTrue(BillingBlockClassification.isOrganizationGuard(
            blockType: "organization_billing_guard",
            reason: "ORGANIZATION_INSUFFICIENT_CREDITS",
            code: nil,
            errorCode: nil
        ))
    }

    func testBillingBlockClassificationSupportsLegacyRequestShortfallCodes() {
        XCTAssertFalse(BillingBlockClassification.isOrganizationGuard(
            blockType: nil,
            reason: "ORGANIZATION_INSUFFICIENT_CREDITS",
            code: nil,
            errorCode: nil
        ))
        XCTAssertFalse(BillingBlockClassification.isOrganizationGuard(
            blockType: nil,
            reason: "billing_error",
            code: "billing_precheck_failed",
            errorCode: nil
        ))
        XCTAssertTrue(BillingBlockClassification.isOrganizationGuard(
            blockType: nil,
            reason: "unknown_legacy_event",
            code: nil,
            errorCode: nil
        ))
    }

    @MainActor
    func testSendNakOnlyPersistsExplicitOrganizationBillingGuard() {
        XCTAssertFalse(ConversationViewModel.isOrganizationBillingGuard(
            code: "internal_error",
            category: "route_none"
        ))
        XCTAssertFalse(ConversationViewModel.isOrganizationBillingGuard(
            code: "billing_precheck_failed",
            category: "billing_error"
        ))
        XCTAssertTrue(ConversationViewModel.isOrganizationBillingGuard(
            code: "billing_precheck_failed",
            category: "billing_blocked"
        ))
    }

    @MainActor
    func testBillingWarningDoesNotBlockConversationSubmission() {
        let viewModel = ConversationViewModel(sessionId: "billing-warning-session")
        viewModel.ingestEnvelopeForTesting(WSEnvelope.build(
            type: "billing.balance_low",
            deviceId: "ios-test",
            payload: ["message": "余额较低"],
            requestId: "billing-warning"
        ))

        XCTAssertNil(viewModel.billingBlockedTitle)
        XCTAssertNil(viewModel.billingBlockedMessage)
        XCTAssertNil(viewModel.enqueueBlockReason())
    }
}
