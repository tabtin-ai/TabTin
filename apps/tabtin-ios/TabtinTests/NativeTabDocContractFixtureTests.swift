import UIKit
import XCTest
import UIKit
@testable import Tabtin

final class NativeTabDocContractFixtureTests: XCTestCase {
    private enum Disposition: String, Decodable {
        case editable
        case readonlyPreserve = "readonly_preserve"
        case summary
    }

    private struct CurrentDisposition: Decodable {
        let ios: Disposition
        let android: Disposition
    }

    private struct CurrentPresentation: Decodable {
        let ios: String
        let android: String
    }

    private struct Presentation: Decodable {
        let target: String
        let current: CurrentPresentation
    }

    private struct BlockExpectation: Decodable {
        let path: String
        let blockId: String?
        let type: String
        let disposition: Disposition
        let currentDisposition: CurrentDisposition
        let presentation: Presentation?
    }

    private struct TableCellExpectation: Decodable {
        let path: String
        let disposition: Disposition
        let currentDisposition: CurrentDisposition
    }

    private struct MarkCaseExpectation: Decodable {
        let path: String
        let disposition: Disposition
        let currentDisposition: CurrentDisposition
        let presentation: Presentation?
        let fixture: [String: AnyCodable]

        var fixtureNode: [String: Any] { fixture.mapValues(\.value) }
    }

    private enum GapAspect: String, Decodable {
        case disposition
        case presentation
    }

    private struct Gap: Decodable {
        let path: String
        let aspect: GapAspect
        let batch: Int
        let issue: Int
        let reason: String
    }

    private struct KnownGaps: Decodable {
        let ios: [Gap]
        let android: [Gap]
    }

    private enum ReleaseReadiness: String, Decodable {
        case blocked
        case ready
    }

    private struct ReleaseGate: Decodable {
        let requireDispositionParity: Bool
        let requireKnownGapsEmpty: Bool
        let releaseReadiness: ReleaseReadiness
    }

    private struct Contract: Decodable {
        let blocks: [BlockExpectation]
        let tableCells: [TableCellExpectation]
        let markCases: [MarkCaseExpectation]
        let knownGaps: KnownGaps
        let releaseGate: ReleaseGate
    }

    private enum SessionSurfaceMutation {
        case updated(expectedTargetNode: [String: Any])
        case removed
        case unavailable(String)
    }

    func testExpectationsPinEveryTopLevelBlockAndCurrentIOSDisposition() throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let contract = try loadContract()

        XCTAssertEqual(contract.blocks.count, sourceNodes.count)
        XCTAssertEqual(Set(contract.blocks.map(\.path)).count, contract.blocks.count)

