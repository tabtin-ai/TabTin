import XCTest
@testable import Tabtin

final class NativeTabDocTests: XCTestCase {
    func testReadingWidthKeepsTextCappedAndLetsTablesUseTheWholeViewport() {
        XCTAssertEqual(
            NativeTabDocReadingWidthPolicy.contentWidth(viewportWidth: 320),
            288
        )
        XCTAssertEqual(
            NativeTabDocReadingWidthPolicy.contentWidth(viewportWidth: 1_024),
            720
        )
        XCTAssertEqual(
            NativeTabDocReadingWidthPolicy.blockWidth(
                viewportWidth: 1_024,
                kind: .paragraph
            ),
            720
        )
        XCTAssertEqual(
            NativeTabDocReadingWidthPolicy.blockWidth(
                viewportWidth: 1_024,
                kind: .table
            ),
            1_024
        )
    }

    func testRichTextFocusPolicyEndsEditingWhenWritePermissionIsRemoved() {
        XCTAssertTrue(
            NativeTabDocRichTextFocusPolicy.shouldResignFirstResponder(
                wasEditable: true,
                isEditable: false,
                isFirstResponder: true
            )
        )
        XCTAssertFalse(
            NativeTabDocRichTextFocusPolicy.shouldResignFirstResponder(
                wasEditable: false,
                isEditable: false,
                isFirstResponder: true
            )
        )
        XCTAssertFalse(
            NativeTabDocRichTextFocusPolicy.shouldResignFirstResponder(
                wasEditable: true,
                isEditable: true,
                isFirstResponder: true
            )
        )
    }

    func testTableRowHeightUsesTallestCellForEveryCell() {
        XCTAssertEqual(
            NativeTabDocTableRowHeightPolicy.sharedHeight(cellHeights: [44, 132, 76]),
            132
        )
        XCTAssertEqual(
            NativeTabDocTableRowHeightPolicy.sharedHeight(cellHeights: []),
            0
        )
    }

    func testTableColumnWidthUsesViewportAfterReservingTheCoordinateHeader() {
        // 与 Android TablePresentation 共用同一组输入与预期：
        // available = max(viewport - rowHeader, 0); column = max(available / n, 120)
        XCTAssertEqual(
            NativeTabDocTableColumnWidthPolicy.columnWidth(viewportWidth: 320, columnCount: 2),
            142
        )
        XCTAssertEqual(
            NativeTabDocTableColumnWidthPolicy.columnWidth(viewportWidth: 768, columnCount: 2),
            366
        )
        XCTAssertEqual(
            NativeTabDocTableColumnWidthPolicy.columnWidth(viewportWidth: 320, columnCount: 3),
            120
        )
        XCTAssertEqual(
            NativeTabDocTableColumnWidthPolicy.columnWidth(viewportWidth: 320, columnCount: 0),
            0
        )
        XCTAssertEqual(
            NativeTabDocTableColumnWidthPolicy.columnWidth(viewportWidth: 0, columnCount: 2),
            120
        )
    }

    func testTableHorizontalScrollHintTracksActualMinimumWidth() {
        // 2 列最小总宽 = 36 + 120 * 2 = 276；3 列 = 36 + 360 = 396
        XCTAssertFalse(
            NativeTabDocTableColumnWidthPolicy.requiresHorizontalScrolling(
                viewportWidth: 0,
                columnCount: 3
            )
        )
        XCTAssertTrue(
            NativeTabDocTableColumnWidthPolicy.requiresHorizontalScrolling(
                viewportWidth: 275,
                columnCount: 2
            )
        )
        XCTAssertFalse(
            NativeTabDocTableColumnWidthPolicy.requiresHorizontalScrolling(
                viewportWidth: 276,
                columnCount: 2
            )
        )
        XCTAssertTrue(
            NativeTabDocTableColumnWidthPolicy.requiresHorizontalScrolling(
                viewportWidth: 320,
                columnCount: 3
            )
        )
        XCTAssertFalse(
            NativeTabDocTableColumnWidthPolicy.requiresHorizontalScrolling(
                viewportWidth: 320,
                columnCount: 0
            )
        )
    }

    func testHeadingStylePolicyPreservesHOneThroughHSixSemanticHierarchy() {
        let styles = (1...6).map { NativeTabDocHeadingStylePolicy.style(for: $0) }

        XCTAssertEqual(
            styles,
            [.heading, .title, .subtitle, .headingFour, .headingFive, .headingSix]
        )
        XCTAssertEqual(styles.map(\.font.pointSize), [24, 20, 16, 14, 13, 12])
        XCTAssertEqual(
            styles.map(\.typographyRole),
            [.heading, .title, .subtitle, .body, .meta, .caption]
        )
        XCTAssertEqual(NativeTabDocRichTextStyle.headingSix.textColorRole, .secondary)
        XCTAssertEqual(NativeTabDocRichTextStyle.body.textColorRole, .primary)
    }

    func testRichTextLineHeightUsesTypographyTokenWithoutClippingScaledFonts() {
        XCTAssertEqual(
            NativeTabDocRichTextLineHeightPolicy.resolvedLineHeight(
                scaledTargetLineHeight: 22,
                scaledFontLineHeight: 17
            ),
            22
        )
        XCTAssertEqual(
            NativeTabDocRichTextLineHeightPolicy.resolvedLineHeight(
                scaledTargetLineHeight: 22,
                scaledFontLineHeight: 24
            ),
            24
        )
    }

    func testRichTextSizingKeepsTouchTargetOnlyForEmptyBlocks() {
        XCTAssertEqual(
            NativeTabDocRichTextSizingPolicy.height(fittedHeight: 24, isEmpty: true),
            TTSpacing.Control.minimumTouchTarget
        )
        XCTAssertEqual(
            NativeTabDocRichTextSizingPolicy.height(fittedHeight: 24, isEmpty: false),
            24
        )
        XCTAssertEqual(
            NativeTabDocRichTextSizingPolicy.height(fittedHeight: 72, isEmpty: false),
            72
        )
    }

    func testBlockGapPolicyMatchesTheCanonicalReadingRhythm() {
        XCTAssertEqual(
            NativeTabDocBlockGapPolicy.gap(previous: nil, current: .paragraph),
            TTSpacing.xxl
        )
        XCTAssertEqual(
            NativeTabDocBlockGapPolicy.gap(previous: .paragraph, current: .paragraph),
            0
        )
        XCTAssertEqual(
            NativeTabDocBlockGapPolicy.gap(previous: .paragraph, current: .heading(level: 1)),
            TTSpacing.xxl
        )
        XCTAssertEqual(
            NativeTabDocBlockGapPolicy.gap(previous: .heading(level: 1), current: .paragraph),
            TTSpacing.xs
        )
        XCTAssertEqual(
            NativeTabDocBlockGapPolicy.gap(previous: .paragraph, current: .divider),
            TTSpacing.xxxl
        )
        XCTAssertEqual(
            NativeTabDocBlockGapPolicy.gap(previous: .divider, current: .paragraph),
            TTSpacing.xxxl
        )
    }

    func testEditorMoreMenuAlwaysKeepsShareHistoryAndFullEditorSlots() {
        let menu = NativeTabDocMoreMenuPolicy.moreMenu(
            canShareLink: true,
            canSendDirectMessage: true,
            canOpenFullEditor: true,
            canSave: true
        )
        XCTAssertTrue(menu.showShareLink)
        XCTAssertTrue(menu.showVersionHistory)
        XCTAssertTrue(menu.showFullEditor)
    }

    func testBackspaceAtStartRemovesEmptyBlockAndFocusesPreviousEnd() {
        let previous = NativeTabDocBlock(kind: .paragraph, text: "上一块")
        let current = NativeTabDocBlock(kind: .paragraph)

        let result = NativeTabDocBackspacePolicy.mergeBlockWithPrevious(
            blocks: [previous, current],
            blockId: current.id
        )

        XCTAssertTrue(result.didMutate)
        XCTAssertEqual(result.blocks, [previous])
        XCTAssertEqual(result.focus?.editorId, previous.id)
        XCTAssertEqual(result.focus?.caretPosition, 3)
    }

    func testBackspaceAtStartMergesNonEmptyBlockAtPreviousEnd() {
        let previous = NativeTabDocBlock(kind: .paragraph, text: "前文")
        let current = NativeTabDocBlock(kind: .heading(level: 2), text: "后文")

        let result = NativeTabDocBackspacePolicy.mergeBlockWithPrevious(
            blocks: [previous, current],
            blockId: current.id
        )

        XCTAssertTrue(result.didMutate)
        XCTAssertEqual(result.blocks.count, 1)
        XCTAssertEqual(result.blocks[0].text, "前文后文")
        XCTAssertEqual(result.focus?.editorId, previous.id)
        XCTAssertEqual(result.focus?.caretPosition, 2)
    }

    func testBackspaceAtStartRemovesEmptyCodeBlockAfterParagraph() {
        let previous = NativeTabDocBlock(kind: .paragraph, text: "前文")
        let current = NativeTabDocBlock(kind: .codeBlock)

        let result = NativeTabDocBackspacePolicy.mergeBlockWithPrevious(
            blocks: [previous, current],
            blockId: current.id
        )

        XCTAssertEqual(result.blocks, [previous])
        XCTAssertEqual(result.focus?.editorId, previous.id)
        XCTAssertEqual(result.focus?.caretPosition, 2)
    }

    func testBackspaceFocusUsesUIKitUTF16CaretPosition() {
        let previous = NativeTabDocBlock(kind: .paragraph, text: "A😀")
        let current = NativeTabDocBlock(kind: .paragraph)

        let result = NativeTabDocBackspacePolicy.mergeBlockWithPrevious(
            blocks: [previous, current],
            blockId: current.id
        )

        XCTAssertEqual(result.focus?.caretPosition, 3)
    }

    func testBackspaceAtStartMergesListItemIntoPreviousItem() {
        let previous = NativeTabDocListItem(spans: .nativeTabDocPlain("第一项"))
        let current = NativeTabDocListItem(spans: .nativeTabDocPlain("第二项"))
        let block = NativeTabDocBlock(
            kind: .bulletList,
            listItems: [previous, current]
        )

        let result = NativeTabDocBackspacePolicy.mergeListItemWithPrevious(
            blocks: [block],
            blockId: block.id,
            itemId: current.id
        )

        XCTAssertTrue(result.didMutate)
        XCTAssertEqual(result.blocks[0].listItems.count, 1)
        XCTAssertEqual(result.blocks[0].listItems[0].text, "第一项第二项")
        XCTAssertEqual(result.focus?.editorId, previous.id)
        XCTAssertEqual(result.focus?.caretPosition, 3)
    }

    func testSaveIndicatorOnlyOccupiesNavigationSpaceWhileActiveOrActionable() {
        XCTAssertFalse(NativeTabDocSaveIndicatorPolicy.shows(.idle))
        XCTAssertTrue(NativeTabDocSaveIndicatorPolicy.shows(.dirty))
        XCTAssertTrue(NativeTabDocSaveIndicatorPolicy.shows(.saved))
        XCTAssertTrue(NativeTabDocSaveIndicatorPolicy.shows(.saving))
        XCTAssertTrue(NativeTabDocSaveIndicatorPolicy.shows(.conflict))
        XCTAssertTrue(NativeTabDocSaveIndicatorPolicy.shows(.permissionDenied))
        XCTAssertTrue(NativeTabDocSaveIndicatorPolicy.shows(.failed))
    }

    func testSaveRetryIsOfferedOnlyAfterAFailedAutosave() {
        XCTAssertFalse(NativeTabDocSaveIndicatorPolicy.showsRetry(.idle))
        XCTAssertFalse(NativeTabDocSaveIndicatorPolicy.showsRetry(.dirty))
        XCTAssertFalse(NativeTabDocSaveIndicatorPolicy.showsRetry(.saving))
        XCTAssertFalse(NativeTabDocSaveIndicatorPolicy.showsRetry(.saved))
        XCTAssertFalse(NativeTabDocSaveIndicatorPolicy.showsRetry(.conflict))
        XCTAssertFalse(NativeTabDocSaveIndicatorPolicy.showsRetry(.permissionDenied))
        XCTAssertTrue(NativeTabDocSaveIndicatorPolicy.showsRetry(.failed))
    }

    func testInlineEditChromeStaysHiddenUntilTheBlockIsFocusedOrSelected() {
        XCTAssertFalse(
            NativeTabDocEditChromePolicy.showsInlineMenu(
                canEdit: true,
                isFocused: false,
                isSelected: false
            )
        )
        XCTAssertTrue(
            NativeTabDocEditChromePolicy.showsInlineMenu(
                canEdit: true,
                isFocused: true,
                isSelected: false
            )
        )
        XCTAssertTrue(
            NativeTabDocEditChromePolicy.showsInlineMenu(
                canEdit: true,
                isFocused: false,
                isSelected: true
            )
        )
        XCTAssertFalse(
            NativeTabDocEditChromePolicy.showsInlineMenu(
                canEdit: false,
                isFocused: true,
                isSelected: true
            )
        )
    }

    func testListMarkersKeepACompactVisualColumnAndExpandOnlyTheHitTarget() {
        XCTAssertEqual(NativeTabDocListMarkerMetrics.visualColumn, TTSpacing.xxl)
        XCTAssertEqual(NativeTabDocListMarkerMetrics.hitTarget, TTSpacing.Control.minimumTouchTarget)
        XCTAssertGreaterThan(
            NativeTabDocListMarkerMetrics.hitTarget,
            NativeTabDocListMarkerMetrics.visualColumn
        )
    }

    func testWholeTablePreservationDisablesAllNativeBlockMutations() {
        XCTAssertFalse(
            NativeTabDocTableBlockActionPolicy.allowsMutation(
                requiresWholeTablePreservation: true
            )
        )
        XCTAssertFalse(
            NativeTabDocTableBlockActionPolicy.allowsMutation(
                requiresWholeTablePreservation: false
            ),
            "移动端原生云文档里的所有表格都必须只读"
        )
    }

    func testUnsupportedContentKindsMapKnownRawTypesWithoutExposingUnknownTypes() {
        XCTAssertEqual(NativeTabDocUnsupportedContentKind(rawType: "tabwhiteboard"), .whiteboard)
        XCTAssertEqual(NativeTabDocUnsupportedContentKind(rawType: "tabdataBlock"), .embeddedTable)
        XCTAssertEqual(NativeTabDocUnsupportedContentKind(rawType: "htmlBlock"), .embeddedHTML)
        XCTAssertEqual(NativeTabDocUnsupportedContentKind(rawType: "youtube"), .video)
        XCTAssertNil(NativeTabDocUnsupportedContentKind(rawType: "futureChart"))
    }

