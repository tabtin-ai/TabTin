import XCTest
@testable import Tabtin

final class NativeTabDocCommentTests: XCTestCase {
    private let labels = NativeTabDocCommentPresentationLabels(
        documentTitle: "文档评论",
        blockTitle: "块评论",
        orphanedTitle: "失联评论",
        anonymousAuthor: "匿名"
    )

    func testWritePolicyBlocksConflictReadOnlyAndFullEditor() {
        XCTAssertTrue(
            NativeTabDocCommentWritePolicy.canCreate(
                saveState: .saved,
                isReadOnly: false,
                requiresFullEditor: false
            )
        )
        XCTAssertFalse(
            NativeTabDocCommentWritePolicy.canCreate(
                saveState: .conflict,
                isReadOnly: false,
                requiresFullEditor: false
            )
        )
        XCTAssertFalse(
            NativeTabDocCommentWritePolicy.canCreate(
                saveState: .saved,
                isReadOnly: true,
                requiresFullEditor: false
            )
        )
        XCTAssertFalse(
            NativeTabDocCommentWritePolicy.canCreate(
                saveState: .saved,
                isReadOnly: false,
                requiresFullEditor: true
            )
        )
    }

    /// 服务端 `serialize_thread` 不返回顶层 `selected_text`，文档级 `anchor` 只有
    /// `{"version":1}`，桌面端块级评论也可能不带 `block_ids`。任一字段缺失都不能
    /// 让整份列表解不出来——那会让手机端显示成「还没有评论」。
    func testListDecodesServerPayloadWithoutOptionalAnchorKeys() throws {
        let json = """
        {
          "threads": [
            {
              "id": "thread-doc",
              "document_id": "doc-1",
              "scope": "document",
              "status": "open",
              "anchor": {"version": 1},
              "anchor_status": "none",
              "created_by_user_id": null,
              "resolved_by_user_id": null,
              "resolved_at": null,
              "created_at": "2026-08-18T01:00:00+00:00",
              "updated_at": "2026-08-18T01:00:00+00:00",
              "messages": [
                {
                  "id": "msg-1",
                  "thread_id": "thread-doc",
                  "kind": "root",
                  "author_name": "桌面端同事",
                  "author_user_id": "user-9",
                  "author_avatar": null,
                  "author_account_name": "desktop",
                  "body": "桌面端写的文档评论",
                  "mention_user_ids": [],
                  "client_request_id": null,
                  "is_deleted": false,
                  "attachments": [],
                  "created_at": "2026-08-18T01:00:00+00:00",
                  "updated_at": "2026-08-18T01:00:00+00:00"
                }
              ]
            },
            {
              "id": "thread-block",
              "document_id": "doc-1",
              "scope": "block",
              "status": "open",
              "anchor": {"version": 1, "block_ids": ["pm-block-1"], "block_type": "paragraph"},
              "anchor_status": "attached",
              "messages": [
                {
                  "id": "msg-2",
                  "thread_id": "thread-block",
                  "kind": "root",
                  "author_name": "桌面端同事",
                  "body": "桌面端写的段落评论",
                  "is_deleted": false
                }
              ]
            }
          ],
          "capabilities": ["comment_threads_v1"]
        }
        """
        let decoded = try JSONDecoder().decode(
            NativeTabDocCommentThreadListResponse.self,
            from: try XCTUnwrap(json.data(using: .utf8))
        )

        XCTAssertEqual(decoded.threads.count, 2)
        XCTAssertEqual(decoded.threads.first?.anchor.version, 1)
        XCTAssertEqual(decoded.threads.first?.anchor.blockIds, [])
        XCTAssertNil(decoded.threads.first?.selectedText)
        XCTAssertEqual(decoded.threads.first?.messages.first?.body, "桌面端写的文档评论")
        XCTAssertEqual(decoded.threads.last?.anchor.blockIds, ["pm-block-1"])
        XCTAssertEqual(decoded.threads.last?.anchor.blockType, "paragraph")
    }