        for (index, expectation) in contract.blocks.enumerated() {
            let path = "/content/\(index)"
            let source = sourceNodes[index]
            XCTAssertEqual(expectation.path, path)
            XCTAssertEqual(expectation.type, source["type"] as? String, path)
            XCTAssertEqual(
                expectation.blockId,
                (source["attrs"] as? [String: Any])?["blockId"] as? String,
                path
            )

            let body = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([source]),
                ],
                markdownFallback: ""
            )
            let actual = try currentDisposition(of: XCTUnwrap(body.blocks.first), path: path)
            XCTAssertEqual(actual, expectation.currentDisposition.ios, "iOS 当前处置发生漂移：\(path)")

            if actual != .editable {
                let serialized = try XCTUnwrap(
                    body.serializedJSON["content"]?.arrayValue?.first
                )
                XCTAssertEqual(
                    try canonicalJSONData(source),
                    try canonicalJSONData(serialized),
                    "只读或摘要块必须原样写回：\(path)"
                )
            }
        }

        let fullBody = NativeTabDocBody.parse(
            json: document.mapValues { AnyCodable($0) },
            markdownFallback: ""
        )
        for expectation in contract.tableCells {
            let indices = try tableCellIndices(from: expectation.path)
            let table = try XCTUnwrap(fullBody.blocks[indices.block].table, expectation.path)
            let cell = table.rows[indices.row].cells[indices.cell]
            let actual: Disposition = table.isCellReadOnly(cell) ? .readonlyPreserve : .editable
            XCTAssertEqual(
                actual,
                expectation.currentDisposition.ios,
                "iOS 表格格子当前处置发生漂移：\(expectation.path)"
            )
        }

        XCTAssertTrue(contract.releaseGate.requireDispositionParity)
        XCTAssertTrue(contract.releaseGate.requireKnownGapsEmpty)

        let declaredGapEntries = contract.knownGaps.ios
        let declaredGapKeys = Set(declaredGapEntries.map { gap in
            XCTAssertEqual(gap.issue, 10459)
            XCTAssertEqual(gap.batch, 4)
            XCTAssertFalse(gap.reason.isEmpty)
            return gapKey(path: gap.path, aspect: gap.aspect)
        })
        XCTAssertEqual(declaredGapKeys.count, declaredGapEntries.count, "gap 的 path#aspect 必须唯一")
        let contractSurfacePaths = Set(
            contract.blocks.map(\.path)
                + contract.tableCells.map(\.path)
                + contract.markCases.map(\.path)
        )
        XCTAssertTrue(
            Set(declaredGapEntries.map(\.path)).isSubset(of: contractSurfacePaths),
            "gap 路径必须指向已登记的块"
        )
        let blockGapKeys = contract.blocks.flatMap { expectation -> [String] in
            var keys: [String] = []
            if expectation.disposition != expectation.currentDisposition.ios {
                keys.append(gapKey(path: expectation.path, aspect: .disposition))
            }
            if let presentation = expectation.presentation,
               presentation.current.ios != presentation.target {
                keys.append(gapKey(path: expectation.path, aspect: .presentation))
            }
            return keys
        }
        let markCaseGapKeys = contract.markCases.flatMap { expectation -> [String] in
            var keys: [String] = []
            if expectation.disposition != expectation.currentDisposition.ios {
                keys.append(gapKey(path: expectation.path, aspect: .disposition))
            }
            if let presentation = expectation.presentation,
               presentation.current.ios != presentation.target {
                keys.append(gapKey(path: expectation.path, aspect: .presentation))
            }
            return keys
        }
        let cellGapKeys = contract.tableCells.compactMap { expectation in
            expectation.disposition == expectation.currentDisposition.ios
                ? nil
                : gapKey(path: expectation.path, aspect: .disposition)
        }
        let actualGapKeys = Set(blockGapKeys + cellGapKeys + markCaseGapKeys)
        XCTAssertEqual(
            declaredGapKeys,
            actualGapKeys,
            "iOS gap 必须与 disposition/presentation 的当前事实精确相等，不能多报或漏报"
        )
        let dispositionParityReached =
            contract.blocks.allSatisfy {
                $0.currentDisposition.ios == $0.currentDisposition.android
            }
            && contract.tableCells.allSatisfy {
                $0.currentDisposition.ios == $0.currentDisposition.android
            }
            && contract.markCases.allSatisfy {
                $0.currentDisposition.ios == $0.currentDisposition.android
            }
        let knownGapsEmpty = contract.knownGaps.ios.isEmpty && contract.knownGaps.android.isEmpty
        let hasUnresolvedTargetGaps = contract.blocks.contains { expectation in
            expectation.disposition != expectation.currentDisposition.ios
                || expectation.disposition != expectation.currentDisposition.android
                || (expectation.presentation.map {
                    $0.target != $0.current.ios || $0.target != $0.current.android
                } ?? false)
        } || contract.tableCells.contains { expectation in
            expectation.disposition != expectation.currentDisposition.ios
                || expectation.disposition != expectation.currentDisposition.android
        } || contract.markCases.contains { expectation in
            expectation.disposition != expectation.currentDisposition.ios
                || expectation.disposition != expectation.currentDisposition.android
                || (expectation.presentation.map {
                    $0.target != $0.current.ios || $0.target != $0.current.android
                } ?? false)
        }
        let releaseGatePassed =
            (!contract.releaseGate.requireDispositionParity || dispositionParityReached)
            && (!contract.releaseGate.requireKnownGapsEmpty || knownGapsEmpty)
            && !hasUnresolvedTargetGaps
        let actualReleaseReadiness: ReleaseReadiness = releaseGatePassed ? .ready : .blocked
        XCTAssertEqual(
            actualReleaseReadiness,
            contract.releaseGate.releaseReadiness,
            "releaseReadiness 必须由处置一致性与 known gap 共同推导"
        )
    }

    @MainActor
    func testMarkCasesDriveIOSSessionAndExactSerialization() async throws {
        let contract = try loadContract()
        XCTAssertEqual(contract.markCases.count, 8, "共享契约必须独立覆盖八类行内能力")
        XCTAssertEqual(Set(contract.markCases.map(\.path)).count, contract.markCases.count)

        for expectation in contract.markCases {
            let fixture = expectation.fixtureNode
            let safeSibling: [String: Any] = [
                "type": "paragraph",
                "attrs": ["blockId": "\(expectation.path)-safe", "textAlign": NSNull()],
                "content": [["type": "text", "text": "安全兄弟"]],
            ]
            let document: [String: Any] = [
                "type": "doc",
                "content": [fixture, safeSibling],
            ]
            var savedDraft: NativeTabDocDraft?
            let detail = fixtureDetail(
                document: document,
                documentId: "mark-case-\(expectation.path.replacingOccurrences(of: "/", with: "-"))"
            )
            let session = fixtureSession(detail: detail) { savedDraft = $0 }
            await session.load()

            XCTAssertTrue(session.canEdit, "行内只读只能锁定目标块，不能锁定整篇：\(expectation.path)")
            XCTAssertEqual(session.body.blocks.count, 2, expectation.path)
            let targetBlock = session.body.blocks[0]
            let actual = try currentDisposition(of: targetBlock, path: expectation.path)
            XCTAssertEqual(
                actual,
                expectation.currentDisposition.ios,
                "iOS 行内能力处置发生漂移：\(expectation.path)"
            )

            if expectation.presentation?.current.ios == "formula_omitted" {
                if case .unsupported = targetBlock.kind {
                    // 公式尚未进入 iOS 行内模型；raw 子树会保留，但当前可读摘要不得伪装成已渲染公式。
                } else {
                    XCTFail("formula_omitted 必须来自局部只读 raw 路径：\(expectation.path)")
                }
                XCTAssertFalse(
                    targetBlock.readablePreview?.contains("E = mc^2") == true,
                    "未渲染的 LaTeX 不得伪装成公式正文：\(expectation.path)"
                )
            }

            var expectedNodes = [fixture, safeSibling]
            if actual == .editable {
                let suffix = " 契约行内编辑"
                var editedSpans = targetBlock.spans
                let lastTextIndex = try XCTUnwrap(
                    editedSpans.lastIndex(where: { !$0.text.isEmpty }),
                    "可编辑行内 case 缺少正文：\(expectation.path)"
                )
                editedSpans[lastTextIndex].text += suffix
                session.updateBlockSpans(id: targetBlock.id, spans: editedSpans)
                expectedNodes[0] = try appendingToLastInlineText(fixture, suffix: suffix)
            } else {
                let before = session.body.serializedJSON.mapValues(\.value)
                session.updateBlockSpans(
                    id: targetBlock.id,
                    spans: [NativeTabDocInlineSpan(text: "不得写入")]
                )
                XCTAssertEqual(
                    try canonicalJSONData(session.body.serializedJSON.mapValues(\.value)),
                    try canonicalJSONData(before),
                    "只读行内 case 必须拒绝正文改写：\(expectation.path)"
                )

                let safeText = "安全兄弟已编辑"
                let safeBlock = session.body.blocks[1]
                session.updateBlockSpans(
                    id: safeBlock.id,
                    spans: [NativeTabDocInlineSpan(text: safeText)]
                )
                var expectedSafeSibling = safeSibling
                expectedSafeSibling["content"] = [["type": "text", "text": safeText]]
                expectedNodes[1] = expectedSafeSibling
            }

            let didSave = await session.save()
            XCTAssertTrue(didSave, expectation.path)
            XCTAssertEqual(
                try canonicalJSONData(try savedTopLevelNodes(from: savedDraft)),
                try canonicalJSONData(expectedNodes),
                "mark case 保存必须只包含预期正文变化，fixture 与安全兄弟不得被连带改写：\(expectation.path)"
            )
        }
    }

    @MainActor
    func testSessionEditsInlineMathematicsLatexOnlyWithoutRewritingSiblings() async throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        var savedDocument: NativeTabDocDraft?
        let session = fixtureSession(
            detail: fixtureDetail(document: document, documentId: "ios-inline-math-content-7")
        ) { savedDocument = $0 }
        await session.load()

        XCTAssertGreaterThan(session.body.blocks.count, 7)
        let target = session.body.blocks[7]
        XCTAssertEqual(try currentDisposition(of: target, path: "/content/7"), .editable)
        let formulaIndex = try XCTUnwrap(target.spans.firstIndex { $0.mathematics != nil })
        var edited = target.spans
        edited[formulaIndex].text = "E = m c^2"
        session.updateBlockSpans(id: target.id, spans: edited)

        var expectedNodes = try deepCopyNodes(sourceNodes)
        var expectedTarget = expectedNodes[7]
        var inline = try XCTUnwrap(expectedTarget["content"] as? [[String: Any]])
        let mathIndex = try XCTUnwrap(inline.firstIndex { $0["type"] as? String == "mathematics" })
        var mathNode = inline[mathIndex]
        var attrs = try XCTUnwrap(mathNode["attrs"] as? [String: Any])
        attrs["latex"] = "E = m c^2"
        mathNode["attrs"] = attrs
        inline[mathIndex] = mathNode
        expectedTarget["content"] = inline
        expectedNodes[7] = expectedTarget

        let didSaveDocument = await session.save()
        XCTAssertTrue(didSaveDocument)
        XCTAssertEqual(
            try canonicalJSONData(try savedTopLevelNodes(from: savedDocument)),
            try canonicalJSONData(expectedNodes),
            "整篇 /content/7 只能改公式 latex，其余顶层块与行内兄弟必须深等"
        )

        let contract = try loadContract()
        let markCase = try XCTUnwrap(
            contract.markCases.first { $0.path == "/markCases/inline-mathematics-only" }
        )
        let fixture = markCase.fixtureNode
        let safeSibling: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "inline-math-safe", "textAlign": NSNull()],
            "content": [["type": "text", "text": "安全兄弟"]],
        ]
        var savedMarkCase: NativeTabDocDraft?
        let markSession = fixtureSession(
            detail: fixtureDetail(
                document: ["type": "doc", "content": [fixture, safeSibling]],
                documentId: "ios-inline-math-mark-case"
            )
        ) { savedMarkCase = $0 }
        await markSession.load()
        let markTarget = try XCTUnwrap(markSession.body.blocks.first)
        XCTAssertEqual(
            try currentDisposition(of: markTarget, path: markCase.path),
            .editable
        )
        let markFormula = try XCTUnwrap(markTarget.spans.firstIndex { $0.mathematics != nil })
        var markSpans = markTarget.spans
        markSpans[markFormula].text = "E = m c^2"
        markSession.updateBlockSpans(id: markTarget.id, spans: markSpans)
        var expectedFixture = try deepCopyNode(fixture)
        var fixtureInline = try XCTUnwrap(expectedFixture["content"] as? [[String: Any]])
        let fixtureMath = try XCTUnwrap(
            fixtureInline.firstIndex { $0["type"] as? String == "mathematics" }
        )
        var fixtureMathNode = fixtureInline[fixtureMath]
        var fixtureAttrs = try XCTUnwrap(fixtureMathNode["attrs"] as? [String: Any])
        fixtureAttrs["latex"] = "E = m c^2"
        fixtureMathNode["attrs"] = fixtureAttrs
        fixtureInline[fixtureMath] = fixtureMathNode
        expectedFixture["content"] = fixtureInline
        let didSaveMarkCase = await markSession.save()
        XCTAssertTrue(didSaveMarkCase)
        XCTAssertEqual(
            try canonicalJSONData(try savedTopLevelNodes(from: savedMarkCase)),
            try canonicalJSONData([expectedFixture, safeSibling])
        )
    }

    @MainActor
    func testIOSColorAndScriptMarksRemainEditableThroughSessionSave() async throws {
        let upgradedPaths: Set<String> = [
            "/markCases/text-style-hex6",
            "/markCases/highlight-hex6",
            "/markCases/subscript-only",
            "/markCases/superscript-only",
        ]
        let expectations = try loadContract().markCases.filter {
            upgradedPaths.contains($0.path)
        }
        XCTAssertEqual(Set(expectations.map(\.path)), upgradedPaths)

        for expectation in expectations {
            let fixture = expectation.fixtureNode
            let safeSibling: [String: Any] = [
                "type": "paragraph",
                "attrs": ["blockId": "\(expectation.path)-safe", "textAlign": NSNull()],
                "content": [["type": "text", "text": "安全兄弟"]],
            ]
            var savedDraft: NativeTabDocDraft?
            let detail = fixtureDetail(
                document: ["type": "doc", "content": [fixture, safeSibling]],
                documentId: "ios-inline-upgrade-\(expectation.path.replacingOccurrences(of: "/", with: "-"))"
            )
            let session = fixtureSession(detail: detail) { savedDraft = $0 }
            await session.load()

            let target = try XCTUnwrap(session.body.blocks.first, expectation.path)
            XCTAssertEqual(
                try currentDisposition(of: target, path: expectation.path),
                .editable,
                "本切片的四类 canonical mark 必须进入 iOS 原生编辑链：\(expectation.path)"
            )
            let markedSpanIndex = try XCTUnwrap(
                target.spans.firstIndex(where: { !$0.marks.isEmpty }),
                "目标 mark 必须保留为结构化 span：\(expectation.path)"
            )
            let suffix = "已编辑"
            var editedSpans = target.spans
            editedSpans[markedSpanIndex].text += suffix
            session.updateBlockSpans(id: target.id, spans: editedSpans)

            var expectedFixture = try deepCopyNode(fixture)
            var inlineNodes = try XCTUnwrap(expectedFixture["content"] as? [[String: Any]])
            let markedNodeIndex = try XCTUnwrap(
                inlineNodes.firstIndex(where: { ($0["marks"] as? [[String: Any]])?.isEmpty == false })
            )
            inlineNodes[markedNodeIndex]["text"] =
                (inlineNodes[markedNodeIndex]["text"] as? String ?? "") + suffix
            expectedFixture["content"] = inlineNodes

            let didSave = await session.save()
            XCTAssertTrue(didSave, expectation.path)
            XCTAssertEqual(
                try canonicalJSONData(try savedTopLevelNodes(from: savedDraft)),
                try canonicalJSONData([expectedFixture, safeSibling]),
                "编辑 mark 内正文后，类型、attrs、其它正文与安全兄弟必须精确保留：\(expectation.path)"
            )
        }
    }

    func testComplexNoticeUsesEffectiveEditPermissionWithoutLockingSafeContent() throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let body = NativeTabDocBody.parse(
            json: document.mapValues(AnyCodable.init),
            markdownFallback: ""
        )

        XCTAssertTrue(body.hasUnsupportedBlocks)
        XCTAssertTrue(NativeTabDocEditPolicy.allowsWholeDocumentEdit(body))
        XCTAssertEqual(
            NativeTabDocComplexContentNoticePolicy.presentation(for: body, canEdit: true),
            .partialReadOnly,
            "混合文档必须提示局部只读，不能误报整篇只读"
        )
        XCTAssertEqual(
            NativeTabDocComplexContentNoticePolicy.presentation(for: body, canEdit: false),
            .wholeDocumentReadOnly,
            "viewer、权限变化或冲突态不能继续承诺安全块可编辑"
        )

        // 简单表 /content/16 的带 marks 格已解锁，不再有投影格。
        // 合并表 /content/17 仍整表只读，用来钉「投影格提示」。
        let projectedTableBody = NativeTabDocBody.parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable([sourceNodes[17]]),
            ],
            markdownFallback: ""
        )
        XCTAssertFalse(projectedTableBody.hasUnsupportedBlocks)
        XCTAssertTrue(projectedTableBody.hasProjectedTableCells)
        XCTAssertEqual(
            NativeTabDocComplexContentNoticePolicy.presentation(
                for: projectedTableBody,
                canEdit: true
            ),
            .projectedTableCells
        )
        XCTAssertEqual(
            NativeTabDocComplexContentNoticePolicy.presentation(
                for: projectedTableBody,
                canEdit: false
            ),
            .wholeDocumentReadOnly,
            "整篇不可编辑时不能继续承诺标准单元格可编辑"
        )
    }

    @MainActor
    func testPresentationCurrentIsProducedByNativeSurfacesWithoutRawTypesOrIDs() throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let contract = try loadContract()
        let body = NativeTabDocBody.parse(
            json: document.mapValues { AnyCodable($0) },
            markdownFallback: ""
        )
        XCTAssertEqual(body.blocks.count, sourceNodes.count)

        for (index, expectation) in contract.blocks.enumerated() {
            guard let declared = expectation.presentation?.current.ios else { continue }
            XCTAssertEqual(
                try actualPresentation(
                    block: body.blocks[index],
                    sourceNode: sourceNodes[index]
                ),
                declared,
                "iOS 生产展示与 presentation.current 漂移：\(expectation.path)"
            )
        }

        for expectation in contract.markCases {
            guard let declared = expectation.presentation?.current.ios else { continue }
            let markBody = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([expectation.fixtureNode]),
                ],
                markdownFallback: ""
            )
            XCTAssertEqual(
                try actualPresentation(
                    block: XCTUnwrap(markBody.blocks.first),
                    sourceNode: expectation.fixtureNode
                ),
                declared,
                "iOS 生产展示与 presentation.current 漂移：\(expectation.path)"
            )
        }

        let summaryIndices = contract.blocks.indices.filter {
            contract.blocks[$0].disposition == .summary
        }
        XCTAssertEqual(
            summaryIndices.map { sourceNodes[$0]["type"] as? String },
            ["tabdataBlock", "tabwhiteboard", "htmlBlock", "youtube"]
        )

        let previousLanguage = LanguageManager.shared.language
        defer { LanguageManager.shared.language = previousLanguage }
        for (language, expectedLabels) in [
            (AppLanguage.en, ["Embedded table", "Whiteboard", "Embedded HTML", "Video"]),
            (AppLanguage.zhHans, ["嵌入的多维表", "画板", "嵌入的 HTML", "视频"]),
        ] {
            LanguageManager.shared.language = language
            let actualLabels = summaryIndices.compactMap { index -> String? in
                guard case .unsupported(let rawType) = body.blocks[index].kind else { return nil }
                return NativeTabDocUnsupportedContentPresentation.label(for: rawType)
            }
            XCTAssertEqual(actualLabels, expectedLabels)

            for (offset, index) in summaryIndices.enumerated() {
                let visible = [actualLabels[offset], body.blocks[index].readablePreview ?? ""]
                    .joined(separator: " ")
                let rawType = try XCTUnwrap(sourceNodes[index]["type"] as? String)
                XCTAssertFalse(visible.localizedCaseInsensitiveContains(rawType))
                let attrs = sourceNodes[index]["attrs"] as? [String: Any] ?? [:]
                for key in ["tableId", "viewId", "canvasId", "fileId"] {
                    if let identity = attrs[key] as? String {
                        XCTAssertFalse(visible.contains(identity), "产品摘要不得显示 \(key)")
                    }
                }
            }

            XCTAssertEqual(body.blocks[18].readablePreview, "项目任务表")
            XCTAssertEqual(body.blocks[19].readablePreview, "架构草图")
            XCTAssertEqual(body.blocks[20].readablePreview, "交互报表")
            XCTAssertNil(
                body.blocks[21].readablePreview,
                "没有标题的视频必须明确走 label-only，不能把原始 src 当产品标题"
            )

            let blockFormula = body.blocks[8]
            XCTAssertEqual(L10n.TabDoc.unsupportedBlock, blockFormula.kind.conversionLabel)
            XCTAssertFalse(blockFormula.kind.conversionLabel.contains("mathematicsBlock"))
            XCTAssertEqual(
                try actualPresentation(block: blockFormula, sourceNode: sourceNodes[8]),
                "formula_rendered"
            )
        }

        let inlineFormulaPreview = try XCTUnwrap(body.blocks[7].readablePreview)
        XCTAssertTrue(inlineFormulaPreview.contains("质能方程"))
        XCTAssertFalse(inlineFormulaPreview.contains("blk-p-0008"))
        XCTAssertFalse(inlineFormulaPreview.contains("mathematics"))
        XCTAssertEqual(
            try actualPresentation(block: body.blocks[7], sourceNode: sourceNodes[7]),
            "formula_rendered"
        )

        XCTAssertNil(
            NativeTabDocUnsupportedContentPresentation.label(for: "futureWidget"),
            "未知类型必须走通用占位，不能把实现名作为第二行标签"
        )
        let unknownConversionLabel = NativeTabDocBlockKind
            .unsupported(type: "futureWidget")
            .conversionLabel
        XCTAssertEqual(unknownConversionLabel, L10n.TabDoc.unsupportedBlock)
        XCTAssertFalse(unknownConversionLabel.localizedCaseInsensitiveContains("futureWidget"))

        let complexTable = try XCTUnwrap(body.blocks[17].table)
        XCTAssertTrue(complexTable.requiresWholeTablePreservation)
        XCTAssertEqual(
            NativeTabDocTableHeaderStatusPolicy.status(
                for: complexTable,
                canEdit: true
            ),
            .readOnlyPreview,
            "整表保留时必须显示只读预览，不能只把它描述成若干复杂单元格"
        )
        for (language, expectedSummary, expectedStatus) in [
            (AppLanguage.en, "2 rows × 3 columns", "Read-only preview"),
            (AppLanguage.zhHans, "2 行 × 3 列", "只读预览"),
        ] {
            LanguageManager.shared.language = language
            XCTAssertEqual(
                L10n.TabDoc.tableSummary(
                    complexTable.rows.count,
                    complexTable.presentationColumnCount
                ),
                expectedSummary
            )
            XCTAssertEqual(L10n.TabDoc.tableReadOnlyPreview, expectedStatus)
        }
    }

    func testKnownEmbedPreviewSkipsRawTypeAndSensitiveAttributeAliases() {
        let cases: [(rawType: String, attributes: [String: Any], expectedPreview: String?)] = [
            (
                rawType: "tabdataBlock",
                attributes: [
                    "title": "tabdataBlock",
                    "name": "tbl-secret",
                    "alt": "view-secret",
                    "label": "项目任务表",
                    "tableId": "tbl-secret",
                    "viewId": "view-secret",
                ],
                expectedPreview: "项目任务表"
            ),
            (
                rawType: "tabwhiteboard",
                attributes: [
                    "title": "canvas-secret",
                    "name": "file-secret",
                    "alt": "架构草图",
                    "canvasId": "canvas-secret",
                    "fileId": "file-secret",
                ],
                expectedPreview: "架构草图"
            ),
            (
                rawType: "htmlBlock",
                attributes: [
                    "title": "https://private.example/source",
                    "name": "https://private.example/link",
                    "alt": "https://private.example/resource",
                    "label": "交互报表",
                    "src": "https://private.example/source",
                    "href": "https://private.example/link",
                    "url": "https://private.example/resource",
                ],
                expectedPreview: "交互报表"
            ),
            (
                rawType: "youtube",
                attributes: [
                    "title": "youtube",
                    "name": "演示视频",
                ],
                expectedPreview: "演示视频"
            ),
            (
                rawType: "tabdataBlock",
                attributes: [
                    "title": "普通标题",
                    "tableId": "tbl-secret",
                ],
                expectedPreview: "普通标题"
            ),
            (
                rawType: "youtube",
                attributes: [
                    "title": "https://example.com/public-title",
                    "src": "https://private.example/video",
                ],
                expectedPreview: "https://example.com/public-title"
            ),
        ]

        for testCase in cases {
            let body = NativeTabDocBody.parse(
                json: [
                    "type": AnyCodable("doc"),
                    "content": AnyCodable([[
                        "type": testCase.rawType,
                        "attrs": testCase.attributes,
                    ]]),
                ],
                markdownFallback: ""
            )

            XCTAssertEqual(
                body.blocks.first?.readablePreview,
                testCase.expectedPreview,
                "\(testCase.rawType) 应跳过 raw type 与敏感字段别名，并继续选择安全标题"
            )
        }
    }

    @MainActor
    func testSessionDrivesEveryEditableFixtureSurfaceWithExactTargetOnlyMutation() async throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let contract = try loadContract()
        let paragraph: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "contract-edit-paragraph", "textAlign": NSNull()],
            "content": [["type": "text", "text": "契约正文"]],
        ]
        var sessionDocument = document
        let sessionSourceNodes = [paragraph] + sourceNodes
        sessionDocument["content"] = sessionSourceNodes
        let editableFixtureExpectations = contract.blocks.filter {
            $0.currentDisposition.ios == .editable
        }
        let targets = [(path: "synthetic:paragraph", index: 0)]
            + editableFixtureExpectations.enumerated().map { _, expectation in
                let fixtureIndex = Int(expectation.path.split(separator: "/").last ?? "")
                return (path: expectation.path, index: (fixtureIndex ?? -2) + 1)
            }
        let expectedTargetPaths = Set(["synthetic:paragraph"] + editableFixtureExpectations.map(\.path))
        let expectedUnavailablePaths: Set<String> = []
        var exercisedPaths: Set<String> = []
        var unavailableReasons: [String: String] = [:]

        for target in targets {
            guard sessionSourceNodes.indices.contains(target.index) else {
                unavailableReasons[target.path] = "expectation path 无法映射到 fixture 顶层节点"
                continue
            }
            var savedDraft: NativeTabDocDraft?
            let detail = fixtureDetail(
                document: sessionDocument,
                documentId: "contract-surface-\(target.index)"
            )
            let session = fixtureSession(detail: detail) { savedDraft = $0 }
            await session.load()

            XCTAssertTrue(session.canEdit, target.path)
            XCTAssertEqual(session.body.blocks.count, sessionSourceNodes.count, target.path)
            let targetBlock = session.body.blocks[target.index]
            let mutation = try mutateSurface(
                in: session,
                block: targetBlock,
                path: target.path,
                sourceNode: sessionSourceNodes[target.index]
            )
            if case .unavailable(let reason) = mutation {
                unavailableReasons[target.path] = reason
                continue
            }

            var expectedSavedNodes = try deepCopyNodes(sessionSourceNodes)
            switch mutation {
            case .updated(let expectedTargetNode):
                expectedSavedNodes[target.index] = expectedTargetNode
            case .removed:
                expectedSavedNodes.remove(at: target.index)
            case .unavailable:
                XCTFail("不可达：unavailable 已在保存前处理", file: #filePath, line: #line)
                continue
            }

            let didSave = await session.save()
            XCTAssertTrue(didSave, target.path)
            let savedNodes = try savedTopLevelNodes(from: savedDraft)
            XCTAssertEqual(
                try canonicalJSONData(savedNodes),
                try canonicalJSONData(expectedSavedNodes),
                "驱动 \(target.path) 后的完整顶层 JSON 必须只包含预期目标变化"
            )
            if case .updated(let expectedTargetNode) = mutation {
                XCTAssertEqual(
                    try canonicalJSONData(savedNodes[target.index]),
                    try canonicalJSONData(expectedTargetNode),
                    "目标节点必须与手工构造的完整预期精确相等：\(target.path)"
                )
            }
            exercisedPaths.insert(target.path)
        }

        XCTAssertEqual(Set(unavailableReasons.keys), expectedUnavailablePaths)
        XCTAssertTrue(unavailableReasons.values.allSatisfy { !$0.isEmpty })
        XCTAssertEqual(exercisedPaths, expectedTargetPaths.subtracting(expectedUnavailablePaths))
    }

    @MainActor
    func testSessionRejectsEveryReadOnlyFixtureBlockAndStillSavesSafeSibling() async throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let contract = try loadContract()
        let safeSiblingIndex = try XCTUnwrap(contract.blocks.firstIndex {
            $0.currentDisposition.ios == .editable && $0.path == "/content/0"
        })
        let readOnlyTargets = contract.blocks.enumerated().filter {
            $0.element.currentDisposition.ios != .editable
        }
        var exercisedPaths: Set<String> = []

        for (targetIndex, expectation) in readOnlyTargets {
            var savedDraft: NativeTabDocDraft?
            let detail = fixtureDetail(
                document: document,
                documentId: "contract-readonly-\(targetIndex)"
            )
            let session = fixtureSession(detail: detail) { savedDraft = $0 }
            await session.load()

            XCTAssertTrue(session.canEdit, "安全兄弟应让混合文档保持可编辑：\(expectation.path)")
            XCTAssertEqual(session.body.blocks.count, sourceNodes.count, expectation.path)
            let before = session.body.serializedJSON.mapValues(\.value)
            let targetBlock = session.body.blocks[targetIndex]

            session.updateBlockSpans(
                id: targetBlock.id,
                spans: [NativeTabDocInlineSpan(text: "不得写入")]
            )
            XCTAssertEqual(
                try canonicalJSONData(session.body.serializedJSON.mapValues(\.value)),
                try canonicalJSONData(before),
                "只读块必须拒绝正文改写：\(expectation.path)"
            )

            session.removeBlock(id: targetBlock.id)
            XCTAssertEqual(
                try canonicalJSONData(session.body.serializedJSON.mapValues(\.value)),
                try canonicalJSONData(before),
                "只读块必须拒绝整块删除：\(expectation.path)"
            )

            let replacementText = "安全兄弟已编辑 \(expectation.path)"
            let safeSibling = session.body.blocks[safeSiblingIndex]
            session.updateBlockSpans(
                id: safeSibling.id,
                spans: [NativeTabDocInlineSpan(text: replacementText)]
            )
            let didSave = await session.save()
            XCTAssertTrue(didSave, expectation.path)

            var expectedSavedNodes = try deepCopyNodes(sourceNodes)
            expectedSavedNodes[safeSiblingIndex] = try expectedTextBlockNode(
                sourceNodes[safeSiblingIndex],
                kind: safeSibling.kind,
                inlineNodes: [["type": "text", "text": replacementText]]
            )
            let savedNodes = try savedTopLevelNodes(from: savedDraft)
            XCTAssertEqual(
                try canonicalJSONData(savedNodes),
                try canonicalJSONData(expectedSavedNodes),
                "保存安全兄弟时只读目标及其它兄弟必须原样保留：\(expectation.path)"
            )
            XCTAssertEqual(
                try canonicalJSONData(savedNodes[targetIndex]),
                try canonicalJSONData(sourceNodes[targetIndex]),
                "只读目标保存后必须逐字节等价：\(expectation.path)"
            )
            exercisedPaths.insert(expectation.path)
        }

        XCTAssertEqual(exercisedPaths, Set(readOnlyTargets.map { $0.element.path }))
    }

    @MainActor
    func testSessionEnforcesCanonicalPlainAndMarkedTableCellPermissions() async throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let contract = try loadContract()
        let detail = fixtureDetail(document: document, documentId: "contract-table-cells")
        var savedDraft: NativeTabDocDraft?
        let session = fixtureSession(detail: detail) { savedDraft = $0 }
        await session.load()

        let plainExpectation = try XCTUnwrap(contract.tableCells.first {
            $0.path == "/content/16/content/1/content/0"
        })
        let markedExpectation = try XCTUnwrap(contract.tableCells.first {
            $0.path == "/content/16/content/3/content/0"
        })
        XCTAssertEqual(plainExpectation.currentDisposition.ios, .editable)
        XCTAssertEqual(markedExpectation.currentDisposition.ios, .editable)
        let plainIndices = try tableCellIndices(from: plainExpectation.path)
        let markedIndices = try tableCellIndices(from: markedExpectation.path)
        XCTAssertEqual(plainIndices.block, markedIndices.block)

        let tableBlock = session.body.blocks[plainIndices.block]
        let table = try XCTUnwrap(tableBlock.table)
        let plainCell = table.rows[plainIndices.row].cells[plainIndices.cell]
        let markedCell = table.rows[markedIndices.row].cells[markedIndices.cell]
        XCTAssertFalse(table.isCellReadOnly(markedCell), "带 canonical marks 的格子必须可编辑")

        session.updateTableCellSpans(
            blockId: tableBlock.id,
            cellId: plainCell.id,
            spans: [NativeTabDocInlineSpan(text: "允许写入")]
        )
        let updatedTable = try XCTUnwrap(session.body.blocks[plainIndices.block].table)
        XCTAssertEqual(updatedTable.rows[plainIndices.row].cells[plainIndices.cell].text, "允许写入")
        XCTAssertNil(savedDraft, "显式 save 前不应提前发出写请求")

        var markedSavedDraft: NativeTabDocDraft?
        let markedSession = fixtureSession(detail: detail) { markedSavedDraft = $0 }
        await markedSession.load()
        let markedBlock = markedSession.body.blocks[markedIndices.block]
        let markedLoadedCell = try XCTUnwrap(
            markedBlock.table?.rows[markedIndices.row].cells[markedIndices.cell]
        )
        let appendedMarkedSpans = markedLoadedCell.spans.map { span in
            NativeTabDocInlineSpan(text: span.text + " 契约格编辑", marks: span.marks)
        }
        markedSession.updateTableCellSpans(
            blockId: markedBlock.id,
            cellId: markedLoadedCell.id,
            spans: appendedMarkedSpans
        )
        let didSaveMarked = await markedSession.save()
        XCTAssertTrue(didSaveMarked)
        let markedSavedNodes = try savedTopLevelNodes(from: markedSavedDraft)
        let expectedMarkedTable = try expectedTableNode(
            sourceNodes[markedIndices.block],
            rowIndex: markedIndices.row,
            cellIndex: markedIndices.cell,
            inlineNodes: [[
                "type": "text",
                "text": "加粗备注 契约格编辑",
                "marks": [["type": "bold"]],
            ]]
        )
        XCTAssertEqual(
            try canonicalJSONData(markedSavedNodes[markedIndices.block]),
            try canonicalJSONData(expectedMarkedTable),
            "带 marks 的格子必须可编辑，且 bold 原样保留"
        )

        let hardBreakExpectation = try XCTUnwrap(contract.tableCells.first {
            $0.path == "/content/16/content/3/content/1"
        })
        XCTAssertEqual(hardBreakExpectation.currentDisposition.ios, .editable)
        let hardBreakIndices = try tableCellIndices(from: hardBreakExpectation.path)
        var hardBreakSavedDraft: NativeTabDocDraft?
        let hardBreakSession = fixtureSession(detail: detail) { hardBreakSavedDraft = $0 }
        await hardBreakSession.load()
        let hardBreakBlock = hardBreakSession.body.blocks[hardBreakIndices.block]
        let hardBreakTable = try XCTUnwrap(hardBreakBlock.table)
        let hardBreakCell = hardBreakTable.rows[hardBreakIndices.row].cells[hardBreakIndices.cell]
        hardBreakSession.updateTableCellSpans(
            blockId: hardBreakBlock.id,
            cellId: hardBreakCell.id,
            spans: [NativeTabDocInlineSpan(text: "换行一\n换行二")]
        )
        let didSaveHardBreak = await hardBreakSession.save()
        XCTAssertTrue(didSaveHardBreak)
        let savedNodes = try savedTopLevelNodes(from: hardBreakSavedDraft)
        let expectedTable = try expectedTableNode(
            sourceNodes[hardBreakIndices.block],
            rowIndex: hardBreakIndices.row,
            cellIndex: hardBreakIndices.cell,
            inlineNodes: [
                ["type": "text", "text": "换行一"],
                ["type": "hardBreak"],
                ["type": "text", "text": "换行二"],
            ]
        )
        XCTAssertEqual(
            try canonicalJSONData(savedNodes[hardBreakIndices.block]),
            try canonicalJSONData(expectedTable),
            "hardBreak 格必须可编辑，且除目标格正文外不改写表格结构或 attrs"
        )
        var expectedSavedNodes = try deepCopyNodes(sourceNodes)
        expectedSavedNodes[hardBreakIndices.block] = expectedTable
        XCTAssertEqual(
            try canonicalJSONData(savedNodes),
            try canonicalJSONData(expectedSavedNodes),
            "hardBreak 格保存后，完整顶层 JSON 必须只包含目标格正文变化"
        )
    }

    @MainActor
    func testSessionRemovesStandaloneImageWithoutReorderingOrRewritingSiblings() async throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let imageSourceIndex = try XCTUnwrap(sourceNodes.firstIndex { node in
            let attributes = node["attrs"] as? [String: Any]
            return attributes?["blockId"] as? String == "blk-p-0047"
        }, "fixture 缺少独立图片段落")
        var savedDraft: NativeTabDocDraft?
        let detail = fixtureDetail(document: document, documentId: "contract-image-doc")
        let session = fixtureSession(detail: detail) { savedDraft = $0 }

        await session.load()

        XCTAssertTrue(session.canEdit)
        XCTAssertEqual(session.body.blocks.count, sourceNodes.count)
        let imageBlock = session.body.blocks[imageSourceIndex]
        XCTAssertEqual(imageBlock.kind, .image, "独立图片应投影为可查看、可整块删除的图片块")
        session.removeBlock(id: imageBlock.id)

        let didSave = await session.save()
        XCTAssertTrue(didSave)
        let savedNodes = try savedTopLevelNodes(from: savedDraft)
        var expectedSavedNodes = try deepCopyNodes(sourceNodes)
        expectedSavedNodes.remove(at: imageSourceIndex)
        XCTAssertEqual(
            try canonicalJSONData(savedNodes),
            try canonicalJSONData(expectedSavedNodes),
            "删除独立图片后，完整顶层 JSON 必须只少目标图片块"
        )
    }

    /// 核心断言：编辑混排段落的文字后保存，图片节点必须逐字段回到 JSON。
    @MainActor
    func testEditingMixedInlineImageParagraphKeepsEveryImageAttributeIdentical() async throws {
        let document = try loadDocument()
        let sourceNodes = try XCTUnwrap(document["content"] as? [[String: Any]])
        let targetIndex = 15
        let sourceParagraph = sourceNodes[targetIndex]
        let sourceImage = try XCTUnwrap(
            (sourceParagraph["content"] as? [[String: Any]])?
                .first { $0["type"] as? String == "image" },
            "fixture 缺少混排行内图片"
        )
        var savedDraft: NativeTabDocDraft?
        let detail = fixtureDetail(document: document, documentId: "contract-inline-image")
        let session = fixtureSession(detail: detail) { savedDraft = $0 }
        await session.load()

        let block = session.body.blocks[targetIndex]
        XCTAssertEqual(block.kind, .paragraph, "混排图文段落必须投影成可编辑段落")
        XCTAssertTrue(
            block.spans.contains { $0.image != nil },
            "行内图片必须以原子 span 进入正文模型"
        )

        // 走真实富文本桥：spans → NSAttributedString → 用户追加文字 → spans。
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let attributed = NSMutableAttributedString()
        for span in block.spans {
            attributed.append(NSAttributedString(
                string: span.text,
                attributes: NativeTabDocRichTextMarkBridge.attributes(
                    for: span.marks,
                    mathematics: span.mathematics,
                    image: span.image,
                    style: .body,
                    textAlignment: .natural,
                    traitCollection: traits
                )
            ))
        }
        let suffix = "（本轮编辑）"
        let tailAttributes = attributed.attributes(at: attributed.length - 1, effectiveRange: nil)
        attributed.append(NSAttributedString(string: suffix, attributes: tailAttributes))
        let editedSpans = NativeTabDocRichTextMarkBridge.spans(from: attributed, baseStyle: .body)
        XCTAssertTrue(
            editedSpans.contains { $0.image != nil },
            "富文本回采必须带回行内图片身份，否则保存时图片会被吃掉"
        )
        session.updateBlockSpans(id: block.id, spans: editedSpans)

        let didSave = await session.save()
        XCTAssertTrue(didSave)
        let savedNodes = try savedTopLevelNodes(from: savedDraft)
        var expectedSavedNodes = try deepCopyNodes(sourceNodes)
        expectedSavedNodes[targetIndex] = try appendingToLastInlineText(
            sourceParagraph,
            suffix: suffix
        )
        XCTAssertEqual(
            try canonicalJSONData(savedNodes),
            try canonicalJSONData(expectedSavedNodes),
            "编辑混排段落只能改写目标文字，图片 / hardBreak / 兄弟块必须逐字段不变"
        )

        let savedInlines = try XCTUnwrap(savedNodes[targetIndex]["content"] as? [[String: Any]])
        XCTAssertEqual(
            savedInlines.map { $0["type"] as? String },
            ["text", "image", "hardBreak", "text"],
            "混排结构必须仍是 文字 / 图片 / hardBreak / 文字"
        )
        let savedImage = try XCTUnwrap(savedInlines.first { $0["type"] as? String == "image" })
        XCTAssertEqual(
            try canonicalJSONData(savedImage),
            try canonicalJSONData(sourceImage),
            "图片节点必须原样写回"
        )
        let attrs = try XCTUnwrap(savedImage["attrs"] as? [String: Any])
        XCTAssertEqual(attrs["fileId"] as? String, "file-demo-0001", "fileId 是稳定引用，不得被改写")
        XCTAssertEqual(attrs["alt"] as? String, "示例图片")
        XCTAssertEqual(attrs["title"] as? String, "示例图片标题")
        XCTAssertEqual(attrs["width"] as? Int, 640)
        XCTAssertEqual(attrs["height"] as? Int, 360)
        XCTAssertEqual(
            attrs["src"] as? String,
            (sourceImage["attrs"] as? [String: Any])?["src"] as? String,
            "src 只能原样带回来源值，原生端不得重新生成签名地址"
        )
    }

    /// `src` 是渲染期签名地址：来源没有 `src` 时，保存也不能凭空长出一个 URL。
    func testInlineImageWithoutSourceURLNeverGainsOneThroughEditing() throws {
        let paragraph: [String: Any] = [
            "type": "paragraph",
            "attrs": ["blockId": "blk-inline-image-no-src", "textAlign": NSNull()],
            "content": [
                ["type": "text", "text": "图："],
                ["type": "image", "attrs": ["fileId": "file-only-id", "alt": "仅有 fileId"]],
            ],
        ]
        let body = NativeTabDocBody.parse(
            json: ["type": AnyCodable("doc"), "content": AnyCodable([paragraph])],
            markdownFallback: ""
        )
        var block = try XCTUnwrap(body.blocks.first)
        XCTAssertEqual(block.kind, .paragraph, "仅有 fileId 的行内图片段落必须可编辑")

        block.spans.append(NativeTabDocInlineSpan(text: " 追加"))
        let savedInlines = try XCTUnwrap(block.serializedNode["content"] as? [[String: Any]])
        let savedImage = try XCTUnwrap(savedInlines.first { $0["type"] as? String == "image" })
        XCTAssertEqual(
            try canonicalJSONData(savedImage),
            try canonicalJSONData([
                "type": "image",
                "attrs": ["fileId": "file-only-id", "alt": "仅有 fileId"],
            ] as [String: Any]),
            "attrs 必须与来源逐字段相同，不得补出 src"
        )
    }

    /// 删掉整段占位等于删除这张图片；其余正文不受影响。
    func testDeletingInlineImagePlaceholderRemovesExactlyOneImageNode() throws {
        let document = try loadDocument()
        let body = NativeTabDocBody.parse(
            json: document.mapValues { AnyCodable($0) },
            markdownFallback: ""
        )
        var block = body.blocks[15]
        block.spans = block.spans.filter { $0.image == nil }
        let savedInlines = try XCTUnwrap(block.serializedNode["content"] as? [[String: Any]])
        XCTAssertEqual(
            savedInlines.map { $0["type"] as? String },
            ["text", "hardBreak", "text"],
            "删除占位后只剩文字与 hardBreak"
        )
    }

    /// 诚实占位是产品可见表面，只暴露 alt/title，不得泄露签名 URL、fileId 或实现类型名。
    func testInlineImagePlaceholderShowsAltWithoutLeakingSourceOrFileId() throws {
        let document = try loadDocument()
        let body = NativeTabDocBody.parse(
            json: document.mapValues { AnyCodable($0) },
            markdownFallback: ""
        )
        let text = body.blocks[15].spans.map(\.text).joined()
        XCTAssertTrue(text.contains("🖼 示例图片"), "占位必须显示 alt 文案：\(text)")
        XCTAssertFalse(text.contains("oss.example.com"), "占位不得泄露签名 URL：\(text)")
        XCTAssertFalse(text.contains("file-demo-0001"), "占位不得泄露 fileId：\(text)")
        XCTAssertFalse(text.contains("image"), "占位不得暴露实现类型名：\(text)")
    }

    /// 行内图片占位不是可加粗的正文：加 mark 会在保存时被静默吞掉，必须在工具条层拦住。
    @MainActor
    func testInlineImageAtomRejectsToolbarMarks() throws {
        let document = try loadDocument()
        let body = NativeTabDocBody.parse(
            json: document.mapValues { AnyCodable($0) },
            markdownFallback: ""
        )
        let spans = body.blocks[15].spans
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let accepted = spans.map { span in
            NativeTabDocRichTextMarkBridge.acceptsInlineMark(
                NativeTabDocRichTextMarkBridge.attributes(
                    for: span.marks,
                    mathematics: span.mathematics,
                    image: span.image,
                    style: .body,
                    textAlignment: .natural,
                    traitCollection: traits
                )
            )
        }
        XCTAssertEqual(
            zip(spans, accepted).filter { $0.0.image != nil }.map(\.1),
            Array(repeating: false, count: spans.filter { $0.image != nil }.count),
            "图片原子不得接受会在保存时丢失的 mark"
        )
        XCTAssertTrue(
            zip(spans, accepted).contains { $0.0.image == nil && $0.1 },
            "同段落的普通正文仍应能加粗"
        )
    }

    private func currentDisposition(
        of block: NativeTabDocBlock,
        path: String
    ) throws -> Disposition {
        switch block.kind {
        case .unsupported(let rawType):
            return NativeTabDocUnsupportedContentKind(rawType: rawType) == nil
                ? .readonlyPreserve
                : .summary
        case .table:
            let table = try XCTUnwrap(block.table, "表格投影缺失：\(path)")
            return table.requiresWholeTablePreservation ? .readonlyPreserve : .editable
        default:
            return .editable
        }
    }

    @MainActor
    private func actualPresentation(
        block: NativeTabDocBlock,
        sourceNode: [String: Any]
    ) throws -> String {
        let rawType = try XCTUnwrap(sourceNode["type"] as? String)
        if NativeTabDocUnsupportedContentPresentation.label(for: rawType) != nil {
            return block.readablePreview == nil
                ? "product_label_only"
                : "product_label_with_title"
        }
        if rawType == "mathematicsBlock" {
            return try blockFormulaPresentation(block: block, sourceNode: sourceNode)
        }
        let latexSources = mathematicsLatex(in: sourceNode)
        if !latexSources.isEmpty {
            return try inlineFormulaPresentation(block: block, latexSources: latexSources)
        }
        let inlineImages = inlineImageAttributes(in: sourceNode)
        if !inlineImages.isEmpty {
            return try inlineImagePresentation(block: block, sourceAttributes: inlineImages)
        }
        throw NSError(
            domain: "NativeTabDocContractFixtureTests.Presentation",
            code: 1,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "没有可证明的生产 presentation 映射：\(rawType)",
            ]
        )
    }

    /// `image_rendered` 只能由编辑器同款渲染路径证明，不能由模型层文本反推：
    /// 每张行内图片都要排成一个可承载真图的附件字符，同时保留可读、不泄露身份的降级文案。
    @MainActor
    private func inlineImagePresentation(
        block: NativeTabDocBlock,
        sourceAttributes: [[String: Any]]
    ) throws -> String {
        let images = block.spans.compactMap(\.image)
        guard images.count == sourceAttributes.count else { return "image_dropped" }

        let traits = UITraitCollection(userInterfaceStyle: .light)
        let store = NativeTabDocInlineImageStore()
        let decoded = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        for image in images {
            store.prime(decoded, for: NativeTabDocInlineImagePresentation.descriptor(for: image))
        }
        let rendered = NativeTabDocRichTextMarkBridge.attributedString(
            spans: block.spans,
            style: .body,
            textAlignment: block.textAlignment,
            traitCollection: traits,
            inlineImageAttachment: { image, font in
                NativeTabDocInlineImageAttachmentFactory.make(
                    for: image,
                    font: font,
                    traitCollection: traits,
                    store: store
                )
            }
        )

        var attachments: [NativeTabDocInlineImageAttachment] = []
        var atomicPlaceholders = true
        rendered.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: rendered.length)
        ) { value, range, _ in
            guard let attachment = value as? NativeTabDocInlineImageAttachment else { return }
            attachments.append(attachment)
            if rendered.attributedSubstring(from: range).string
                != NativeTabDocRichTextMarkBridge.inlineImagePlaceholderCharacter {
                atomicPlaceholders = false
            }
        }

        // 无论真图还是降级，都不许把签名地址或 fileId 摆到用户面前。
        let visible = ([rendered.string] + attachments.flatMap {
            [$0.fallbackText, $0.accessibilityLabel ?? ""]
        }).joined(separator: " ")
        let identityLeaked = sourceAttributes.contains { attrs in
            ["src", "fileId", "file_id"].contains { key in
                guard let value = attrs[key] as? String, !value.isEmpty else { return false }
                return visible.contains(value)
            }
        }
        if identityLeaked { return "image_identity_leak" }

        let altReadable = zip(sourceAttributes, images).allSatisfy { attrs, image in
            guard let alt = attrs["alt"] as? String, !alt.isEmpty else { return true }
            return NativeTabDocInlineImagePresentation.fallbackText(for: image).contains(alt)
        }
        guard altReadable else { return "image_opaque_placeholder" }

        guard attachments.count == images.count, atomicPlaceholders else {
            // 没排成附件就还是文本占位；此时 alt 必须直接出现在正文里。
            let altInBody = sourceAttributes.allSatisfy { attrs in
                guard let alt = attrs["alt"] as? String, !alt.isEmpty else { return true }
                return rendered.string.contains(alt)
            }
            return altInBody ? "image_alt_placeholder" : "image_opaque_placeholder"
        }
        return "image_rendered"
    }

    @MainActor
    private func inlineFormulaPresentation(
        block: NativeTabDocBlock,
        latexSources: [String]
    ) throws -> String {
        let formulas = block.spans.compactMap(\.mathematics)
        guard formulas.count == latexSources.count else { return "formula_omitted" }

        let traits = UITraitCollection(userInterfaceStyle: .light)
        let store = NativeTabDocFormulaStore()
        let renderedImage = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 16)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 16))
        }
        for mathematics in formulas {
            let attributes = NativeTabDocRichTextMarkBridge.attributes(
                for: [],
                mathematics: mathematics,
                style: .body,
                textAlignment: block.textAlignment,
                traitCollection: traits
            )
            let font = attributes[.font] as? UIFont ?? TTFonts.uiFont(role: .body)
            let textColor = TTColors.textPrimaryUI.resolvedColor(with: traits)
            store.prime(
                renderedImage,
                for: NativeTabDocFormulaRenderer.Descriptor(
                    latex: NativeTabDocFormulaRenderer.latex(from: mathematics),
                    displayMode: NativeTabDocFormulaRenderer.displayMode(from: mathematics),
                    fontSize: font.pointSize,
                    textColorHex: textColor.tabDocFormulaHexString
                )
            )
        }
        let rendered = NativeTabDocRichTextMarkBridge.attributedString(
            spans: block.spans,
            style: .body,
            textAlignment: block.textAlignment,
            traitCollection: traits,
            inlineImageAttachment: nil,
            inlineFormulaAttachment: { mathematics, font in
                NativeTabDocFormulaAttachmentFactory.make(
                    for: mathematics,
                    font: font,
                    traitCollection: traits,
                    store: store
                )
            }
        )

        var attachments: [NativeTabDocFormulaAttachment] = []
        var atomicPlaceholders = true
        rendered.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: rendered.length)
        ) { value, range, _ in
            guard let attachment = value as? NativeTabDocFormulaAttachment else { return }
            attachments.append(attachment)
            if rendered.attributedSubstring(from: range).string
                != NativeTabDocRichTextMarkBridge.inlineImagePlaceholderCharacter {
                atomicPlaceholders = false
            }
        }

        let visible = rendered.string
        XCTAssertFalse(visible.contains("mathematics"), "行内公式不得泄露节点类型名")
        guard attachments.count == formulas.count, atomicPlaceholders else {
            let preview = block.readablePreview ?? visible
            return latexSources.contains(where: preview.contains)
                ? "source_fallback"
                : "formula_omitted"
        }
        return "formula_rendered"
    }

    @MainActor
    private func blockFormulaPresentation(
        block: NativeTabDocBlock,
        sourceNode: [String: Any]
    ) throws -> String {
        let latex = NativeTabDocFormulaRenderer.blockLatex(in: block.rawNode)
        XCTAssertFalse(
            block.kind.conversionLabel.localizedCaseInsensitiveContains("mathematicsBlock")
        )
        guard NativeTabDocFormulaRenderer.isMathematicsBlock(
            (sourceNode["type"] as? String) ?? ""
        ) else { return "unsupported_placeholder" }
        guard !latex.isEmpty else { return "unsupported_placeholder" }
        guard let html = NativeTabDocFormulaRenderer.renderHTML(latex: latex, displayMode: true),
              NativeTabDocFormulaRenderer.looksRendered(html)
        else { return "source_fallback" }
        return "formula_rendered"
    }

    /// 只收集混排段落里的行内图片；独立图片段落走块级 .image 投影，不是行内呈现。
    private func inlineImageAttributes(in node: [String: Any]) -> [[String: Any]] {
        let children = node["content"] as? [[String: Any]] ?? []
        guard children.count > 1 else { return [] }
        var values: [[String: Any]] = []
        for child in children where child["type"] as? String == "image" {
            values.append(child["attrs"] as? [String: Any] ?? [:])
        }
        return values
    }

    private func mathematicsLatex(in node: [String: Any]) -> [String] {
        var values: [String] = []
        if ["mathematics", "mathematicsBlock"].contains(node["type"] as? String),
           let latex = (node["attrs"] as? [String: Any])?["latex"] as? String,
           !latex.isEmpty {
            values.append(latex)
        }
        for child in node["content"] as? [[String: Any]] ?? [] {
            values.append(contentsOf: mathematicsLatex(in: child))
        }
        return values
    }

    private func loadDocument() throws -> [String: Any] {
        let data = try fixtureData(named: "rich-mixed.pm")
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        return try XCTUnwrap(root["doc"] as? [String: Any])
    }

    private func loadContract() throws -> Contract {
        try JSONDecoder().decode(
            Contract.self,
            from: fixtureData(named: "rich-mixed.expectations")
        )
    }

    private func gapKey(path: String, aspect: GapAspect) -> String {
        "\(path)#\(aspect.rawValue)"
    }

    private func tableCellIndices(
        from path: String
    ) throws -> (block: Int, row: Int, cell: Int) {
        let components = path.split(separator: "/")
        guard components.count == 6,
              components[0] == "content",
              components[2] == "content",
              components[4] == "content",
              let block = Int(components[1]),
              let row = Int(components[3]),
              let cell = Int(components[5]) else {
            throw NSError(
                domain: "NativeTabDocContractFixtureTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "非法表格格子路径：\(path)"]
            )
        }
        return (block, row, cell)
    }

    @MainActor
    private func mutateSurface(
        in session: NativeTabDocSession,
        block: NativeTabDocBlock,
        path: String,
        sourceNode: [String: Any]
    ) throws -> SessionSurfaceMutation {
        let replacementText = "契约编辑 \(path)"
        let replacementSpans = [NativeTabDocInlineSpan(text: replacementText)]
        let replacementInlineNodes: [[String: Any]] = [[
            "type": "text",
            "text": replacementText,
        ]]

        switch block.kind {
        case .paragraph, .heading, .blockquote, .codeBlock:
            // 带行内原子的段落用「追加尾部正文」驱动，才能验证原子在编辑后原样回写；
            // 整段替换只能证明删除路径。
            if block.spans.contains(where: {
                $0.mathematics != nil
                    || $0.image != nil
                    || $0.marks.contains(where: { $0.kind == .unknown })
            }) {
                let suffix = " 契约编辑"
                var editedSpans = block.spans
                let plainIndex = try XCTUnwrap(
                    editedSpans.lastIndex(where: {
                        $0.mathematics == nil
                            && $0.image == nil
                            && !$0.marks.contains(where: { $0.kind == .unknown })
                            && !$0.text.isEmpty
                    }),
                    "含行内原子或未知 mark 的段落缺少可追加的普通正文：\(path)"
                )
                editedSpans[plainIndex].text += suffix
                session.updateBlockSpans(id: block.id, spans: editedSpans)
                return .updated(
                    expectedTargetNode: try appendingToLastPlainInlineText(
                        sourceNode,
                        kind: block.kind,
                        suffix: suffix
                    )
                )
            }
            session.updateBlockSpans(id: block.id, spans: replacementSpans)
            let expectedNode = try expectedTextBlockNode(
                sourceNode,
                kind: block.kind,
                inlineNodes: replacementInlineNodes
            )
            return .updated(expectedTargetNode: expectedNode)
        case .bulletList, .orderedList:
            guard let itemId = block.listItems.first?.id else {
                return .unavailable("列表没有可由 updateListItem 驱动的列表项")
            }
            session.updateListItemSpans(
                blockId: block.id,
                itemId: itemId,
                spans: replacementSpans
            )
            let expectedNode = try expectedListNode(
                sourceNode,
                inlineNodes: replacementInlineNodes,
                togglesFirstTask: false
            )
            return .updated(expectedTargetNode: expectedNode)
        case .taskList:
            guard let itemId = block.listItems.first?.id else {
                return .unavailable("任务列表没有可编辑的首个任务项")
            }
            session.updateListItemSpans(
                blockId: block.id,
                itemId: itemId,
                spans: replacementSpans
            )
            session.toggleTask(blockId: block.id, itemId: itemId)
            let expectedNode = try expectedListNode(
                sourceNode,
                inlineNodes: replacementInlineNodes,
                togglesFirstTask: true
            )
            return .updated(expectedTargetNode: expectedNode)
        case .table:
            guard let table = block.table else {
                return .unavailable("表格投影缺失，无法调用 updateTableCell")
            }
            for (rowIndex, row) in table.rows.enumerated() {
                for (cellIndex, cell) in row.cells.enumerated() where !table.isCellReadOnly(cell) {
                    session.updateTableCellSpans(
                        blockId: block.id,
                        cellId: cell.id,
                        spans: replacementSpans
                    )
                    let expectedNode = try expectedTableNode(
                        sourceNode,
                        rowIndex: rowIndex,
                        cellIndex: cellIndex,
                        inlineNodes: replacementInlineNodes
                    )
                    return .updated(expectedTargetNode: expectedNode)
                }
            }
            return .unavailable("表格没有可由 updateTableCell 驱动的简单单元格")
        case .divider, .image:
            session.removeBlock(id: block.id)
            return .removed
        case .unsupported(let type):
            return .unavailable("块 \(type) 没有稳定的原生 Session 修改 API")
        }
    }

    private func expectedTextBlockNode(
        _ sourceNode: [String: Any],
        kind: NativeTabDocBlockKind,
        inlineNodes: [[String: Any]]
    ) throws -> [String: Any] {
        var expected = try deepCopyNode(sourceNode)
        if case .blockquote = kind {
            var children = try XCTUnwrap(expected["content"] as? [[String: Any]])
            var paragraph = try XCTUnwrap(children.first)
            paragraph["content"] = inlineNodes
            children[0] = paragraph
            expected["content"] = children
        } else {
            expected["content"] = inlineNodes
        }
        return expected
    }

    private func expectedListNode(
        _ sourceNode: [String: Any],
        inlineNodes: [[String: Any]],
        togglesFirstTask: Bool
    ) throws -> [String: Any] {
        var expected = try deepCopyNode(sourceNode)
        var items = try XCTUnwrap(expected["content"] as? [[String: Any]])
        var firstItem = try XCTUnwrap(items.first)
        var itemChildren = try XCTUnwrap(firstItem["content"] as? [[String: Any]])
        var paragraph = try XCTUnwrap(itemChildren.first)
        paragraph["content"] = inlineNodes
        itemChildren[0] = paragraph
        firstItem["content"] = itemChildren
        if togglesFirstTask {
            var attributes = try XCTUnwrap(firstItem["attrs"] as? [String: Any])
            let wasChecked = try XCTUnwrap(attributes["checked"] as? Bool)
            attributes["checked"] = !wasChecked
            firstItem["attrs"] = attributes
        }
        items[0] = firstItem
        expected["content"] = items
        return expected
    }

    private func expectedTableNode(
        _ sourceNode: [String: Any],
        rowIndex: Int,
        cellIndex: Int,
        inlineNodes: [[String: Any]]
    ) throws -> [String: Any] {
        var expected = try deepCopyNode(sourceNode)
        var rows = try XCTUnwrap(expected["content"] as? [[String: Any]])
        var row = try XCTUnwrap(
            rows.indices.contains(rowIndex) ? rows[rowIndex] : nil,
            "运行时表格行无法映射回 fixture：\(rowIndex)"
        )
        var cells = try XCTUnwrap(row["content"] as? [[String: Any]])
        var cell = try XCTUnwrap(
            cells.indices.contains(cellIndex) ? cells[cellIndex] : nil,
            "运行时表格单元格无法映射回 fixture：\(rowIndex)/\(cellIndex)"
        )
        var cellChildren = try XCTUnwrap(cell["content"] as? [[String: Any]])
        var paragraph = try XCTUnwrap(cellChildren.first)
        paragraph["content"] = inlineNodes
        cellChildren[0] = paragraph
        cell["content"] = cellChildren
        cells[cellIndex] = cell
        row["content"] = cells
        rows[rowIndex] = row
        expected["content"] = rows
        return expected
    }

    private func appendingToLastPlainInlineText(
        _ sourceNode: [String: Any],
        kind: NativeTabDocBlockKind,
        suffix: String
    ) throws -> [String: Any] {
        if case .blockquote = kind {
            var expected = try deepCopyNode(sourceNode)
            var children = try XCTUnwrap(expected["content"] as? [[String: Any]])
            children[0] = try appendingToLastInlineText(children[0], suffix: suffix)
            expected["content"] = children
            return expected
        }
        return try appendingToLastInlineText(sourceNode, suffix: suffix)
    }

    private func appendingToLastInlineText(
        _ sourceNode: [String: Any],
        suffix: String
    ) throws -> [String: Any] {
        var expected = try deepCopyNode(sourceNode)
        var children = try XCTUnwrap(expected["content"] as? [[String: Any]])
        let textIndex = try XCTUnwrap(
            children.lastIndex(where: { $0["type"] as? String == "text" }),
            "mark case 缺少可追加的尾部 text 节点"
        )
        var textNode = children[textIndex]
        textNode["text"] = (textNode["text"] as? String ?? "") + suffix
        children[textIndex] = textNode
        expected["content"] = children
        return expected
    }

    private func deepCopyNode(_ node: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: node)
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
    }

    private func deepCopyNodes(_ nodes: [[String: Any]]) throws -> [[String: Any]] {
        let data = try JSONSerialization.data(withJSONObject: nodes)
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        )
    }

    private func fixtureDetail(
        document: [String: Any],
        documentId: String
    ) -> NativeTabDocDetail {
        NativeTabDocDetail(
            document: NativeTabDocDocument(
                id: documentId,
                organizationId: "org-1",
                spaceId: "space-1",
                title: "移动端契约文档",
                latestVersion: 1,
                updatedAt: "2026-08-15T09:00:00Z",
                currentUserRole: "editor"
            ),
            content: NativeTabDocContent(
                descriptionJSON: document.mapValues(AnyCodable.init),
                descriptionMarkdown: "",
                descriptionPlaintext: ""
            )
        )
    }

    @MainActor
    private func fixtureSession(
        detail: NativeTabDocDetail,
        onWrite: @escaping (NativeTabDocDraft) -> Void
    ) -> NativeTabDocSession {
        NativeTabDocSession(
            documentId: detail.document.id,
            organizationId: detail.document.organizationId,
            fallbackTitle: "加载前标题",
            draftStore: NativeTabDocDraftStore(
                store: UserDefaults(suiteName: UUID().uuidString)!
            ),
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            detailRequest: { _ in detail },
            writeRequest: { _, draft in
                onWrite(draft)
                return NativeTabDocWriteResponse(document: NativeTabDocDocument(
                    id: detail.document.id,
                    organizationId: detail.document.organizationId,
                    spaceId: detail.document.spaceId,
                    title: draft.title,
                    latestVersion: 2,
                    updatedAt: "2026-08-15T09:01:00Z",
                    currentUserRole: "editor"
                ))
            }
        )
    }

    private func savedTopLevelNodes(
        from draft: NativeTabDocDraft?
    ) throws -> [[String: Any]] {
        try XCTUnwrap(
            draft?.body.serializedJSON["content"]?.arrayValue as? [[String: Any]],
            "保存请求缺少顶层块数组"
        )
    }

    private func fixtureData(named name: String) throws -> Data {
        let bundle = Bundle(for: Self.self)
        let url = bundle.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "mobile-contract/doc"
        ) ?? bundle.url(forResource: name, withExtension: "json")
        return try Data(contentsOf: XCTUnwrap(url, "测试包缺少 \(name).json"))
    }

    private func canonicalJSONData(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