    @MainActor
    func testTransientInitialLoadFailureExposesPersistedDraftReadOnlyWithoutWriteAuthority() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let draft = NativeTabDocDraft(
            title: "离线草稿",
            body: NativeTabDocBody(
                rootAttributes: ["type": AnyCodable("doc")],
                blocks: [NativeTabDocBlock(kind: .paragraph, text: "唯一的本地正文")]
            ),
            baseVersion: 3,
            baseUpdatedAt: "2026-08-13T08:00:00Z"
        )
        try store.save(draft, documentId: "doc-1", userId: "user-1", organizationId: "org-1")
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "远端标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                throw APIError.networkError(URLError(.notConnectedToInternet))
            }
        )

        await session.load()

        XCTAssertNil(session.document)
        XCTAssertNotNil(session.loadError)
        XCTAssertEqual(session.localDraftForRecovery, draft)
        XCTAssertTrue(session.canViewLocalDraftForRecovery)
        XCTAssertFalse(session.canEdit)
        let saved = await session.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(
            store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"),
            draft
        )
    }

    func testLocalDraftRecoveryPolicyOnlyOpensBeforeCloudIdentityIsVerified() {
        XCTAssertTrue(NativeTabDocLocalDraftRecoveryPolicy.canView(
            documentLoaded: false,
            hasLocalDraft: true
        ))
        XCTAssertFalse(NativeTabDocLocalDraftRecoveryPolicy.canView(
            documentLoaded: true,
            hasLocalDraft: true
        ))
        XCTAssertFalse(NativeTabDocLocalDraftRecoveryPolicy.canView(
            documentLoaded: false,
            hasLocalDraft: false
        ))
    }

    func testParserKeepsUnknownNodesAndAttributesWhenEditingSupportedBlock() throws {
        let json: [String: AnyCodable] = [
            "type": AnyCodable("doc"),
            "attrs": AnyCodable(["schemaVersion": 7]),
            "content": AnyCodable([
                [
                    "type": "paragraph",
                    "attrs": ["id": "p-1", "align": "center"],
                    "content": [["type": "text", "text": "旧正文", "marks": [["type": "bold"]]]],
                ],
                [
                    "type": "paragraph",
                    "attrs": ["id": "p-2"],
                    "content": [["type": "text", "text": "可编辑正文"]],
                ],
                [
                    "type": "tabdataEmbed",
                    "attrs": ["tableId": "table-1", "viewId": "view-2"],
                ],
            ]),
        ]

        var document = NativeTabDocBody.parse(json: json, markdownFallback: "")
        XCTAssertEqual(document.blocks.count, 3)
        XCTAssertEqual(document.blocks[0].kind, .unsupported(type: "paragraph"))
        XCTAssertEqual(document.blocks[1].kind, .paragraph)
        XCTAssertEqual(document.blocks[2].kind, .unsupported(type: "tabdataEmbed"))

        document.blocks[1].text = "新正文"
        let serialized = document.serializedJSON
        let content = try XCTUnwrap(serialized["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual((content[0]["attrs"] as? [String: Any])?["id"] as? String, "p-1")
        XCTAssertEqual((content[0]["attrs"] as? [String: Any])?["align"] as? String, "center")
        let preservedMarks = ((content[0]["content"] as? [[String: Any]])?.first)?["marks"] as? [[String: Any]]
        XCTAssertEqual(preservedMarks?.first?["type"] as? String, "bold")
        XCTAssertEqual(((content[1]["content"] as? [[String: Any]])?.first)?["text"] as? String, "新正文")
        XCTAssertEqual((content[2]["attrs"] as? [String: Any])?["tableId"] as? String, "table-1")
        XCTAssertEqual((content[2]["attrs"] as? [String: Any])?["viewId"] as? String, "view-2")
        XCTAssertEqual(serialized["attrs"]?.dictValue?["schemaVersion"] as? Int, 7)
    }

    func testTextBlockAlignmentAllowlistIsEditableAndInvalidValuesFailClosed() throws {
        let rawNodes: [[String: Any]] = [
            [
                "type": "paragraph",
                "attrs": ["id": "paragraph-legacy"],
                "content": [["type": "text", "text": "旧身份"]],
            ],
            [
                "type": "paragraph",
                "attrs": ["blockId": "paragraph-current", "textAlign": NSNull()],
                "content": [["type": "text", "text": "当前身份"]],
            ],
            [
                "type": "heading",
                "attrs": ["level": 2, "id": "heading-legacy"],
                "content": [["type": "text", "text": "二级标题"]],
            ],
            [
                "type": "heading",
                "attrs": ["level": 3, "blockId": "heading-current", "textAlign": NSNull()],
                "content": [["type": "text", "text": "三级标题"]],
            ],
            [
                "type": "paragraph",
                "attrs": ["blockId": "align-left", "textAlign": "left"],
                "content": [["type": "text", "text": "左对齐正文"]],
            ],
            [
                "type": "heading",
                "attrs": ["level": 2, "blockId": "align-center", "textAlign": "center"],
                "content": [["type": "text", "text": "居中标题"]],
            ],
            [
                "type": "paragraph",
                "attrs": ["blockId": "align-right", "textAlign": "right"],
                "content": [["type": "text", "text": "右对齐正文"]],
            ],
            [
                "type": "heading",
                "attrs": ["level": 3, "blockId": "align-justify", "textAlign": "justify"],
                "content": [["type": "text", "text": "两端对齐标题"]],
            ],
            [
                "type": "paragraph",
                "attrs": ["blockId": "invalid-middle", "textAlign": "middle"],
                "content": [["type": "text", "text": "未知对齐"]],
            ],
            [
                "type": "paragraph",
                "attrs": ["blockId": "invalid-empty", "textAlign": ""],
                "content": [["type": "text", "text": "空对齐"]],
            ],
            [
                "type": "paragraph",
                "attrs": ["blockId": "invalid-case", "textAlign": "LEFT"],
                "content": [["type": "text", "text": "大小写漂移"]],
            ],
            [
                "type": "paragraph",
                "attrs": ["blockId": "invalid-type", "textAlign": 7],
                "content": [["type": "text", "text": "错误类型"]],
            ],
            [
                "type": "heading",
                "attrs": ["level": 2, "futureStyle": "keep"],
                "content": [["type": "text", "text": "未知标题样式"]],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable(rawNodes)],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.map(\.kind), [
            .paragraph,
            .paragraph,
            .heading(level: 2),
            .heading(level: 3),
            .paragraph,
            .heading(level: 2),
            .paragraph,
            .heading(level: 3),
            .unsupported(type: "paragraph"),
            .unsupported(type: "paragraph"),
            .unsupported(type: "paragraph"),
            .unsupported(type: "paragraph"),
            .unsupported(type: "heading"),
        ])

        let serialized = try XCTUnwrap(
            body.serializedJSON["content"]?.arrayValue as? [[String: Any]]
        )
        let serializedAlignments = serialized.map { node in
            (node["attrs"] as? [String: Any])?["textAlign"]
        }
        XCTAssertNil(serializedAlignments[0], "缺省对齐不得被补写为 left")
        XCTAssertTrue(serializedAlignments[1] is NSNull, "null 对齐必须保持 null")
        XCTAssertEqual(serializedAlignments[4] as? String, "left")
        XCTAssertEqual(serializedAlignments[5] as? String, "center")
        XCTAssertEqual(serializedAlignments[6] as? String, "right")
        XCTAssertEqual(serializedAlignments[7] as? String, "justify")
        XCTAssertEqual(serializedAlignments[8] as? String, "middle")
        XCTAssertEqual(serializedAlignments[9] as? String, "")
        XCTAssertEqual(serializedAlignments[10] as? String, "LEFT")
        XCTAssertEqual(serializedAlignments[11] as? Int, 7)
    }

    @MainActor
    func testTextAlignmentMapsToUIKitAndSurvivesRealTextViewEditingWithoutCanonicalizingRawAttrs() throws {
        struct Case {
            let name: String
            let rawValue: Any?
            let expectedSemantic: NativeTabDocTextAlignment
            let expectedUIKit: NSTextAlignment
        }

        let cases: [Case] = [
            Case(
                name: "missing",
                rawValue: nil,
                expectedSemantic: .natural,
                expectedUIKit: .natural
            ),
            Case(
                name: "null",
                rawValue: NSNull(),
                expectedSemantic: .natural,
                expectedUIKit: .natural
            ),
            Case(
                name: "left",
                rawValue: "left",
                expectedSemantic: .left,
                expectedUIKit: .left
            ),
            Case(
                name: "center",
                rawValue: "center",
                expectedSemantic: .center,
                expectedUIKit: .center
            ),
            Case(
                name: "right",
                rawValue: "right",
                expectedSemantic: .right,
                expectedUIKit: .right
            ),
            Case(
                name: "justify",
                rawValue: "justify",
                expectedSemantic: .justify,
                expectedUIKit: .justified
            ),
        ]

        for testCase in cases {
            var rawAttrs: [String: Any] = ["blockId": "align-\(testCase.name)"]
            if let rawValue = testCase.rawValue {
                rawAttrs["textAlign"] = rawValue
            }
            let rawNode: [String: Any] = [
                "type": "paragraph",
                "attrs": rawAttrs,
                "content": [["type": "text", "text": "正文"]],
            ]
            var body = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([rawNode]),
                ],
                markdownFallback: ""
            )
            let block = try XCTUnwrap(body.blocks.first, testCase.name)

            XCTAssertEqual(block.kind, .paragraph, testCase.name)
            XCTAssertEqual(block.textAlignment, testCase.expectedSemantic, testCase.name)

            let attributes = NativeTabDocRichTextMarkBridge.attributes(
                for: block.spans.first?.marks ?? [],
                style: .body,
                textAlignment: block.textAlignment,
                traitCollection: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
            )
            let paragraphStyle = try XCTUnwrap(
                attributes[.paragraphStyle] as? NSParagraphStyle,
                testCase.name
            )
            XCTAssertEqual(paragraphStyle.alignment, testCase.expectedUIKit, testCase.name)

            let textView = UITextView()
            textView.attributedText = NSAttributedString(
                string: block.text,
                attributes: attributes
            )
            textView.selectedRange = NSRange(location: textView.attributedText.length, length: 0)
            textView.typingAttributes = attributes
            textView.insertText("已编辑")
            body.blocks[0].spans = NativeTabDocRichTextMarkBridge.spans(
                from: textView.attributedText,
                baseStyle: .body
            )

            let serialized = try XCTUnwrap(
                body.serializedJSON["content"]?.arrayValue as? [[String: Any]],
                testCase.name
            )
            let serializedNode = try XCTUnwrap(serialized.first, testCase.name)
            let serializedAttrs = try XCTUnwrap(
                serializedNode["attrs"] as? [String: Any],
                testCase.name
            )
            XCTAssertEqual(
                ((serializedNode["content"] as? [[String: Any]])?.first)?["text"] as? String,
                "正文已编辑",
                testCase.name
            )
            XCTAssertEqual(
                serializedAttrs["blockId"] as? String,
                "align-\(testCase.name)",
                testCase.name
            )
            switch testCase.rawValue {
            case nil:
                XCTAssertNil(serializedAttrs["textAlign"], "缺省值不得被补写：\(testCase.name)")
            case is NSNull:
                XCTAssertTrue(
                    serializedAttrs["textAlign"] is NSNull,
                    "null 不得被规范化成 left：\(testCase.name)"
                )
            case let rawValue as String:
                XCTAssertEqual(serializedAttrs["textAlign"] as? String, rawValue, testCase.name)
            default:
                XCTFail("测试夹具包含未覆盖的 textAlign 类型：\(testCase.name)")
            }
        }
    }

    func testNestedParagraphAlignmentIsStrictAndTableFailsClosedPerCell() throws {
        let safeQuote: [String: Any] = [
            "type": "blockquote",
            "content": [[
                "type": "paragraph",
                "attrs": ["blockId": "quote-safe", "textAlign": "center"],
                "content": [["type": "text", "text": "安全引用"]],
            ]],
        ]
        let unsafeQuote: [String: Any] = [
            "type": "blockquote",
            "content": [[
                "type": "paragraph",
                "attrs": ["textAlign": "center", "futureLayout": "keep"],
                "content": [["type": "text", "text": "未知引用布局"]],
            ]],
        ]
        let safeList: [String: Any] = [
            "type": "bulletList",
            "content": [[
                "type": "listItem",
                "content": [[
                    "type": "paragraph",
                    "attrs": ["blockId": "list-safe", "textAlign": "right"],
                    "content": [["type": "text", "text": "安全列表项"]],
                ]],
            ]],
        ]
        let unsafeList: [String: Any] = [
            "type": "taskList",
            "content": [[
                "type": "taskItem",
                "attrs": ["checked": false],
                "content": [[
                    "type": "paragraph",
                    "attrs": ["textAlign": "middle"],
                    "content": [["type": "text", "text": "错误列表对齐"]],
                ]],
            ]],
        ]
        let unsafeTableCell: [String: Any] = [
            "type": "tableCell",
            "attrs": ["cellId": "unsafe-cell"],
            "content": [[
                "type": "paragraph",
                "attrs": ["blockId": "unsafe-cell-paragraph", "textAlign": "middle"],
                "content": [["type": "text", "text": "只读单元格"]],
            ]],
        ]
        let safeTableCell: [String: Any] = [
            "type": "tableCell",
            "attrs": ["cellId": "safe-cell"],
            "content": [[
                "type": "paragraph",
                "attrs": ["blockId": "safe-cell-paragraph", "textAlign": "justify"],
                "content": [["type": "text", "text": "可编辑单元格"]],
            ]],
        ]
        let emptyMarksTableCell: [String: Any] = [
            "type": "tableCell",
            "attrs": ["cellId": "empty-marks-cell"],
            "content": [[
                "type": "paragraph",
                "attrs": ["textAlign": "left"],
                "content": [["type": "text", "text": "空 marks", "marks": []]],
            ]],
        ]
        let table: [String: Any] = [
            "type": "table",
            "content": [[
                "type": "tableRow",
                "content": [unsafeTableCell, safeTableCell, emptyMarksTableCell],
            ]],
        ]
        let body = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([safeQuote, unsafeQuote, safeList, unsafeList, table]),
            ],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.map(\.kind), [
            .blockquote,
            .unsupported(type: "blockquote"),
            .bulletList,
            .unsupported(type: "taskList"),
            .table,
        ])
        XCTAssertEqual(body.blocks[0].textAlignment, .center)
        XCTAssertEqual(body.blocks[2].listItems.first?.textAlignment, .right)

        let parsedTable = try XCTUnwrap(body.blocks[4].table)
        XCTAssertEqual(parsedTable.rows[0].cells[0].isReadOnlyProjection, true)
        XCTAssertEqual(parsedTable.rows[0].cells[0].textAlignment, .natural)
        XCTAssertEqual(parsedTable.rows[0].cells[1].isReadOnlyProjection, false)
        XCTAssertEqual(parsedTable.rows[0].cells[1].textAlignment, .justify)
        XCTAssertEqual(parsedTable.rows[0].cells[2].isReadOnlyProjection, true)
        XCTAssertEqual(parsedTable.rows[0].cells[2].textAlignment, .left)

        let serialized = try XCTUnwrap(
            body.serializedJSON["content"]?.arrayValue as? [[String: Any]]
        )
        let serializedRows = try XCTUnwrap(serialized[4]["content"] as? [[String: Any]])
        let serializedCells = try XCTUnwrap(serializedRows[0]["content"] as? [[String: Any]])
        XCTAssertTrue(
            NSDictionary(dictionary: serializedCells[0]).isEqual(to: unsafeTableCell),
            "非法 table paragraph 只能锁住目标格，且 rawCell 必须原样写回"
        )
        XCTAssertEqual(
            (((serializedCells[1]["content"] as? [[String: Any]])?.first)?["attrs"]
                as? [String: Any])?["textAlign"] as? String,
            "justify"
        )
        XCTAssertTrue(
            NSDictionary(dictionary: serializedCells[2]).isEqual(to: emptyMarksTableCell),
            "marks: [] 保存时会被省略，因此必须逐格只读并原样写回"
        )
    }

    func testBlockConversionPreservesAlignmentAndRefusesCodeWhenItWouldDropSemantics() throws {
        func parseBlock(_ raw: [String: Any]) throws -> NativeTabDocBlock {
            let body = NativeTabDocBody.parse(
                json: ["type": AnyCodable("doc"), "content": AnyCodable([raw])],
                markdownFallback: ""
            )
            return try XCTUnwrap(body.blocks.first)
        }

        let centeredParagraph = try parseBlock([
            "type": "paragraph",
            "attrs": ["blockId": "stable-block", "textAlign": "center"],
            "content": [["type": "text", "text": "居中正文"]],
        ])
        let centeredQuote = try XCTUnwrap(centeredParagraph.converted(to: .blockquote))
        XCTAssertEqual(centeredQuote.textAlignment, .center)
        XCTAssertEqual(
            ((((centeredQuote.serializedNode["content"] as? [[String: Any]])?.first)?["attrs"]
                as? [String: Any])?["textAlign"] as? String),
            "center"
        )
        let centeredList = try XCTUnwrap(centeredQuote.converted(to: .bulletList))
        XCTAssertEqual(centeredList.listItems.first?.textAlignment, .center)
        XCTAssertEqual(
            (((((centeredList.serializedNode["content"] as? [[String: Any]])?.first)?["content"]
                as? [[String: Any]])?.first)?["attrs"] as? [String: Any])?["textAlign"] as? String,
            "center"
        )
        let centeredHeading = try XCTUnwrap(centeredList.converted(to: .heading(level: 2)))
        XCTAssertEqual(centeredHeading.textAlignment, .center)
        XCTAssertEqual(
            (centeredHeading.serializedNode["attrs"] as? [String: Any])?["textAlign"] as? String,
            "center"
        )
        XCTAssertFalse(centeredParagraph.conversionOptions.contains(.codeBlock))
        XCTAssertNil(centeredParagraph.converted(to: .codeBlock))

        let explicitlyLeftParagraph = try parseBlock([
            "type": "paragraph",
            "attrs": ["textAlign": "left"],
            "content": [["type": "text", "text": "显式左对齐"]],
        ])
        XCTAssertEqual(explicitlyLeftParagraph.textAlignment, .left)
        XCTAssertFalse(explicitlyLeftParagraph.conversionOptions.contains(.codeBlock))
        XCTAssertNil(explicitlyLeftParagraph.converted(to: .codeBlock))

        let nullAlignedParagraph = try parseBlock([
            "type": "paragraph",
            "attrs": ["textAlign": NSNull()],
            "content": [["type": "text", "text": "默认对齐"]],
        ])
        XCTAssertEqual(nullAlignedParagraph.textAlignment, .natural)
        let code = try XCTUnwrap(nullAlignedParagraph.converted(to: .codeBlock))
        XCTAssertNil((code.serializedNode["attrs"] as? [String: Any])?["textAlign"])

        let markedParagraph = try parseBlock([
            "type": "paragraph",
            "content": [[
                "type": "text",
                "text": "加粗正文",
                "marks": [["type": "bold"]],
            ]],
        ])
        XCTAssertFalse(markedParagraph.conversionOptions.contains(.codeBlock))
        XCTAssertNil(markedParagraph.converted(to: .codeBlock))

        let markedList = try parseBlock([
            "type": "bulletList",
            "content": [[
                "type": "listItem",
                "content": [[
                    "type": "paragraph",
                    "content": [[
                        "type": "text",
                        "text": "带格式列表项",
                        "marks": [["type": "italic"]],
                    ]],
                ]],
            ]],
        ])
        XCTAssertFalse(markedList.conversionOptions.contains(.codeBlock))
        XCTAssertNil(markedList.converted(to: .codeBlock))
    }

    func testStandaloneImageParagraphOnlyAcceptsDefaultAlignmentUntilImageUIConsumesIt() throws {
        func imageParagraph(textAlign: Any) -> [String: Any] {
            [
                "type": "paragraph",
                "attrs": ["blockId": "image-block", "textAlign": textAlign],
                "content": [[
                    "type": "image",
                    "attrs": ["src": "https://tabtin.example.com/cover.png", "alt": "封面"],
                ]],
            ]
        }

        let explicit = imageParagraph(textAlign: "center")
        let defaultAligned = imageParagraph(textAlign: NSNull())
        let body = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([explicit, defaultAligned]),
            ],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.map(\.kind), [
            .unsupported(type: "paragraph"),
            .image,
        ])
        let serialized = try XCTUnwrap(
            body.serializedJSON["content"]?.arrayValue as? [[String: Any]]
        )
        XCTAssertTrue(
            NSDictionary(dictionary: serialized[0]).isEqual(to: explicit),
            "图片 UI 未消费 textAlign 前，非默认图片段落必须原样只读"
        )
    }

    func testTableDimensionsRequireExactUnitIntegersAndPreserveUnsafeTableRaw() throws {
        struct Case {
            let name: String
            let includesAttributes: Bool
            let attributes: Any
            let isEditableShape: Bool
        }

        let cases: [Case] = [
            Case(name: "missing", includesAttributes: false, attributes: NSNull(), isEditableShape: true),
            Case(name: "null", includesAttributes: true, attributes: NSNull(), isEditableShape: true),
            Case(
                name: "exact integer one",
                includesAttributes: true,
                attributes: ["colspan": 1, "rowspan": 1],
                isEditableShape: true
            ),
            Case(
                name: "foundation integer one",
                includesAttributes: true,
                attributes: ["colspan": NSNumber(value: 1)],
                isEditableShape: true
            ),
            Case(
                name: "null dimensions",
                includesAttributes: true,
                attributes: ["colspan": NSNull(), "rowspan": NSNull()],
                isEditableShape: true
            ),
            Case(
                name: "string one",
                includesAttributes: true,
                attributes: ["colspan": "1"],
                isEditableShape: false
            ),
            Case(
                name: "boolean one",
                includesAttributes: true,
                attributes: ["rowspan": true],
                isEditableShape: false
            ),
            Case(
                name: "foundation boolean one",
                includesAttributes: true,
                attributes: ["rowspan": NSNumber(value: true)],
                isEditableShape: false
            ),
            Case(
                name: "zero",
                includesAttributes: true,
                attributes: ["colspan": 0],
                isEditableShape: false
            ),
            Case(
                name: "merged",
                includesAttributes: true,
                attributes: ["rowspan": 2],
                isEditableShape: false
            ),
            Case(
                name: "floating point one",
                includesAttributes: true,
                attributes: ["colspan": 1.0],
                isEditableShape: false
            ),
            Case(
                name: "malformed attrs",
                includesAttributes: true,
                attributes: "future-shape",
                isEditableShape: false
            ),
        ]

        for testCase in cases {
            var cell: [String: Any] = [
                "type": "tableCell",
                "content": [[
                    "type": "paragraph",
                    "content": [["type": "text", "text": "目标格"]],
                ]],
            ]
            if testCase.includesAttributes {
                cell["attrs"] = testCase.attributes
            }
            let rawTable: [String: Any] = [
                "type": "table",
                "content": [[
                    "type": "tableRow",
                    "content": [cell],
                ]],
            ]
            let safeSibling: [String: Any] = [
                "type": "paragraph",
                "content": [["type": "text", "text": "安全兄弟"]],
            ]
            var body = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([rawTable, safeSibling]),
                ],
                markdownFallback: ""
            )

            let table = try XCTUnwrap(body.blocks.first?.table, testCase.name)
            XCTAssertEqual(
                table.requiresWholeTablePreservation,
                !testCase.isEditableShape,
                testCase.name
            )
            XCTAssertEqual(body.blocks[1].kind, .paragraph, testCase.name)
            body.blocks[1].text = "兄弟已编辑"

            let serialized = try XCTUnwrap(
                body.serializedJSON["content"]?.arrayValue as? [[String: Any]],
                testCase.name
            )
            if testCase.isEditableShape {
                XCTAssertFalse(table.rows[0].cells[0].isReadOnlyProjection == true, testCase.name)
            } else {
                XCTAssertTrue(
                    NSDictionary(dictionary: serialized[0]).isEqual(to: rawTable),
                    "不安全维度必须整表原样保留：\(testCase.name)"
                )
            }
            XCTAssertEqual(
                ((serialized[1]["content"] as? [[String: Any]])?.first)?["text"] as? String,
                "兄弟已编辑",
                testCase.name
            )
        }
    }

    func testQuoteAndListContainerAttributesFailClosedWithoutRewritingRaw() throws {
        let safeParagraph: [String: Any] = [
            "type": "paragraph",
            "content": [["type": "text", "text": "正文"]],
        ]
        let safeListItem: [String: Any] = [
            "type": "listItem",
            "content": [safeParagraph],
        ]
        let safeTaskItem: [String: Any] = [
            "type": "taskItem",
            "attrs": ["checked": true, "blockId": "task-item"],
            "content": [safeParagraph],
        ]
        let unsafeNodes: [[String: Any]] = [
            [
                "type": "blockquote",
                "attrs": ["futureContainer": "keep"],
                "content": [safeParagraph],
            ],
            [
                "type": "bulletList",
                "attrs": ["tight": true],
                "content": [safeListItem],
            ],
            [
                "type": "orderedList",
                "attrs": ["start": "3"],
                "content": [safeListItem],
            ],
            [
                "type": "orderedList",
                "attrs": ["start": 1, "futureContainer": "keep"],
                "content": [safeListItem],
            ],
            [
                "type": "taskList",
                "attrs": ["futureContainer": "keep"],
                "content": [safeTaskItem],
            ],
            [
                "type": "bulletList",
                "content": [[
                    "type": "listItem",
                    "attrs": ["futureIdentity": "keep"],
                    "content": [safeParagraph],
                ]],
            ],
            [
                "type": "taskList",
                "content": [[
                    "type": "taskItem",
                    "attrs": ["checked": "true"],
                    "content": [safeParagraph],
                ]],
            ],
        ]

        for (index, unsafeNode) in unsafeNodes.enumerated() {
            var body = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([
                        unsafeNode,
                        [
                            "type": "paragraph",
                            "content": [["type": "text", "text": "安全兄弟"]],
                        ],
                    ]),
                ],
                markdownFallback: ""
            )

            XCTAssertEqual(
                body.blocks.first?.kind,
                .unsupported(type: unsafeNode["type"] as? String ?? ""),
                "case \(index)"
            )
            body.blocks[1].text = "兄弟已编辑"
            let serialized = try XCTUnwrap(
                body.serializedJSON["content"]?.arrayValue as? [[String: Any]],
                "case \(index)"
            )
            XCTAssertTrue(
                NSDictionary(dictionary: serialized[0]).isEqual(to: unsafeNode),
                "不安全容器必须原样保留：case \(index)"
            )
            XCTAssertEqual(
                ((serialized[1]["content"] as? [[String: Any]])?.first)?["text"] as? String,
                "兄弟已编辑",
                "case \(index)"
            )
        }

        let canonicalNodes: [[String: Any]] = [
            [
                "type": "blockquote",
                "attrs": ["blockId": "quote-parent"],
                "content": [safeParagraph],
            ],
            [
                "type": "bulletList",
                "attrs": ["blockId": "bullet-parent"],
                "content": [[
                    "type": "listItem",
                    "attrs": ["blockId": "bullet-item"],
                    "content": [safeParagraph],
                ]],
            ],
            [
                "type": "orderedList",
                "attrs": ["start": 3, "blockId": "ordered-parent"],
                "content": [safeListItem],
            ],
            [
                "type": "orderedList",
                "attrs": ["start": 1, "type": NSNull()],
                "content": [safeListItem],
            ],
            [
                "type": "taskList",
                "attrs": ["blockId": "task-parent"],
                "content": [safeTaskItem],
            ],
        ]
        let canonical = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable(canonicalNodes),
            ],
            markdownFallback: ""
        )
        XCTAssertEqual(canonical.blocks.map(\.kind), [
            .blockquote,
            .bulletList,
            .orderedList(start: 3),
            .orderedList(start: 1),
            .taskList,
        ])
        let canonicalSerialized = try XCTUnwrap(
            canonical.serializedJSON["content"]?.arrayValue as? [[String: Any]]
        )
        XCTAssertEqual(
            (canonicalSerialized[2]["attrs"] as? [String: Any])?["start"] as? Int,
            3
        )
        XCTAssertTrue(
            ((canonicalSerialized[3]["attrs"] as? [String: Any])?["type"]) is NSNull
        )
        XCTAssertEqual(
            ((((canonicalSerialized[4]["content"] as? [[String: Any]])?.first)?["attrs"]
                as? [String: Any])?["checked"] as? Bool),
            true
        )
    }

    func testUnsupportedInlinePreviewConcatenatesTextAndPreservesHardBreak() {
        let raw: [String: Any] = [
            "type": "paragraph",
            "attrs": ["futureStyle": "keep"],
            "content": [
                ["type": "text", "text": "相邻"],
                ["type": "text", "text": "文本"],
                ["type": "hardBreak"],
                ["type": "text", "text": "下一行"],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([raw])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .unsupported(type: "paragraph"))
        XCTAssertEqual(body.blocks.first?.readablePreview, "相邻文本\n下一行")
    }

    func testTableCellContentReusesNativeDocumentParserWithoutMutatingRawCell() throws {
        let rawCell: [String: AnyCodable] = [
            "type": AnyCodable("tableCell"),
            "attrs": AnyCodable(["colspan": 1, "rowspan": 1]),
            "content": AnyCodable([
                [
                    "type": "paragraph",
                    "content": [["type": "text", "text": "详情正文"]],
                ],
                [
                    "type": "heading",
                    "attrs": ["level": 2],
                    "content": [["type": "text", "text": "二级标题"]],
                ],
                [
                    "type": "bulletList",
                    "content": [[
                        "type": "listItem",
                        "content": [[
                            "type": "paragraph",
                            "content": [["type": "text", "text": "列表项"]],
                        ]],
                    ]],
                ],
            ]),
        ]
        let snapshot = rawCell

        let body = try XCTUnwrap(NativeTabDocBody.parseTableCellContent(rawCell))

        XCTAssertEqual(body.blocks.map(\.kind), [
            .paragraph,
            .heading(level: 2),
            .bulletList,
        ])
        XCTAssertEqual(body.blocks[0].text, "详情正文")
        XCTAssertEqual(body.blocks[1].text, "二级标题")
        XCTAssertEqual(body.blocks[2].listItems.first?.text, "列表项")
        XCTAssertEqual(rawCell, snapshot)
    }

    func testRichInlineMarksAndHardBreakRoundTripLosslessly() throws {
        let rawNodes: [[String: Any]] = [
            [
                "type": "paragraph",
                "content": [
                    ["type": "text", "text": "加粗", "marks": [["type": "bold"]]],
                    ["type": "text", "text": "链接", "marks": [["type": "link", "attrs": ["href": "https://www.example.com", "target": "_blank"]]]],
                ],
            ],
            [
                "type": "paragraph",
                "content": [
                    ["type": "text", "text": "第一行"],
                    ["type": "hardBreak"],
                    ["type": "text", "text": "第二行"],
                ],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable(rawNodes)],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.map(\.kind), [.paragraph, .paragraph])
        XCTAssertEqual(body.blocks[0].readablePreview, "加粗链接")
        XCTAssertEqual(body.blocks[1].text, "第一行\n第二行")
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let firstContent = try XCTUnwrap(roundTrip[0]["content"] as? [[String: Any]])
        let linkMarks = try XCTUnwrap(firstContent[1]["marks"] as? [[String: Any]])
        let linkAttributes = try XCTUnwrap(linkMarks.first?["attrs"] as? [String: Any])
        XCTAssertEqual(
            linkAttributes["href"] as? String,
            "https://www.example.com"
        )
        XCTAssertEqual(linkAttributes["target"] as? String, "_blank")
        XCTAssertEqual((roundTrip[1]["content"] as? [[String: Any]])?[1]["type"] as? String, "hardBreak")
    }

    func testUnknownInlineMarkStaysEditableAndRoundTripsIdentity() throws {
        let raw: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "blk-p-0046", "textAlign": "right"],
            "content": [
                ["type": "text", "text": "右对齐段落，携带"],
                [
                    "type": "text",
                    "text": "未知标记",
                    "marks": [["type": "futureMark", "attrs": ["weight": 9, "source": "ai"]]],
                ],
                ["type": "text", "text": "的文本。"],
            ],
        ]
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([raw])],
            markdownFallback: ""
        )

        let block = try XCTUnwrap(body.blocks.first)
        XCTAssertEqual(block.kind, .paragraph)
        XCTAssertEqual(block.textAlignment, .right)
        XCTAssertEqual(block.spans.map(\.text), ["右对齐段落，携带", "未知标记", "的文本。"])
        let unknown = try XCTUnwrap(block.spans[1].marks.first)
        XCTAssertEqual(unknown.kind, .unknown)
        XCTAssertEqual(unknown.rawNode["type"]?.stringValue, "futureMark")
        XCTAssertEqual(unknown.rawNode["attrs"]?.dictValue?["source"] as? String, "ai")

        let traits = UITraitCollection(userInterfaceStyle: .light)
        let attributes = NativeTabDocRichTextMarkBridge.attributes(
            for: block.spans[1].marks,
            style: .body,
            textAlignment: block.textAlignment,
            traitCollection: traits
        )
        XCTAssertNil(attributes[.backgroundColor], "未知 mark 不得发明高亮")
        XCTAssertTrue(
            NativeTabDocRichTextMarkBridge.preservedMarks(from: attributes)
                .contains(where: { $0.kind == .unknown })
        )
        XCTAssertFalse(NativeTabDocRichTextMarkBridge.acceptsInlineMark(attributes))

        var edited = block.spans
        edited[2].text += "旁"
        body.blocks[0].spans = edited
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual((roundTrip.first?["attrs"] as? [String: Any])?["textAlign"] as? String, "right")
        let inlines = try XCTUnwrap(roundTrip.first?["content"] as? [[String: Any]])
        let mark = try XCTUnwrap(
            (inlines.first { ($0["text"] as? String) == "未知标记" })?["marks"] as? [[String: Any]]
        ).first
        XCTAssertEqual(mark?["type"] as? String, "futureMark")
        XCTAssertEqual((mark?["attrs"] as? [String: Any])?["weight"] as? Int, 9)
        XCTAssertEqual((mark?["attrs"] as? [String: Any])?["source"] as? String, "ai")
        XCTAssertEqual(inlines.last?["text"] as? String, "的文本。旁")
    }

    func testMalformedUnknownMarksKeepWholeBlockReadOnly() throws {
        let cases: [[String: Any]] = [
            ["type": "text", "text": "空 type", "marks": [["type": "", "attrs": ["weight": 9]]]],
            ["type": "text", "text": "非对象 attrs", "marks": [["type": "futureMark", "attrs": "ai"]]],
            ["type": "text", "text": "空 attrs", "marks": [["type": "futureMark", "attrs": [:]]]],
            ["type": "text", "text": "空 marks", "marks": []],
            ["type": "text", "text": "多余键", "marks": [["type": "futureMark", "attrs": ["weight": 9], "meta": 1]]],
        ]
        for inline in cases {
            let raw: [String: Any] = ["type": "paragraph", "content": [inline]]
            let body = NativeTabDocBody.parse(
                json: ["type": AnyCodable("doc"), "content": AnyCodable([raw])],
                markdownFallback: ""
            )
            XCTAssertEqual(
                body.blocks.first?.kind,
                .unsupported(type: "paragraph"),
                "畸形未知 mark 必须整段只读：\(inline)"
            )
        }

        let heading: [String: Any] = [
            "type": "heading",
            "attrs": ["level": 2],
            "content": [[
                "type": "text",
                "text": "标题未知",
                "marks": [["type": "futureMark", "attrs": ["weight": 9]]],
            ]],
        ]
        let headingBody = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([heading])],
            markdownFallback: ""
        )
        XCTAssertEqual(
            headingBody.blocks.first?.kind,
            .unsupported(type: "heading"),
            "本刀只开顶层段落，标题里的未知 mark 继续整段只读"
        )
    }

    func testUnknownMarkRangeEditPolicyRejectsInteriorEdits() {
        let ranges = [NSRange(location: 5, length: 3)]
        XCTAssertTrue(
            NativeTabDocRichTextMarkBridge.allowsUnknownRangeEdit(
                in: ranges,
                replacing: NSRange(location: 5, length: 0)
            )
        )
        XCTAssertTrue(
            NativeTabDocRichTextMarkBridge.allowsUnknownRangeEdit(
                in: ranges,
                replacing: NSRange(location: 5, length: 3)
            )
        )
        XCTAssertFalse(
            NativeTabDocRichTextMarkBridge.allowsUnknownRangeEdit(
                in: ranges,
                replacing: NSRange(location: 6, length: 0)
            )
        )
        XCTAssertFalse(
            NativeTabDocRichTextMarkBridge.allowsUnknownRangeEdit(
                in: ranges,
                replacing: NSRange(location: 5, length: 1)
            )
        )
    }

    func testCanonicalInlineMathematicsParsesAsEditableSourceAndRoundTripsExactly() throws {
        let raw: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "blk-p-0008", "textAlign": NSNull()],
            "content": [
                ["type": "text", "text": "质能方程 "],
                ["type": "mathematics", "attrs": ["latex": "E = mc^2", "display": false]],
                ["type": "text", "text": "。"],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([raw])],
            markdownFallback: ""
        )

        let block = try XCTUnwrap(body.blocks.first)
        XCTAssertEqual(block.kind, .paragraph)
        XCTAssertEqual(block.spans.map(\.text), ["质能方程 ", "E = mc^2", "。"])
        let formulaIndex = try XCTUnwrap(block.spans.firstIndex(where: { $0.text == "E = mc^2" }))
        let formula = try XCTUnwrap(block.spans[formulaIndex].mathematics)
        XCTAssertFalse(formula.atomId.isEmpty)
        XCTAssertEqual(formula.nodeType, "mathematics")
        XCTAssertEqual(formula.valueAttribute, "latex")
        XCTAssertEqual(formula.attrs["display"]?.value as? Bool, false)
        XCTAssertEqual(block.readablePreview?.contains("E = mc^2"), true)

        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual(try stableJSONData(roundTrip), try stableJSONData([raw]))
        let serializedFormula = try XCTUnwrap((roundTrip.first?["content"] as? [[String: Any]])?[1])
        XCTAssertEqual(serializedFormula["type"] as? String, "mathematics")
        XCTAssertNil(serializedFormula["atomId"])
        XCTAssertNil((serializedFormula["attrs"] as? [String: Any])?["atomId"])
    }

    func testNonCanonicalInlineMathematicsStaysReadOnlyAndLossless() throws {
        let cases: [[String: Any]] = [
            ["type": "math", "attrs": ["latex": "a+b", "display": false]],
            ["type": "math_inline", "attrs": ["latex": "a+b", "display": false]],
            ["type": "mathematics", "attrs": ["text": "a+b", "display": false]],
            ["type": "mathematics", "attrs": ["latex": "a+b", "display": true]],
            ["type": "mathematics", "attrs": ["latex": "a+b", "display": "false"]],
            ["type": "mathematics", "attrs": ["latex": "a+b", "text": "a+b"]],
            ["type": "mathematics", "attrs": ["latex": ""]],
            ["type": "mathematics", "attrs": ["latex": "a+b", "extra": 1]],
            ["type": "mathematics", "attrs": ["latex": "a+b"], "marks": []],
            ["type": "futureMath", "attrs": ["latex": "a+b"]],
        ]
        for inline in cases {
            let raw: [String: Any] = [
                "type": "paragraph",
                "content": [
                    ["type": "text", "text": "前"],
                    inline,
                    ["type": "text", "text": "后"],
                ],
            ]
            let body = NativeTabDocBody.parse(
                json: ["type": AnyCodable("doc"), "content": AnyCodable([raw])],
                markdownFallback: ""
            )
            XCTAssertEqual(
                body.blocks.first?.kind,
                .unsupported(type: "paragraph"),
                "非 canonical 公式必须整段只读：\(inline)"
            )
            let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
            XCTAssertEqual(
                try stableJSONData(roundTrip),
                try stableJSONData([raw]),
                "非 canonical 公式必须 raw 精确往返：\(inline)"
            )
        }
    }

    func testEditingMathematicsSourceKeepsDisplayAndSiblingNodes() throws {
        let raw: [String: Any] = [
            "type": "paragraph",
            "content": [
                ["type": "text", "text": "前"],
                ["type": "mathematics", "attrs": ["latex": "E = mc^2", "display": false]],
                ["type": "text", "text": "后"],
            ],
        ]
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([raw])],
            markdownFallback: ""
        )
        let formulaIndex = try XCTUnwrap(body.blocks[0].spans.firstIndex(where: { $0.mathematics != nil }))
        body.blocks[0].spans[formulaIndex].text = "E = m c^2"
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let content = try XCTUnwrap(roundTrip.first?["content"] as? [[String: Any]])
        XCTAssertEqual(content[0]["text"] as? String, "前")
        XCTAssertEqual(content[2]["text"] as? String, "后")
        XCTAssertEqual(content[1]["type"] as? String, "mathematics")
        XCTAssertEqual((content[1]["attrs"] as? [String: Any])?["latex"] as? String, "E = m c^2")
        XCTAssertEqual((content[1]["attrs"] as? [String: Any])?["display"] as? Bool, false)
        XCTAssertNil((content[1]["attrs"] as? [String: Any])?["atomId"])
    }

    func testAdjacentEquivalentFormulasDoNotMergeWhenAtomIdsDiffer() throws {
        let first = NativeTabDocInlineMathematics(
            atomId: "atom-a",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let second = NativeTabDocInlineMathematics(
            atomId: "atom-b",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let block = NativeTabDocBlock(
            kind: .paragraph,
            spans: [
                NativeTabDocInlineSpan(text: "a", mathematics: first),
                NativeTabDocInlineSpan(text: "b", mathematics: second),
            ]
        )
        let content = try XCTUnwrap(block.serializedNode["content"] as? [[String: Any]])
        XCTAssertEqual(content.map { $0["type"] as? String }, ["mathematics", "mathematics"])
        XCTAssertEqual((content[0]["attrs"] as? [String: Any])?["latex"] as? String, "a")
        XCTAssertEqual((content[1]["attrs"] as? [String: Any])?["latex"] as? String, "b")
    }

    func testSameAtomFragmentsMergeAndKeepNewlinesInsideLatex() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-shared",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let block = NativeTabDocBlock(
            kind: .paragraph,
            spans: [
                NativeTabDocInlineSpan(text: "a+\n", mathematics: atom),
                NativeTabDocInlineSpan(text: "b", mathematics: atom),
            ]
        )
        let content = try XCTUnwrap(block.serializedNode["content"] as? [[String: Any]])
        XCTAssertEqual(content.count, 1)
        XCTAssertEqual(content.first?["type"] as? String, "mathematics")
        XCTAssertEqual((content.first?["attrs"] as? [String: Any])?["latex"] as? String, "a+\nb")
        XCTAssertFalse(content.contains { $0["type"] as? String == "hardBreak" })
    }

    func testDuplicatingMathematicsRenewsSharedAtomIdentity() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-old",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let original = NativeTabDocBlock(
            kind: .paragraph,
            spans: [
                NativeTabDocInlineSpan(text: "a+", mathematics: atom),
                NativeTabDocInlineSpan(text: "b", mathematics: atom),
            ],
            rawNode: ["type": AnyCodable("paragraph"), "attrs": AnyCodable(["blockId": "old"])]
        )
        let duplicate = original.duplicatedForInsertion()
        let first = try XCTUnwrap(duplicate.spans[0].mathematics)
        let second = try XCTUnwrap(duplicate.spans[1].mathematics)
        XCTAssertEqual(first.atomId, second.atomId)
        XCTAssertNotEqual(first.atomId, "atom-old")
        XCTAssertEqual(first.nodeType, "mathematics")
        XCTAssertNil((duplicate.serializedNode["attrs"] as? [String: Any])?["blockId"])
        XCTAssertNil((duplicate.serializedNode["content"] as? [[String: Any]])?.first?["atomId"])
    }

    func testMathematicsBlocksCodeConversionButSurvivesSafeTurnInto() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-1",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let paragraph = NativeTabDocBlock(
            kind: .paragraph,
            spans: [
                NativeTabDocInlineSpan(text: "前"),
                NativeTabDocInlineSpan(text: "E=mc^2", mathematics: atom),
            ]
        )
        XCTAssertNil(paragraph.converted(to: .codeBlock))
        XCTAssertFalse(paragraph.conversionOptions.contains(.codeBlock))
        let heading = try XCTUnwrap(paragraph.converted(to: .heading(level: 2)))
        XCTAssertEqual(heading.kind, .heading(level: 2))
        XCTAssertEqual(heading.spans[1].mathematics?.atomId, "atom-1")
        XCTAssertEqual(heading.spans[1].text, "E=mc^2")
    }

    func testLegacyDraftWithoutMathematicsFieldStillDecodes() throws {
        let data = try JSONEncoder().encode(NativeTabDocInlineSpan(text: "旧草稿"))
        let decoded = try JSONDecoder().decode(NativeTabDocInlineSpan.self, from: data)
        XCTAssertEqual(decoded.text, "旧草稿")
        XCTAssertNil(decoded.mathematics)
    }

    func testContainerAttributesFollowLosslessAllowlistAndPreserveUnsafeRaw() throws {
        func paragraph(attributes: Any? = nil) -> [String: Any] {
            var node: [String: Any] = [
                "type": "paragraph",
                "content": [["type": "text", "text": "正文"]],
            ]
            if let attributes { node["attrs"] = attributes }
            return node
        }

        func list(
            type: String,
            attributes: Any? = nil,
            itemAttributes: Any? = nil,
            paragraphAttributes: Any? = nil
        ) -> [String: Any] {
            let itemType = type == "taskList" ? "taskItem" : "listItem"
            var item: [String: Any] = [
                "type": itemType,
                "content": [paragraph(attributes: paragraphAttributes)],
            ]
            if let itemAttributes { item["attrs"] = itemAttributes }
            var node: [String: Any] = ["type": type, "content": [item]]
            if let attributes { node["attrs"] = attributes }
            return node
        }

        let unsafeNodes: [(String, [String: Any])] = [
            ("quote unknown", [
                "type": "blockquote",
                "attrs": ["future": true],
                "content": [paragraph()],
            ]),
            ("ordered string start", list(type: "orderedList", attributes: ["start": "3"])),
            ("ordered out-of-range start", list(
                type: "orderedList",
                attributes: ["start": NSNumber(value: Double.greatestFiniteMagnitude)]
            )),
            ("ordered explicit style", list(type: "orderedList", attributes: ["start": 1, "type": "decimal"])),
            ("ordered null type without start", list(type: "orderedList", attributes: ["type": NSNull()])),
            ("list item unknown", list(type: "bulletList", itemAttributes: ["itemId": "item-1"])),
            ("list item malformed identity", list(type: "bulletList", itemAttributes: ["blockId": 1])),
            ("task checked string", list(type: "taskList", itemAttributes: ["checked": "true"])),
            ("task checked numeric", list(type: "taskList", itemAttributes: ["checked": NSNumber(value: 1)])),
            ("task todo identity", list(type: "taskList", itemAttributes: ["todoId": "todo-1"])),
            ("task unknown", list(type: "taskList", itemAttributes: ["checked": true, "taskId": "task-1"])),
        ]
        for (name, rawNode) in unsafeNodes {
            let sibling = paragraph()
            var body = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([rawNode, sibling]),
                ],
                markdownFallback: ""
            )
            XCTAssertEqual(
                body.blocks[0].kind,
                .unsupported(type: rawNode["type"] as? String ?? "unknown"),
                name
            )
            body.blocks[1].text = "兄弟已编辑"
            let serialized = try XCTUnwrap(
                body.serializedJSON["content"]?.arrayValue as? [[String: Any]],
                name
            )
            XCTAssertTrue(
                NSDictionary(dictionary: serialized[0]).isEqual(to: rawNode),
                "不安全容器必须整块原样保留：\(name)"
            )
            XCTAssertEqual(
                ((serialized[1]["content"] as? [[String: Any]])?.first)?["text"] as? String,
                "兄弟已编辑",
                name
            )
        }

        let safeNodes: [[String: Any]] = [
            ["type": "blockquote", "content": [paragraph(attributes: ["blockId": "quote-p"])]] ,
            list(type: "orderedList", attributes: ["start": 3]),
            list(type: "orderedList", attributes: ["start": 1, "type": NSNull()]),
            list(type: "bulletList", itemAttributes: ["blockId": "item-1"]),
            list(
                type: "taskList",
                itemAttributes: ["checked": true, "blockId": "task-1", "todoId": NSNull()]
            ),
            [
                "type": "blockquote",
                "attrs": ["blockId": "quote-1"],
                "content": [paragraph()],
            ],
            list(type: "orderedList", attributes: ["start": 1, "blockId": "list-1"]),
            list(
                type: "bulletList",
                attributes: ["blockId": "list-2"],
                itemAttributes: ["blockId": "item-2"],
                paragraphAttributes: ["blockId": "paragraph-2", "textAlign": "right"]
            ),
            list(type: "taskList", attributes: ["blockId": "list-3"]),
            list(type: "bulletList", paragraphAttributes: ["blockId": "list-paragraph-1"]),
        ]
        var safeBody = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable(safeNodes)],
            markdownFallback: ""
        )
        XCTAssertEqual(safeBody.blocks.map(\.kind), [
            .blockquote,
            .orderedList(start: 3),
            .orderedList(start: 1),
            .bulletList,
            .taskList,
            .blockquote,
            .orderedList(start: 1),
            .bulletList,
            .taskList,
            .bulletList,
        ])
        safeBody.blocks[1].listItems[0].spans = [NativeTabDocInlineSpan(text: "已编辑")]
        let safeSerialized = try XCTUnwrap(
            safeBody.serializedJSON["content"]?.arrayValue as? [[String: Any]]
        )
        XCTAssertEqual((safeSerialized[1]["attrs"] as? [String: Any])?["start"] as? Int, 3)
        XCTAssertEqual(
            ((((safeSerialized[1]["content"] as? [[String: Any]])?.first)?["content"] as? [[String: Any]])?.first?["content"] as? [[String: Any]])?.first?["text"] as? String,
            "已编辑"
        )
        let reparsed = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable(safeSerialized)],
            markdownFallback: ""
        )
        XCTAssertEqual(reparsed.blocks.map(\.kind), safeBody.blocks.map(\.kind))

        let converted = try XCTUnwrap(safeBody.blocks[0].converted(to: .bulletList))
        let convertedBody = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([converted.serializedNode])],
            markdownFallback: ""
        )
        XCTAssertEqual(convertedBody.blocks.first?.kind, .bulletList)

        let convertedList = try XCTUnwrap(safeBody.blocks[7].converted(to: .orderedList(start: 1)))
        let convertedListNode = convertedList.serializedNode
        XCTAssertEqual(
            (convertedListNode["attrs"] as? [String: Any])?["blockId"] as? String,
            "list-2"
        )
        XCTAssertEqual(
            ((((convertedListNode["content"] as? [[String: Any]])?.first)?["attrs"] as? [String: Any])?["blockId"] as? String),
            "item-2"
        )
        XCTAssertEqual(
            (((((convertedListNode["content"] as? [[String: Any]])?.first)?["content"] as? [[String: Any]])?.first)?["attrs"] as? [String: Any])?["blockId"] as? String,
            "paragraph-2"
        )
        XCTAssertEqual(
            (((((convertedListNode["content"] as? [[String: Any]])?.first)?["content"] as? [[String: Any]])?.first)?["attrs"] as? [String: Any])?["textAlign"] as? String,
            "right"
        )
    }

    func testFlatListsRoundTripAndNestedListIsEditable() throws {
        let flatNodes: [[String: Any]] = [
            [
                "type": "bulletList",
                "attrs": ["blockId": "list-b1"],
                "content": [[
                    "type": "listItem",
                    "attrs": ["blockId": "b1"],
                    "content": [["type": "paragraph", "content": [["type": "text", "text": "项目一", "marks": [["type": "italic"]]]]]],
                ]],
            ],
            [
                "type": "orderedList",
                "attrs": ["start": 3],
                "content": [[
                    "type": "listItem",
                    "content": [["type": "paragraph", "content": [["type": "text", "text": "第三项"]]]],
                ]],
            ],
            [
                "type": "taskList",
                "content": [[
                    "type": "taskItem",
                    "attrs": ["checked": true, "blockId": "t1"],
                    "content": [["type": "paragraph", "content": [["type": "text", "text": "完成"]]]],
                ]],
            ],
        ]
        let flat = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable(flatNodes)],
            markdownFallback: ""
        )
        XCTAssertEqual(flat.blocks.map(\.kind), [.bulletList, .orderedList(start: 3), .taskList])
        XCTAssertTrue(flat.blocks[2].listItems[0].isChecked)
        let roundTrip = try XCTUnwrap(flat.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual((roundTrip[0]["attrs"] as? [String: Any])?["blockId"] as? String, "list-b1")
        XCTAssertEqual((roundTrip[1]["attrs"] as? [String: Any])?["start"] as? Int, 3)
        XCTAssertEqual((((roundTrip[2]["content"] as? [[String: Any]])?.first)?["attrs"] as? [String: Any])?["blockId"] as? String, "t1")

        let nested: [String: Any] = [
            "type": "bulletList",
            "content": [[
                "type": "listItem",
                "content": [
                    ["type": "paragraph", "content": [["type": "text", "text": "父项"]]],
                    ["type": "bulletList", "content": [[
                        "type": "listItem",
                        "content": [["type": "paragraph", "content": [["type": "text", "text": "子项"]]]],
                    ]]],
                ],
            ]],
        ]
        let complex = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([nested])],
            markdownFallback: ""
        )
        XCTAssertEqual(complex.blocks.first?.kind, .bulletList)
        XCTAssertEqual(complex.blocks.first?.listItems.first?.text, "父项")
        XCTAssertEqual(complex.blocks.first?.listItems.first?.nested?.kind, .bulletList)
        XCTAssertEqual(complex.blocks.first?.listItems.first?.nested?.items.first?.text, "子项")
        XCTAssertEqual(complex.blocks.first?.readablePreview, "父项 子项")
        let nestedRoundTrip = try XCTUnwrap(complex.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertTrue(NSDictionary(dictionary: nestedRoundTrip[0]).isEqual(to: nested))
    }

    func testAdjacentSameTypeListContainersKeepThreeLayerIdentitiesAndStayUnmerged() throws {
        let first = listNode(blockId: "blk-bl-adj-a", items: [
            listItemNode("相邻无序甲", blockId: "blk-li-adj-a", paragraphId: "blk-p-adj-a"),
        ])
        let second = listNode(blockId: "blk-bl-adj-b", items: [
            listItemNode("相邻无序乙", blockId: "blk-li-adj-b", paragraphId: "blk-p-adj-b"),
        ])
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([first, second])],
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.map(\.kind), [.bulletList, .bulletList])
        XCTAssertEqual(body.blocks.count, 2)

        body.blocks[0].listItems[0].spans = .nativeTabDocPlain("相邻无序甲已改")
        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual(serialized.count, 2)
        XCTAssertEqual(serialized[0]["type"] as? String, "bulletList")
        XCTAssertEqual(serialized[1]["type"] as? String, "bulletList")
        XCTAssertEqual(try stableJSONData(serialized[1]), try stableJSONData(second))
        XCTAssertEqual((serialized[0]["attrs"] as? [String: Any])?["blockId"] as? String, "blk-bl-adj-a")
        let firstItem = try XCTUnwrap((serialized[0]["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((firstItem["attrs"] as? [String: Any])?["blockId"] as? String, "blk-li-adj-a")
        XCTAssertEqual(
            ((firstItem["content"] as? [[String: Any]])?.first?["attrs"] as? [String: Any])?["blockId"] as? String,
            "blk-p-adj-a"
        )
        XCTAssertEqual(plainListItemText(firstItem), "相邻无序甲已改")
    }

    func testAdjacentOrderedListContainersKeepThreeLayerIdentitiesAndRestartNumbering() throws {
        let first = listNode(type: "orderedList", blockId: "blk-ol-adj-a", start: 1, items: [
            listItemNode("相邻有序甲", blockId: "blk-li-oadj-a", paragraphId: "blk-p-oadj-a"),
        ])
        let second = listNode(type: "orderedList", blockId: "blk-ol-adj-b", start: 1, items: [
            listItemNode("相邻有序乙", blockId: "blk-li-oadj-b", paragraphId: "blk-p-oadj-b"),
        ])
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([first, second])],
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.map(\.kind), [.orderedList(start: 1), .orderedList(start: 1)])

        body.blocks[0].listItems[0].spans = .nativeTabDocPlain("相邻有序甲已改")
        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual(serialized.count, 2)
        XCTAssertEqual(try stableJSONData(serialized[1]), try stableJSONData(second))
        // 合并会让第二个列表接着上一列表编号，用户直接看到序号从 1 变成 2
        XCTAssertEqual((serialized[1]["attrs"] as? [String: Any])?["start"] as? Int, 1)
        XCTAssertEqual((serialized[0]["attrs"] as? [String: Any])?["blockId"] as? String, "blk-ol-adj-a")
        let firstItem = try XCTUnwrap((serialized[0]["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((firstItem["attrs"] as? [String: Any])?["blockId"] as? String, "blk-li-oadj-a")
        XCTAssertEqual(
            ((firstItem["content"] as? [[String: Any]])?.first?["attrs"] as? [String: Any])?["blockId"] as? String,
            "blk-p-oadj-a"
        )
        XCTAssertEqual(plainListItemText(firstItem), "相邻有序甲已改")
    }

    func testTwoLevelNestedListRoundTripsIdentitiesByteForByte() throws {
        let nested: [String: Any] = [
            "type": "bulletList",
            "attrs": ["blockId": "list-root"],
            "content": [[
                "type": "listItem",
                "attrs": ["blockId": "item-1"],
                "content": [
                    [
                        "type": "paragraph",
                        "attrs": ["blockId": "para-1", "textAlign": "right"],
                        "content": [["type": "text", "text": "父项"]],
                    ],
                    [
                        "type": "bulletList",
                        "attrs": ["blockId": "list-child"],
                        "content": [[
                            "type": "listItem",
                            "attrs": ["blockId": "item-1-1"],
                            "content": [[
                                "type": "paragraph",
                                "attrs": ["blockId": "para-1-1"],
                                "content": [["type": "text", "text": "子项"]],
                            ]],
                        ]],
                    ],
                ],
            ]],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([nested])],
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.first?.kind, .bulletList)
        XCTAssertEqual(body.blocks.first?.listItems.first?.textAlignment, .right)
        XCTAssertEqual(body.blocks.first?.listItems.first?.nested?.rawNode["attrs"]?.dictValue?["blockId"] as? String, "list-child")
        XCTAssertEqual(body.markdown, "- 父项\n  - 子项")
        XCTAssertEqual(body.plaintext, "父项\n子项")
        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertTrue(NSDictionary(dictionary: serialized[0]).isEqual(to: nested))
        XCTAssertEqual(try stableJSONData(serialized[0]), try stableJSONData(nested))
    }

    func testMixedNestedListTypesPreserveOrderedStartAndTaskChecked() throws {
        let nested: [String: Any] = [
            "type": "bulletList",
            "content": [
                [
                    "type": "listItem",
                    "content": [
                        ["type": "paragraph", "content": [["type": "text", "text": "有序父项"]]],
                        [
                            "type": "orderedList",
                            "attrs": ["start": 3, "blockId": "ordered-child"],
                            "content": [[
                                "type": "listItem",
                                "attrs": ["blockId": "ordered-item"],
                                "content": [[
                                    "type": "paragraph",
                                    "content": [["type": "text", "text": "第三项"]],
                                ]],
                            ]],
                        ],
                    ],
                ],
                [
                    "type": "listItem",
                    "content": [
                        ["type": "paragraph", "content": [["type": "text", "text": "任务父项"]]],
                        [
                            "type": "taskList",
                            "attrs": ["blockId": "task-child"],
                            "content": [[
                                "type": "taskItem",
                                "attrs": ["checked": true, "blockId": "task-item", "todoId": NSNull()],
                                "content": [[
                                    "type": "paragraph",
                                    "content": [["type": "text", "text": "已完成"]],
                                ]],
                            ]],
                        ],
                    ],
                ],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([nested])],
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.first?.kind, .bulletList)
        XCTAssertEqual(body.blocks.first?.listItems[0].nested?.kind, .orderedList(start: 3))
        XCTAssertEqual(body.blocks.first?.listItems[1].nested?.kind, .taskList)
        XCTAssertTrue(try XCTUnwrap(body.blocks.first?.listItems[1].nested?.items.first?.isChecked))
        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertTrue(NSDictionary(dictionary: serialized[0]).isEqual(to: nested))
        XCTAssertEqual(try stableJSONData(serialized[0]), try stableJSONData(nested))
    }

    func testThreeLevelNestedListRoundTrips() throws {
        let nested: [String: Any] = [
            "type": "bulletList",
            "attrs": ["blockId": "l0"],
            "content": [[
                "type": "listItem",
                "attrs": ["blockId": "i0"],
                "content": [
                    [
                        "type": "paragraph",
                        "attrs": ["blockId": "p0"],
                        "content": [["type": "text", "text": "一层"]],
                    ],
                    [
                        "type": "orderedList",
                        "attrs": ["start": 2, "blockId": "l1"],
                        "content": [[
                            "type": "listItem",
                            "attrs": ["blockId": "i1"],
                            "content": [
                                [
                                    "type": "paragraph",
                                    "attrs": ["blockId": "p1"],
                                    "content": [["type": "text", "text": "二层"]],
                                ],
                                [
                                    "type": "taskList",
                                    "attrs": ["blockId": "l2"],
                                    "content": [[
                                        "type": "taskItem",
                                        "attrs": ["checked": false, "blockId": "i2"],
                                        "content": [[
                                            "type": "paragraph",
                                            "attrs": ["blockId": "p2"],
                                            "content": [["type": "text", "text": "三层"]],
                                        ]],
                                    ]],
                                ],
                            ],
                        ]],
                    ],
                ],
            ]],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([nested])],
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.first?.kind, .bulletList)
        XCTAssertEqual(body.blocks.first?.listItems.first?.nested?.kind, .orderedList(start: 2))
        XCTAssertEqual(body.blocks.first?.listItems.first?.nested?.items.first?.nested?.kind, .taskList)
        XCTAssertEqual(body.markdown, "- 一层\n  2. 二层\n    - [ ] 三层")
        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertTrue(NSDictionary(dictionary: serialized[0]).isEqual(to: nested))
        XCTAssertEqual(try stableJSONData(serialized[0]), try stableJSONData(nested))
    }

    func testEditingTopLevelListItemPreservesNestedSubtreeAndIdentities() throws {
        let nested: [String: Any] = [
            "type": "bulletList",
            "attrs": ["blockId": "l0"],
            "content": [[
                "type": "listItem",
                "attrs": ["blockId": "i0"],
                "content": [
                    [
                        "type": "paragraph",
                        "attrs": ["blockId": "p0"],
                        "content": [["type": "text", "text": "一层原文"]],
                    ],
                    [
                        "type": "bulletList",
                        "attrs": ["blockId": "l1"],
                        "content": [[
                            "type": "listItem",
                            "attrs": ["blockId": "i1"],
                            "content": [
                                [
                                    "type": "paragraph",
                                    "attrs": ["blockId": "p1"],
                                    "content": [["type": "text", "text": "二层原文"]],
                                ],
                                [
                                    "type": "bulletList",
                                    "attrs": ["blockId": "l2"],
                                    "content": [[
                                        "type": "listItem",
                                        "attrs": ["blockId": "i2"],
                                        "content": [[
                                            "type": "paragraph",
                                            "attrs": ["blockId": "p2"],
                                            "content": [["type": "text", "text": "三层原文"]],
                                        ]],
                                    ]],
                                ],
                            ],
                        ]],
                    ],
                ],
            ]],
        ]
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([nested])],
            markdownFallback: ""
        )
        body.blocks[0].listItems[0].spans = [NativeTabDocInlineSpan(text: "一层已改")]
        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let root = serialized[0]
        XCTAssertEqual((root["attrs"] as? [String: Any])?["blockId"] as? String, "l0")
        let topItem = try XCTUnwrap((root["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((topItem["attrs"] as? [String: Any])?["blockId"] as? String, "i0")
        let topChildren = try XCTUnwrap(topItem["content"] as? [[String: Any]])
        XCTAssertEqual(topChildren.count, 2)
        XCTAssertEqual((topChildren[0]["attrs"] as? [String: Any])?["blockId"] as? String, "p0")
        XCTAssertEqual(
            ((topChildren[0]["content"] as? [[String: Any]])?.first)?["text"] as? String,
            "一层已改"
        )
        XCTAssertTrue(NSDictionary(dictionary: topChildren[1]).isEqual(to: [
            "type": "bulletList",
            "attrs": ["blockId": "l1"],
            "content": [[
                "type": "listItem",
                "attrs": ["blockId": "i1"],
                "content": [
                    [
                        "type": "paragraph",
                        "attrs": ["blockId": "p1"],
                        "content": [["type": "text", "text": "二层原文"]],
                    ],
                    [
                        "type": "bulletList",
                        "attrs": ["blockId": "l2"],
                        "content": [[
                            "type": "listItem",
                            "attrs": ["blockId": "i2"],
                            "content": [[
                                "type": "paragraph",
                                "attrs": ["blockId": "p2"],
                                "content": [["type": "text", "text": "三层原文"]],
                            ]],
                        ]],
                    ],
                ],
            ]],
        ] as [String: Any]))
    }

    func testUnsafeNestedListShapesFailClosedAndPreserveRawNode() throws {
        func paragraph(_ text: String, attributes: [String: Any]? = nil) -> [String: Any] {
            var node: [String: Any] = [
                "type": "paragraph",
                "content": [["type": "text", "text": text]],
            ]
            if let attributes { node["attrs"] = attributes }
            return node
        }
        func item(_ children: [[String: Any]]) -> [String: Any] {
            ["type": "listItem", "content": children]
        }
        func bullet(_ items: [[String: Any]], attributes: [String: Any]? = nil) -> [String: Any] {
            var node: [String: Any] = ["type": "bulletList", "content": items]
            if let attributes { node["attrs"] = attributes }
            return node
        }
        func deeplyNestedBulletList(levels: Int) -> [String: Any] {
            var node = bullet([item([paragraph("叶")])])
            for _ in 1..<levels {
                node = bullet([item([paragraph("枝"), node])])
            }
            return node
        }

        let sibling = paragraph("兄弟")
        let unsafeNodes: [(String, [String: Any])] = [
            ("three children", bullet([item([
                paragraph("父"),
                bullet([item([paragraph("子")])]),
                paragraph("多余"),
            ])])),
            ("second child not list", bullet([item([
                paragraph("父"),
                paragraph("不是列表"),
            ])])),
            ("paragraph not first", bullet([item([
                bullet([item([paragraph("子")])]),
                paragraph("父"),
            ])])),
            (
                "over depth limit",
                deeplyNestedBulletList(levels: NativeTabDocNestedList.maxDepth + 2)
            ),
            ("nested unknown attr", bullet([item([
                paragraph("父"),
                bullet([item([paragraph("子")])], attributes: ["tight": true]),
            ])])),
        ]
        for (name, rawNode) in unsafeNodes {
            var body = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([rawNode, sibling]),
                ],
                markdownFallback: ""
            )
            XCTAssertEqual(body.blocks[0].kind, .unsupported(type: "bulletList"), name)
            XCTAssertTrue(
                NSDictionary(dictionary: body.blocks[0].rawNode.mapValues(\.value)).isEqual(to: rawNode),
                name
            )
            body.blocks[1].text = "兄弟已编辑"
            let serialized = try XCTUnwrap(
                body.serializedJSON["content"]?.arrayValue as? [[String: Any]],
                name
            )
            XCTAssertTrue(
                NSDictionary(dictionary: serialized[0]).isEqual(to: rawNode),
                "不安全嵌套必须整块原样保留：\(name)"
            )
            XCTAssertEqual(
                ((serialized[1]["content"] as? [[String: Any]])?.first)?["text"] as? String,
                "兄弟已编辑",
                name
            )
        }

        let atLimit = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([
                    deeplyNestedBulletList(levels: NativeTabDocNestedList.maxDepth + 1),
                ]),
            ],
            markdownFallback: ""
        )
        XCTAssertEqual(atLimit.blocks.first?.kind, .bulletList)
    }

    func testDuplicatingNestedListStripsSubtreeIdentities() throws {
        let nested: [String: Any] = [
            "type": "bulletList",
            "attrs": ["blockId": "l0", "id": "legacy-l0"],
            "content": [[
                "type": "listItem",
                "attrs": ["blockId": "i0"],
                "content": [
                    [
                        "type": "paragraph",
                        "attrs": ["blockId": "p0"],
                        "content": [["type": "text", "text": "父项"]],
                    ],
                    [
                        "type": "orderedList",
                        "attrs": ["start": 4, "blockId": "l1"],
                        "content": [[
                            "type": "listItem",
                            "attrs": ["blockId": "i1", "id": "legacy-i1"],
                            "content": [[
                                "type": "paragraph",
                                "attrs": ["blockId": "p1"],
                                "content": [["type": "text", "text": "子项"]],
                            ]],
                        ]],
                    ],
                ],
            ]],
        ]
        let original = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([nested])],
            markdownFallback: ""
        ).blocks[0]
        let duplicate = original.duplicatedForInsertion()
        XCTAssertNotEqual(duplicate.id, original.id)
        XCTAssertNotEqual(duplicate.listItems[0].id, original.listItems[0].id)
        XCTAssertNotEqual(
            duplicate.listItems[0].nested?.items[0].id,
            original.listItems[0].nested?.items[0].id
        )
        XCTAssertEqual(duplicate.listItems[0].nested?.kind, .orderedList(start: 4))
        XCTAssertEqual(duplicate.listItems[0].nested?.items[0].text, "子项")

        let serialized = duplicate.serializedNode
        XCTAssertEqual(collectBlockIds(serialized), [])
        XCTAssertNil((serialized["attrs"] as? [String: Any])?["id"])
        let topItem = try XCTUnwrap((serialized["content"] as? [[String: Any]])?.first)
        XCTAssertNil((topItem["attrs"] as? [String: Any])?["blockId"])
        let nestedList = try XCTUnwrap((topItem["content"] as? [[String: Any]])?.dropFirst().first)
        XCTAssertEqual(nestedList["type"] as? String, "orderedList")
        XCTAssertEqual((nestedList["attrs"] as? [String: Any])?["start"] as? Int, 4)
        XCTAssertNil((nestedList["attrs"] as? [String: Any])?["blockId"])
        let nestedItem = try XCTUnwrap((nestedList["content"] as? [[String: Any]])?.first)
        XCTAssertNil((nestedItem["attrs"] as? [String: Any])?["blockId"])
        XCTAssertNil((nestedItem["attrs"] as? [String: Any])?["id"])
        let nestedParagraph = try XCTUnwrap((nestedItem["content"] as? [[String: Any]])?.first)
        XCTAssertNil((nestedParagraph["attrs"] as? [String: Any])?["blockId"])
    }

    func testNestedSingleItemListCannotConvertToInlineBlock() throws {
        let nested = NativeTabDocListItem(
            spans: .nativeTabDocPlain("父项"),
            nested: NativeTabDocNestedList(
                kind: .bulletList,
                items: [NativeTabDocListItem(spans: .nativeTabDocPlain("子项"))]
            )
        )
        let block = NativeTabDocBlock(kind: .bulletList, listItems: [nested])
        XCTAssertFalse(block.conversionOptions.contains(.paragraph))
        XCTAssertNil(block.converted(to: .paragraph))
        XCTAssertTrue(block.conversionOptions.contains(.orderedList(start: 1)))
        let converted = try XCTUnwrap(block.converted(to: .taskList))
        XCTAssertEqual(converted.listItems[0].nested?.items.first?.text, "子项")
    }

    func testStandaloneImageParagraphAndSimpleTableRoundTripWhileMergedTableStaysReadOnly() throws {
        let nameText: [String: Any] = ["type": "text", "text": "名称"]
        let statusText: [String: Any] = ["type": "text", "text": "状态"]
        let mobileText: [String: Any] = ["type": "text", "text": "移动端"]
        let progressText: [String: Any] = [
            "type": "text",
            "text": "开发中",
        ]
        let nameHeader: [String: Any] = [
            "type": "tableHeader",
            "attrs": ["colspan": 1],
            "content": [["type": "paragraph", "content": [nameText]]],
        ]
        let statusHeader: [String: Any] = [
            "type": "tableHeader",
            "attrs": ["colspan": 1],
            "content": [["type": "paragraph", "content": [statusText]]],
        ]
        let mobileCell: [String: Any] = [
            "type": "tableCell",
            "content": [["type": "paragraph", "content": [mobileText]]],
        ]
        let progressCell: [String: Any] = [
            "type": "tableCell",
            "content": [["type": "paragraph", "content": [progressText]]],
        ]
        let headerRow: [String: Any] = [
            "type": "tableRow",
            "content": [nameHeader, statusHeader],
        ]
        let valueRow: [String: Any] = [
            "type": "tableRow",
            "content": [mobileCell, progressCell],
        ]
        let nodes: [[String: Any]] = [
            [
                "type": "paragraph",
                "attrs": ["blockId": "image-paragraph"],
                "content": [[
                    "type": "image",
                    "attrs": [
                        "src": "https://signed.example/image.png",
                        "fileId": "11111111-1111-1111-1111-111111111111",
                        "alt": "路线图",
                        "width": 800,
                        "custom": "keep-me",
                    ],
                ]],
            ],
            [
                "type": "table",
                "attrs": ["layout": "fixed"],
                "content": [headerRow, valueRow],
            ],
        ]
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable(nodes)],
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.map(\.kind), [.image, .table])
        body.blocks[1].table?.rows[1].cells[1].spans = [NativeTabDocInlineSpan(text: "已完成")]
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual(roundTrip[0]["type"] as? String, "paragraph")
        XCTAssertEqual((roundTrip[0]["attrs"] as? [String: Any])?["blockId"] as? String, "image-paragraph")
        let image = try XCTUnwrap((roundTrip[0]["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(image["type"] as? String, "image")
        XCTAssertEqual((image["attrs"] as? [String: Any])?["fileId"] as? String, "11111111-1111-1111-1111-111111111111")
        XCTAssertEqual((image["attrs"] as? [String: Any])?["custom"] as? String, "keep-me")
        XCTAssertEqual((roundTrip[1]["attrs"] as? [String: Any])?["layout"] as? String, "fixed")
        let rows = try XCTUnwrap(roundTrip[1]["content"] as? [[String: Any]])
        let cells = try XCTUnwrap(rows[1]["content"] as? [[String: Any]])
        let paragraph = try XCTUnwrap((cells[1]["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(((paragraph["content"] as? [[String: Any]])?.first)?["text"] as? String, "已完成")

        let merged: [String: Any] = [
            "type": "table",
            "content": [[
                "type": "tableRow",
                "content": [[
                    "type": "tableCell",
                    "attrs": ["colspan": 2],
                    "content": [["type": "paragraph", "content": [["type": "text", "text": "合并单元格"]]]],
                ]],
            ]],
        ]
        let complex = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([merged])],
            markdownFallback: ""
        )
        XCTAssertEqual(complex.blocks.first?.kind, .table)
        XCTAssertEqual(complex.blocks.first?.table?.requiresWholeTablePreservation, true)
        let mergedRoundTrip = try XCTUnwrap(complex.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let mergedRow = try XCTUnwrap((mergedRoundTrip.first?["content"] as? [[String: Any]])?.first)
        let mergedCell = try XCTUnwrap((mergedRow["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((mergedCell["attrs"] as? [String: Any])?["colspan"] as? Int, 2)
    }

    func testMarkedTableCellIsReadOnlyAndSiblingParagraphRemainsEditable() throws {
        let markedTable: [String: Any] = [
            "type": "table",
            "content": [[
                "type": "tableRow",
                "content": [[
                    "type": "tableCell",
                    "content": [[
                        "type": "paragraph",
                        "content": [[
                            "type": "text",
                            "text": "加粗",
                            "marks": [["type": "bold"]],
                        ]],
                    ]],
                ]],
            ]],
        ]
        let paragraph: [String: Any] = [
            "type": "paragraph",
            "content": [["type": "text", "text": "修改前"]],
        ]
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([markedTable, paragraph])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.map(\.kind), [.table, .paragraph])
        let markedCell = try XCTUnwrap(body.blocks[0].table?.rows[0].cells[0])
        XCTAssertEqual(markedCell.isReadOnlyProjection, false)
        XCTAssertEqual(markedCell.spans, [
            NativeTabDocInlineSpan(text: "加粗", marks: [.canonical(.bold)]),
        ])
        XCTAssertTrue(NativeTabDocEditPolicy.allowsWholeDocumentEdit(body))

        body.blocks[0].table?.rows[0].cells[0].spans = [
            NativeTabDocInlineSpan(text: "加粗后", marks: [.canonical(.bold)]),
        ]
        body.blocks[1].spans = [NativeTabDocInlineSpan(text: "修改后")]
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let serializedRows = try XCTUnwrap(roundTrip[0]["content"] as? [[String: Any]])
        let serializedCells = try XCTUnwrap(serializedRows[0]["content"] as? [[String: Any]])
        let serializedParagraph = try XCTUnwrap(
            (serializedCells[0]["content"] as? [[String: Any]])?.first
        )
        let serializedText = try XCTUnwrap(
            (serializedParagraph["content"] as? [[String: Any]])?.first
        )
        XCTAssertEqual(serializedText["text"] as? String, "加粗后")
        XCTAssertEqual(
            (serializedText["marks"] as? [[String: Any]])?.map { $0["type"] as? String },
            ["bold"]
        )
        XCTAssertEqual(
            (((roundTrip[1]["content"] as? [[String: Any]])?.first)?["text"] as? String),
            "修改后"
        )
    }

    func testUnknownMarkTableCellIsReadOnlyAndPreservesRaw() throws {
        let unknownMarkCell: [String: Any] = [
            "type": "tableCell",
            "content": [[
                "type": "paragraph",
                "content": [[
                    "type": "text",
                    "text": "未知标记",
                    "marks": [["type": "futureMark", "attrs": ["weight": 9]]],
                ]],
            ]],
        ]
        let unknownMarkTable: [String: Any] = [
            "type": "table",
            "content": [["type": "tableRow", "content": [unknownMarkCell]]],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([unknownMarkTable])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .table)
        XCTAssertEqual(body.blocks[0].table?.rows[0].cells[0].isReadOnlyProjection, true)
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let serializedRows = try XCTUnwrap(roundTrip[0]["content"] as? [[String: Any]])
        let serializedCells = try XCTUnwrap(serializedRows[0]["content"] as? [[String: Any]])
        XCTAssertTrue(
            NSDictionary(dictionary: serializedCells[0]).isEqual(to: unknownMarkCell),
            "未知 mark 格必须只读，且 rawCell 原样写回"
        )
    }

    func testMathematicsTableCellIsReadOnlyAndPreservesRaw() throws {
        let formulaCell: [String: Any] = [
            "type": "tableCell",
            "content": [[
                "type": "paragraph",
                "content": [[
                    "type": "mathematics",
                    "attrs": ["latex": "E = mc^2", "display": false],
                ]],
            ]],
        ]
        let formulaTable: [String: Any] = [
            "type": "table",
            "content": [["type": "tableRow", "content": [formulaCell]]],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([formulaTable])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .table)
        XCTAssertEqual(body.blocks[0].table?.rows[0].cells[0].isReadOnlyProjection, true)
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let serializedRows = try XCTUnwrap(roundTrip[0]["content"] as? [[String: Any]])
        let serializedCells = try XCTUnwrap(serializedRows[0]["content"] as? [[String: Any]])
        XCTAssertTrue(
            NSDictionary(dictionary: serializedCells[0]).isEqual(to: formulaCell),
            "公式格必须只读，且 rawCell 原样写回，不能走 parseInlineSpans 改写 atom"
        )
    }

    func testMergedTableIsReadonlyTableBlockWithoutLockingSiblingParagraph() throws {
        let merged: [String: Any] = [
            "type": "table",
            "content": [[
                "type": "tableRow",
                "content": [[
                    "type": "tableCell",
                    "attrs": ["colspan": 2],
                    "content": [[
                        "type": "paragraph",
                        "content": [["type": "text", "text": "合并单元格"]],
                    ]],
                ]],
            ]],
        ]
        let paragraph: [String: Any] = [
            "type": "paragraph",
            "content": [["type": "text", "text": "旁段"]],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([merged, paragraph])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.map(\.kind), [.table, .paragraph])
        XCTAssertEqual(body.blocks[0].table?.requiresWholeTablePreservation, true)
        XCTAssertFalse(body.hasUnsupportedBlocks)
        XCTAssertTrue(NativeTabDocEditPolicy.allowsWholeDocumentEdit(body))
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertTrue(NSDictionary(dictionary: roundTrip[0]).isEqual(to: merged))
    }

    func testComplexTableSummariesStaySemanticWithoutModelLanguageOrSchemaTypes() throws {
        let schemaTypes = ["tabwhiteboard", "tabdataBlock", "htmlBlock", "youtube", "futureWidget"]
        let table: [String: Any] = [
            "type": "table",
            "content": [[
                "type": "tableRow",
                "content": [[
                    "type": "tableCell",
                    "content": schemaTypes.map { ["type": $0] },
                ]],
            ]],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([table])],
            markdownFallback: ""
        )
        let cell = try XCTUnwrap(body.blocks.first?.table?.rows.first?.cells.first)
        let summaries = try XCTUnwrap(cell.projection?.parts.compactMap { part ->
            NativeTabDocTableContentSummaryKind? in
            guard case .summary(let kind, _) = part else { return nil }
            return kind
        })

        XCTAssertEqual(
            summaries,
            [.whiteboard, .embeddedTable, .embeddedHTML, .video, .complexContent]
        )
        XCTAssertTrue(
            cell.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            "模型层不应写入任何界面语言"
        )
    }

    func testComplexTableProjectionLocalizesUIAndClipboardInChineseAndEnglish() {
        let projection = NativeTabDocTableProjection.joined(
            [
                .summary(.whiteboard, title: "Roadmap"),
                .summary(.embeddedTable),
                .summary(.embeddedHTML),
                .summary(.video),
                .summary(.complexContent),
            ],
            separator: "\n"
        )
        let cell = NativeTabDocTableCell(
            isReadOnlyProjection: true,
            projection: projection
        )
        let table = NativeTabDocTable(rows: [NativeTabDocTableRow(cells: [cell])])
        let previousLanguage = LanguageManager.shared.language
        defer { LanguageManager.shared.language = previousLanguage }

        LanguageManager.shared.language = .en
        let english = """
        Whiteboard Roadmap
        Embedded table
        Embedded HTML
        Video
        Complex block preserved
        """
        XCTAssertEqual(english, NativeTabDocTableProjectionLocalization.cellText(cell))
        XCTAssertEqual(english, NativeTabDocTableProjectionLocalization.tableText(table))

        LanguageManager.shared.language = .zhHans
        let chinese = """
        画板 Roadmap
        嵌入的多维表
        嵌入的 HTML
        视频
        复杂内容块已保留
        """
        XCTAssertEqual(chinese, NativeTabDocTableProjectionLocalization.cellText(cell))
        XCTAssertEqual(chinese, NativeTabDocTableProjectionLocalization.tableText(table))
    }

    func testComplexRectangularTableProjectsReadableCellContentWithoutBecomingEditable() throws {
        let complexCell: [String: Any] = [
            "type": "tableCell",
            "content": [
                ["type": "paragraph", "content": [["type": "text", "text": "第一段"]]],
                [
                    "type": "bulletList",
                    "content": [[
                        "type": "listItem",
                        "content": [
                            ["type": "paragraph", "content": [["type": "text", "text": "父项"]]],
                            [
                                "type": "bulletList",
                                "content": [[
                                    "type": "listItem",
                                    "content": [[
                                        "type": "paragraph",
                                        "content": [["type": "text", "text": "子项"]],
                                    ]],
                                ]],
                            ],
                        ],
                    ]],
                ],
                [
                    "type": "paragraph",
                    "content": [[
                        "type": "image",
                        "attrs": ["src": "https://example.com/diagram.png", "alt": "架构图"],
                    ]],
                ],
                ["type": "htmlBlock", "attrs": ["title": "嵌入内容"]],
            ],
        ]
        let simpleCell: [String: Any] = [
            "type": "tableCell",
            "content": [["type": "paragraph", "content": [["type": "text", "text": "第二列"]]]],
        ]
        let rawTable: [String: Any] = [
            "type": "table",
            "content": [["type": "tableRow", "content": [complexCell, simpleCell]]],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([rawTable])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .table)
        let table = try XCTUnwrap(body.blocks.first?.table)
        XCTAssertEqual(table.rows.count, 1)
        XCTAssertEqual(table.columnCount, 2)
        let projected = table.rows[0].cells[0].text
        ["第一段", "父项", "子项", "架构图", "嵌入内容"].forEach {
            XCTAssertTrue(projected.contains($0), "missing projected content: \($0)")
        }
        XCTAssertFalse(body.hasUnsupportedBlocks)
        XCTAssertTrue(body.hasProjectedTableCells)
        XCTAssertEqual(table.projectedCellCount, 1)
        XCTAssertTrue(table.isCellReadOnly(table.rows[0].cells[0]))
        XCTAssertFalse(table.isCellReadOnly(table.rows[0].cells[1]))
        XCTAssertTrue(NativeTabDocEditPolicy.allowsWholeDocumentEdit(body))

        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let row = try XCTUnwrap((serialized.first?["content"] as? [[String: Any]])?.first)
        let cell = try XCTUnwrap((row["content"] as? [[String: Any]])?.first)
        let cellContent = try XCTUnwrap(cell["content"] as? [[String: Any]])
        XCTAssertEqual(cellContent.map { $0["type"] as? String }, ["paragraph", "bulletList", "paragraph", "htmlBlock"])
    }

    func testMixedComplexTableEditsSimpleCellsWithoutFlatteningProjectedCells() throws {
        let simpleCell: [String: Any] = [
            "type": "tableCell",
            "attrs": ["colspan": 1, "rowspan": 1, "custom": "keep-simple"],
            "content": [[
                "type": "paragraph",
                "attrs": ["textAlign": "left"],
                "content": [["type": "text", "text": "可编辑"]],
            ]],
        ]
        let projectedCell: [String: Any] = [
            "type": "tableCell",
            "attrs": ["custom": "keep-complex"],
            "content": [
                ["type": "paragraph", "content": [["type": "text", "text": "复杂首段"]]],
                [
                    "type": "bulletList",
                    "content": [[
                        "type": "listItem",
                        "content": [[
                            "type": "paragraph",
                            "content": [["type": "text", "text": "复杂列表"]],
                        ]],
                    ]],
                ],
            ],
        ]
        let rawTable: [String: Any] = [
            "type": "table",
            "attrs": ["layout": "fixed"],
            "content": [[
                "type": "tableRow",
                "attrs": ["custom": "keep-row"],
                "content": [simpleCell, projectedCell],
            ]],
        ]
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([rawTable])],
            markdownFallback: ""
        )

        XCTAssertTrue(NativeTabDocEditPolicy.allowsWholeDocumentEdit(body))
        let parsedTable = try XCTUnwrap(body.blocks[0].table)
        XCTAssertEqual(parsedTable.projectedCellCount, 1)
        XCTAssertFalse(parsedTable.isCellReadOnly(parsedTable.rows[0].cells[0]))
        XCTAssertTrue(parsedTable.isCellReadOnly(parsedTable.rows[0].cells[1]))
        body.blocks[0].table?.rows[0].cells[0].spans = [NativeTabDocInlineSpan(text: "已更新")]
        body.blocks[0].table?.rows[0].cells[1].spans = [NativeTabDocInlineSpan(text: "不得覆盖")]

        let serialized = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let table = try XCTUnwrap(serialized.first)
        XCTAssertEqual((table["attrs"] as? [String: Any])?["layout"] as? String, "fixed")
        let row = try XCTUnwrap((table["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((row["attrs"] as? [String: Any])?["custom"] as? String, "keep-row")
        let cells = try XCTUnwrap(row["content"] as? [[String: Any]])
        let simpleParagraph = try XCTUnwrap((cells[0]["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(((simpleParagraph["content"] as? [[String: Any]])?.first)?["text"] as? String, "已更新")
        XCTAssertEqual((cells[0]["attrs"] as? [String: Any])?["custom"] as? String, "keep-simple")
        XCTAssertEqual((cells[1]["attrs"] as? [String: Any])?["custom"] as? String, "keep-complex")
        let complexContent = try XCTUnwrap(cells[1]["content"] as? [[String: Any]])
        XCTAssertEqual(complexContent.map { $0["type"] as? String }, ["paragraph", "bulletList"])
        let complexParagraph = try XCTUnwrap(complexContent.first)
        XCTAssertEqual(((complexParagraph["content"] as? [[String: Any]])?.first)?["text"] as? String, "复杂首段")
    }

    func testLegacyProjectedTableDraftKeepsWholeTableReadOnly() throws {
        let firstRawCell: [String: Any] = [
            "type": "tableCell",
            "content": [["type": "paragraph", "content": [["type": "text", "text": "第一格"]]]],
        ]
        let secondRawCell: [String: Any] = [
            "type": "tableCell",
            "content": [["type": "paragraph", "content": [["type": "text", "text": "第二格"]]]],
        ]
        let rawTable: [String: Any] = [
            "type": "table",
            "content": [["type": "tableRow", "content": [firstRawCell, secondRawCell]]],
        ]
        let legacyTable = NativeTabDocTable(
            rows: [NativeTabDocTableRow(cells: [
                NativeTabDocTableCell(
                    spans: [NativeTabDocInlineSpan(text: "第一格")],
                    rawCell: firstRawCell.mapValues(AnyCodable.init),
                    rawParagraph: ((firstRawCell["content"] as? [[String: Any]])?.first ?? [:])
                        .mapValues(AnyCodable.init)
                ),
                NativeTabDocTableCell(
                    spans: [NativeTabDocInlineSpan(text: "第二格")],
                    rawCell: secondRawCell.mapValues(AnyCodable.init),
                    rawParagraph: ((secondRawCell["content"] as? [[String: Any]])?.first ?? [:])
                        .mapValues(AnyCodable.init)
                ),
            ])],
            isReadOnlyProjection: true
        )

        let decoded = try JSONDecoder().decode(
            NativeTabDocTable.self,
            from: JSONEncoder().encode(legacyTable)
        )

        XCTAssertTrue(decoded.requiresWholeTablePreservation)
        XCTAssertTrue(decoded.hasProjectedCells)
        XCTAssertEqual(decoded.projectedCellCount, 2)
        XCTAssertTrue(decoded.rows[0].cells.allSatisfy(decoded.isCellReadOnly))

        var block = NativeTabDocBlock(
            kind: .table,
            table: decoded,
            rawNode: rawTable.mapValues(AnyCodable.init)
        )
        block.table?.rows[0].cells[0].spans = [NativeTabDocInlineSpan(text: "不得覆盖")]
        let row = try XCTUnwrap((block.serializedNode["content"] as? [[String: Any]])?.first)
        let cell = try XCTUnwrap((row["content"] as? [[String: Any]])?.first)
        let paragraph = try XCTUnwrap((cell["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(((paragraph["content"] as? [[String: Any]])?.first)?["text"] as? String, "第一格")
    }

    @MainActor
    func testSessionEditsStandardTableCellAndAddsStructureWithoutFlatteningProjectedCell() async throws {
        let simpleCell: [String: Any] = [
            "type": "tableCell",
            "content": [["type": "paragraph", "content": [["type": "text", "text": "可编辑"]]]],
        ]
        let projectedCell: [String: Any] = [
            "type": "tableCell",
            "content": [
                ["type": "paragraph", "content": [["type": "text", "text": "复杂首段"]]],
                [
                    "type": "bulletList",
                    "content": [[
                        "type": "listItem",
                        "content": [[
                            "type": "paragraph",
                            "content": [["type": "text", "text": "复杂列表"]],
                        ]],
                    ]],
                ],
            ],
        ]
        let rawTable: [String: Any] = [
            "type": "table",
            "content": [["type": "tableRow", "content": [simpleCell, projectedCell]]],
        ]
        let contentBody = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([rawTable])],
            markdownFallback: ""
        )
        let detail = NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: "doc-1",
                organizationId: "org-1",
                spaceId: "space-1",
                title: "混合表格",
                latestVersion: 1,
                updatedAt: "2026-08-15T09:00:00Z",
                currentUserRole: "editor"
            ),
            content: NativeTabDocContent(
                descriptionJSON: contentBody.serializedJSON,
                descriptionMarkdown: contentBody.markdown,
                descriptionPlaintext: contentBody.plaintext
            )
        )
        var savedDraft: NativeTabDocDraft?
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: NativeTabDocDraftStore(store: UserDefaults(suiteName: UUID().uuidString)!),
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in detail },
            writeRequest: { _, draft in
                savedDraft = draft
                return NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: "doc-1",
                    organizationId: "org-1",
                    spaceId: "space-1",
                    title: draft.title,
                    latestVersion: 2,
                    updatedAt: "2026-08-15T09:01:00Z",
                    currentUserRole: "editor"
                ))
            }
        )

        await session.load()

        XCTAssertTrue(session.canEdit)
        XCTAssertTrue(session.hasProjectedTableCells)
        let table = try XCTUnwrap(session.body.blocks.first?.table)
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let simpleCellId = table.rows[0].cells[0].id
        let projectedCellId = table.rows[0].cells[1].id
        let projectedText = table.rows[0].cells[1].text

        session.updateTableCell(blockId: blockId, cellId: projectedCellId, text: "不得覆盖")
        session.addTableRow(blockId: blockId, afterRowIndex: 0)
        session.addTableColumn(blockId: blockId, afterColumnIndex: 0)

        let protectedTable = try XCTUnwrap(session.body.blocks.first?.table)
        XCTAssertEqual(protectedTable.rows.count, 2)
        XCTAssertEqual(protectedTable.columnCount, 3)
        XCTAssertEqual(protectedTable.rows[0].cells[2].text, projectedText)
        XCTAssertTrue(protectedTable.rows[1].cells.allSatisfy { $0.isReadOnlyProjection == false })
        XCTAssertEqual(protectedTable.rows[0].cells[1].isReadOnlyProjection, false)
        XCTAssertFalse(protectedTable.requiresWholeTablePreservation)

        session.updateTableCell(blockId: blockId, cellId: simpleCellId, text: "已更新")
        let saved = await session.save()

        XCTAssertTrue(saved)
        let savedBody = try XCTUnwrap(savedDraft?.body)
        let savedTable = try XCTUnwrap(savedBody.blocks.first?.table)
        XCTAssertEqual(savedTable.rows.count, 2)
        XCTAssertEqual(savedTable.columnCount, 3)
        XCTAssertEqual(savedTable.rows[0].cells[0].text, "已更新")
        XCTAssertEqual(savedTable.rows[0].cells[2].text, projectedText)
        let serialized = try XCTUnwrap(savedBody.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let row = try XCTUnwrap((serialized.first?["content"] as? [[String: Any]])?.first)
        let cells = try XCTUnwrap(row["content"] as? [[String: Any]])
        let complexContent = try XCTUnwrap(cells[2]["content"] as? [[String: Any]])
        XCTAssertEqual(complexContent.map { $0["type"] as? String }, ["paragraph", "bulletList"])
    }

    @MainActor
    func testSessionEditsBoldTableCellWithoutDroppingMarks() async throws {
        let markedCell: [String: Any] = [
            "type": "tableCell",
            "content": [[
                "type": "paragraph",
                "content": [[
                    "type": "text",
                    "text": "加粗",
                    "marks": [["type": "bold"]],
                ]],
            ]],
        ]
        let rawTable: [String: Any] = [
            "type": "table",
            "content": [["type": "tableRow", "content": [markedCell]]],
        ]
        let contentBody = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([rawTable])],
            markdownFallback: ""
        )
        let detail = NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: "doc-1",
                organizationId: "org-1",
                spaceId: "space-1",
                title: "加粗表格",
                latestVersion: 1,
                updatedAt: "2026-08-15T09:00:00Z",
                currentUserRole: "editor"
            ),
            content: NativeTabDocContent(
                descriptionJSON: contentBody.serializedJSON,
                descriptionMarkdown: contentBody.markdown,
                descriptionPlaintext: contentBody.plaintext
            )
        )
        var savedDraft: NativeTabDocDraft?
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: NativeTabDocDraftStore(store: UserDefaults(suiteName: UUID().uuidString)!),
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in detail },
            writeRequest: { _, draft in
                savedDraft = draft
                return NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: "doc-1",
                    organizationId: "org-1",
                    spaceId: "space-1",
                    title: draft.title,
                    latestVersion: 2,
                    updatedAt: "2026-08-15T09:01:00Z",
                    currentUserRole: "editor"
                ))
            }
        )

        await session.load()

        let table = try XCTUnwrap(session.body.blocks.first?.table)
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let cell = table.rows[0].cells[0]
        XCTAssertEqual(cell.isReadOnlyProjection, false)
        session.updateTableCellSpans(
            blockId: blockId,
            cellId: cell.id,
            spans: [NativeTabDocInlineSpan(text: "加粗后", marks: [.canonical(.bold)])]
        )
        let saved = await session.save()

        XCTAssertTrue(saved)
        let savedBody = try XCTUnwrap(savedDraft?.body)
        let serialized = try XCTUnwrap(
            savedBody.serializedJSON["content"]?.arrayValue as? [[String: Any]]
        )
        let row = try XCTUnwrap((serialized.first?["content"] as? [[String: Any]])?.first)
        let cells = try XCTUnwrap(row["content"] as? [[String: Any]])
        let paragraph = try XCTUnwrap((cells[0]["content"] as? [[String: Any]])?.first)
        let textNode = try XCTUnwrap((paragraph["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(textNode["text"] as? String, "加粗后")
        XCTAssertEqual(
            (textNode["marks"] as? [[String: Any]])?.map { $0["type"] as? String },
            ["bold"]
        )
    }

    func testDuplicatingBlockRegeneratesNodeIdentitiesAndPreservesContent() throws {
        let original = NativeTabDocBlock(
            kind: .taskList,
            listItems: [NativeTabDocListItem(
                spans: [NativeTabDocInlineSpan(
                    text: "保留富文本",
                    marks: [.canonical(.bold)]
                )],
                isChecked: true,
                rawItem: [
                    "type": AnyCodable("taskItem"),
                    "attrs": AnyCodable([
                        "taskId": "task-old",
                        "todoId": "todo-old",
                        "checked": true,
                        "tone": "green",
                    ]),
                ],
                rawParagraph: [
                    "type": AnyCodable("paragraph"),
                    "attrs": AnyCodable(["blockId": "paragraph-old"]),
                ]
            )],
            rawNode: [
                "type": AnyCodable("taskList"),
                "attrs": AnyCodable([
                    "blockId": "block-old",
                    "id": "legacy-old",
                    "layout": "compact",
                ]),
            ]
        )

        let duplicate = original.duplicatedForInsertion()

        XCTAssertNotEqual(duplicate.id, original.id)
        XCTAssertNotEqual(duplicate.listItems[0].id, original.listItems[0].id)
        XCTAssertEqual(duplicate.listItems[0].spans, original.listItems[0].spans)
        XCTAssertTrue(duplicate.listItems[0].isChecked)

        let serialized = duplicate.serializedNode
        let blockAttributes = try XCTUnwrap(serialized["attrs"] as? [String: Any])
        XCTAssertNil(blockAttributes["blockId"])
        XCTAssertNil(blockAttributes["id"])
        XCTAssertEqual(blockAttributes["layout"] as? String, "compact")
        let item = try XCTUnwrap((serialized["content"] as? [[String: Any]])?.first)
        let itemAttributes = try XCTUnwrap(item["attrs"] as? [String: Any])
        XCTAssertNil(itemAttributes["taskId"])
        XCTAssertNil(itemAttributes["todoId"])
        XCTAssertEqual(itemAttributes["tone"] as? String, "green")
        XCTAssertEqual(itemAttributes["checked"] as? Bool, true)
        let paragraph = try XCTUnwrap((item["content"] as? [[String: Any]])?.first)
        XCTAssertNil((paragraph["attrs"] as? [String: Any])?["blockId"])
    }

    func testBlockConversionPreservesTextAndNeverFlattensMultiItemList() throws {
        let richSpans = [NativeTabDocInlineSpan(
            text: "带格式正文",
            marks: [.canonical(.italic)]
        )]
        let paragraph = NativeTabDocBlock(
            kind: .paragraph,
            spans: richSpans,
            rawNode: [
                "type": AnyCodable("paragraph"),
                "attrs": AnyCodable([
                    "blockId": "block-stable",
                    "align": "center",
                ]),
            ]
        )

        let taskList = try XCTUnwrap(paragraph.converted(to: .taskList))
        XCTAssertEqual(taskList.id, paragraph.id)
        XCTAssertEqual(taskList.listItems.map(\.spans), [richSpans])
        XCTAssertEqual(taskList.serializedNode["type"] as? String, "taskList")
        XCTAssertEqual(
            (taskList.serializedNode["attrs"] as? [String: Any])?["blockId"] as? String,
            "block-stable"
        )
        XCTAssertNil((taskList.serializedNode["attrs"] as? [String: Any])?["align"])

        let twoItems = NativeTabDocBlock(
            kind: .bulletList,
            listItems: [
                NativeTabDocListItem(spans: .nativeTabDocPlain("第一项")),
                NativeTabDocListItem(spans: .nativeTabDocPlain("第二项")),
            ]
        )
        XCTAssertFalse(twoItems.conversionOptions.contains(.paragraph))
        XCTAssertNil(twoItems.converted(to: .paragraph))
        XCTAssertTrue(twoItems.conversionOptions.contains(.orderedList(start: 1)))
    }

    @MainActor
    func testBlockActionsUseDraftAndSavePipeline() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initialBody = NativeTabDocBody(
            rootAttributes: ["type": AnyCodable("doc")],
            blocks: [
                NativeTabDocBlock(kind: .paragraph, text: "第一块"),
                NativeTabDocBlock(kind: .paragraph, text: "第二块"),
            ]
        )
        let initialDocument = NativeTabDocDocument(
            id: "doc-1",
            organizationId: "org-1",
            spaceId: "space-1",
            title: "块操作",
            latestVersion: 1,
            updatedAt: "2026-08-13T08:00:00Z",
            currentUserRole: "editor"
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "块操作",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                NativeTabDocDetail(
                    document: initialDocument,
                    content: NativeTabDocContent(
                        descriptionJSON: initialBody.serializedJSON,
                        descriptionMarkdown: initialBody.markdown,
                        descriptionPlaintext: initialBody.plaintext
                    )
                )
            },
            writeRequest: { _, draft in
                NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: "doc-1",
                    organizationId: "org-1",
                    spaceId: "space-1",
                    title: draft.title,
                    latestVersion: 2,
                    updatedAt: "2026-08-13T08:01:00Z",
                    currentUserRole: "editor"
                ))
            }
        )

        await session.load()
        let firstId = try XCTUnwrap(session.body.blocks.first?.id)
        session.duplicateBlock(id: firstId)
        XCTAssertEqual(session.body.blocks.count, 3)
        let duplicateId = session.body.blocks[1].id
        session.moveBlock(id: duplicateId, by: 1)
        session.convertBlock(id: firstId, to: .heading(level: 2))

        XCTAssertEqual(session.body.blocks.map(\.text), ["第一块", "第二块", "第一块"])
        XCTAssertEqual(session.body.blocks.first?.kind, .heading(level: 2))
        XCTAssertEqual(session.saveState, .dirty)
        let persistedDraft = try XCTUnwrap(
            store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1")
        )
        XCTAssertEqual(
            persistedDraft.body.blocks.map(\.id),
            session.body.blocks.map(\.id)
        )
        XCTAssertEqual(
            try stableSerializedData(persistedDraft.body),
            try stableSerializedData(session.body)
        )

        let saved = await session.save()
        XCTAssertTrue(saved)
        XCTAssertEqual(session.saveState, .saved)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    func testNewUploadedImageSerializesInsideParagraph() throws {
        let block = NativeTabDocBlock.uploadedImageParagraph(
            source: "",
            fileId: "11111111-1111-1111-1111-111111111111",
            alt: "移动端上传图片"
        )

        let paragraph = block.serializedNode
        XCTAssertEqual(paragraph["type"] as? String, "paragraph")
        let image = try XCTUnwrap((paragraph["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(image["type"] as? String, "image")
        XCTAssertEqual((image["attrs"] as? [String: Any])?["fileId"] as? String, "11111111-1111-1111-1111-111111111111")
        XCTAssertEqual((image["attrs"] as? [String: Any])?["alt"] as? String, "移动端上传图片")
    }

    func testMixedTextAndImageParagraphIsEditableAndLossless() throws {
        let paragraph: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "mixed"],
            "content": [
                ["type": "text", "text": "图片前"],
                ["type": "image", "attrs": ["src": "https://example.com/image.png", "alt": "插图"]],
                ["type": "text", "text": "图片后"],
            ],
        ]
        var body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([paragraph])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .paragraph)
        XCTAssertEqual(body.blocks.first?.readablePreview, "图片前🖼 插图图片后")
        body.blocks[0].spans[body.blocks[0].spans.count - 1].text += "追加"
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let children = try XCTUnwrap(roundTrip.first?["content"] as? [[String: Any]])
        XCTAssertEqual(children.map { $0["type"] as? String }, ["text", "image", "text"])
        XCTAssertEqual(children[2]["text"] as? String, "图片后追加")
        XCTAssertEqual(
            children[1]["attrs"] as? [String: String],
            ["src": "https://example.com/image.png", "alt": "插图"],
            "编辑正文不得改写图片身份"
        )
    }

    /// 未建模的图片属性无法无损写回，整段必须继续走只读保留。
    func testMixedParagraphWithUnmodelledImageAttributeStaysReadOnly() throws {
        let paragraph: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "mixed-unknown"],
            "content": [
                ["type": "text", "text": "图片前"],
                [
                    "type": "image",
                    "attrs": [
                        "src": "https://example.com/image.png",
                        "alt": "插图",
                        "futureCrop": ["x": 1, "y": 2],
                    ],
                ],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([paragraph])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .unsupported(type: "paragraph"))
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let children = try XCTUnwrap(roundTrip.first?["content"] as? [[String: Any]])
        let attrs = try XCTUnwrap(children[1]["attrs"] as? [String: Any])
        XCTAssertNotNil(attrs["futureCrop"], "未知属性必须原样保留")
    }

    func testLegacyTopLevelImageStaysReadOnlyInsteadOfWritingInvalidSchema() throws {
        let image: [String: Any] = [
            "type": "image",
            "attrs": ["src": "https://example.com/legacy.png", "alt": "旧图片"],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([image])],
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .unsupported(type: "image"))
        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual(roundTrip.first?["type"] as? String, "image")
    }

    func testMalformedRootContentAndInlineContentNeverDisappearOnRoundTrip() throws {
        let mixedRoot: [Any] = [
            ["type": "paragraph", "content": [["type": "text", "text": "保留正文"]]],
            "invalid-node",
        ]
        let mixed = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable(mixedRoot)],
            markdownFallback: ""
        )
        XCTAssertEqual(mixed.blocks.first?.kind, .unsupported(type: "document"))
        XCTAssertFalse(NativeTabDocEditPolicy.allowsWholeDocumentEdit(mixed))
        let mixedRoundTrip = try XCTUnwrap(mixed.serializedJSON["content"]?.arrayValue)
        XCTAssertEqual(mixedRoundTrip.count, 2)
        XCTAssertEqual(mixedRoundTrip[1] as? String, "invalid-node")

        let wrongInlineType: [String: Any] = ["type": "paragraph", "content": "not-an-array"]
        let paragraph = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([wrongInlineType])],
            markdownFallback: ""
        )
        XCTAssertEqual(paragraph.blocks.first?.kind, .unsupported(type: "paragraph"))
        let paragraphRoundTrip = try XCTUnwrap(paragraph.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual(paragraphRoundTrip.first?["content"] as? String, "not-an-array")

        let wrongCodeType: [String: Any] = ["type": "codeBlock", "content": ["not-a-node"]]
        let code = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([wrongCodeType])],
            markdownFallback: ""
        )
        XCTAssertEqual(code.blocks.first?.kind, .unsupported(type: "codeBlock"))

        let wrongMarksType: [String: Any] = [
            "type": "paragraph",
            "content": [["type": "text", "text": "带坏 marks", "marks": "bold"]],
        ]
        let marks = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([wrongMarksType])],
            markdownFallback: ""
        )
        XCTAssertEqual(marks.blocks.first?.kind, .unsupported(type: "paragraph"))
    }

    func testParserKeepsNonCanonicalColorAndScriptMarksReadOnlyAndLossless() throws {
        let unsupportedMarks: [[String: Any]] = [
            ["type": "textStyle", "attrs": ["color": "yellow"]],
            ["type": "textStyle", "attrs": ["color": "#E54"]],
            ["type": "textStyle", "attrs": ["color": "#80E5484D"]],
            ["type": "textStyle", "attrs": ["color": "var(--foreground)"]],
            ["type": "highlight", "attrs": ["color": "orange"]],
            ["type": "highlight", "attrs": ["color": "#FDE"]],
            ["type": "highlight", "attrs": ["color": "#80FDE68A"]],
            ["type": "highlight", "attrs": ["color": "#FDE68A", "future": true]],
            ["type": "subscript", "attrs": [:]],
            ["type": "superscript", "attrs": ["future": true]],
        ]

        for (index, mark) in unsupportedMarks.enumerated() {
            let document: [String: Any] = [
                "type": "doc",
                "content": [[
                    "type": "paragraph",
                    "attrs": ["blockId": "unsafe-mark-\(index)", "textAlign": NSNull()],
                    "content": [["type": "text", "marks": [mark], "text": "原样保留"]],
                ]],
            ]
            let body = NativeTabDocBody.parse(
                json: document.mapValues(AnyCodable.init),
                markdownFallback: ""
            )

            XCTAssertEqual(body.blocks.first?.kind, .unsupported(type: "paragraph"), "case \(index)")
            XCTAssertEqual(
                try stableSerializedData(body),
                try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys]),
                "非 canonical mark 必须局部只读并逐字节语义往返：case \(index)"
            )
        }
    }

    @MainActor
    func testDefaultYellowHighlightParsesDisplaysAndWritesBackExactly() throws {
        let expectedMark = NativeTabDocInlineMark(
            kind: .highlight,
            rawNode: [
                "type": AnyCodable("highlight"),
                "attrs": AnyCodable(["color": "yellow"]),
            ]
        )
        let document: [String: Any] = [
            "type": "doc",
            "content": [[
                "type": "paragraph",
                "attrs": ["blockId": "default-yellow-highlight", "textAlign": NSNull()],
                "content": [[
                    "type": "text",
                    "marks": [["type": "highlight", "attrs": ["color": "yellow"]]],
                    "text": "默认黄色",
                ]],
            ]],
        ]
        var body = NativeTabDocBody.parse(
            json: document.mapValues(AnyCodable.init),
            markdownFallback: ""
        )

        XCTAssertEqual(body.blocks.first?.kind, .paragraph)
        XCTAssertEqual(body.blocks.first?.spans.first?.marks, [expectedMark])
        let attributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [expectedMark],
            style: .body,
            traitCollection: UITraitCollection(userInterfaceStyle: .light)
        )
        XCTAssertTrue(
            (attributes[.backgroundColor] as? UIColor)?.isEqual(UIColor.yellow) == true,
            "默认 yellow 必须映射为 UIKit 黄色高亮"
        )

        body.blocks[0].spans = [
            NativeTabDocInlineSpan(text: "默认黄色已编辑", marks: [expectedMark]),
        ]
        let nodes = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let inline = try XCTUnwrap((nodes.first?["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(inline["text"] as? String, "默认黄色已编辑")
        XCTAssertEqual(
            try JSONSerialization.data(withJSONObject: inline["marks"] as Any, options: [.sortedKeys]),
            try JSONSerialization.data(
                withJSONObject: [["type": "highlight", "attrs": ["color": "yellow"]]],
                options: [.sortedKeys]
            ),
            "编辑正文后 highlight attrs 必须原样写回"
        )
    }

    @MainActor
    func testParserEditsUnsafeAndRelativeLinksWithoutMakingThemInteractiveOrLosingHref() throws {
        for href in ["javascript:alert(1)", "/docs/relative"] {
            let document: [String: Any] = [
                "type": "doc",
                "content": [[
                    "type": "paragraph",
                    "attrs": ["blockId": "non-interactive-link", "textAlign": NSNull()],
                    "content": [[
                        "type": "text",
                        "marks": [["type": "link", "attrs": ["href": href]]],
                        "text": "链接",
                    ]],
                ]],
            ]
            var body = NativeTabDocBody.parse(
                json: document.mapValues(AnyCodable.init),
                markdownFallback: ""
            )
            let block = try XCTUnwrap(body.blocks.first)
            XCTAssertEqual(block.kind, .paragraph)
            let attributes = NativeTabDocRichTextMarkBridge.attributes(
                for: try XCTUnwrap(block.spans.first?.marks),
                style: .body,
                traitCollection: UITraitCollection(userInterfaceStyle: .light)
            )
            XCTAssertNil(attributes[.link], "不安全或相对地址不得成为可点击链接")

            let textView = UITextView()
            textView.attributedText = NSAttributedString(string: block.text, attributes: attributes)
            textView.selectedRange = NSRange(location: textView.attributedText.length, length: 0)
            textView.typingAttributes = attributes
            textView.insertText("已编辑")
            body.blocks[0].spans = NativeTabDocRichTextMarkBridge.spans(
                from: textView.attributedText,
                baseStyle: .body
            )

            let nodes = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
            let inline = try XCTUnwrap((nodes[0]["content"] as? [[String: Any]])?.first)
            let marks = try XCTUnwrap(inline["marks"] as? [[String: Any]])
            XCTAssertEqual(inline["text"] as? String, "链接已编辑")
            XCTAssertEqual((marks.first?["attrs"] as? [String: Any])?["href"] as? String, href)
        }
    }

    @MainActor
    func testCanonicalBlankTargetLinkParsesEditsAndWritesBackExactly() throws {
        let href = "https://tabtin.example.com/extra"
        let expectedMark: [String: Any] = [
            "type": "link",
            "attrs": ["href": href, "target": "_blank"],
        ]
        let document: [String: Any] = [
            "type": "doc",
            "content": [[
                "type": "paragraph",
                "attrs": ["blockId": "canonical-blank-target", "textAlign": NSNull()],
                "content": [[
                    "type": "text",
                    "marks": [expectedMark],
                    "text": "链接",
                ]],
            ]],
        ]
        var body = NativeTabDocBody.parse(
            json: document.mapValues(AnyCodable.init),
            markdownFallback: ""
        )

        let block = try XCTUnwrap(body.blocks.first)
        XCTAssertEqual(block.kind, .paragraph)
        let mark = try XCTUnwrap(block.spans.first?.marks.first)
        XCTAssertEqual(mark.kind, .link)
        XCTAssertEqual(mark.linkHref, href)
        XCTAssertEqual(mark.rawNode["attrs"]?.dictValue?["target"] as? String, "_blank")

        let attributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [mark],
            style: .body,
            traitCollection: UITraitCollection(userInterfaceStyle: .light)
        )
        XCTAssertEqual((attributes[.link] as? URL)?.absoluteString, href)

        let textView = UITextView()
        textView.attributedText = NSAttributedString(string: block.text, attributes: attributes)
        textView.selectedRange = NSRange(location: textView.attributedText.length, length: 0)
        textView.typingAttributes = attributes
        textView.insertText("已编辑")
        body.blocks[0].spans = NativeTabDocRichTextMarkBridge.spans(
            from: textView.attributedText,
            baseStyle: .body
        )

        let nodes = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let inline = try XCTUnwrap((nodes.first?["content"] as? [[String: Any]])?.first)
        let serializedMark = try XCTUnwrap((inline["marks"] as? [[String: Any]])?.first)
        XCTAssertEqual(inline["text"] as? String, "链接已编辑")
        XCTAssertEqual(
            try JSONSerialization.data(withJSONObject: serializedMark, options: [.sortedKeys]),
            try JSONSerialization.data(withJSONObject: expectedMark, options: [.sortedKeys]),
            "正文编辑回采后必须精确保留 canonical href + target"
        )
    }

    @MainActor
    func testCanonicalBlankTargetDoesNotMakeUnsafeHrefInteractive() throws {
        let href = "javascript:alert(1)"
        let document: [String: Any] = [
            "type": "doc",
            "content": [[
                "type": "paragraph",
                "attrs": ["blockId": "unsafe-blank-target", "textAlign": NSNull()],
                "content": [[
                    "type": "text",
                    "marks": [[
                        "type": "link",
                        "attrs": ["href": href, "target": "_blank"],
                    ]],
                    "text": "不安全链接",
                ]],
            ]],
        ]
        let body = NativeTabDocBody.parse(
            json: document.mapValues(AnyCodable.init),
            markdownFallback: ""
        )

        let block = try XCTUnwrap(body.blocks.first)
        XCTAssertEqual(block.kind, .paragraph)
        let mark = try XCTUnwrap(block.spans.first?.marks.first)
        XCTAssertEqual(mark.linkHref, href)
        XCTAssertEqual(mark.rawNode["attrs"]?.dictValue?["target"] as? String, "_blank")
        let attributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [mark],
            style: .body,
            traitCollection: UITraitCollection(userInterfaceStyle: .light)
        )
        XCTAssertNil(attributes[.link], "target 不得绕过基于 href 协议的可点击安全策略")
    }

    func testNonCanonicalLinkAttributesStayReadOnlyAndLossless() throws {
        let invalidAttributes: [[String: Any]] = [
            ["href": "https://tabtin.example.com/extra", "target": "_self"],
            ["href": "https://tabtin.example.com/extra", "target": true],
            ["href": "https://tabtin.example.com/extra", "target": NSNull()],
            [
                "href": "https://tabtin.example.com/extra",
                "target": "_blank",
                "rel": "noopener noreferrer",
            ],
        ]

        for (index, attrs) in invalidAttributes.enumerated() {
            let document: [String: Any] = [
                "type": "doc",
                "content": [[
                    "type": "paragraph",
                    "attrs": ["blockId": "non-canonical-link-\(index)", "textAlign": NSNull()],
                    "content": [[
                        "type": "text",
                        "marks": [["type": "link", "attrs": attrs]],
                        "text": "原样保留",
                    ]],
                ]],
            ]
            let body = NativeTabDocBody.parse(
                json: document.mapValues(AnyCodable.init),
                markdownFallback: ""
            )

            XCTAssertEqual(body.blocks.first?.kind, .unsupported(type: "paragraph"), "case \(index)")
            XCTAssertEqual(
                try stableSerializedData(body),
                try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys]),
                "非 canonical link attrs 必须局部只读并无损往返：case \(index)"
            )
        }
    }

    func testParserUsesMarkdownOnlyWhenJSONContentIsAbsent() {
        let document = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc")],
            markdownFallback: "# 标题\n\n正文"
        )

        XCTAssertEqual(document.blocks.map(\.kind), [.heading(level: 1), .paragraph])
        XCTAssertEqual(document.blocks.map(\.text), ["标题", "正文"])
    }

    func testExplicitEmptyJSONDoesNotResurrectStaleMarkdown() {
        let document = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([]),
            ],
            markdownFallback: "旧正文"
        )

        XCTAssertTrue(document.blocks.isEmpty)
        XCTAssertEqual(document.markdown, "")
        XCTAssertEqual(document.plaintext, "")
    }

    func testNewDividerSerializesAndRoundTripsAsHorizontalRule() throws {
        let divider = NativeTabDocBlock.new(kind: .divider)

        XCTAssertEqual(divider.serializedNode["type"] as? String, "horizontalRule")

        let body = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([divider.serializedNode]),
            ],
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.map(\.kind), [.divider])

        let roundTrip = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual(roundTrip.first?["type"] as? String, "horizontalRule")
    }

    func testBlockquoteUsesProseMirrorParagraphWrapperAndKeepsParagraphAttributes() throws {
        let raw: [String: AnyCodable] = [
            "type": AnyCodable("doc"),
            "content": AnyCodable([[
                "type": "blockquote",
                "attrs": ["blockId": "quote-1"],
                "content": [[
                    "type": "paragraph",
                    "attrs": ["blockId": "quote-paragraph-1"],
                    "content": [["type": "text", "text": "旧引用"]],
                ]],
            ]]),
        ]

        var body = NativeTabDocBody.parse(json: raw, markdownFallback: "")
        XCTAssertEqual(body.blocks.first?.kind, .blockquote)
        body.blocks[0].text = "新引用"

        let nodes = try XCTUnwrap(body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let quote = try XCTUnwrap(nodes.first)
        XCTAssertEqual(quote["type"] as? String, "blockquote")
        XCTAssertEqual((quote["attrs"] as? [String: Any])?["blockId"] as? String, "quote-1")
        let paragraph = try XCTUnwrap((quote["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(paragraph["type"] as? String, "paragraph")
        XCTAssertEqual((paragraph["attrs"] as? [String: Any])?["blockId"] as? String, "quote-paragraph-1")
        XCTAssertEqual(((paragraph["content"] as? [[String: Any]])?.first)?["text"] as? String, "新引用")

        let inserted = NativeTabDocBlock.new(kind: .blockquote).serializedNode
        let insertedParagraph = try XCTUnwrap((inserted["content"] as? [[String: Any]])?.first)
        XCTAssertEqual(insertedParagraph["type"] as? String, "paragraph")
    }

    func testNativeRoutePolicyKeepsTabDocNativeAndOtherResourcesUnchanged() {
        XCTAssertEqual(NativeCloudResourcePolicy.presentation(for: .tabdoc), .nativeTabDoc)
        XCTAssertEqual(NativeCloudResourcePolicy.presentation(for: .tabdata), .nativeTabData)
        XCTAssertEqual(NativeCloudResourcePolicy.presentation(for: .tabslide), .web)
    }

    func testDraftRoundTripKeepsBaseVersionAndUnsupportedRawNodes() throws {
        let storage = NativeTabDocDraftStore(store: UserDefaults(suiteName: UUID().uuidString)!)
        let draft = NativeTabDocDraft(
            title: "离线标题",
            body: NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([["type": "htmlBlock", "attrs": ["html": "<b>x</b>"]]]),
                ],
                markdownFallback: ""
            ),
            baseVersion: 12,
            baseUpdatedAt: "2026-08-12T09:00:00Z"
        )

        try storage.save(draft, documentId: "doc-1", userId: "user-1", organizationId: "org-1")
        let loaded = try XCTUnwrap(storage.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))

        XCTAssertEqual(loaded.title, "离线标题")
        XCTAssertEqual(loaded.baseVersion, 12)
        XCTAssertEqual(loaded.body.blocks.first?.kind, .unsupported(type: "htmlBlock"))
        XCTAssertEqual(loaded.body.blocks.first?.rawNode["attrs"]?.dictValue?["html"] as? String, "<b>x</b>")
    }

    func testDraftIdentityComponentsCannotCollide() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let storage = NativeTabDocDraftStore(store: defaults)
        let first = NativeTabDocDraft(
            title: "第一份",
            body: NativeTabDocBody(rootAttributes: ["type": AnyCodable("doc")], blocks: []),
            baseVersion: 1,
            baseUpdatedAt: nil
        )
        let second = NativeTabDocDraft(
            title: "第二份",
            body: NativeTabDocBody(rootAttributes: ["type": AnyCodable("doc")], blocks: []),
            baseVersion: 2,
            baseUpdatedAt: nil
        )

        try storage.save(first, documentId: "c", userId: "a_b", organizationId: "org")
        try storage.save(second, documentId: "b_c", userId: "a", organizationId: "org")

        XCTAssertEqual(storage.load(documentId: "c", userId: "a_b", organizationId: "org")?.title, "第一份")
        XCTAssertEqual(storage.load(documentId: "b_c", userId: "a", organizationId: "org")?.title, "第二份")
    }

    func testDraftStoreCanPurgeNativeTabDocDraftsOnLogout() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let storage = NativeTabDocDraftStore(store: defaults)
        let draft = NativeTabDocDraft(
            title: "敏感草稿",
            body: NativeTabDocBody(rootAttributes: ["type": AnyCodable("doc")], blocks: []),
            baseVersion: 1,
            baseUpdatedAt: nil
        )
        try storage.save(draft, documentId: "doc", userId: "user", organizationId: "org")
        defaults.set("keep", forKey: "unrelated")

        storage.removeAll()

        XCTAssertNil(storage.load(documentId: "doc", userId: "user", organizationId: "org"))
        XCTAssertEqual(defaults.string(forKey: "unrelated"), "keep")
    }

    func testSaveFailurePolicyRevalidatesWriteDenialsAndOnlyPurgesAfterDeniedRead() {
        XCTAssertEqual(NativeTabDocSaveFailurePolicy.resolve(APIError.serverError(409, nil)), .conflict)
        XCTAssertEqual(NativeTabDocSaveFailurePolicy.resolve(APIError.serverError(403, nil)), .permissionDenied)
        XCTAssertEqual(NativeTabDocSaveFailurePolicy.resolve(APIError.serverError(404, nil)), .resourceUnavailable)
        XCTAssertTrue(NativeTabDocSaveFailurePolicy.requiresDetailRevalidationAfterWriteFailure(
            APIError.serverError(403, nil)
        ))
        XCTAssertTrue(NativeTabDocSaveFailurePolicy.requiresDetailRevalidationAfterWriteFailure(
            APIError.serverError(404, nil)
        ))
        XCTAssertFalse(NativeTabDocSaveFailurePolicy.requiresDetailRevalidationAfterWriteFailure(
            APIError.serverError(409, nil)
        ))
        XCTAssertTrue(NativeTabDocSaveFailurePolicy.mustPurgeLocalDraftAfterReadFailure(
            APIError.serverError(403, nil)
        ))
        XCTAssertTrue(NativeTabDocSaveFailurePolicy.mustPurgeLocalDraftAfterReadFailure(
            APIError.serverError(404, nil)
        ))
        XCTAssertFalse(NativeTabDocSaveFailurePolicy.mustPurgeLocalDraftAfterReadFailure(
            APIError.serverError(409, nil)
        ))
        XCTAssertEqual(
            NativeTabDocSaveFailurePolicy.resolve(APIError.networkError(URLError(.notConnectedToInternet))),
            .retryable
        )
    }

    @MainActor
    func testWriteDenialRevalidationKeepsLocalDraftAndBecomesReadOnlyConflict() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "远端旧标题",
            text: "远端旧正文",
            version: 1,
            updatedAt: "2026-08-12T09:00:00Z",
            role: "editor"
        )
        let revalidated = detail(
            title: "远端新标题",
            text: "远端新正文",
            version: 2,
            updatedAt: "2026-08-12T09:05:00Z",
            role: "viewer"
        )
        var detailRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : revalidated
            },
            writeRequest: { _, _ in
                throw APIError.serverError(403, nil)
            }
        )

        await session.load()
        session.updateTitle("本地标题")
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "本地正文")

        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(detailRequestCount, 2)
        XCTAssertEqual(session.document?.currentUserRole, "viewer")
        XCTAssertEqual(session.document?.latestVersion, 2)
        XCTAssertEqual(session.title, "本地标题")
        XCTAssertEqual(session.body.blocks.first?.text, "本地正文")
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.saveError, L10n.TabDoc.conflictMessage)
        XCTAssertFalse(session.canEdit)
        let persisted = try XCTUnwrap(store.load(
            documentId: "doc-1",
            userId: "user-1",
            organizationId: "org-1"
        ))
        XCTAssertEqual(persisted.title, "本地标题")
        XCTAssertEqual(persisted.body.blocks.first?.text, "本地正文")
        XCTAssertEqual(persisted.baseVersion, 1)
        XCTAssertEqual(persisted.baseUpdatedAt, "2026-08-12T09:00:00Z")
    }

    @MainActor
    func testInitialDetailWithWrongDocumentIdRestoresPersistedDraftAndLocksConflict() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        try store.save(
            NativeTabDocDraft(
                title: "本地草稿标题",
                body: body(text: "本地草稿正文"),
                baseVersion: 3,
                baseUpdatedAt: "2026-08-12T09:00:00Z"
            ),
            documentId: "doc-1",
            userId: "user-1",
            organizationId: "org-1"
        )
        let wrongDetail = detail(
            documentId: "another-doc",
            title: "错误文档标题",
            text: "错误文档正文",
            version: 99,
            updatedAt: "2026-08-12T10:00:00Z",
            role: "owner"
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in wrongDetail }
        )

        await session.load()

        XCTAssertNil(session.document)
        XCTAssertEqual(session.title, "本地草稿标题")
        XCTAssertEqual(session.body.blocks.first?.text, "本地草稿正文")
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.saveError, L10n.TabDoc.conflictMessage)
        XCTAssertEqual(session.loadError, L10n.TabDoc.conflictMessage)
        XCTAssertFalse(session.canEdit)
        XCTAssertEqual(
            store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1")?.title,
            "本地草稿标题"
        )
    }

    @MainActor
    func testWriteDenialRevalidationRejectsWrongDocumentIdWithoutLosingDraft() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "远端标题",
            text: "远端正文",
            version: 1,
            updatedAt: "2026-08-12T09:00:00Z",
            role: "editor"
        )
        let wrongDetail = detail(
            documentId: "another-doc",
            title: "错误文档标题",
            text: "错误文档正文",
            version: 99,
            updatedAt: "2026-08-12T10:00:00Z",
            role: "owner"
        )
        var detailRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : wrongDetail
            },
            writeRequest: { _, _ in throw APIError.serverError(403, nil) }
        )

        await session.load()
        session.updateTitle("本地标题")

        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(detailRequestCount, 2)
        XCTAssertEqual(session.document?.id, "doc-1")
        XCTAssertEqual(session.document?.latestVersion, 1)
        XCTAssertEqual(session.title, "本地标题")
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.saveError, L10n.TabDoc.conflictMessage)
        XCTAssertFalse(session.canEdit)
        XCTAssertEqual(
            store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1")?.title,
            "本地标题"
        )
    }

    @MainActor
    func testWebResumeReloadRejectsWrongDocumentIdAndKeepsCurrentSnapshot() async throws {
        let initial = detail(
            title: "当前文档",
            text: "当前正文",
            version: 1,
            updatedAt: "2026-08-12T09:00:00Z",
            role: "editor"
        )
        let wrongDetail = detail(
            documentId: "another-doc",
            title: "错误文档",
            text: "错误正文",
            version: 2,
            updatedAt: "2026-08-12T10:00:00Z",
            role: "owner"
        )
        var detailRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : wrongDetail
            }
        )

        await session.load()
        await session.load()

        XCTAssertEqual(detailRequestCount, 2)
        XCTAssertEqual(session.document?.id, "doc-1")
        XCTAssertEqual(session.document?.title, "当前文档")
        XCTAssertEqual(session.title, "当前文档")
        XCTAssertEqual(session.body.blocks.first?.text, "当前正文")
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.loadError, L10n.TabDoc.conflictMessage)
        XCTAssertFalse(session.canEdit)
    }

    @MainActor
    func testSaveResponseWithWrongDocumentIdKeepsDraftAndLocksConflict() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "远端标题",
            text: "远端正文",
            version: 1,
            updatedAt: "2026-08-12T09:00:00Z",
            role: "editor"
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in initial },
            writeRequest: { _, _ in
                NativeTabDocWriteResponse(
                    document: NativeTabDocDocument(
                        id: "doc-from-another-response",
                        organizationId: "org-1",
                        spaceId: "space-1",
                        title: "错误文档标题",
                        latestVersion: 99,
                        updatedAt: "2026-08-12T10:00:00Z",
                        currentUserRole: "owner"
                    )
                )
            }
        )

        await session.load()
        session.updateTitle("本地标题")

        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(session.document?.id, "doc-1")
        XCTAssertEqual(session.title, "本地标题")
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.saveError, L10n.TabDoc.conflictMessage)
        XCTAssertFalse(session.canEdit)
        XCTAssertEqual(
            store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1")?.title,
            "本地标题"
        )
    }

    @MainActor
    func testSaveResponseFromAnotherOrganizationPurgesProtectedDraftAndContent() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "远端标题",
            text: "远端正文",
            version: 1,
            updatedAt: "2026-08-12T09:00:00Z",
            role: "editor"
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in initial },
            writeRequest: { _, _ in
                NativeTabDocWriteResponse(
                    document: NativeTabDocDocument(
                        id: "doc-1",
                        organizationId: "org-2",
                        spaceId: "space-2",
                        title: "越界标题",
                        latestVersion: 99,
                        updatedAt: "2026-08-12T10:00:00Z",
                        currentUserRole: "owner"
                    )
                )
            }
        )

        await session.load()
        session.updateTitle("本地敏感标题")

        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertNil(session.document)
        XCTAssertEqual(session.title, "")
        XCTAssertTrue(session.body.blocks.isEmpty)
        XCTAssertEqual(session.saveState, .permissionDenied)
        XCTAssertEqual(session.saveError, L10n.TabDoc.permissionMessage)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testDeniedDetailRevalidationPurgesProtectedDraftAndContent() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "远端标题",
            text: "远端正文",
            version: 1,
            updatedAt: "2026-08-12T09:00:00Z",
            role: "editor"
        )
        var detailRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                guard detailRequestCount == 1 else {
                    throw APIError.serverError(403, nil)
                }
                return initial
            },
            writeRequest: { _, _ in
                throw APIError.serverError(403, nil)
            }
        )

        await session.load()
        session.updateTitle("本地敏感标题")
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "本地敏感正文")

        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertNil(session.document)
        XCTAssertEqual(session.title, "")
        XCTAssertTrue(session.body.blocks.isEmpty)
        XCTAssertEqual(session.saveState, .permissionDenied)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testInvalidSessionFencePurgesPersistedDocumentDraft() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        try store.save(
            NativeTabDocDraft(
                title: "本地敏感标题",
                body: body(text: "本地敏感正文"),
                baseVersion: 1,
                baseUpdatedAt: "2026-08-12T09:00:00Z"
            ),
            documentId: "doc-1",
            userId: "user-1",
            organizationId: "org-1"
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { false }
        )

        XCTAssertFalse(session.validateSession())
        XCTAssertEqual(session.title, "")
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    func testRestoredDraftKeepsItsOwnBaselineAndDetectsRemoteAdvance() {
        let matching = NativeTabDocDraftBaselinePolicy.resolve(
            draftVersion: 7,
            draftUpdatedAt: "2026-08-12T09:00:00Z",
            remoteVersion: 7,
            remoteUpdatedAt: "2026-08-12T09:00:00Z"
        )
        XCTAssertEqual(matching, .resume(version: 7, updatedAt: "2026-08-12T09:00:00Z"))

        let advanced = NativeTabDocDraftBaselinePolicy.resolve(
            draftVersion: 7,
            draftUpdatedAt: "2026-08-12T09:00:00Z",
            remoteVersion: 8,
            remoteUpdatedAt: "2026-08-12T09:05:00Z"
        )
        XCTAssertEqual(advanced, .conflict(version: 7, updatedAt: "2026-08-12T09:00:00Z"))

        let timestampOnlyAdvance = NativeTabDocDraftBaselinePolicy.resolve(
            draftVersion: nil,
            draftUpdatedAt: "2026-08-12T09:00:00Z",
            remoteVersion: nil,
            remoteUpdatedAt: "2026-08-12T09:05:00Z"
        )
        XCTAssertEqual(timestampOnlyAdvance, .conflict(version: nil, updatedAt: "2026-08-12T09:00:00Z"))
    }

    @MainActor
    func testStaleDraftClearsWhenNewerRemoteIsItsCanonicalEquivalent() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let draftBody = body(text: "已同步正文")
        try store.save(
            NativeTabDocDraft(
                title: "验收文档",
                body: draftBody,
                baseVersion: 5,
                baseUpdatedAt: "2026-08-13T03:05:00Z"
            ),
            documentId: "doc-1",
            userId: "user-1",
            organizationId: "org-1"
        )
        let canonicalBody = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([[
                    "type": "paragraph",
                    "attrs": ["blockId": "server-block", "textAlign": NSNull()],
                    "content": [["type": "text", "text": "已同步正文"]],
                ]]),
            ],
            markdownFallback: ""
        )
        let remote = NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: "doc-1",
                organizationId: "org-1",
                spaceId: "space-1",
                title: "验收文档",
                latestVersion: 6,
                updatedAt: "2026-08-13T03:06:00Z",
                currentUserRole: "editor"
            ),
            content: NativeTabDocContent(
                descriptionJSON: canonicalBody.serializedJSON,
                descriptionMarkdown: canonicalBody.markdown,
                descriptionPlaintext: canonicalBody.plaintext
            )
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in remote }
        )

        await session.load()

        XCTAssertEqual(session.saveState, .saved)
        XCTAssertNil(session.saveError)
        XCTAssertEqual(session.document?.latestVersion, 6)
        XCTAssertEqual(session.body.blocks.first?.text, "已同步正文")
        XCTAssertNil(session.localDraftForRecovery)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    func testWholeDocumentNativeEditAllowsSafeBlocksBesideOpaqueBlocks() {
        let safe = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([
                    ["type": "heading", "attrs": ["level": 1], "content": [["type": "text", "text": "标题"]]],
                    ["type": "paragraph", "content": [["type": "text", "text": "正文"]]],
                ]),
            ],
            markdownFallback: ""
        )
        XCTAssertTrue(NativeTabDocEditPolicy.allowsWholeDocumentEdit(safe))

        var mixed = safe
        mixed.blocks.append(NativeTabDocBlock(
            kind: .unsupported(type: "tabdataEmbed"),
            rawNode: ["type": AnyCodable("tabdataEmbed")]
        ))
        XCTAssertTrue(NativeTabDocEditPolicy.allowsWholeDocumentEdit(mixed))

        let unsupportedOnly = NativeTabDocBody(
            rootAttributes: ["type": AnyCodable("doc")],
            blocks: [NativeTabDocBlock(
                kind: .unsupported(type: "tabdataEmbed"),
                rawNode: ["type": AnyCodable("tabdataEmbed")]
            )]
        )
        XCTAssertFalse(NativeTabDocEditPolicy.allowsWholeDocumentEdit(unsupportedOnly))
    }

    @MainActor
    func testSessionEditsSupportedSiblingAndPreservesUnsupportedBlockVerbatim() async throws {
        let paragraph: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "supported-1"],
            "content": [["type": "text", "text": "修改前"]],
        ]
        let embeddedTable: [String: Any] = [
            "type": "tabdataBlock",
            "attrs": [
                "blockId": "opaque-1",
                "tableId": "table-secret",
                "view": ["type": "gallery", "coverField": "attachment"],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([paragraph, embeddedTable]),
            ],
            markdownFallback: ""
        )
        let detail = NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: "mixed-doc",
                organizationId: "org-1",
                spaceId: "space-1",
                title: "混合文档",
                latestVersion: 1,
                updatedAt: "2026-08-15T09:00:00Z",
                currentUserRole: "editor"
            ),
            content: NativeTabDocContent(
                descriptionJSON: body.serializedJSON,
                descriptionMarkdown: body.markdown,
                descriptionPlaintext: body.plaintext
            )
        )
        var savedDraft: NativeTabDocDraft?
        let session = NativeTabDocSession(
            documentId: "mixed-doc",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: NativeTabDocDraftStore(
                store: UserDefaults(suiteName: UUID().uuidString)!
            ),
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in detail },
            writeRequest: { _, draft in
                savedDraft = draft
                return NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: "mixed-doc",
                    organizationId: "org-1",
                    spaceId: "space-1",
                    title: draft.title,
                    latestVersion: 2,
                    updatedAt: "2026-08-15T09:01:00Z",
                    currentUserRole: "editor"
                ))
            }
        )

        await session.load()

        XCTAssertTrue(session.canEdit)
        XCTAssertTrue(session.hasUnsupportedBlocks)
        XCTAssertEqual(session.body.blocks.map(\.kind), [
            .paragraph,
            .unsupported(type: "tabdataBlock"),
        ])
        let paragraphId = session.body.blocks[0].id
        let opaqueId = session.body.blocks[1].id
        session.updateBlock(id: paragraphId, text: "修改后")
        session.updateBlock(id: opaqueId, text: "不得覆盖")
        session.removeBlock(id: opaqueId)

        XCTAssertEqual(session.body.blocks.count, 2)
        XCTAssertEqual(session.body.blocks[0].text, "修改后")
        XCTAssertEqual(session.body.blocks[1].kind, .unsupported(type: "tabdataBlock"))
        let didSave = await session.save()
        XCTAssertTrue(didSave)

        let savedContent = try XCTUnwrap(
            savedDraft?.body.serializedJSON["content"]?.arrayValue as? [[String: Any]]
        )
        XCTAssertEqual(
            ((savedContent[0]["content"] as? [[String: Any]])?.first)?["text"] as? String,
            "修改后"
        )
        XCTAssertTrue(NSDictionary(dictionary: savedContent[1]).isEqual(to: embeddedTable))
    }

    func testUnsupportedBlockAlwaysHasTypeAndCanExposeReadableAttributePreview() {
        let block = NativeTabDocBlock(
            kind: .unsupported(type: "image"),
            rawNode: [
                "type": AnyCodable("image"),
                "attrs": AnyCodable(["alt": "季度结果图", "src": "https://example.com/result.png"]),
            ]
        )

        XCTAssertEqual(block.kind, .unsupported(type: "image"))
        XCTAssertEqual(block.readablePreview, "季度结果图")
    }

    func testFullEditorHandoffRequiresSaveOrExplicitDraftDiscard() {
        XCTAssertEqual(
            NativeTabDocFullEditorPolicy.preparation(isDirty: false, saveState: .saved),
            .open
        )
        XCTAssertEqual(
            NativeTabDocFullEditorPolicy.preparation(isDirty: true, saveState: .dirty),
            .saveFirst
        )
        XCTAssertEqual(
            NativeTabDocFullEditorPolicy.preparation(isDirty: true, saveState: .conflict),
            .confirmDiscard
        )
        XCTAssertEqual(
            NativeTabDocFullEditorPolicy.preparation(isDirty: true, saveState: .permissionDenied),
            .confirmDiscard
        )
    }

    func testRichTextSynchronizationDefersModelTrafficDuringIMEComposition() {
        XCTAssertFalse(NativeTabDocRichTextSynchronizationPolicy.shouldApplyIncoming(
            isApplyingChange: false,
            hasMarkedText: true,
            contentMatches: false
        ))
        XCTAssertFalse(NativeTabDocRichTextSynchronizationPolicy.shouldPublishChange(
            isApplyingChange: false,
            hasMarkedText: true
        ))

        XCTAssertTrue(NativeTabDocRichTextSynchronizationPolicy.shouldApplyIncoming(
            isApplyingChange: false,
            hasMarkedText: false,
            contentMatches: false
        ))
        XCTAssertTrue(NativeTabDocRichTextSynchronizationPolicy.shouldPublishChange(
            isApplyingChange: false,
            hasMarkedText: false
        ))
    }

    @MainActor
    func testRichTextMathematicsIdentitySurvivesVisualItalicAndArchive() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-archive",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let attributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [],
            mathematics: atom,
            style: .body,
            traitCollection: traits
        )
        XCTAssertNotNil(attributes[NativeTabDocRichTextMarkBridge.inlineMathematicsKey])
        let attributed = NSAttributedString(string: "E = mc^2", attributes: attributes)
        let archived = try NSKeyedArchiver.archivedData(
            withRootObject: attributed,
            requiringSecureCoding: false
        )
        let restored = try XCTUnwrap(
            NSKeyedUnarchiver.unarchiveTopLevelObjectWithData(archived) as? NSAttributedString
        )
        let spans = NativeTabDocRichTextMarkBridge.spans(from: restored, baseStyle: .body)
        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans.first?.text, "E = mc^2")
        XCTAssertEqual(spans.first?.mathematics?.atomId, "atom-archive")
        XCTAssertFalse(spans.first?.marks.contains { $0.kind == .italic } == true)
        XCTAssertFalse(spans.first?.marks.contains { $0.kind == .code } == true)
    }

    @MainActor
    func testSystemRTFRoundTripDropsMathematicsIdentity() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-rtf",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let attributed = NSAttributedString(
            string: "E = mc^2",
            attributes: NativeTabDocRichTextMarkBridge.attributes(
                for: [],
                mathematics: atom,
                style: .body,
                traitCollection: UITraitCollection(userInterfaceStyle: .light)
            )
        )
        let rtf = try attributed.data(
            from: NSRange(location: 0, length: attributed.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]
        )
        let restored = try NSAttributedString(
            data: rtf,
            options: [.documentType: NSAttributedString.DocumentType.rtf],
            documentAttributes: nil
        )
        XCTAssertNil(
            NativeTabDocRichTextMarkBridge.mathematics(
                from: restored.attributes(at: 0, effectiveRange: nil)
            ),
            "系统 RTF 复制不能带走公式身份，必须走自定义剪贴板"
        )
    }

    @MainActor
    func testRichTextPasteboardKeepsMathematicsAndRenewsAtom() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-copy",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let spans = [
            NativeTabDocInlineSpan(text: "质能方程 "),
            NativeTabDocInlineSpan(text: "E = mc^2", mathematics: atom),
            NativeTabDocInlineSpan(text: "。"),
        ]
        let data = try NativeTabDocRichTextPasteboard.encodedSpans(spans)
        let restored = try NativeTabDocRichTextPasteboard.decodedSpans(
            from: data,
            renewingMathematics: true
        )
        XCTAssertEqual(restored.map(\.text), spans.map(\.text))
        XCTAssertEqual(restored[1].mathematics?.nodeType, "mathematics")
        XCTAssertNotEqual(restored[1].mathematics?.atomId, "atom-copy")
        let block = NativeTabDocBlock(kind: .paragraph, spans: restored)
        let content = try XCTUnwrap(block.serializedNode["content"] as? [[String: Any]])
        XCTAssertEqual(content.map { $0["type"] as? String }, ["text", "mathematics", "text"])
        XCTAssertEqual((content[1]["attrs"] as? [String: Any])?["latex"] as? String, "E = mc^2")
    }

    @MainActor
    func testRichTextCopyPasteInsideEditorKeepsMathematicsNode() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-editor",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let attributed = NSMutableAttributedString()
        attributed.append(NSAttributedString(
            string: "前",
            attributes: NativeTabDocRichTextMarkBridge.attributes(
                for: [],
                style: .body,
                traitCollection: traits
            )
        ))
        attributed.append(NSAttributedString(
            string: "E = mc^2",
            attributes: NativeTabDocRichTextMarkBridge.attributes(
                for: [],
                mathematics: atom,
                style: .body,
                traitCollection: traits
            )
        ))
        attributed.append(NSAttributedString(
            string: "后",
            attributes: NativeTabDocRichTextMarkBridge.attributes(
                for: [],
                style: .body,
                traitCollection: traits
            )
        ))
        let textView = NativeTabDocUITextView()
        textView.attributedText = attributed
        textView.selectedRange = NSRange(location: 0, length: attributed.length)
        let previousItems = UIPasteboard.general.items
        defer { UIPasteboard.general.items = previousItems }
        NativeTabDocRichTextPasteboard.copySelection(from: textView)
        textView.selectedRange = NSRange(location: attributed.length, length: 0)
        // 真机 XCTest 进程里系统剪贴板会短暂不可用，那是环境问题而非产品回归
        guard NativeTabDocRichTextPasteboard.paste(
            into: textView,
            style: .body,
            textAlignment: .natural,
            traitCollection: traits
        ) else {
            throw XCTSkip("系统剪贴板当前不可用，跳过复制粘贴回归")
        }
        let spans = NativeTabDocRichTextMarkBridge.spans(
            from: textView.attributedText,
            baseStyle: .body
        )
        let formulas = spans.compactMap(\.mathematics)
        XCTAssertEqual(formulas.count, 2)
        guard formulas.count == 2 else { return }
        XCTAssertNotEqual(formulas[0].atomId, formulas[1].atomId)
        let block = NativeTabDocBlock(kind: .paragraph, spans: spans)
        let types = (block.serializedNode["content"] as? [[String: Any]])?.compactMap { $0["type"] as? String }
        XCTAssertEqual(types?.filter { $0 == "mathematics" }.count, 2)
    }

    @MainActor
    func testRichTextCaretInheritsMathematicsOnlyInsideAtom() throws {
        let atom = NativeTabDocInlineMathematics(
            atomId: "atom-caret",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["display": AnyCodable(false)]
        )
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let formula = NativeTabDocRichTextMarkBridge.attributes(
            for: [],
            mathematics: atom,
            style: .body,
            traitCollection: traits
        )
        let plain = NativeTabDocRichTextMarkBridge.attributes(
            for: [],
            style: .body,
            traitCollection: traits
        )
        let attributed = NSMutableAttributedString()
        attributed.append(NSAttributedString(string: "前", attributes: plain))
        attributed.append(NSAttributedString(string: "ab", attributes: formula))
        attributed.append(NSAttributedString(string: "后", attributes: plain))
        let textView = UITextView()
        textView.attributedText = attributed
        let parent = NativeTabDocRichTextView(
            spans: [
                NativeTabDocInlineSpan(text: "前"),
                NativeTabDocInlineSpan(text: "ab", mathematics: atom),
                NativeTabDocInlineSpan(text: "后"),
            ],
            isEditable: true,
            style: .body,
            placeholder: "",
            onChange: { _ in },
            onFocusChange: { _ in }
        )
        let coordinator = parent.makeCoordinator()
        coordinator.textView = textView

        textView.selectedRange = NSRange(location: 1, length: 0)
        coordinator.textViewDidChangeSelection(textView)
        XCTAssertNil(NativeTabDocRichTextMarkBridge.mathematics(from: textView.typingAttributes))

        textView.selectedRange = NSRange(location: 2, length: 0)
        coordinator.textViewDidChangeSelection(textView)
        XCTAssertEqual(
            NativeTabDocRichTextMarkBridge.mathematics(from: textView.typingAttributes)?.atomId,
            "atom-caret"
        )

        textView.selectedRange = NSRange(location: 3, length: 0)
        coordinator.textViewDidChangeSelection(textView)
        XCTAssertNil(NativeTabDocRichTextMarkBridge.mathematics(from: textView.typingAttributes))
    }

    @MainActor
    func testRichTextMarkBridgePreservesColorAndScriptIdentityThroughTyping() throws {
        let cases: [(mark: NativeTabDocInlineMark, visualKey: NSAttributedString.Key)] = [
            (
                NativeTabDocInlineMark(
                    kind: .textStyle,
                    rawNode: [
                        "type": AnyCodable("textStyle"),
                        "attrs": AnyCodable(["color": "#E5484D"]),
                    ]
                ),
                .foregroundColor
            ),
            (
                NativeTabDocInlineMark(
                    kind: .highlight,
                    rawNode: [
                        "type": AnyCodable("highlight"),
                        "attrs": AnyCodable(["color": "#FDE68A"]),
                    ]
                ),
                .backgroundColor
            ),
            (.canonical(.subscript), .baselineOffset),
            (.canonical(.superscript), .baselineOffset),
        ]
        let traits = UITraitCollection(userInterfaceStyle: .light)

        for testCase in cases {
            let attributes = NativeTabDocRichTextMarkBridge.attributes(
                for: [.canonical(.bold), testCase.mark],
                style: .body,
                traitCollection: traits
            )
            XCTAssertNotNil(attributes[testCase.visualKey], "目标 mark 必须产生可见排版属性")

            let textView = UITextView()
            textView.attributedText = NSAttributedString(string: "A", attributes: attributes)
            textView.selectedRange = NSRange(location: textView.attributedText.length, length: 0)
            textView.typingAttributes = attributes
            textView.insertText("已编辑")
            let spans = NativeTabDocRichTextMarkBridge.spans(
                from: textView.attributedText,
                baseStyle: .body
            )

            XCTAssertEqual(spans.count, 1)
            XCTAssertEqual(spans.first?.text, "A已编辑")
            XCTAssertEqual(spans.first?.marks, [.canonical(.bold), testCase.mark])
        }

        let ordinaryVisualAttributes: [NSAttributedString.Key: Any] = [
            .font: NativeTabDocRichTextStyle.body.scaledFont(),
            .foregroundColor: UIColor.red,
            .backgroundColor: UIColor.yellow,
            .baselineOffset: 3,
        ]
        let ordinarySpans = NativeTabDocRichTextMarkBridge.spans(
            from: NSAttributedString(string: "普通排版", attributes: ordinaryVisualAttributes),
            baseStyle: .body
        )
        XCTAssertTrue(
            ordinarySpans.first?.marks.allSatisfy {
                ![.textStyle, .highlight, .subscript, .superscript].contains($0.kind)
            } == true,
            "没有 TabDoc 身份元数据的 UIKit 颜色或基线不能被猜成业务 mark"
        )
    }

    @MainActor
    func testRichTextSelectionRestoresMarkIdentityAfterUIKitReset() throws {
        let textStyle = NativeTabDocInlineMark(
            kind: .textStyle,
            rawNode: [
                "type": AnyCodable("textStyle"),
                "attrs": AnyCodable(["color": "#E5484D"]),
            ]
        )
        let originalMarks: [NativeTabDocInlineMark] = [.canonical(.bold), textStyle]
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let markedAttributes = NativeTabDocRichTextMarkBridge.attributes(
            for: originalMarks,
            style: .body,
            textAlignment: .right,
            traitCollection: traits
        )
        let textView = UITextView()
        textView.attributedText = NSAttributedString(string: "AB", attributes: markedAttributes)
        textView.selectedRange = NSRange(location: 1, length: 0)
        textView.typingAttributes = [
            .font: NativeTabDocRichTextStyle.body.scaledFont(),
            .foregroundColor: UIColor.black,
        ]
        let parent = NativeTabDocRichTextView(
            spans: [NativeTabDocInlineSpan(text: "AB", marks: originalMarks)],
            isEditable: true,
            style: .body,
            textAlignment: .right,
            placeholder: "",
            onChange: { _ in },
            onFocusChange: { _ in }
        )
        let coordinator = parent.makeCoordinator()

        coordinator.textViewDidChangeSelection(textView)
        XCTAssertEqual(
            (textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.alignment,
            .right
        )
        textView.insertText("新")
        let spans = NativeTabDocRichTextMarkBridge.spans(
            from: textView.attributedText,
            baseStyle: .body
        )

        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans.first?.text, "A新B")
        XCTAssertEqual(spans.first?.marks, originalMarks)
        XCTAssertEqual(
            (textView.attributedText.attribute(
                .paragraphStyle,
                at: 1,
                effectiveRange: nil
            ) as? NSParagraphStyle)?.alignment,
            .right
        )
    }

    @MainActor
    func testRichTextIncomingUpdateRestoresMarkIdentityForActiveEditor() throws {
        let highlight = NativeTabDocInlineMark(
            kind: .highlight,
            rawNode: [
                "type": AnyCodable("highlight"),
                "attrs": AnyCodable(["color": "#FDE68A"]),
            ]
        )
        let originalMarks: [NativeTabDocInlineMark] = [.canonical(.italic), highlight]
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let markedAttributes = NativeTabDocRichTextMarkBridge.attributes(
            for: originalMarks,
            style: .body,
            textAlignment: .center,
            traitCollection: traits
        )
        let textView = UITextView()
        textView.attributedText = NSAttributedString(string: "AB", attributes: markedAttributes)
        textView.selectedRange = NSRange(location: 1, length: 0)
        textView.typingAttributes = [
            .font: NativeTabDocRichTextStyle.body.scaledFont(),
            .foregroundColor: UIColor.black,
        ]
        let parent = NativeTabDocRichTextView(
            spans: [NativeTabDocInlineSpan(text: "AB", marks: originalMarks)],
            isEditable: true,
            style: .body,
            textAlignment: .center,
            placeholder: "",
            onChange: { _ in },
            onFocusChange: { _ in }
        )
        let coordinator = parent.makeCoordinator()
        coordinator.isApplyingChange = true

        coordinator.didApplyIncoming(to: textView)
        XCTAssertFalse(coordinator.isApplyingChange)
        XCTAssertEqual(textView.selectedRange, NSRange(location: 1, length: 0))
        XCTAssertEqual(
            (textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.alignment,
            .center
        )
        textView.insertText("新")
        let spans = NativeTabDocRichTextMarkBridge.spans(
            from: textView.attributedText,
            baseStyle: .body
        )

        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans.first?.text, "A新B")
        XCTAssertEqual(spans.first?.marks, originalMarks)
    }

    @MainActor
    func testRichTextEmptyEditorSeedsAlignmentBeforeFirstCharacter() {
        let parent = NativeTabDocRichTextView(
            spans: [],
            isEditable: true,
            style: .body,
            textAlignment: .justify,
            placeholder: "",
            onChange: { _ in },
            onFocusChange: { _ in }
        )
        let coordinator = parent.makeCoordinator()
        let textView = UITextView()
        textView.attributedText = NSAttributedString()
        textView.selectedRange = NSRange(location: 0, length: 0)

        coordinator.textViewDidBeginEditing(textView)

        XCTAssertEqual(
            (textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.alignment,
            .justified
        )
        textView.insertText("首字")
        XCTAssertEqual(
            (textView.attributedText.attribute(
                .paragraphStyle,
                at: 0,
                effectiveRange: nil
            ) as? NSParagraphStyle)?.alignment,
            .justified
        )
    }

    @MainActor
    func testRichTextLinkDecorationDoesNotCreateAnUnderlineMark() {
        let link = NativeTabDocInlineMark.canonical(
            .link,
            href: "https://tabtin.example.com/docs"
        )
        let attributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [link],
            style: .body,
            traitCollection: UITraitCollection(userInterfaceStyle: .light)
        )
        let spans = NativeTabDocRichTextMarkBridge.spans(
            from: NSAttributedString(string: "链接", attributes: attributes),
            baseStyle: .body
        )

        XCTAssertEqual(spans.first?.marks, [link])

        let explicitlyUnderlined = NativeTabDocRichTextMarkBridge.attributes(
            for: [.canonical(.underline), link],
            style: .body,
            traitCollection: UITraitCollection(userInterfaceStyle: .light)
        )
        let underlinedSpans = NativeTabDocRichTextMarkBridge.spans(
            from: NSAttributedString(string: "下划线链接", attributes: explicitlyUnderlined),
            baseStyle: .body
        )
        XCTAssertEqual(underlinedSpans.first?.marks, [.canonical(.underline), link])

        let textStyle = NativeTabDocInlineMark(
            kind: .textStyle,
            rawNode: [
                "type": AnyCodable("textStyle"),
                "attrs": AnyCodable(["color": "#E5484D"]),
            ]
        )
        let styledLink = NativeTabDocRichTextMarkBridge.attributes(
            for: [link, textStyle],
            style: .body,
            traitCollection: UITraitCollection(userInterfaceStyle: .light)
        )
        let styledLinkSpans = NativeTabDocRichTextMarkBridge.spans(
            from: NSAttributedString(string: "红色链接", attributes: styledLink),
            baseStyle: .body
        )
        XCTAssertEqual(styledLinkSpans.first?.marks, [link, textStyle])

        for href in ["javascript:alert(1)", "/docs/relative"] {
            let nonInteractiveLink = NativeTabDocInlineMark.canonical(.link, href: href)
            let nonInteractiveAttributes = NativeTabDocRichTextMarkBridge.attributes(
                for: [nonInteractiveLink],
                style: .body,
                traitCollection: UITraitCollection(userInterfaceStyle: .light)
            )
            XCTAssertNil(nonInteractiveAttributes[.link], "不安全或相对地址不得成为可点击链接")
            let nonInteractiveSpans = NativeTabDocRichTextMarkBridge.spans(
                from: NSAttributedString(string: "原样保留", attributes: nonInteractiveAttributes),
                baseStyle: .body
            )
            XCTAssertEqual(nonInteractiveSpans.first?.marks, [nonInteractiveLink])
        }
    }

    @MainActor
    func testRichTextColorAndScriptVisualValuesMatchTheirSemantics() throws {
        let textColor = NativeTabDocInlineMark(
            kind: .textStyle,
            rawNode: [
                "type": AnyCodable("textStyle"),
                "attrs": AnyCodable(["color": "#E5484D"]),
            ]
        )
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let colorAttributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [textColor],
            style: .body,
            traitCollection: traits
        )
        let color = try XCTUnwrap(colorAttributes[.foregroundColor] as? UIColor)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(color.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
        XCTAssertEqual(red, 0xE5 / 255.0, accuracy: 0.001)
        XCTAssertEqual(green, 0x48 / 255.0, accuracy: 0.001)
        XCTAssertEqual(blue, 0x4D / 255.0, accuracy: 0.001)
        XCTAssertEqual(alpha, 1, accuracy: 0.001)

        let subscriptAttributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [.canonical(.subscript)],
            style: .body,
            traitCollection: traits
        )
        let superscriptAttributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [.canonical(.superscript)],
            style: .body,
            traitCollection: traits
        )
        XCTAssertLessThan(try XCTUnwrap(subscriptAttributes[.baselineOffset] as? CGFloat), 0)
        XCTAssertGreaterThan(try XCTUnwrap(superscriptAttributes[.baselineOffset] as? CGFloat), 0)
    }

    func testTableCellPreviewRendersCanonicalBoldMark() throws {
        let spans = [
            NativeTabDocInlineSpan(text: "加粗备注", marks: [.canonical(.bold)]),
        ]
        XCTAssertTrue(NativeTabDocTableCellPreviewTypography.usesAttributedPreview(spans))
        let attributed = NativeTabDocTableCellPreviewTypography.attributedString(
            spans: spans,
            style: .body,
            textAlignment: .natural,
            traitCollection: UITraitCollection(userInterfaceStyle: .light)
        )
        var sawBold = false
        attributed.enumerateAttribute(
            .font,
            in: NSRange(location: 0, length: attributed.length),
            options: []
        ) { value, _, _ in
            guard let font = value as? UIFont else { return }
            if font.fontDescriptor.symbolicTraits.contains(.traitBold) {
                sawBold = true
            }
        }
        XCTAssertTrue(sawBold, "表格网格预览必须把 bold mark 画成加粗，不能只剩纯文本")
        XCTAssertFalse(
            NativeTabDocTableCellPreviewTypography.usesAttributedPreview(
                [NativeTabDocInlineSpan(text: "普通格子")]
            )
        )
    }

    func testRichTextAccessoryOnlyAddsHomeIndicatorInsetWhenDockedToViewportBottom() {
        XCTAssertEqual(
            NativeTabDocInputAccessoryLayout.bottomSafeAreaInset(
                accessoryMaxY: 874,
                viewportMaxY: 874,
                safeAreaBottom: 34
            ),
            34
        )
        XCTAssertEqual(
            NativeTabDocInputAccessoryLayout.bottomSafeAreaInset(
                accessoryMaxY: 540,
                viewportMaxY: 874,
                safeAreaBottom: 34
            ),
            0
        )
    }

    func testCloudResourceOrganizationBoundaryRejectsCrossTenantResponse() {
        XCTAssertTrue(NativeCloudOrganizationBoundary.matches(
            resourceOrganizationId: "org-1",
            expectedOrganizationId: "org-1"
        ))
        XCTAssertFalse(NativeCloudOrganizationBoundary.matches(
            resourceOrganizationId: nil,
            expectedOrganizationId: "org-1"
        ))
        XCTAssertFalse(NativeCloudOrganizationBoundary.matches(
            resourceOrganizationId: "",
            expectedOrganizationId: "org-1"
        ))
        XCTAssertFalse(NativeCloudOrganizationBoundary.matches(
            resourceOrganizationId: "org-1",
            expectedOrganizationId: ""
        ))
        XCTAssertFalse(NativeCloudOrganizationBoundary.matches(
            resourceOrganizationId: "org-2",
            expectedOrganizationId: "org-1"
        ))
    }

    func testCloudSessionFenceRejectsLogoutAccountOrganizationAndGenerationChanges() {
        let fence = NativeCloudSessionFence(
            userId: "user-1",
            generation: 7,
            organizationId: "org-1"
        )
        XCTAssertTrue(fence.matches(
            userId: "user-1",
            generation: 7,
            organizationId: "org-1"
        ))
        XCTAssertFalse(fence.matches(
            userId: nil,
            generation: 7,
            organizationId: "org-1"
        ))
        XCTAssertFalse(fence.matches(
            userId: "user-2",
            generation: 7,
            organizationId: "org-1"
        ))
        XCTAssertFalse(fence.matches(
            userId: "user-1",
            generation: 8,
            organizationId: "org-1"
        ))
        XCTAssertFalse(fence.matches(
            userId: "user-1",
            generation: 7,
            organizationId: nil
        ))
        XCTAssertFalse(fence.matches(
            userId: "user-1",
            generation: 7,
            organizationId: "org-2"
        ))
    }

    func testSaveCommitPolicyKeepsEditsMadeAfterRequestSnapshot() {
        let snapshot = NativeTabDocDraft(
            title: "请求时标题",
            body: body(text: "请求时正文"),
            baseVersion: 1,
            baseUpdatedAt: nil
        )

        XCTAssertFalse(NativeTabDocSaveCommitPolicy.hasEditsAfterSnapshot(
            currentTitle: "请求时标题",
            currentBody: body(text: "请求时正文"),
            snapshot: snapshot
        ))
        XCTAssertTrue(NativeTabDocSaveCommitPolicy.hasEditsAfterSnapshot(
            currentTitle: "请求期间新标题",
            currentBody: body(text: "请求时正文"),
            snapshot: snapshot
        ))
        XCTAssertTrue(NativeTabDocSaveCommitPolicy.hasEditsAfterSnapshot(
            currentTitle: "请求时标题",
            currentBody: body(text: "请求期间新正文"),
            snapshot: snapshot
        ))
    }

    func testFlushRequiresStableSavedStateWithoutRequestInFlight() {
        XCTAssertTrue(NativeTabDocSaveCommitPolicy.canFinishFlush(
            isDirty: false,
            saveState: .saved,
            hasSaveInFlight: false
        ))
        XCTAssertFalse(NativeTabDocSaveCommitPolicy.canFinishFlush(
            isDirty: true,
            saveState: .dirty,
            hasSaveInFlight: false
        ))
        XCTAssertFalse(NativeTabDocSaveCommitPolicy.canFinishFlush(
            isDirty: false,
            saveState: .saving,
            hasSaveInFlight: true
        ))
    }

    func testConflictRebaseComparisonIgnoresGeneratedIdsAndSchemaDefaults() {
        let committed = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([[
                    "type": "paragraph",
                    "content": [["type": "text", "text": "正文"]],
                ]]),
            ],
            markdownFallback: ""
        )
        let serverStamped = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([[
                    "type": "paragraph",
                    "attrs": [
                        "blockId": "server-generated",
                        "textAlign": NSNull(),
                    ],
                    "content": [["type": "text", "text": "正文"]],
                ]]),
            ],
            markdownFallback: ""
        )
        let unknownAttributeChanged = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([[
                    "type": "paragraph",
                    "attrs": ["blockId": "server-generated", "source": "collaborator"],
                    "content": [["type": "text", "text": "正文"]],
                ]]),
            ],
            markdownFallback: ""
        )

        XCTAssertTrue(NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle: "标题",
            remoteBody: serverStamped,
            committedTitle: "标题",
            committedBody: committed
        ))
        XCTAssertFalse(NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle: "另一个标题",
            remoteBody: serverStamped,
            committedTitle: "标题",
            committedBody: committed
        ))
        XCTAssertFalse(NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle: "标题",
            remoteBody: unknownAttributeChanged,
            committedTitle: "标题",
            committedBody: committed
        ))
    }

    func testConflictRebaseComparisonIgnoresOnlyKnownSchemaDefaultValues() throws {
        let committed = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([
                    [
                        "type": "codeBlock",
                        "content": [["type": "text", "text": "let value = 1"]],
                    ],
                    [
                        "type": "taskList",
                        "content": [[
                            "type": "taskItem",
                            "attrs": ["checked": false],
                            "content": [[
                                "type": "paragraph",
                                "content": [["type": "text", "text": "待办"]],
                            ]],
                        ]],
                    ],
                    [
                        "type": "table",
                        "content": [[
                            "type": "tableRow",
                            "content": [[
                                "type": "tableCell",
                                "content": [[
                                    "type": "paragraph",
                                    "content": [["type": "text", "text": "单元格"]],
                                ]],
                            ]],
                        ]],
                    ],
                ]),
            ],
            markdownFallback: ""
        )
        let serverCanonicalized = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([
                    [
                        "type": "codeBlock",
                        "attrs": ["blockId": "code-1", "language": NSNull()],
                        "content": [["type": "text", "text": "let value = 1"]],
                    ],
                    [
                        "type": "taskList",
                        "attrs": ["blockId": "tasks-1"],
                        "content": [[
                            "type": "taskItem",
                            "attrs": [
                                "blockId": "task-1",
                                "checked": false,
                                "todoId": NSNull(),
                            ],
                            "content": [[
                                "type": "paragraph",
                                "attrs": ["blockId": "task-paragraph-1", "textAlign": NSNull()],
                                "content": [["type": "text", "text": "待办"]],
                            ]],
                        ]],
                    ],
                    [
                        "type": "table",
                        "attrs": ["blockId": "table-1"],
                        "content": [[
                            "type": "tableRow",
                            "content": [[
                                "type": "tableCell",
                                "attrs": ["colspan": 1, "rowspan": 1, "colwidth": NSNull()],
                                "content": [[
                                    "type": "paragraph",
                                    "attrs": ["blockId": "cell-paragraph-1", "textAlign": NSNull()],
                                    "content": [["type": "text", "text": "单元格"]],
                                ]],
                            ]],
                        ]],
                    ],
                ]),
            ],
            markdownFallback: ""
        )

        XCTAssertTrue(NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle: "标题",
            remoteBody: serverCanonicalized,
            committedTitle: "标题",
            committedBody: committed
        ))

        var semanticChange = serverCanonicalized
        var changedTable = try XCTUnwrap(semanticChange.blocks[2].table)
        changedTable.rows[0].cells[0].rawCell["colspan"] = AnyCodable(2)
        semanticChange.blocks[2].table = changedTable
        XCTAssertFalse(NativeTabDocConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle: "标题",
            remoteBody: semanticChange,
            committedTitle: "标题",
            committedBody: committed
        ))
    }

    @MainActor
    func testInFlightSaveKeepsNewerEditAndUsesAcknowledgedVersionNext() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "验收文档",
            text: "初始正文",
            version: 1,
            updatedAt: "2026-08-14T10:00:00Z",
            role: "editor"
        )
        let firstWriteStarted = expectation(description: "first write reached server")
        var releaseFirstWrite: CheckedContinuation<Void, Never>?
        var writeRequestCount = 0
        var requestedBaseVersions: [Int?] = []
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in initial },
            writeRequest: { _, draft in
                writeRequestCount += 1
                requestedBaseVersions.append(draft.baseVersion)
                let nextVersion = writeRequestCount + 1
                if writeRequestCount == 1 {
                    firstWriteStarted.fulfill()
                    await withCheckedContinuation { continuation in
                        releaseFirstWrite = continuation
                    }
                }
                return NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: "doc-1",
                    organizationId: "org-1",
                    spaceId: "space-1",
                    title: draft.title,
                    latestVersion: nextVersion,
                    updatedAt: "2026-08-14T10:00:0\(nextVersion)Z",
                    currentUserRole: "editor"
                ))
            }
        )

        await session.load()
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "第一次编辑")
        let firstSaveTask = Task { await session.save() }
        await fulfillment(of: [firstWriteStarted], timeout: 1)

        session.updateBlock(id: blockId, text: "第二次编辑")
        try XCTUnwrap(releaseFirstWrite).resume()
        let firstSaved = await firstSaveTask.value
        let flushed = await session.flush()

        XCTAssertTrue(firstSaved)
        XCTAssertTrue(flushed)
        XCTAssertEqual(requestedBaseVersions, [1, 2])
        XCTAssertEqual(session.document?.latestVersion, 3)
        XCTAssertEqual(session.body.blocks.first?.text, "第二次编辑")
        XCTAssertEqual(session.saveState, .saved)
    }

    @MainActor
    func testLostSaveResponseRebasesAgainstUnacknowledgedSnapshot() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "验收文档",
            text: "初始正文",
            version: 1,
            updatedAt: "2026-08-14T11:00:00Z",
            role: "editor"
        )
        var remote = initial
        var detailRequestCount = 0
        var writeRequestCount = 0
        var requestedBaseVersions: [Int?] = []
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : remote
            },
            writeRequest: { _, draft in
                writeRequestCount += 1
                requestedBaseVersions.append(draft.baseVersion)
                switch writeRequestCount {
                case 1:
                    remote = self.detail(
                        title: draft.title,
                        text: draft.body.blocks.first?.text ?? "",
                        version: 2,
                        updatedAt: "2026-08-14T11:00:01Z",
                        role: "editor"
                    )
                    throw APIError.networkError(URLError(.networkConnectionLost))
                case 2:
                    throw APIError.serverError(409, "当前版本 2，提交版本 1")
                default:
                    XCTAssertEqual(draft.baseVersion, 2)
                    remote = self.detail(
                        title: draft.title,
                        text: draft.body.blocks.first?.text ?? "",
                        version: 3,
                        updatedAt: "2026-08-14T11:00:02Z",
                        role: "editor"
                    )
                    return NativeTabDocWriteResponse(document: remote.document)
                }
            }
        )

        await session.load()
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "第一次编辑")
        let firstSaved = await session.save()
        XCTAssertFalse(firstSaved)
        XCTAssertEqual(session.saveState, .failed)

        session.updateBlock(id: blockId, text: "第二次编辑")
        let saved = await session.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(detailRequestCount, 2)
        XCTAssertEqual(requestedBaseVersions, [1, 1, 2])
        XCTAssertEqual(session.document?.latestVersion, 3)
        XCTAssertEqual(session.body.blocks.first?.text, "第二次编辑")
        XCTAssertEqual(session.saveState, .saved)
        XCTAssertNil(session.saveError)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testVersionConflictRebasesAndRetriesWhenRemoteStillMatchesLastCommittedSnapshot() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "验收文档",
            text: "初始正文",
            version: 3,
            updatedAt: "2026-08-13T03:00:00Z",
            role: "editor"
        )
        let equivalentRemoteAdvance = detail(
            title: "验收文档",
            text: "已提交正文",
            version: 5,
            updatedAt: "2026-08-13T03:02:00Z",
            role: "editor"
        )
        var detailRequestCount = 0
        var writeRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : equivalentRemoteAdvance
            },
            writeRequest: { _, draft in
                writeRequestCount += 1
                if writeRequestCount == 2 {
                    throw APIError.serverError(409, "当前版本 5，提交版本 4")
                }
                let nextVersion = writeRequestCount == 1 ? 4 : 6
                return NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: "doc-1",
                    organizationId: "org-1",
                    spaceId: "space-1",
                    title: draft.title,
                    latestVersion: nextVersion,
                    updatedAt: "2026-08-13T03:0\(nextVersion):00Z",
                    currentUserRole: "editor"
                ))
            }
        )

        await session.load()
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "已提交正文")
        let firstSaveSucceeded = await session.save()
        XCTAssertTrue(firstSaveSucceeded)
        session.updateBlock(id: blockId, text: "冲突期间继续编辑")

        let saved = await session.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(detailRequestCount, 2)
        XCTAssertEqual(writeRequestCount, 3)
        XCTAssertEqual(session.document?.latestVersion, 6)
        XCTAssertEqual(session.body.blocks.first?.text, "冲突期间继续编辑")
        XCTAssertEqual(session.saveState, .saved)
        XCTAssertNil(session.saveError)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testVersionConflictDoesNotRetryWhenRemoteContentReallyChanged() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "验收文档",
            text: "共同基线",
            version: 4,
            updatedAt: "2026-08-13T03:00:00Z",
            role: "editor"
        )
        let collaboratorEdit = detail(
            title: "验收文档",
            text: "协作者的新正文",
            version: 5,
            updatedAt: "2026-08-13T03:02:00Z",
            role: "editor"
        )
        var detailRequestCount = 0
        var writeRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : collaboratorEdit
            },
            writeRequest: { _, _ in
                writeRequestCount += 1
                throw APIError.serverError(409, "当前版本 5，提交版本 4")
            }
        )

        await session.load()
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "本地草稿")

        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(detailRequestCount, 2)
        XCTAssertEqual(writeRequestCount, 1)
        XCTAssertEqual(session.body.blocks.first?.text, "本地草稿")
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.saveError, L10n.TabDoc.conflictMessage)
        XCTAssertNotNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testDiscardingConflictDraftReloadsRemoteContentAndClearsLocalDraft() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "验收文档",
            text: "共同基线",
            version: 4,
            updatedAt: "2026-08-13T03:00:00Z",
            role: "editor"
        )
        let collaboratorEdit = detail(
            title: "验收文档",
            text: "协作者的新正文",
            version: 5,
            updatedAt: "2026-08-13T03:02:00Z",
            role: "editor"
        )
        var detailRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : collaboratorEdit
            },
            writeRequest: { _, _ in
                throw APIError.serverError(409, "当前版本 5，提交版本 4")
            }
        )

        await session.load()
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "本地草稿")
        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(session.body.blocks.first?.text, "本地草稿")
        XCTAssertEqual(session.saveState, .conflict)

        await session.discardConflictingDraftAndReload()

        XCTAssertEqual(session.body.blocks.first?.text, "协作者的新正文")
        XCTAssertEqual(session.document?.latestVersion, 5)
        XCTAssertEqual(session.saveState, .saved)
        XCTAssertNil(session.saveError)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    func testVersionHistoryTitleUsesProductLanguageInsteadOfRecordId() {
        let title = NativeTabDocVersionHistoryPresentation.entryTitle(
            id: "internal-history-record-id",
            name: "",
            createdAt: nil,
            isSnapshot: false,
            snapshotLabel: "Snapshot",
            historyVersionLabel: "History version"
        )

        XCTAssertEqual(title, "History version")
        XCTAssertFalse(title.contains("internal-history-record-id"))
        XCTAssertFalse(title.contains("internal"))
    }

    @MainActor
    func testSessionLoadsVersionHistoryFromCollabEntries() async throws {
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detail(
                    title: "验收文档",
                    text: "共同基线",
                    version: 4,
                    updatedAt: "2026-08-13T03:00:00Z",
                    role: "editor"
                )
            },
            writeRequest: { _, _ in
                throw APIError.serverError(500, "unused")
            },
            historyListRequest: { documentId in
                XCTAssertEqual(documentId, "doc-1")
                return [
                    NativeTabDocHistoryEntry(
                        id: "internal-history-record-id",
                        name: "",
                        createdAt: nil,
                        isSnapshot: false
                    ),
                ]
            }
        )

        await session.load()
        await session.showVersionHistory()

        XCTAssertTrue(session.isShowingVersionHistory)
        let entry = try XCTUnwrap(session.versionHistories.first)
        XCTAssertEqual(entry.id, "internal-history-record-id")
        let title = NativeTabDocVersionHistoryPresentation.entryTitle(
            id: entry.id,
            name: entry.name,
            createdAt: entry.createdAt,
            isSnapshot: entry.isSnapshot,
            snapshotLabel: L10n.TabDoc.versionSnapshot,
            historyVersionLabel: L10n.TabDoc.versionUnnamed
        )
        XCTAssertEqual(title, L10n.TabDoc.versionUnnamed)
        XCTAssertFalse(title.contains("internal-history-record-id"))
    }

    @MainActor
    func testRestoringVersionReloadsRemoteContentAndClearsLocalDraft() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let initial = detail(
            title: "验收文档",
            text: "共同基线",
            version: 4,
            updatedAt: "2026-08-13T03:00:00Z",
            role: "editor"
        )
        let restored = detail(
            title: "验收文档",
            text: "还原后的正文",
            version: 5,
            updatedAt: "2026-08-13T03:04:00Z",
            role: "editor"
        )
        var detailRequestCount = 0
        var restoreRequestCount = 0
        var restoredVersionId: String?
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "加载前标题",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                detailRequestCount += 1
                return detailRequestCount == 1 ? initial : restored
            },
            writeRequest: { _, _ in
                throw APIError.serverError(500, "unused")
            },
            historyListRequest: { _ in
                [
                    NativeTabDocHistoryEntry(id: "history-1", name: "命名版本"),
                ]
            },
            restoreRequest: { documentId, versionId in
                restoreRequestCount += 1
                XCTAssertEqual(documentId, "doc-1")
                restoredVersionId = versionId
            }
        )

        await session.load()
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "本地草稿")
        XCTAssertNotNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))

        await session.showVersionHistory()
        await session.restoreVersion(id: "history-1")

        XCTAssertEqual(restoreRequestCount, 1)
        XCTAssertEqual(restoredVersionId, "history-1")
        XCTAssertEqual(session.body.blocks.first?.text, "还原后的正文")
        XCTAssertEqual(session.document?.latestVersion, 5)
        XCTAssertEqual(session.saveState, .saved)
        XCTAssertFalse(session.isShowingVersionHistory)
        XCTAssertEqual(session.versionHistoryMessage, L10n.TabDoc.versionRestored)
        XCTAssertNil(store.load(documentId: "doc-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testRestoreIsBlockedDuringConflict() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        var restoreRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detail(
                    title: "验收文档",
                    text: "共同基线",
                    version: 4,
                    updatedAt: "2026-08-13T03:00:00Z",
                    role: "editor"
                )
            },
            writeRequest: { _, _ in
                throw APIError.serverError(409, "当前版本 5，提交版本 4")
            },
            restoreRequest: { _, _ in
                restoreRequestCount += 1
            }
        )

        await session.load()
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        session.updateBlock(id: blockId, text: "本地草稿")
        let saved = await session.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(session.saveState, .conflict)

        await session.restoreVersion(id: "history-1")

        XCTAssertEqual(restoreRequestCount, 0)
        XCTAssertEqual(session.body.blocks.first?.text, "本地草稿")
        XCTAssertEqual(session.document?.latestVersion, 4)
    }

    @MainActor
    func testRestoreFailureKeepsHistoryListAndShowsMessage() async throws {
        var restoreRequestCount = 0
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "验收文档",
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                self.detail(
                    title: "验收文档",
                    text: "共同基线",
                    version: 4,
                    updatedAt: "2026-08-13T03:00:00Z",
                    role: "editor"
                )
            },
            writeRequest: { _, _ in
                throw APIError.serverError(500, "unused")
            },
            historyListRequest: { _ in
                [
                    NativeTabDocHistoryEntry(id: "history-1", name: "命名版本"),
                ]
            },
            restoreRequest: { _, _ in
                restoreRequestCount += 1
                throw APIError.serverError(500, "restore failed")
            }
        )

        await session.load()
        await session.showVersionHistory()
        await session.restoreVersion(id: "history-1")

        XCTAssertEqual(restoreRequestCount, 1)
        XCTAssertTrue(session.isShowingVersionHistory)
        XCTAssertEqual(session.versionHistories.map(\.id), ["history-1"])
        XCTAssertEqual(session.versionHistoryMessage, L10n.TabDoc.versionRestoreFailed)
        XCTAssertEqual(session.body.blocks.first?.text, "共同基线")
        XCTAssertEqual(session.document?.latestVersion, 4)
    }

    @MainActor
    func testIndentMovesItemUnderPreviousSiblingWithoutGivingNewListAnIdentity() async throws {
        let session = try await editableListSession(content: [
            listNode(blockId: "list-root", items: [
                listItemNode("甲", blockId: "item-a", paragraphId: "para-a"),
                listItemNode("乙", blockId: "item-b", paragraphId: "para-b"),
            ]),
        ])
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let itemB = try XCTUnwrap(session.body.blocks.first?.listItems[1].id)

        XCTAssertTrue(session.canIndentListItem(blockId: blockId, itemId: itemB))
        session.indentListItem(blockId: blockId, itemId: itemB)

        let items = try XCTUnwrap(session.body.blocks.first?.listItems)
        XCTAssertEqual(items.map(\.text), ["甲"])
        XCTAssertEqual(items[0].nested?.kind, .bulletList)
        XCTAssertEqual(items[0].nested?.items.map(\.text), ["乙"])

        let serialized = try XCTUnwrap(session.body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let root = serialized[0]
        XCTAssertEqual((root["attrs"] as? [String: Any])?["blockId"] as? String, "list-root")
        let parent = try XCTUnwrap((root["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((parent["attrs"] as? [String: Any])?["blockId"] as? String, "item-a")
        let nested = try XCTUnwrap(firstNestedList(in: parent))
        XCTAssertEqual(nested["type"] as? String, "bulletList")
        assertNoPersistentIdentity(nested)
        let child = try XCTUnwrap((nested["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((child["attrs"] as? [String: Any])?["blockId"] as? String, "item-b")
        XCTAssertEqual(
            ((child["content"] as? [[String: Any]])?.first?["attrs"] as? [String: Any])?["blockId"] as? String,
            "para-b"
        )
    }

    @MainActor
    func testIndentInOrderedListKeepsOrderedKindAndFirstItemDoesNotMove() async throws {
        let session = try await editableListSession(content: [
            listNode(type: "orderedList", start: 3, items: [
                listItemNode("一"),
                listItemNode("二"),
            ]),
        ])
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let firstId = try XCTUnwrap(session.body.blocks.first?.listItems[0].id)
        let secondId = try XCTUnwrap(session.body.blocks.first?.listItems[1].id)
        let before = try stableSerializedData(session.body)

        XCTAssertFalse(session.canIndentListItem(blockId: blockId, itemId: firstId))
        session.indentListItem(blockId: blockId, itemId: firstId)
        XCTAssertEqual(try stableSerializedData(session.body), before)
        XCTAssertEqual(session.saveState, .saved)

        session.indentListItem(blockId: blockId, itemId: secondId)
        XCTAssertEqual(session.body.blocks.first?.listItems[0].nested?.kind, .orderedList(start: 3))
        let parent = try XCTUnwrap(
            (session.body.serializedJSON["content"]?.arrayValue as? [[String: Any]])?
                .first?["content"] as? [[String: Any]]
        ).first
        let nested = try XCTUnwrap(firstNestedList(in: try XCTUnwrap(parent)))
        XCTAssertEqual(nested["type"] as? String, "orderedList")
        assertNoPersistentIdentity(nested)
    }

    @MainActor
    func testFirstItemInEachLayerCannotIndent() async throws {
        let session = try await editableListSession(content: [
            listNode(items: [
                listItemNode("父", nested: listNode(items: [
                    listItemNode("子一"),
                    listItemNode("子二"),
                ])),
                listItemNode("兄"),
            ]),
        ])
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let parentId = try XCTUnwrap(session.body.blocks.first?.listItems[0].id)
        let firstChildId = try XCTUnwrap(session.body.blocks.first?.listItems[0].nested?.items[0].id)
        let before = try stableSerializedData(session.body)

        XCTAssertFalse(session.canIndentListItem(blockId: blockId, itemId: parentId))
        XCTAssertFalse(session.canIndentListItem(blockId: blockId, itemId: firstChildId))
        session.indentListItem(blockId: blockId, itemId: parentId)
        session.indentListItem(blockId: blockId, itemId: firstChildId)
        XCTAssertEqual(try stableSerializedData(session.body), before)
        XCTAssertEqual(session.saveState, .saved)
    }

    @MainActor
    func testOutdentLiftsFollowingSiblingsAsChildrenToPreserveDocumentOrder() async throws {
        let session = try await editableListSession(content: [
            listNode(items: [
                listItemNode("父", nested: listNode(items: [
                    listItemNode("子一"),
                    listItemNode("子二"),
                    listItemNode("子三"),
                ])),
            ]),
        ])
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let secondChildId = try XCTUnwrap(session.body.blocks.first?.listItems[0].nested?.items[1].id)

        session.outdentListItem(blockId: blockId, itemId: secondChildId)

        let items = try XCTUnwrap(session.body.blocks.first?.listItems)
        XCTAssertEqual(items.map(\.text), ["父", "子二"])
        XCTAssertEqual(items[0].nested?.items.map(\.text), ["子一"])
        XCTAssertEqual(items[1].nested?.items.map(\.text), ["子三"])
        XCTAssertEqual(items[1].nested?.kind, .bulletList)
        assertNoPersistentIdentity(try XCTUnwrap(items[1].nested?.rawNode.mapValues(\.value)))

        let serialized = try XCTUnwrap(session.body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        let rootItems = try XCTUnwrap(serialized[0]["content"] as? [[String: Any]])
        XCTAssertEqual(rootItems.count, 2)
        XCTAssertEqual(plainListItemText(rootItems[0]), "父")
        XCTAssertEqual(plainListItemText(rootItems[1]), "子二")
        let liftedNested = try XCTUnwrap(firstNestedList(in: rootItems[1]))
        XCTAssertEqual(plainListItemText(try XCTUnwrap((liftedNested["content"] as? [[String: Any]])?.first)), "子三")
    }

    @MainActor
    func testOutdentClearsEmptyParentNestedList() async throws {
        let session = try await editableListSession(content: [
            listNode(items: [
                listItemNode("父", nested: listNode(blockId: "old-nested", items: [
                    listItemNode("唯一子项"),
                ])),
            ]),
        ])
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let childId = try XCTUnwrap(session.body.blocks.first?.listItems[0].nested?.items[0].id)

        session.outdentListItem(blockId: blockId, itemId: childId)

        let parent = try XCTUnwrap(session.body.blocks.first?.listItems[0])
        XCTAssertNil(parent.nested)
        XCTAssertEqual(session.body.blocks.first?.listItems.map(\.text), ["父", "唯一子项"])

        let serializedParent = try XCTUnwrap(
            (session.body.serializedJSON["content"]?.arrayValue as? [[String: Any]])?
                .first?["content"] as? [[String: Any]]
        ).first
        let children = try XCTUnwrap(serializedParent?["content"] as? [[String: Any]])
        XCTAssertEqual(children.map { $0["type"] as? String }, ["paragraph"])
        XCTAssertFalse(children.contains { ($0["content"] as? [Any])?.isEmpty == true && $0["type"] as? String != "paragraph" })
    }

    @MainActor
    func testTopLevelItemCannotOutdent() async throws {
        let session = try await editableListSession(content: [
            listNode(items: [
                listItemNode("顶层甲"),
                listItemNode("顶层乙"),
            ]),
        ])
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let firstId = try XCTUnwrap(session.body.blocks.first?.listItems[0].id)
        let secondId = try XCTUnwrap(session.body.blocks.first?.listItems[1].id)
        let before = try stableSerializedData(session.body)

        XCTAssertFalse(session.canOutdentListItem(blockId: blockId, itemId: firstId))
        XCTAssertFalse(session.canOutdentListItem(blockId: blockId, itemId: secondId))
        session.outdentListItem(blockId: blockId, itemId: firstId)
        session.outdentListItem(blockId: blockId, itemId: secondId)
        XCTAssertEqual(try stableSerializedData(session.body), before)
        XCTAssertEqual(session.saveState, .saved)
    }

    @MainActor
    func testAddListItemInsertsAtSameLayerWithoutInheritingIdentity() async throws {
        let session = try await editableListSession(content: [
            listNode(blockId: "list-root", items: [
                listItemNode("父", blockId: "item-parent", paragraphId: "para-parent", nested: listNode(
                    blockId: "list-child",
                    items: [listItemNode("子", blockId: "item-child", paragraphId: "para-child")]
                )),
                listItemNode("兄", blockId: "item-sibling"),
            ]),
        ])
        let blockId = try XCTUnwrap(session.body.blocks.first?.id)
        let nestedId = try XCTUnwrap(session.body.blocks.first?.listItems[0].nested?.items[0].id)

        session.addListItem(blockId: blockId, afterItemId: nestedId)

        let nestedItems = try XCTUnwrap(session.body.blocks.first?.listItems[0].nested?.items)
        XCTAssertEqual(nestedItems.map(\.text), ["子", ""])
        XCTAssertEqual(session.body.blocks.first?.listItems.map(\.text), ["父", "兄"])
        XCTAssertTrue(nestedItems[1].spans.isEmpty)
        XCTAssertFalse(nestedItems[1].isChecked)
        XCTAssertNil(nestedItems[1].nested)
        assertNoPersistentIdentity(nestedItems[1].rawItem.mapValues(\.value))
        assertNoPersistentIdentity(nestedItems[1].rawParagraph.mapValues(\.value))

        let serializedParent = try XCTUnwrap(
            (session.body.serializedJSON["content"]?.arrayValue as? [[String: Any]])?
                .first?["content"] as? [[String: Any]]
        ).first
        let nested = try XCTUnwrap(firstNestedList(in: try XCTUnwrap(serializedParent)))
        let added = try XCTUnwrap((nested["content"] as? [[String: Any]])?.last)
        assertNoPersistentIdentity(added)
        let addedParagraph = try XCTUnwrap((added["content"] as? [[String: Any]])?.first)
        assertNoPersistentIdentity(addedParagraph)
        XCTAssertEqual((nested["content"] as? [[String: Any]])?.count, 2)
        XCTAssertEqual(
            ((nested["content"] as? [[String: Any]])?.first?["attrs"] as? [String: Any])?["blockId"] as? String,
            "item-child"
        )

        session.addListItem(blockId: blockId)
        XCTAssertEqual(session.body.blocks.first?.listItems.map(\.text), ["父", "兄", ""])
    }

    @MainActor
    func testIndentAndOutdentLeaveUntouchedBlocksAndIdentitiesIntact() async throws {
        let session = try await editableListSession(
            content: [
                [
                    "type": "paragraph",
                    "attrs": ["id": "p-keep", "align": "center"],
                    "content": [["type": "text", "text": "保留段落", "marks": [["type": "bold"]]]],
                ],
                listNode(blockId: "list-keep", items: [
                    listItemNode("甲", blockId: "item-a", paragraphId: "para-a"),
                    listItemNode("乙", blockId: "item-b", paragraphId: "para-b"),
                ]),
                [
                    "type": "heading",
                    "attrs": ["level": 2, "blockId": "h-keep"],
                    "content": [["type": "text", "text": "保留标题"]],
                ],
            ],
            rootAttributes: ["schemaVersion": 7]
        )
        let listBlockId = try XCTUnwrap(session.body.blocks[1].id)
        let itemB = try XCTUnwrap(session.body.blocks[1].listItems[1].id)

        session.indentListItem(blockId: listBlockId, itemId: itemB)
        var serialized = try XCTUnwrap(session.body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual((serialized[0]["attrs"] as? [String: Any])?["id"] as? String, "p-keep")
        XCTAssertEqual((serialized[0]["attrs"] as? [String: Any])?["align"] as? String, "center")
        let preservedMarks = ((serialized[0]["content"] as? [[String: Any]])?.first)?["marks"] as? [[String: Any]]
        XCTAssertEqual(preservedMarks?.first?["type"] as? String, "bold")
        XCTAssertEqual((serialized[1]["attrs"] as? [String: Any])?["blockId"] as? String, "list-keep")
        let parent = try XCTUnwrap((serialized[1]["content"] as? [[String: Any]])?.first)
        XCTAssertEqual((parent["attrs"] as? [String: Any])?["blockId"] as? String, "item-a")
        XCTAssertEqual(
            ((parent["content"] as? [[String: Any]])?.first?["attrs"] as? [String: Any])?["blockId"] as? String,
            "para-a"
        )
        let nested = try XCTUnwrap(firstNestedList(in: parent))
        assertNoPersistentIdentity(nested)
        XCTAssertEqual(
            ((nested["content"] as? [[String: Any]])?.first?["attrs"] as? [String: Any])?["blockId"] as? String,
            "item-b"
        )
        XCTAssertEqual((serialized[2]["attrs"] as? [String: Any])?["blockId"] as? String, "h-keep")
        XCTAssertEqual(session.body.serializedJSON["attrs"]?.dictValue?["schemaVersion"] as? Int, 7)

        session.outdentListItem(blockId: listBlockId, itemId: itemB)
        serialized = try XCTUnwrap(session.body.serializedJSON["content"]?.arrayValue as? [[String: Any]])
        XCTAssertEqual((serialized[0]["attrs"] as? [String: Any])?["align"] as? String, "center")
        XCTAssertEqual((serialized[1]["attrs"] as? [String: Any])?["blockId"] as? String, "list-keep")
        let restoredItems = try XCTUnwrap(serialized[1]["content"] as? [[String: Any]])
        XCTAssertEqual(restoredItems.count, 2)
        XCTAssertEqual((restoredItems[0]["attrs"] as? [String: Any])?["blockId"] as? String, "item-a")
        XCTAssertEqual((restoredItems[1]["attrs"] as? [String: Any])?["blockId"] as? String, "item-b")
        XCTAssertNil(firstNestedList(in: restoredItems[0]))
        XCTAssertEqual((serialized[2]["attrs"] as? [String: Any])?["blockId"] as? String, "h-keep")
    }

    private func body(text: String) -> NativeTabDocBody {
        NativeTabDocBody(
            rootAttributes: ["type": AnyCodable("doc")],
            blocks: [NativeTabDocBlock(kind: .paragraph, text: text)]
        )
    }

    @MainActor
    private func editableListSession(
        content: [Any],
        rootAttributes: [String: Any] = [:]
    ) async throws -> NativeTabDocSession {
        var documentJSON: [String: Any] = ["type": "doc", "content": content]
        if !rootAttributes.isEmpty {
            documentJSON["attrs"] = rootAttributes
        }
        let parsed = NativeTabDocBody.parse(
            json: documentJSON.mapValues(AnyCodable.init),
            markdownFallback: ""
        )
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDocDraftStore(store: defaults)
        let document = NativeTabDocDocument(
            id: "doc-1",
            organizationId: "org-1",
            spaceId: "space-1",
            title: "列表层级",
            latestVersion: 1,
            updatedAt: "2026-08-17T00:00:00Z",
            currentUserRole: "editor"
        )
        let session = NativeTabDocSession(
            documentId: "doc-1",
            organizationId: "org-1",
            fallbackTitle: "列表层级",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 1,
            sessionIsCurrent: { true },
            detailRequest: { _ in
                NativeTabDocDetail(
                    document: document,
                    content: NativeTabDocContent(
                        descriptionJSON: parsed.serializedJSON,
                        descriptionMarkdown: parsed.markdown,
                        descriptionPlaintext: parsed.plaintext
                    )
                )
            },
            writeRequest: { _, draft in
                NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: "doc-1",
                    organizationId: "org-1",
                    spaceId: "space-1",
                    title: draft.title,
                    latestVersion: 2,
                    updatedAt: "2026-08-17T00:01:00Z",
                    currentUserRole: "editor"
                ))
            }
        )
        await session.load()
        return session
    }

    private func listNode(
        type: String = "bulletList",
        blockId: String? = nil,
        start: Int? = nil,
        items: [[String: Any]]
    ) -> [String: Any] {
        var node: [String: Any] = [
            "type": type,
            "content": items,
        ]
        var attrs: [String: Any] = [:]
        if let blockId { attrs["blockId"] = blockId }
        if let start { attrs["start"] = start }
        if !attrs.isEmpty { node["attrs"] = attrs }
        return node
    }

    private func listItemNode(
        _ text: String,
        blockId: String? = nil,
        paragraphId: String? = nil,
        nested: [String: Any]? = nil,
        checked: Bool? = nil
    ) -> [String: Any] {
        var paragraph: [String: Any] = [
            "type": "paragraph",
            "content": [["type": "text", "text": text]],
        ]
        if let paragraphId {
            paragraph["attrs"] = ["blockId": paragraphId]
        }
        var content: [[String: Any]] = [paragraph]
        if let nested { content.append(nested) }
        var node: [String: Any] = [
            "type": checked == nil ? "listItem" : "taskItem",
            "content": content,
        ]
        var attrs: [String: Any] = [:]
        if let blockId { attrs["blockId"] = blockId }
        if let checked { attrs["checked"] = checked }
        if !attrs.isEmpty { node["attrs"] = attrs }
        return node
    }

    private func firstNestedList(in item: [String: Any]) -> [String: Any]? {
        let children = item["content"] as? [[String: Any]] ?? []
        return children.dropFirst().first
    }

    private func plainListItemText(_ item: [String: Any]) -> String? {
        let paragraph = (item["content"] as? [[String: Any]])?.first
        return ((paragraph?["content"] as? [[String: Any]])?.first)?["text"] as? String
    }

    private func assertNoPersistentIdentity(
        _ node: [String: Any],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let attrs = node["attrs"] as? [String: Any] ?? [:]
        XCTAssertNil(attrs["blockId"], file: file, line: line)
        XCTAssertNil(attrs["id"], file: file, line: line)
        XCTAssertNil(attrs["itemId"], file: file, line: line)
        XCTAssertNil(attrs["taskId"], file: file, line: line)
        XCTAssertNil(attrs["todoId"], file: file, line: line)
    }

    private func collectBlockIds(_ value: Any) -> [String] {
        if let dictionary = value as? [String: Any] {
            var ids: [String] = []
            if let blockId = dictionary["blockId"] as? String {
                ids.append(blockId)
            }
            return ids + dictionary.values.flatMap(collectBlockIds)
        }
        if let array = value as? [Any] {
            return array.flatMap(collectBlockIds)
        }
        return []
    }

    private func stableSerializedData(_ body: NativeTabDocBody) throws -> Data {
        try JSONSerialization.data(
            withJSONObject: body.serializedJSON.mapValues(\.value),
            options: [.sortedKeys]
        )
    }

    private func stableJSONData(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    private func detail(
        documentId: String = "doc-1",
        title: String,
        text: String,
        version: Int,
        updatedAt: String,
        role: String,
        organizationId: String = "org-1"
    ) -> NativeTabDocDetail {
        let contentBody = body(text: text)
        return NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: documentId,
                organizationId: organizationId,
                spaceId: "space-1",
                title: title,
                latestVersion: version,
                updatedAt: updatedAt,
                currentUserRole: role
            ),
            content: NativeTabDocContent(
                descriptionJSON: contentBody.serializedJSON,
                descriptionMarkdown: contentBody.markdown,
                descriptionPlaintext: contentBody.plaintext
            )
        )
    }
}