    func testPresentationSeedsAvatarColorWithAuthorIdentity() {
        let thread = NativeTabDocCommentThread(
            id: "thread-record-id",
            documentId: "doc-1",
            scope: "document",
            messages: [
                NativeTabDocCommentMessage(
                    id: "msg-1",
                    threadId: "thread-record-id",
                    authorName: "王小明",
                    authorUserId: "user-9",
                    body: "整篇备注"
                ),
            ]
        )

        let presented = NativeTabDocCommentPresentationPolicy.present(
            threads: [thread],
            blocks: [],
            labels: labels
        ).first

        XCTAssertEqual(presented?.authorIdentitySeed, "user-9")
        XCTAssertNotEqual(presented?.authorIdentitySeed, "thread-record-id")
    }

    func testPresentationFallsBackToAuthorNameWhenIdentityMissing() {
        let thread = NativeTabDocCommentThread(
            id: "thread-record-id",
            documentId: "doc-1",
            scope: "document",
            messages: [
                NativeTabDocCommentMessage(
                    id: "msg-1",
                    threadId: "thread-record-id",
                    authorName: "王小明",
                    body: "整篇备注"
                ),
            ]
        )

        let presented = NativeTabDocCommentPresentationPolicy.present(
            threads: [thread],
            blocks: [],
            labels: labels
        ).first

        XCTAssertEqual(presented?.authorIdentitySeed, "王小明")
    }

    func testBlockThreadAttachesWhenBlockIdsMatchPersistentId() {
        let block = NativeTabDocBlock(
            kind: .paragraph,
            text: "第一段正文",
            rawNode: [
                "type": AnyCodable("paragraph"),
                "attrs": AnyCodable(["blockId": "pm-block-1"]),
            ]
        )
        let thread = commentThread(
            id: "thread-record-id",
            scope: "block",
            blockIds: ["pm-block-1"],
            body: "看一下这段",
            authorName: "Alice"
        )

        let presented = NativeTabDocCommentPresentationPolicy.present(
            threads: [thread],
            blocks: [block],
            labels: labels
        ).first

        XCTAssertEqual(presented?.kind, .block)
        XCTAssertEqual(presented?.matchedBlockId, "pm-block-1")
        XCTAssertEqual(presented?.title, "第一段正文")
        XCTAssertEqual(presented?.body, "看一下这段")
        XCTAssertEqual(presented?.authorName, "Alice")
        XCTAssertFalse(presented?.title.contains("thread-record-id") == true)
    }

    func testBlockThreadIsOrphanedWhenBlockIdsMissNativeBlock() {
        let block = NativeTabDocBlock(
            kind: .paragraph,
            text: "第一段正文",
            rawNode: [
                "type": AnyCodable("paragraph"),
                "attrs": AnyCodable(["blockId": "pm-block-1"]),
            ]
        )
        let thread = commentThread(
            id: "thread-record-id",
            scope: "block",
            blockIds: ["missing-block"],
            body: "失联内容",
            authorName: "Alice"
        )

        let presented = NativeTabDocCommentPresentationPolicy.present(
            threads: [thread],
            blocks: [block],
            labels: labels
        ).first

        XCTAssertEqual(presented?.kind, .orphaned)
        XCTAssertEqual(presented?.title, "失联评论")
        XCTAssertFalse(presented?.title.contains("thread-record-id") == true)
        XCTAssertNil(presented?.matchedBlockId)
    }

    func testDocumentThreadUsesDocumentCommentTitle() {
        let thread = commentThread(
            id: "thread-record-id",
            scope: "document",
            blockIds: [],
            body: "整篇备注",
            authorName: "Bob"
        )
        let presented = NativeTabDocCommentPresentationPolicy.present(
            threads: [thread],
            blocks: [],
            labels: labels
        ).first

        XCTAssertEqual(presented?.kind, .document)
        XCTAssertEqual(presented?.title, "文档评论")
        XCTAssertFalse(presented?.title.isEmpty == true)
        XCTAssertEqual(presented?.body, "整篇备注")
        XCTAssertFalse(presented?.title.contains("thread-record-id") == true)
    }

