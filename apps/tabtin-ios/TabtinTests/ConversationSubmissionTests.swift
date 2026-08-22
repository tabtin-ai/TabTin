import XCTest
@testable import Tabtin

final class ConversationSubmissionTests: XCTestCase {
    func testComposerAllowsReadyAttachmentWithoutText() {
        let readyImage = ComposerLocalAttachment(
            id: "image-1",
            name: "photo.jpg",
            kind: .photo,
            byteCount: nil,
            mimeType: "image/jpeg",
            url: nil,
            isTemporary: false,
            status: .ready
        )

        XCTAssertTrue(
            AttachmentUploadPolicy.canSubmit(
                text: "",
                attachments: [readyImage]
            )
        )
    }

    func testComposerDoesNotSubmitUnreadyAttachmentWithoutText() {
        let uploadingImage = ComposerLocalAttachment(
            id: "image-1",
            name: "photo.jpg",
            kind: .photo,
            byteCount: nil,
            mimeType: "image/jpeg",
            url: nil,
            isTemporary: false,
            status: .uploading
        )

        XCTAssertFalse(
            AttachmentUploadPolicy.canSubmit(
                text: "",
                attachments: [uploadingImage]
            )
        )
        XCTAssertTrue(
            AttachmentUploadPolicy.canSubmit(
                text: "caption",
                attachments: [uploadingImage]
            )
        )
    }

    func testAttachmentUploadScopeFallsBackToCurrentSessionOrganization() {
        let scope = AttachmentUploadScopeResolver.resolve(
            contextId: "session-1",
            targetOrganizationId: "",
            draftOrganizationId: nil,
            sessionOrganizationId: "session-org",
            workspaceOrganizationId: "workspace-org"
        )

        XCTAssertEqual(scope?.organizationId, "session-org")
        XCTAssertEqual(scope?.contextId, "session-1")
    }

    func testAttachmentUploadScopeFallsBackToSelectedWorkspaceOrganization() {
        let scope = AttachmentUploadScopeResolver.resolve(
            contextId: "draft-1",
            targetOrganizationId: nil,
            draftOrganizationId: " ",
            sessionOrganizationId: nil,
            workspaceOrganizationId: "workspace-org"
        )

        XCTAssertEqual(scope?.organizationId, "workspace-org")
        XCTAssertEqual(scope?.contextType, "message")
    }

    func testCapsuleVoiceDoesNotMutateComposerDraftOrCarryBlocks() {
        let focus = FocusSnapshot(
            appType: "tabdoc",
            openTabs: [FocusTab(type: "tabdoc", id: "doc-A", active: true, app_key: "tabdoc")],
            spaceId: "space-1",
            userTimeZone: "Asia/Shanghai",
            workspaceMode: "desktop"
        )
        let request = ConversationSubmissionRequest.capsuleVoice(
            transcript: "把标题改成发布计划",
            focusSnapshot: focus
        )
        XCTAssertEqual(request.source, .capsuleVoice)
        XCTAssertFalse(request.shouldMutateComposerDraft)
        XCTAssertFalse(request.includesComposerBlocks)
        XCTAssertEqual(request.attachmentPolicy, .none)
        XCTAssertEqual(request.focusSnapshot?.openTabs?.first?.id, "doc-A")
    }

    func testComposerMayCarryBlocksAndMutateDraft() {
        let request = ConversationSubmissionRequest.composer(
            text: "hello",
            focusSnapshot: nil,
            blockCount: 2
        )
        XCTAssertTrue(request.shouldMutateComposerDraft)
        XCTAssertTrue(request.includesComposerBlocks)
    }

    func testGateBlocksHITLPausedBillingAndMissingModel() {
        XCTAssertEqual(
            ConversationSubmission.gate(
                hitlPending: true,
                isPaused: false,
                billingBlocked: false,
                hasSendableModel: true
            ),
            .block(reason: "需要先完成确认或回答，才能继续发送。")
        )
        XCTAssertEqual(
            ConversationSubmission.gate(
                hitlPending: false,
                isPaused: true,
                billingBlocked: false,
                hasSendableModel: true
            ),
            .block(reason: "任务已暂停，恢复后再发送。")
        )
        XCTAssertEqual(
            ConversationSubmission.gate(
                hitlPending: false,
                isPaused: false,
                billingBlocked: true,
                hasSendableModel: true
            ),
            .block(reason: "当前计费状态阻止发送。")
        )
        XCTAssertEqual(
            ConversationSubmission.gate(
                hitlPending: false,
                isPaused: false,
                billingBlocked: false,
                hasSendableModel: false
            ),
            .block(reason: "没有可用模型：请在管理后台配置并激活聊天模型后重试。")
        )
        XCTAssertEqual(
            ConversationSubmission.gate(
                hitlPending: false,
                isPaused: false,
                billingBlocked: false,
                hasSendableModel: true
            ),
            .allow
        )
    }

    func testBusyIsNotBlockedBySubmissionGate() {
        // busy 允许排队：门禁本身不看 busy。
        XCTAssertEqual(
            ConversationSubmission.gate(
                hitlPending: false,
                isPaused: false,
                billingBlocked: false,
                hasSendableModel: true
            ),
            .allow
        )
    }

