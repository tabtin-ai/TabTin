import Foundation
import XCTest
@testable import Tabtin

final class ConversationDraftStoreTests: XCTestCase {
    private var directoryURL: URL!

    override func setUpWithError() throws {
        directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ConversationDraftStoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let directoryURL {
            try? FileManager.default.removeItem(at: directoryURL)
        }
        directoryURL = nil
    }

    func testSaveLoadPreservesRecoverableDraftAndStableID() async throws {
        let store = try ConversationDraftStore(baseDirectory: directoryURL)
        let scope = try ConversationDraftScope(
            organizationId: "organization-a",
            workspaceId: "workspace-a",
            projectId: "project-a"
        )
        let attachment = ConversationDraftAttachmentReference(
            id: "attachment-a",
            uploadedFileId: "file-server-a",
            name: "brief.pdf",
            kind: .file,
            byteCount: 42,
            mimeType: "application/pdf"
        )
        let context = ConversationDraftContextReference(
            id: "context-a",
            type: "document",
            resourceId: "doc-a",
            label: "需求文档",
            preview: "当前版本",
            spaceId: "workspace-a"
        )
        let initial = ConversationDraftSnapshot(
            draftId: "draft-stable-a",
            scope: scope,
            text: "先整理这份需求",
            agentId: "agent-a",
            modelId: "gpt-5.4",
            contextTierId: "long_1m",
            thinkingMode: "deep",
            agentMode: .plan,
            approvalMode: .auto,
            pendingSessionId: "session-pending-a",
            attachments: [attachment],
            contextReferences: [context]
        )

        let firstSave = try await store.save(initial)
        var updated = firstSave
        updated.text = "先整理并给出执行计划"
        updated.draftId = "caller-must-not-replace-stable-id"
        let secondSave = try await store.save(updated)
        let restored = try await store.load(scope: scope)

        XCTAssertEqual(secondSave.draftId, "draft-stable-a")
        XCTAssertEqual(
            secondSave.createdAt.timeIntervalSince1970,
            firstSave.createdAt.timeIntervalSince1970,
            accuracy: 0.001
        )
        XCTAssertEqual(restored?.draftId, "draft-stable-a")
        XCTAssertEqual(restored?.text, "先整理并给出执行计划")
        XCTAssertEqual(restored?.agentId, "agent-a")
        XCTAssertEqual(restored?.modelId, "gpt-5.4")
        XCTAssertEqual(restored?.contextTierId, "long_1m")
        XCTAssertEqual(restored?.thinkingMode, "deep")
        XCTAssertEqual(restored?.agentMode, .plan)
        XCTAssertEqual(restored?.approvalMode, .auto)
        XCTAssertEqual(restored?.pendingSessionId, "session-pending-a")
        XCTAssertEqual(restored?.attachments, [attachment])
        XCTAssertEqual(restored?.contextReferences, [context])
    }

    func testScopesAreStrictlyIsolatedByOrganizationWorkspaceAndProject() async throws {
        let store = try ConversationDraftStore(baseDirectory: directoryURL)
        let scopes = try [
            ConversationDraftScope(organizationId: "org-a", workspaceId: "workspace-a", projectId: nil),
            ConversationDraftScope(organizationId: "org-a", workspaceId: "workspace-a", projectId: "project-a"),
            ConversationDraftScope(organizationId: "org-a", workspaceId: "workspace-b", projectId: nil),
            ConversationDraftScope(organizationId: "org-b", workspaceId: "workspace-a", projectId: nil),
        ]

        for (index, scope) in scopes.enumerated() {
            _ = try await store.save(
                ConversationDraftSnapshot(scope: scope, text: "draft-\(index)")
            )
        }

        for (index, scope) in scopes.enumerated() {
            let draft = try await store.load(scope: scope)
            XCTAssertEqual(draft?.text, "draft-\(index)")
        }
    }

    func testDiscardAndSuccessfulSessionCreationRemoveDraft() async throws {
        let store = try ConversationDraftStore(baseDirectory: directoryURL)
        let scope = try ConversationDraftScope(organizationId: "org", workspaceId: "workspace")

        _ = try await store.save(ConversationDraftSnapshot(scope: scope, text: "待丢弃"))
        try await store.discard(scope: scope)
        let afterDiscard = try await store.load(scope: scope)
        XCTAssertNil(afterDiscard)

        _ = try await store.save(ConversationDraftSnapshot(scope: scope, text: "待转正式会话"))
        try await store.markSessionCreated(scope: scope)
        let afterSessionCreation = try await store.load(scope: scope)
        XCTAssertNil(afterSessionCreation)
    }

    func testPersistedAttachmentReferenceExcludesURLsAndSensitiveUploadData() async throws {
        let store = try ConversationDraftStore(baseDirectory: directoryURL)
        let scope = try ConversationDraftScope(organizationId: "org-sensitive", workspaceId: "workspace-sensitive")
        _ = try await store.save(
            ConversationDraftSnapshot(
                scope: scope,
                text: "保留文件引用",
                attachments: [
                    ConversationDraftAttachmentReference(
                        id: "attachment-safe",
                        uploadedFileId: "server-file-safe",
                        name: "notes.txt",
                        kind: .file
                    ),
                ]
            )
        )

        let savedFiles = try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(savedFiles.count, 1)
        XCTAssertFalse(savedFiles[0].lastPathComponent.contains("org-sensitive"))
        XCTAssertFalse(savedFiles[0].lastPathComponent.contains("workspace-sensitive"))

        let json = try String(contentsOf: savedFiles[0], encoding: .utf8)
        XCTAssertTrue(json.contains("server-file-safe"))
        XCTAssertFalse(json.contains("remoteURL"))
        XCTAssertFalse(json.contains("localURL"))
        XCTAssertFalse(json.contains("authorization"))
        XCTAssertFalse(json.contains("token"))
    }

    func testOnlyUploadedComposerAttachmentCanBecomePersistentReference() {
        let localURL = URL(fileURLWithPath: "/private/tmp/not-for-draft.bin")
        var attachment = ComposerLocalAttachment(
            id: "attachment-local",
            name: "local.bin",
            kind: .file,
            byteCount: 10,
            mimeType: "application/octet-stream",
            url: localURL,
            isTemporary: true
        )
        attachment.status = .ready
        attachment.fileId = "server-file"
        attachment.remoteURL = "https://example.invalid/signed?token=secret"

        let reference = ConversationDraftAttachmentReference(attachment: attachment)
        XCTAssertEqual(reference?.uploadedFileId, "server-file")
        XCTAssertEqual(reference?.name, "local.bin")
        XCTAssertNil(ConversationDraftAttachmentReference(
            attachment: ComposerLocalAttachment(
                id: "attachment-pending",
                name: "pending.bin",
                kind: .file,
                byteCount: nil,
                mimeType: nil,
                url: localURL,
                isTemporary: true
            )
        ))

        let restoredAttachment = reference?.composerAttachment()
        XCTAssertEqual(restoredAttachment?.status, .ready)
        XCTAssertEqual(restoredAttachment?.fileId, "server-file")
        XCTAssertNil(restoredAttachment?.url)
        XCTAssertNil(restoredAttachment?.remoteURL)
    }

    func testScopeRejectsMissingOrganizationOrWorkspace() {
        XCTAssertThrowsError(try ConversationDraftScope(organizationId: "", workspaceId: "workspace"))
        XCTAssertThrowsError(try ConversationDraftScope(organizationId: "org", workspaceId: "  "))
    }
}