    func testDocumentThreadTitleUsesLocalizedDocumentCommentLabel() {
        let englishLabels = NativeTabDocCommentPresentationLabels(
            documentTitle: "Document comment",
            blockTitle: "Block comment",
            orphanedTitle: "Orphaned comment",
            anonymousAuthor: "Anonymous"
        )
        let thread = commentThread(
            id: "thread-record-id",
            scope: "document",
            blockIds: [],
            body: "Whole-document note",
            authorName: "Bob"
        )
        let presented = NativeTabDocCommentPresentationPolicy.present(
            threads: [thread],
            blocks: [],
            labels: englishLabels
        ).first

        XCTAssertEqual(presented?.kind, .document)
        XCTAssertEqual(presented?.title, "Document comment")
        XCTAssertFalse(presented?.title.isEmpty == true)
        XCTAssertNotEqual(presented?.title, thread.id)
        XCTAssertFalse(presented?.title.contains("thread-record-id") == true)
    }

    @MainActor
    func testSessionLoadsCommentThreadsOnOpen() async {
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detailWithBlockId(text: "第一段正文", blockId: "pm-block-1", role: "editor")
            },
            commentThreadsListRequest: { documentId in
                XCTAssertEqual(documentId, "doc-1")
                return NativeTabDocCommentThreadListResponse(
                    threads: [
                        self.commentThread(
                            id: "thread-record-id",
                            scope: "block",
                            blockIds: ["pm-block-1"],
                            body: "看一下这段",
                            authorName: "Alice"
                        ),
                    ]
                )
            }
        )

        await session.load()

        XCTAssertEqual(session.commentPresentations.count, 1)
        XCTAssertEqual(session.commentPresentations.first?.title, "第一段正文")
        XCTAssertFalse(session.commentPresentations.first?.title.contains("thread-record-id") == true)
        XCTAssertTrue(session.canCreateComment)
        XCTAssertNil(session.commentMessage)
    }

    @MainActor
    func testCommentLoadFailureIsSurfacedInsteadOfLookingEmpty() async {
        struct LoadFailure: Error {}
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detailWithBlockId(text: "第一段正文", blockId: "pm-block-1", role: "editor")
            },
            commentThreadsListRequest: { _ in throw LoadFailure() }
        )

        await session.load()

        XCTAssertTrue(session.commentPresentations.isEmpty)
        XCTAssertEqual(session.commentMessage, L10n.TabDoc.commentLoadFailed)
    }

    @MainActor
    func testRefreshCommentsPicksUpThreadsCreatedElsewhere() async {
        var listCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detailWithBlockId(text: "第一段正文", blockId: "pm-block-1", role: "editor")
            },
            commentThreadsListRequest: { _ in
                listCount += 1
                guard listCount > 1 else { return NativeTabDocCommentThreadListResponse() }
                return NativeTabDocCommentThreadListResponse(
                    threads: [
                        self.commentThread(
                            id: "thread-from-desktop",
                            scope: "document",
                            blockIds: [],
                            body: "桌面端刚写的",
                            authorName: "同事"
                        ),
                    ]
                )
            }
        )

        await session.load()
        XCTAssertTrue(session.commentPresentations.isEmpty)

        await session.refreshComments()

        XCTAssertEqual(session.commentPresentations.count, 1)
        XCTAssertEqual(session.commentPresentations.first?.body, "桌面端刚写的")
    }

    @MainActor
    func testSessionPostsDocumentCommentWithoutWritingCommentAnchor() async throws {
        var postedBody: [String: Any]?
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detailWithBlockId(text: "第一段正文", blockId: "pm-block-1", role: "editor")
            },
            commentThreadsListRequest: { _ in NativeTabDocCommentThreadListResponse() },
            commentThreadCreateRequest: { _, body in
                postedBody = body
                return NativeTabDocCommentThreadCreateResponse(
                    thread: self.commentThread(
                        id: "created-1",
                        scope: "document",
                        blockIds: [],
                        body: "文档备注",
                        authorName: "Me"
                    )
                )
            }
        )
        await session.load()
        session.updateDocumentCommentDraft("文档备注")
        await session.submitDocumentComment()

        XCTAssertEqual(postedBody?["scope"] as? String, "document")
        XCTAssertEqual(postedBody?["body"] as? String, "文档备注")
        let anchor = postedBody?["anchor"] as? [String: Any]
        XCTAssertEqual(anchor?["version"] as? Int, 1)
        XCTAssertEqual(session.documentCommentDraft, "")
        XCTAssertEqual(session.commentPresentations.count, 1)
        XCTAssertFalse(session.body.blocks.contains { $0.rawNode["commentAnchor"] != nil })
    }

    @MainActor
    func testSessionPostsBlockCommentUsingPersistentBlockId() async throws {
        var postedBody: [String: Any]?
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detailWithBlockId(text: "第一段正文", blockId: "pm-block-1", role: "editor")
            },
            commentThreadsListRequest: { _ in NativeTabDocCommentThreadListResponse() },
            commentThreadCreateRequest: { _, body in
                postedBody = body
                return NativeTabDocCommentThreadCreateResponse(
                    thread: self.commentThread(
                        id: "created-block",
                        scope: "block",
                        blockIds: ["pm-block-1"],
                        body: "段落备注",
                        authorName: "Me"
                    )
                )
            }
        )
        await session.load()
        let runtimeId = try XCTUnwrap(session.body.blocks.first?.id)
        session.startBlockComment(blockId: runtimeId)
        session.updateBlockCommentDraft("段落备注")
        await session.submitBlockComment()

        XCTAssertEqual(postedBody?["scope"] as? String, "block")
        let anchor = postedBody?["anchor"] as? [String: Any]
        XCTAssertEqual(anchor?["block_ids"] as? [String], ["pm-block-1"])
        XCTAssertEqual(anchor?["block_type"] as? String, "paragraph")
        XCTAssertFalse(session.isShowingBlockCommentComposer)
    }

    @MainActor
    func testCommentCreateIsBlockedDuringConflict() async throws {
        var createCount = 0
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        try store.save(
            NativeTabDocDraft(
                title: "本地草稿",
                body: NativeTabDocBody(
                    rootAttributes: ["type": AnyCodable("doc")],
                    blocks: [NativeTabDocBlock(kind: .paragraph, text: "本地")]
                ),
                baseVersion: 3,
                baseUpdatedAt: "2026-08-13T02:00:00Z"
            ),
            documentId: "doc-1",
            userId: "user-1",
            organizationId: "org-1"
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detailWithBlockId(
                    text: "云端正文",
                    blockId: "pm-block-1",
                    role: "editor",
                    version: 4,
                    updatedAt: "2026-08-13T03:00:00Z"
                )
            },
            commentThreadsListRequest: { _ in NativeTabDocCommentThreadListResponse() },
            commentThreadCreateRequest: { _, _ in
                createCount += 1
                return NativeTabDocCommentThreadCreateResponse(
                    thread: self.commentThread(
                        id: "should-not-create",
                        scope: "document",
                        blockIds: [],
                        body: "no",
                        authorName: "Me"
                    )
                )
            }
        )
        await session.load()
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertFalse(session.canCreateComment)
        session.updateDocumentCommentDraft("不该发出去")
        await session.submitDocumentComment()
        XCTAssertEqual(createCount, 0)
    }

    private func commentThread(
        id: String,
        scope: String,
        blockIds: [String],
        body: String,
        authorName: String
    ) -> NativeTabDocCommentThread {
        NativeTabDocCommentThread(
            id: id,
            documentId: "doc-1",
            scope: scope,
            anchor: NativeTabDocCommentAnchor(blockIds: blockIds),
            messages: [
                NativeTabDocCommentMessage(
                    id: "msg-\(id)",
                    threadId: id,
                    kind: "root",
                    authorName: authorName,
                    body: body
                ),
            ]
        )
    }

    private func detailWithBlockId(
        text: String,
        blockId: String,
        role: String,
        version: Int = 1,
        updatedAt: String = "2026-08-18T00:00:00Z"
    ) -> NativeTabDocDetail {
        let parsed = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([
                    [
                        "type": "paragraph",
                        "attrs": ["blockId": blockId],
                        "content": [["type": "text", "text": text]],
                    ],
                ]),
            ],
            markdownFallback: text
        )
        return NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: "doc-1",
                organizationId: "org-1",
                spaceId: "space-1",
                title: "验收文档",
                latestVersion: version,
                updatedAt: updatedAt,
                currentUserRole: role
            ),
            content: NativeTabDocContent(
                descriptionJSON: parsed.serializedJSON,
                descriptionMarkdown: parsed.markdown,
                descriptionPlaintext: parsed.plaintext
            )
        )
    }
}
