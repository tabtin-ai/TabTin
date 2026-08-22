import XCTest
@testable import Tabtin

final class AttachmentUploadPolicyTests: XCTestCase {
    func testSummaryCountsAttachmentsAndContextReferences() {
        let attachments = [
            makeAttachment(id: "ready", status: .ready),
            makeAttachment(id: "uploading", status: .uploading),
            makeAttachment(id: "failed", status: .error),
        ]

        let summary = AttachmentUploadPolicy.summary(
            attachments: attachments,
            contextReferenceCount: 2
        )

        XCTAssertEqual(summary.attachmentCount, 3)
        XCTAssertEqual(summary.contextReferenceCount, 2)
        XCTAssertEqual(summary.totalCount, 5)
        XCTAssertEqual(summary.readyCount, 3, "ready 附件 + 上下文引用均可随消息发送")
        XCTAssertEqual(summary.uploadingAttachmentCount, 1)
        XCTAssertEqual(summary.failedAttachmentCount, 1)
        XCTAssertEqual(summary.sendingBlocker, .uploading(count: 1))
    }

    func testFailureBlocksSendAfterAllUploadsFinish() {
        let summary = AttachmentUploadPolicy.summary(
            attachments: [makeAttachment(id: "failed", status: .error)],
            contextReferenceCount: 0
        )

        XCTAssertEqual(summary.sendingBlocker, .failed(count: 1))
    }

    func testOnlyPendingAndUploadingAttachmentsAreCancelledInBulk() {
        let attachments = [
            makeAttachment(id: "pending", status: .pending),
            makeAttachment(id: "uploading", status: .uploading),
            makeAttachment(id: "ready", status: .ready),
            makeAttachment(id: "failed", status: .error),
        ]

        XCTAssertEqual(
            AttachmentUploadPolicy.cancellableAttachmentIDs(in: attachments),
            ["pending", "uploading"]
        )
    }

    func testContextOnlyMaterialsAreReadyAndDoNotBlockSend() {
        let summary = AttachmentUploadPolicy.summary(
            attachments: [],
            contextReferenceCount: 3
        )

        XCTAssertEqual(summary.totalCount, 3)
        XCTAssertEqual(summary.readyCount, 3)
        XCTAssertNil(summary.sendingBlocker)
    }

    func testUnsupportedDocumentModelBlocksFileBeforeSendButAllowsImage() {
        let file = makeAttachment(id: "document", status: .ready)
        let image = makeAttachment(id: "image", status: .ready, kind: .photo)

        XCTAssertTrue(AttachmentUploadPolicy.hasUnsupportedDocumentAttachment(
            attachments: [file],
            supportsDocumentInput: false
        ))
        XCTAssertFalse(AttachmentUploadPolicy.hasUnsupportedDocumentAttachment(
            attachments: [image],
            supportsDocumentInput: false
        ))
        XCTAssertFalse(AttachmentUploadPolicy.hasUnsupportedDocumentAttachment(
            attachments: [file],
            supportsDocumentInput: true
        ))
    }

    private func makeAttachment(
        id: String,
        status: ComposerAttachmentUploadStatus,
        kind: ComposerLocalAttachment.Kind = .file
    ) -> ComposerLocalAttachment {
        var attachment = ComposerLocalAttachment(
            id: id,
            name: "\(id).txt",
            kind: kind,
            byteCount: 10,
            mimeType: "text/plain",
            url: nil,
            isTemporary: false
        )
        attachment.status = status
        return attachment
    }
}

final class ComposerCompactPresentationTests: XCTestCase {
    func testModeNamesMatchElectronCompactComposerLanguage() {
        XCTAssertEqual(ComposerModeOption(mode: .ask).title, "问答")
        XCTAssertEqual(ComposerModeOption(mode: .agent).title, "执行")
        XCTAssertEqual(ComposerModeOption(mode: .plan).title, "规划")
        XCTAssertEqual(ComposerModeOption(mode: .group).title, "PMO")
    }

    func testApprovalNamesAndSymbolsMatchElectronShieldSemantics() {
        let ask = ComposerApprovalOption(approval: .alwaysAsk)
        let automatic = ComposerApprovalOption(approval: .auto)
        let fullAccess = ComposerApprovalOption(approval: .fullAccess)

        XCTAssertEqual(ask.title, "请求权限")
        XCTAssertEqual(ask.icon, "checkmark.shield")
        XCTAssertEqual(automatic.title, "自动通过")
        XCTAssertEqual(automatic.icon, "shield")
        XCTAssertEqual(fullAccess.title, "全部允许")
        XCTAssertEqual(fullAccess.icon, "exclamationmark.shield")
    }

}
