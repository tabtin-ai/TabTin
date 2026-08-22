import SwiftUI
import UIKit
@preconcurrency import MarkdownUI

// MARK: - Text content + citations

/// Runtime 会往 LLM 历史里注入 `<turn_identity agent_id="…">…</turn_identity>`，告诉模型
/// 「这段历史回复由哪个 Agent 生成」（见 `packages/agent-runtime` message-block-storage）。
/// 那是给模型看的内部上下文，但模型会把它原样回吐、历史回放也可能带回来；
/// MarkdownUI 不认识这个标签，会把它当普通文字整段画在气泡里（真机截图可见）。
/// 这里在展示层剥掉——不动落库内容，也不影响送给模型的历史。
enum AgentTurnIdentityMarkup {
    private static let markup = try? NSRegularExpression(
        pattern: [
            #"<turn_identity\b[^>]*/>"#,
            #"<turn_identity\b[^>]*>[\s\S]*?</turn_identity\s*>"#,
            // 流式期只到货半截、或历史里只剩落单的一侧标签。
            #"</?turn_identity\b[^>]*>"#,
        ].joined(separator: "|"),
        options: [.caseInsensitive]
    )

    static func stripped(_ text: String) -> String {
        // 流式每帧都会走这里，先用子串扫一遍挡掉绝大多数消息，别每帧起正则。
        guard text.range(of: "turn_identity", options: .caseInsensitive) != nil,
              let markup else { return text }
        let cleaned = markup.stringByReplacingMatches(
            in: text,
            range: NSRange(text.startIndex..., in: text),
            withTemplate: ""
        )
        guard cleaned != text else { return text }
        // 整块被剥掉后往往留下开头的空行，Markdown 会照着排出一段空白。
        return String(cleaned.drop { $0.isWhitespace })
    }
}

