import XCTest
@testable import Tabtin

final class ConversationRecoveryPresentationTests: XCTestCase {
    func testReconnectAfterDropResetsSeqCursor() {
        XCTAssertTrue(ConversationRecoveryPolicy.shouldResetSeqCursor(connectedAfterDrop: true))
        XCTAssertFalse(ConversationRecoveryPolicy.shouldResetSeqCursor(connectedAfterDrop: false))
    }

    func testReconnectWaitsForSubscribeBeforeResume() {
        XCTAssertTrue(
            ConversationRecoveryPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect: true,
                hasDesiredTopics: true
            )
        )
        XCTAssertFalse(
            ConversationRecoveryPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect: true,
                hasDesiredTopics: false
            )
        )
        XCTAssertFalse(
            ConversationRecoveryPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect: false,
                hasDesiredTopics: true
            )
        )
    }

    func testSettleOnlyReconcileSkipsStreamingTickInsteadOfAborting() {
        XCTAssertEqual(
            ConversationRecoveryPolicy.reconcileTick(
                streamingActive: true,
                allowWhileStreaming: false
            ),
            .skipWait
        )
        XCTAssertEqual(
            ConversationRecoveryPolicy.reconcileTick(
                streamingActive: true,
                allowWhileStreaming: true
            ),
            .apply
        )
    }

    func testInitialNormalEntryIsQuiet() {
        XCTAssertNil(ConversationRecoveryPresentation.banner(for: .idle))
    }

    func testTransportRecoveryDoesNotClaimDataIsSynchronized() {
        let interrupted = ConversationRecoveryPolicy.reduce(
            .idle,
            event: .transportInterrupted
        )
        let reconciling = ConversationRecoveryPolicy.reduce(
            interrupted,
            event: .reconciliationStarted
        )

        XCTAssertEqual(interrupted, .transportInterrupted)
        XCTAssertEqual(reconciling, .reconciling)
        XCTAssertFalse(
            ConversationRecoveryPresentation.banner(for: interrupted)?.dataReconciled ?? true
        )
        XCTAssertFalse(
            ConversationRecoveryPresentation.banner(for: reconciling)?.dataReconciled ?? true
        )
        XCTAssertEqual(
            ConversationRecoveryPresentation.banner(for: reconciling)?.text,
            "已连接，正在与服务器核对消息…"
        )
    }

    func testStreamingDefersReconciliationInsteadOfClaimingSuccess() {
        let deferred = ConversationRecoveryPolicy.reduce(
            .transportInterrupted,
            event: .reconciliationDeferredWhileStreaming
        )
        let banner = ConversationRecoveryPresentation.banner(for: deferred)

        XCTAssertEqual(deferred, .reconciliationDeferredWhileStreaming)
        XCTAssertTrue(banner?.showsProgress ?? false)
        XCTAssertFalse(banner?.dataReconciled ?? true)
        XCTAssertFalse(banner?.offersRetry ?? true)
    }

    func testOnlySuccessfulHTTPReconciliationGetsSyncedPresentation() {
        let synced = ConversationRecoveryPolicy.reduce(
            .reconciling,
            event: .reconciliationSucceeded
        )
        let banner = ConversationRecoveryPresentation.banner(for: synced)

        XCTAssertEqual(synced, .synced)
        XCTAssertEqual(banner?.text, "已与服务器同步")
        XCTAssertTrue(banner?.dataReconciled ?? false)
        XCTAssertFalse(banner?.offersRetry ?? true)
        XCTAssertEqual(
            ConversationRecoveryPolicy.reduce(synced, event: .syncedDismissed),
            .idle
        )
    }

    func testTransportReconnectionKeepsWaitingSemanticUntilReconciliationSucceeds() {
        let banner = ConversationRecoveryPresentation.banner(for: .reconciling)

        XCTAssertEqual(banner?.icon, "arrow.triangle.2.circlepath")
        XCTAssertTrue(banner?.showsProgress ?? false)
        XCTAssertFalse(banner?.dataReconciled ?? true)
        XCTAssertFalse(banner?.text.contains("同步完成") ?? true)
    }

    func testFailedReconciliationOffersManualRetry() {
        let failed = ConversationRecoveryPolicy.reduce(
            .reconciling,
            event: .reconciliationFailed
        )
        let banner = ConversationRecoveryPresentation.banner(for: failed)

        XCTAssertEqual(failed, .reconciliationFailed)
        XCTAssertEqual(banner?.style, .critical)
        XCTAssertTrue(banner?.offersRetry ?? false)
        XCTAssertFalse(banner?.dataReconciled ?? true)
        XCTAssertEqual(
            ConversationRecoveryPolicy.reduce(failed, event: .reconciliationStarted),
            .reconciling
        )
    }

    func testRemoteExecutionUnavailableBlocksComposerWithInlineCopy() {
        let deviceNotice = RemoteExecutionNoticePresentation.notice(for: .deviceUnavailable)
        let unboundNotice = RemoteExecutionNoticePresentation.notice(for: .workspaceNeedsDevice)

        XCTAssertTrue(RemoteExecutionState.deviceUnavailable.blocksComposer)
        XCTAssertTrue(RemoteExecutionState.workspaceNeedsDevice.blocksComposer)
        XCTAssertFalse(RemoteExecutionState.ready.blocksComposer)

        XCTAssertEqual(
            deviceNotice?.text,
            "该设备离线（请在电脑打开 TabTin 恢复连接）"
        )
        XCTAssertEqual(
            unboundNotice?.text,
            "尚未关联执行设备。请先在设置里绑定电脑，再发送任务。"
        )
        XCTAssertEqual(
            RemoteExecutionNoticePresentation.composerDisabledReason(for: .deviceUnavailable),
            deviceNotice?.text
        )
        XCTAssertNil(RemoteExecutionNoticePresentation.notice(for: .ready))
        XCTAssertNil(RemoteExecutionNoticePresentation.composerDisabledReason(for: .ready))
    }

    func testSessionReadyIndicatorRequiresWsAndExecutionDevice() {
        XCTAssertTrue(
            SessionReadyIndicatorPolicy.showsReady(
                gatewayConnected: true,
                remoteExecutionState: .ready
            )
        )
        XCTAssertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                gatewayConnected: true,
                remoteExecutionState: .deviceUnavailable
            )
        )
        XCTAssertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                gatewayConnected: true,
                remoteExecutionState: .workspaceNeedsDevice
            )
        )
        XCTAssertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                gatewayConnected: false,
                remoteExecutionState: .ready
            )
        )
        XCTAssertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                gatewayConnected: false,
                remoteExecutionState: .deviceUnavailable
            )
        )
    }
}