    func testAutoDrainRequiresControlAndHITLHydrationFirst() {
        XCTAssertEqual(
            SessionAutoDrainSequence.beforeAutoDrain,
            [.refreshControlState, .hydratePendingInteractions, .openAutoDrain]
        )
        XCTAssertFalse(
            SessionAutoDrainSequence.allowsAutoDrain(
                controlStateReady: true,
                hitlHydrationCompleted: false
            )
        )
        XCTAssertFalse(
            SessionAutoDrainSequence.allowsAutoDrain(
                controlStateReady: false,
                hitlHydrationCompleted: true
            )
        )
        XCTAssertTrue(
            SessionAutoDrainSequence.allowsAutoDrain(
                controlStateReady: true,
                hitlHydrationCompleted: true
            )
        )
    }

    func testAutoDrainFailClosedOnStepFailure() {
        XCTAssertFalse(
            SessionAutoDrainSequence.allowsAutoDrain(
                controlState: .success,
                hitlHydration: .failure
            )
        )
        XCTAssertFalse(
            SessionAutoDrainSequence.allowsAutoDrain(
                controlState: .failure,
                hitlHydration: .success
            )
        )
        XCTAssertFalse(
            SessionAutoDrainSequence.allowsAutoDrain(
                controlState: .failure,
                hitlHydration: .failure
            )
        )
        XCTAssertTrue(
            SessionAutoDrainSequence.allowsAutoDrain(
                controlState: .success,
                hitlHydration: .success
            )
        )
    }

    func testPendingInteractionRefreshResultDistinguishesEmptySuccessFromFailure() {
        // 空成功允许 drain；失败禁止把网络错误当成「无 HITL」。
        XCTAssertNotEqual(
            PendingInteractionRefreshResult.success([]),
            PendingInteractionRefreshResult.failure
        )
        if case let .success(items) = PendingInteractionRefreshResult.success([]) {
            XCTAssertTrue(items.isEmpty)
        } else {
            XCTFail("expected success([])")
        }
    }

    func testComposerSnapshotClearsOnlyMatchingDraft() {
        let focus = FocusSnapshot(
            appType: "tabdoc",
            openTabs: [FocusTab(type: "tabdoc", id: "doc-1", active: true, app_key: "tabdoc")],
            spaceId: "s1",
            userTimeZone: "UTC",
            workspaceMode: "desktop"
        )
        let snapshot = ConversationComposerSendSnapshot.capturing(
            text: "hello",
            focusSnapshot: focus,
            contextRefs: [],
            attachments: [],
            blockPayloads: [["type": "text"]],
            draftRevision: 7,
            sendToken: "token-7"
        )
        XCTAssertEqual(snapshot.request.source, .composer)
        XCTAssertEqual(snapshot.focusSnapshot?.openTabs?.first?.id, "doc-1")
        XCTAssertEqual(snapshot.blockPayloads.count, 1)
        XCTAssertEqual(snapshot.draftRevision, 7)
        XCTAssertEqual(snapshot.sendToken, "token-7")
        XCTAssertTrue(
            ConversationComposerSendSnapshot.shouldClearDraft(
                currentDraft: "hello",
                snapshotText: "hello"
            )
        )
        XCTAssertTrue(
            ConversationComposerSendSnapshot.shouldClearDraft(
                currentDraft: "",
                snapshotText: "hello"
            )
        )
        XCTAssertFalse(
            ConversationComposerSendSnapshot.shouldClearDraft(
                currentDraft: "hello and more typed while sending",
                snapshotText: "hello"
            )
        )
        XCTAssertFalse(
            ConversationComposerSendSnapshot.shouldRestoreDraft(
                currentDraft: "typed after send failed",
                snapshotText: "hello"
            )
        )
        XCTAssertTrue(
            ConversationComposerSendSnapshot.ownsInFlightSend(
                inFlightToken: "token-7",
                snapshotToken: "token-7"
            )
        )
        XCTAssertFalse(
            ConversationComposerSendSnapshot.ownsInFlightSend(
                inFlightToken: "token-other",
                snapshotToken: "token-7"
            )
        )
        XCTAssertFalse(
            ConversationComposerSendSnapshot.ownsInFlightSend(
                inFlightToken: nil,
                snapshotToken: "token-7"
            )
        )
    }

    func testEditResendPreservesDraftForBlockedAndFailedReceipts() {
        XCTAssertTrue(
            ConversationComposerSendSnapshot.shouldPreserveDraft(
                after: .blocked(reason: "需要先完成确认")
            )
        )
        XCTAssertTrue(
            ConversationComposerSendSnapshot.shouldPreserveDraft(
                after: .failed(reason: "消息未能保存到本机")
            )
        )
        XCTAssertTrue(ConversationComposerSendSnapshot.shouldPreserveDraft(after: nil))

        XCTAssertFalse(
            ConversationComposerSendSnapshot.shouldPreserveDraft(
                after: .persisted(queueId: "queue-1")
            )
        )
        XCTAssertFalse(
            ConversationComposerSendSnapshot.shouldPreserveDraft(
                after: .queued(queueId: "queue-2")
            )
        )
        XCTAssertFalse(
            ConversationComposerSendSnapshot.shouldPreserveDraft(
                after: .accepted(queueId: "queue-3")
            )
        )
    }

    func testAutoReadRequiresConversationVisibility() {
        XCTAssertFalse(
            ConversationAutoReadVisibilityGate.allowsAutoReadAck(
                isConversationContentVisible: false
            )
        )
        XCTAssertTrue(
            ConversationAutoReadVisibilityGate.allowsAutoReadAck(
                isConversationContentVisible: true
            )
        )
    }
}