struct TextContentBlockView: View {
    let block: TextBlock
    let displayText: String
    var isStreaming = false

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            if !displayText.isEmpty || isStreaming {
                ContinuityMarkdownText(text: displayText, isStreaming: isStreaming)
            }
            if !block.citations.isEmpty {
                CitationStrip(citations: block.citations)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 引用型正文叶子：只有对应 `MessageTextLeafModel` 的正文变化才会重新求值本视图。
/// 气泡身份、工具块、思考块与历史前缀不订阅这个高频字段。
struct MessageTextLeafView: View {
    @Bindable var model: MessageTextLeafModel

    var body: some View {
        TextContentBlockView(
            block: model.block,
            displayText: AgentTurnIdentityMarkup.stripped(model.block.text),
            isStreaming: model.isStreaming
        )
    }
}

/// 完整 MarkdownUI 不能跟随 16ms UI publish 反复解析。短内容实时渲染；
/// 长内容只在累计增长达到步长时升级 Markdown 快照，其余新增字符走轻量文本尾巴。
enum StreamingMarkdownSnapshotPolicy {
    static let markdownRefreshStride = 420

    static func usesLiveMarkdown(currentUTF16Length: Int) -> Bool {
        // 短文流式走 Text，收束再整段 Markdown；不再每帧 live parse。
        _ = currentUTF16Length
        return false
    }

    static func isExactPrefix(_ snapshot: String, of text: String) -> Bool {
        let snapshotUTF16 = snapshot.utf16
        let textUTF16 = text.utf16
        guard snapshotUTF16.count <= textUTF16.count else { return false }
        return textUTF16.prefix(snapshotUTF16.count).elementsEqual(snapshotUTF16)
    }

    static func canReuseSnapshot(_ snapshot: String, in text: String) -> Bool {
        guard isExactPrefix(snapshot, of: text) else { return false }
        let boundary = String.Index(utf16Offset: snapshot.utf16.count, in: text)
        return boundary == text.endIndex || text.indices.contains(boundary)
    }

    static func shouldRefreshSnapshot(
        currentUTF16Length: Int,
        snapshotUTF16Length: Int,
        snapshotIsPrefix: Bool,
        force: Bool
    ) -> Bool {
        guard !usesLiveMarkdown(currentUTF16Length: currentUTF16Length) else {
            return false
        }
        return force
            || snapshotUTF16Length > currentUTF16Length
            || snapshotUTF16Length == 0
            || !snapshotIsPrefix
            || currentUTF16Length - snapshotUTF16Length >= markdownRefreshStride
    }

    static func reusableTail(in text: String, snapshot: String) -> String? {
        guard !snapshot.isEmpty,
              canReuseSnapshot(snapshot, in: text)
        else { return nil }
        let snapshotUTF16Length = snapshot.utf16.count
        let index = String.Index(utf16Offset: snapshotUTF16Length, in: text)
        return String(text[index...])
    }

    static func tail(in text: String, snapshot: String) -> String {
        reusableTail(in: text, snapshot: snapshot) ?? text
    }
}

/// 流式才切：稳定区冻住 Markdown，尾巴用 Text。
/// 收束沿用上一帧稳定区身份，只把尾巴转正；对不上再整段 Markdown。
private struct ContinuityMarkdownText: View {
    let text: String
    let isStreaming: Bool
    @State private var lastStreamingStable = ""

    var body: some View {
        let layout = StreamingMarkdownContinuityPolicy.layout(
            content: text,
            isStreaming: isStreaming,
            lastStreamingStable: lastStreamingStable
        )
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            if layout.hasStable {
                Markdown(layout.stable)
                    .markdownTheme(.tabtin)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(layout.stableIdentity)
            }
            if !layout.tail.isEmpty || isStreaming {
                if layout.tailRenderer == .plainText || layout.tail.isEmpty {
                    StreamingPlainTail(tail: layout.tail, isStreaming: isStreaming)
                } else {
                    Markdown(layout.tail)
                        .markdownTheme(.tabtin)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { syncStreamingStable(layout) }
        .onChange(of: text) { _, _ in syncStreamingStable(layout) }
        .onChange(of: isStreaming) { _, _ in syncStreamingStable(layout) }
    }

    private func syncStreamingStable(_ layout: StreamingMarkdownContinuityPolicy.Layout) {
        if isStreaming {
            lastStreamingStable = layout.stable
        }
    }
}

/// 只淡最新后缀，光标跟在最后一字后。减弱动态效果时直接出字、光标静止。
private struct StreamingPlainTail: View {
    let tail: String
    let isStreaming: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var previousTail = ""
    @State private var reveal = StreamingTailRevealPolicy.Reveal(
        prefix: "",
        incoming: "",
        shouldAnimateIncoming: false
    )
    @State private var incomingOpacity = 1.0
    @State private var caretOn = true

    var body: some View {
        (prefixText + incomingText + caretText)
            .font(ConversationTypography.bodyFont)
            .lineSpacing(ConversationTypography.bodyLineSpacing)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { syncReveal(tail) }
            .onChange(of: tail) { _, newTail in syncReveal(newTail) }
            .task(id: "\(isStreaming)-\(reduceMotion)") { await blinkCaret() }
    }

    private var prefixText: Text {
        Text(reveal.prefix)
            .foregroundColor(Color.tt.textPrimary)
    }

    private var incomingText: Text {
        Text(reveal.incoming)
            .foregroundColor(Color.tt.textPrimary.opacity(incomingOpacity))
    }

    private var caretText: Text {
        guard isStreaming else { return Text("") }
        return Text("▎")
            .foregroundColor(Color.tt.iconAccent.opacity(caretOn ? 1 : 0))
    }

    private func syncReveal(_ nextTail: String) {
        let next = StreamingTailRevealPolicy.reveal(previousTail: previousTail, nextTail: nextTail)
        reveal = next
        previousTail = nextTail
        applyIncomingAnimation(next)
    }

    private func applyIncomingAnimation(_ next: StreamingTailRevealPolicy.Reveal) {
        guard next.shouldAnimateIncoming, !reduceMotion else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                incomingOpacity = 1
            }
            return
        }
        var snap = Transaction()
        snap.disablesAnimations = true
        withTransaction(snap) {
            incomingOpacity = StreamingTailRevealPolicy.incomingStartOpacity
        }
        withAnimation(.easeOut(duration: StreamingTailRevealPolicy.incomingFadeDuration)) {
            incomingOpacity = 1
        }
    }

    private func blinkCaret() async {
        guard isStreaming else { return }
        if reduceMotion {
            caretOn = true
            return
        }
        caretOn = true
        while !Task.isCancelled {
            do {
                try await Task.sleep(
                    nanoseconds: UInt64(StreamingTailRevealPolicy.caretBlinkDuration * 1_000_000_000)
                )
            } catch {
                return
            }
            caretOn.toggle()
        }
    }
}

private struct CitationStrip: View {
    let citations: [Citation]
    @State private var selectedCitation: CitationDetail?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: TTSpacing.xs) {
                ForEach(Array(citations.enumerated()), id: \.offset) { offset, citation in
                    CitationChip(index: offset + 1, citation: citation) {
                        selectedCitation = CitationDetail(index: offset + 1, citation: citation)
                    }
                }
            }
            .padding(.vertical, 1)
        }
        .sheet(item: $selectedCitation) { detail in
            CitationDetailSheet(detail: detail)
        }
    }
}

private struct CitationChip: View {
    let index: Int
    let citation: Citation
    let onTap: () -> Void

    private var title: String {
        let sourceTitle = citation.sourceTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let sourceTitle, !sourceTitle.isEmpty { return sourceTitle }
        let source = citation.documentTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let source, !source.isEmpty { return source }
        let sourceName = citation.sourceName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let sourceName, !sourceName.isEmpty { return sourceName }
        return "引用 \(citation.documentIndex + 1)"
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 4) {
                Text("[\(index)]")
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textAccent)
                Text(title)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, TTSpacing.xs)
            .padding(.vertical, 4)
            .background(Capsule().fill(.tt.bgSubtle))
            .overlay(Capsule().strokeBorder(.tt.borderLight, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }
}

private struct CitationDetail: Identifiable, Hashable {
    let index: Int
    let citation: Citation

    var id: String {
        var parts: [String] = [
            "\(index)",
            "\(citation.documentIndex)",
            "\(citation.startCharIndex)",
            "\(citation.endCharIndex)",
        ]
        parts.append(citation.documentTitle ?? "")
        parts.append(citation.sourceTitle ?? "")
        parts.append(citation.sourceUrl ?? "")
        parts.append(citation.sourceName ?? "")
        parts.append(citation.sourceId ?? "")
        parts.append(citation.sourceType ?? "")
        parts.append(citation.page.map(String.init) ?? "")
        parts.append(citation.startLine.map(String.init) ?? "")
        parts.append(citation.endLine.map(String.init) ?? "")
        parts.append(citation.chunkId ?? "")
        parts.append(citation.citedText)
        return parts.joined(separator: "|")
    }

    var title: String {
        if let sourceTitle = trimmed(citation.sourceTitle) { return sourceTitle }
        let source = citation.documentTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let source, !source.isEmpty { return source }
        if let sourceName = trimmed(citation.sourceName) { return sourceName }
        return "引用 \(citation.documentIndex + 1)"
    }

    var citedText: String {
        citation.citedText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var rangeText: String {
        "\(citation.startCharIndex)-\(citation.endCharIndex)"
    }

    var sourceURL: URL? {
        guard let raw = trimmed(citation.sourceUrl) else { return nil }
        return URL(string: raw)
    }

    var navigationTarget: CitationResourceTarget? {
        guard let resourceId = sourceResourceId,
              let resourceType = sourceResourceType else { return nil }
        return CitationResourceTarget(
            resourceType: resourceType,
            resourceId: resourceId,
            title: title,
            locationHint: sourceLocationHint,
            page: citation.page,
            startLine: citation.startLine,
            endLine: citation.endLine,
            chunkId: trimmed(citation.chunkId),
            rowIds: metadataStringArray("row_ids", "rowIds") ?? [],
            fieldIds: metadataStringArray("field_ids", "fieldIds") ?? []
        )
    }

    var typeLabel: String {
        switch citation.sourceType ?? citation.type {
        case "web", "webpage", "search_result":
            return "网页来源"
        case "document", "doc", "file":
            return "文档来源"
        case "code", "code_file":
            return "代码来源"
        case "table", "table_selection":
            return "表格来源"
        default:
            return citation.type.isEmpty ? "引用来源" : citation.type
        }
    }

    var sourceLocationLabels: [String] {
        var labels: [String] = []
        if let sourceId = trimmed(citation.sourceId) {
            labels.append("Source \(sourceId)")
        }
        if let explicit = metadataString("location_hint", "locationHint") {
            labels.append(explicit)
        }
        if let page = citation.page {
            labels.append("第 \(page) 页")
        }
        switch (citation.startLine, citation.endLine) {
        case let (.some(start), .some(end)) where end > start:
            labels.append("行 \(start)-\(end)")
        case let (.some(start), _):
            labels.append("行 \(start)")
        default:
            break
        }
        if let chunkId = trimmed(citation.chunkId) {
            labels.append("Chunk \(chunkId)")
        }
        if let rowIds = metadataStringArray("row_ids", "rowIds"), !rowIds.isEmpty {
            labels.append(rowIds.count == 1 ? "记录 \(rowIds[0])" : "\(rowIds.count) 条记录")
        }
        if let fieldIds = metadataStringArray("field_ids", "fieldIds"), !fieldIds.isEmpty {
            labels.append(fieldIds.count == 1 ? "字段 \(fieldIds[0])" : "\(fieldIds.count) 个字段")
        }
        return labels
    }

    private var sourceResourceId: String? {
        metadataString("resource_id", "resourceId")
            ?? metadataString("doc_id", "document_id", "documentId")
            ?? metadataString("table_id", "tableId")
            ?? metadataString("slide_id", "slideId")
            ?? metadataString("site_id", "siteId")
            ?? metadataString("source_id", "sourceId", "id")
            ?? trimmed(citation.sourceId)
    }

    private var sourceResourceType: String? {
        Self.firstNormalizedResourceType([
            metadataString("resource_type", "resourceType", "item_type", "itemType"),
            inferredResourceTypeFromMetadata,
            trimmed(citation.sourceType),
            trimmed(citation.type),
        ])
    }

    private var inferredResourceTypeFromMetadata: String? {
        if metadataString("table_id", "tableId") != nil { return "tabdata" }
        if metadataString("doc_id", "document_id", "documentId") != nil { return "tabdoc" }
        if metadataString("slide_id", "slideId") != nil { return "tabslide" }
        if metadataString("site_id", "siteId") != nil { return "tabsite" }
        return nil
    }

    private var sourceLocationHint: String? {
        if let explicit = metadataString("location_hint", "locationHint") {
            return explicit
        }
        var labels: [String] = []
        if let page = citation.page {
            labels.append("第 \(page) 页")
        }
        switch (citation.startLine, citation.endLine) {
        case let (.some(start), .some(end)) where end > start:
            labels.append("行 \(start)-\(end)")
        case let (.some(start), _):
            labels.append("行 \(start)")
        default:
            break
        }
        if let chunkId = trimmed(citation.chunkId) {
            labels.append("Chunk \(chunkId)")
        }
        if let rowIds = metadataStringArray("row_ids", "rowIds"), !rowIds.isEmpty {
            labels.append(rowIds.count == 1 ? "记录 \(rowIds[0])" : "\(rowIds.count) 条记录")
        }
        if let fieldIds = metadataStringArray("field_ids", "fieldIds"), !fieldIds.isEmpty {
            labels.append(fieldIds.count == 1 ? "字段 \(fieldIds[0])" : "\(fieldIds.count) 个字段")
        }
        return labels.isEmpty ? nil : labels.joined(separator: " · ")
    }

    private func metadataString(_ keys: String...) -> String? {
        for key in keys {
            if let value = citation.metadata?[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private func metadataStringArray(_ keys: String...) -> [String]? {
        for key in keys {
            if let values = citation.metadata?[key]?.stringArrayValue, !values.isEmpty {
                return values
            }
        }
        return nil
    }

    private static func firstNormalizedResourceType(_ candidates: [String?]) -> String? {
        for candidate in candidates {
            if let normalized = normalizedResourceType(candidate) {
                return normalized
            }
        }
        return nil
    }

    private static func normalizedResourceType(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty else { return nil }
        switch value {
        case "tabdata", "table", "table_selection", "record", "records":
            return "tabdata"
        case "tabdoc", "document", "doc", "doc_selection":
            return "tabdoc"
        case "tabslide", "slide", "ppt":
            return "tabslide"
        case "tabsite", "site":
            return "tabsite"
        case "tabcode", "code", "code_file":
            return "tabcode"
        case "tabvideo", "video":
            return "tabvideo"
        case "tabmemo", "memo":
            return "tabmemo"
        case "tabtracker", "tabgoal", "goal", "tracker":
            return "tabtracker"
        case "tabwhiteboard", "whiteboard", "canvas":
            return "tabwhiteboard"
        default:
            return value.hasPrefix("tab") ? value : nil
        }
    }

    private func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

private struct CitationResourceTarget: Hashable {
    let resourceType: String
    let resourceId: String
    let title: String
    let locationHint: String?
    let page: Int?
    let startLine: Int?
    let endLine: Int?
    let chunkId: String?
    let rowIds: [String]
    let fieldIds: [String]

    var typeLabel: String {
        switch resourceType {
        case "tabdata": return "TabData"
        case "tabdoc": return "TabDoc"
        case "tabslide": return "TabSlide"
        case "tabsite": return "TabSite"
        case "tabcode": return "TabCode"
        case "tabvideo": return "TabVideo"
        case "tabmemo": return "TabMemo"
        case "tabtracker": return "TabTracker"
        case "tabwhiteboard": return "TabWhiteboard"
        default: return resourceType
        }
    }

    func postNavigation() {
        var userInfo: [String: Any] = [
            "resource_type": resourceType,
            "resource_id": resourceId,
            "title": title,
        ]
        if let locationHint, !locationHint.isEmpty {
            userInfo["location_hint"] = locationHint
        }
        if let page { userInfo["page"] = page }
        if let startLine { userInfo["start_line"] = startLine }
        if let endLine { userInfo["end_line"] = endLine }
        if let chunkId, !chunkId.isEmpty { userInfo["chunk_id"] = chunkId }
        if !rowIds.isEmpty { userInfo["row_ids"] = rowIds }
        if !fieldIds.isEmpty { userInfo["field_ids"] = fieldIds }
        NotificationCenter.default.post(
            name: .tabtinResourceNavigation,
            object: nil,
            userInfo: userInfo
        )
    }
}

private extension JSONValue {
    var stringValue: String? {
        switch self {
        case .string(let value):
            return value
        case .int(let value):
            return String(value)
        case .double(let value):
            return value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .null, .array, .object:
            return nil
        }
    }

    var stringArrayValue: [String]? {
        switch self {
        case .array(let values):
            let strings = values.compactMap(\.stringValue).filter { !$0.isEmpty }
            return strings.isEmpty ? nil : strings
        case .string(let value):
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : [trimmed]
        default:
            return nil
        }
    }
}

private struct CitationDetailSheet: View {
    let detail: CitationDetail
    @Environment(\.dismiss) private var dismiss
    @State private var copiedText: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.lg) {
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        Text(detail.title)
                            .font(.tt.bodySemibold)
                            .foregroundStyle(.tt.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: TTSpacing.xs) {
                            citationMeta(detail.typeLabel)
                            citationMeta("文档 \(detail.citation.documentIndex + 1)")
                            citationMeta("字符 \(detail.rangeText)")
                        }
                        if !detail.sourceLocationLabels.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: TTSpacing.xs) {
                                    ForEach(detail.sourceLocationLabels, id: \.self) { label in
                                        citationMeta(label)
                                    }
                                }
                            }
                        }
                    }

                    if let sourceURL = detail.sourceURL {
                        Button {
                            UIApplication.shared.open(sourceURL)
                        } label: {
                            HStack(spacing: TTSpacing.sm) {
                                Image(systemName: "safari")
                                    .font(.tt.iconBody)
                                    .foregroundStyle(.tt.iconAccent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("打开来源")
                                        .font(.tt.metaSemibold)
                                        .foregroundStyle(.tt.textPrimary)
                                    Text(sourceURL.absoluteString)
                                        .font(.tt.codeXS)
                                        .foregroundStyle(.tt.textTertiary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "arrow.up.right")
                                    .font(.tt.iconCaption)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                            .padding(TTSpacing.md)
                            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
                        }
                        .buttonStyle(.plain)
                    }

                    if let target = detail.navigationTarget {
                        Button {
                            target.postNavigation()
                            dismiss()
                        } label: {
                            HStack(spacing: TTSpacing.sm) {
                                Image(systemName: "square.grid.2x2")
                                    .font(.tt.iconBody)
                                    .foregroundStyle(.tt.iconAccent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("定位来源")
                                        .font(.tt.metaSemibold)
                                        .foregroundStyle(.tt.textPrimary)
                                    Text("\(target.typeLabel) · \(target.resourceId)")
                                        .font(.tt.codeXS)
                                        .foregroundStyle(.tt.textTertiary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    if let locationHint = target.locationHint {
                                        Text(locationHint)
                                            .font(.tt.caption)
                                            .foregroundStyle(.tt.textSecondary)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.tt.iconCaption)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                            .padding(TTSpacing.md)
                            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
                        }
                        .buttonStyle(.plain)
                    }

                    if !detail.citedText.isEmpty {
                        VStack(alignment: .leading, spacing: TTSpacing.xs) {
                            Text("引用原文")
                                .font(.tt.captionSemibold)
                                .foregroundStyle(.tt.textSecondary)
                            Text(detail.citedText)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textPrimary)
                                .textSelection(.enabled)
                                .padding(TTSpacing.md)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
                        }
                    }

                    if let copiedText {
                        Label(copiedText, systemImage: "checkmark.circle.fill")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textSuccess)
                    }
                }
                .padding(TTSpacing.lg)
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle("引用 \(detail.index)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        copy(detail.title, feedback: "已复制来源")
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .accessibilityLabel("复制来源")

                    if !detail.citedText.isEmpty {
                        Button {
                            copy(detail.citedText, feedback: "已复制引用原文")
                        } label: {
                            Image(systemName: "quote.bubble")
                        }
                        .accessibilityLabel("复制引用原文")
                    }

                    if let sourceURL = detail.sourceURL {
                        Button {
                            copy(sourceURL.absoluteString, feedback: "已复制来源链接")
                        } label: {
                            Image(systemName: "link")
                        }
                        .accessibilityLabel("复制来源链接")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func citationMeta(_ text: String) -> some View {
        Text(text)
            .font(.tt.codeXS)
            .foregroundStyle(.tt.textTertiary)
            .padding(.horizontal, TTSpacing.xs)
            .padding(.vertical, 3)
            .background(Capsule().fill(.tt.bgSubtle))
    }

    private func copy(_ text: String, feedback: String) {
        UIPasteboard.general.string = text
        copiedText = feedback
    }
}
