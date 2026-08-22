import Foundation
import AVKit
import os
import PDFKit
import QuickLook
import SwiftUI
import UIKit

// MARK: - Rich content

struct RichImageGalleryItem: Identifiable, Hashable {
    let id: String
    let url: URL
    let title: String?
    let summary: String?

    init?(block: RichContentBlock, resolvedURL: URL? = nil) {
        guard Self.isPreviewableImage(block),
              let url = resolvedURL ?? block.url.flatMap(URL.init(string:)) else { return nil }
        let raw = url.absoluteString
        self.id = "\(block.messageId ?? "_")_\(block.index)_\(raw)"
        self.url = url
        self.title = block.title?.isEmpty == false ? block.title : block.resourceName
        self.summary = block.summary.isEmpty ? nil : block.summary
    }

    static func isPreviewableImage(_ block: RichContentBlock) -> Bool {
        guard block.url?.isEmpty == false else { return false }
        if block.kind == "image" { return true }
        return block.mimeType?.hasPrefix("image/") == true
    }
}

private struct RichImageGalleryPreview: Identifiable {
    let items: [RichImageGalleryItem]
    let initialItemId: String

    var id: String { "\(initialItemId)-\(items.map(\.id).joined(separator: "|"))" }
}

struct RichContentBlockCard: View {
    private static let collapsedSearchResultLimit = 5

    let block: RichContentBlock
    var imageGallery: [RichImageGalleryItem] = []
    @State private var previewAttachment: AttachmentBlock?
    @State private var previewGallery: RichImageGalleryPreview?
    @State private var mermaidSourceExpanded = false
    @State private var tableCopied = false
    @State private var tableCopyResetTask: Task<Void, Never>?
    @State private var searchResultsExpanded = false
    @State private var showsAllSearchResults = false
    @State private var resolvedFileURL: URL?
    @State private var resolvedFileId: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            switch displayKind {
            case .widget:
                richWidgetCard
            case .image:
                richImageCard
            case .file:
                richFileCard
            case .resource:
                richResourceCard
            case .searchResults:
                richSearchResultsCard
            case .table, .generic:
                genericCard
            }
        }
        .sheet(item: $previewAttachment) { attachment in
            ChatAttachmentPreviewSheet(attachment: attachment)
        }
        .fullScreenCover(item: $previewGallery) { preview in
            RichImageGallerySheet(preview: preview)
        }
        .task(id: block.fileId) {
            resolvedFileId = block.fileId
            resolvedFileURL = nil
            guard let fileId = block.fileId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !fileId.isEmpty else { return }
            guard let access = try? await OSSUploadService.shared.resolveFile(fileId: fileId),
                  FormalOssImageAsset.isHTTPURL(access.resolvedUrl) else { return }
            resolvedFileURL = URL(string: access.resolvedUrl)
        }
    }

    private var richWidgetCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text("图示")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
                .padding(.horizontal, TTSpacing.sm)
                .padding(.top, TTSpacing.xs)

            if let title = displayTitle {
                Text(title)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                    .padding(.horizontal, TTSpacing.sm)
            }

            if let url {
                ZStack {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm))
                        case .failure:
                            widgetUnavailable("图示加载失败")
                        case .empty:
                            ZStack {
                                RoundedRectangle(cornerRadius: TTRadius.sm)
                                    .fill(.tt.bgSubtleSecondary)
                                ProgressView()
                            }
                        @unknown default:
                            widgetUnavailable("图示暂不可用")
                        }
                    }
                }
                .aspectRatio(CGFloat(16) / CGFloat(10), contentMode: .fit)
                .padding(.horizontal, TTSpacing.xs)
                .contentShape(RoundedRectangle(cornerRadius: TTRadius.sm))
                .onTapGesture {
                    previewAttachment = AttachmentBlock(
                        messageId: block.messageId,
                        index: block.index,
                        kind: .image,
                        filename: block.title ?? block.resourceName ?? "图示",
                        mimeType: block.mimeType ?? "image/png",
                        size: block.fileSize,
                        url: block.url,
                        fileId: nil
                    )
                }
            } else {
                widgetBakeFailedFallback
                    .padding(.horizontal, TTSpacing.sm)
            }

            if !block.summary.isEmpty {
                Text(block.summary)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(4)
                    .padding(.horizontal, TTSpacing.sm)
                    .padding(.bottom, TTSpacing.sm)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
    }

    private var genericCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                if displayKind == .table {
                    CloudDocsAppIcon(itemType: "tabdata", size: 22)
                        .frame(width: 28, height: 28)
                } else {
                    Image(systemName: icon)
                        .font(.tt.iconBody)
                        .foregroundStyle(.tt.iconAccent)
                        .frame(width: 28, height: 28)
                }
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(block.title?.isEmpty == false ? block.title! : block.resourceName ?? typeLabel)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if !block.summary.isEmpty {
                        Text(block.summary)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(3)
                    }
                }
                Spacer(minLength: 0)
            }
            if !displayTableRows.isEmpty {
                richTable
            }
            if !displayTableRows.isEmpty || footerText?.isEmpty == false {
                tableFooterRow
            }
        }
        .padding(TTSpacing.sm)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
    }

    /// 对齐 Electron `RichSearchResults`：默认只呈现查询词与结果数量，用户展开后
    /// 才浏览具体结果，避免搜索产物在主时间线里抢占正文。
    private var richSearchResultsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                searchResultsExpanded.toggle()
            } label: {
                HStack(spacing: TTSpacing.xs) {
                    Image(systemName: "magnifyingglass")
                        .font(.tt.iconBodyMedium)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(width: 16, height: 16)

                    Text(searchResultsTitle)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    Text("\(searchResultsCount)")
                        .font(.tt.captionSemibold)
                        .foregroundStyle(.tt.textSecondary)
                        .padding(.horizontal, TTSpacing.xs)
                        .padding(.vertical, 2)
                        .background(
                            Capsule()
                                .fill(.tt.bgSubtleSecondary)
                        )

                    Image(systemName: searchResultsExpanded ? "chevron.down" : "chevron.right")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textTertiary)
                }
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.xs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(searchResultsTitle)，\(searchResultsCount) 条结果")
            .accessibilityHint(searchResultsExpanded ? "收起搜索结果" : "展开搜索结果")

            if searchResultsExpanded {
                Divider().overlay(.tt.borderLight)

                if visibleSearchResults.isEmpty {
                    Text("没有可展示的搜索结果")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(maxWidth: .infinity)
                        .padding(TTSpacing.md)
                } else {
                    ForEach(Array(visibleSearchResults.enumerated()), id: \.offset) { index, result in
                        searchResultRow(result)
                        if index < visibleSearchResults.count - 1 {
                            Divider().overlay(.tt.borderLight.opacity(0.65))
                        }
                    }

                    if block.searchResults.count > Self.collapsedSearchResultLimit {
                        Button {
                            showsAllSearchResults.toggle()
                        } label: {
                            Text(showsAllSearchResults ? "收起部分结果" : "显示全部 \(block.searchResults.count) 条")
                                .font(.tt.captionSemibold)
                                .foregroundStyle(.tt.textAccent)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, TTSpacing.xs)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func searchResultRow(_ result: RichSearchResult) -> some View {
        Button {
            guard let rawURL = result.url,
                  let url = URL(string: rawURL),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
            openURL(url)
        } label: {
            HStack(alignment: .top, spacing: TTSpacing.xs) {
                Image(systemName: "globe")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(width: 16, height: 16)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(result.title ?? result.url ?? "未命名结果")
                        .font(.tt.metaSemibold)
                        .foregroundStyle(result.url == nil ? .tt.textPrimary : .tt.textAccent)
                        .lineLimit(1)

                    if let snippet = result.snippet {
                        Text(snippet)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }

                    if let metadata = searchResultMetadata(result) {
                        Text(metadata)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(result.url == nil)
    }

    private var richImageCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            if let title = displayTitle {
                Text(title)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
            }
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFit()
                    case .failure:
                        imageFallback("图片加载失败")
                            .frame(maxWidth: .infinity)
                            .frame(height: 120)
                    case .empty:
                        ZStack {
                            Color.tt.bgSubtleSecondary
                            ProgressView()
                        }
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 120)
                    @unknown default:
                        imageFallback("图片暂不可用")
                            .frame(maxWidth: .infinity)
                            .frame(height: 120)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(maxHeight: 360)
                .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm))
                .contentShape(RoundedRectangle(cornerRadius: TTRadius.sm))
                .onTapGesture {
                    presentImageGallery()
                }
            } else {
                imageFallback(block.summary.isEmpty ? "图片暂不可用" : block.summary)
                    .frame(height: 96)
            }
            if !block.summary.isEmpty, block.summary != displayTitle {
                Text(block.summary)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(3)
            }
        }
        .padding(TTSpacing.sm)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
    }

    @ViewBuilder
    private var widgetBakeFailedFallback: some View {
        // mermaid widget 没有预览图时，移动端本地渲染（对齐 Electron），
        // 渲染失败再落到「去桌面端看」的说明卡。
        if let source = mermaidFallbackSource {
            MermaidBlockView(code: source) {
                widgetDesktopHintCard(mermaidSource: source)
            }
        } else {
            widgetDesktopHintCard(mermaidSource: nil)
        }
    }

    private func widgetDesktopHintCard(mermaidSource: String?) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "macbook.and.iphone")
                    .font(.tt.iconBody)
                    .foregroundStyle(.tt.iconAccent)
                Text("在桌面端查看图示")
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
            }

            Text("移动端暂时只能显示生成后的图示预览；如果这条内容没有图片，可以在桌面端查看完整交互内容。")
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            if let mermaidSource {
                mermaidSourceDisclosure(mermaidSource)
            }
        }
        .padding(TTSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgCanvasDefault))
    }

    private func mermaidSourceDisclosure(_ source: String) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    mermaidSourceExpanded.toggle()
                }
            } label: {
                HStack(spacing: TTSpacing.xs) {
                    Image(systemName: mermaidSourceExpanded ? "chevron.down" : "chevron.right")
                        .font(.tt.iconCaption)
                    Text("Mermaid 源码")
                        .font(.tt.captionSemibold)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.tt.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if mermaidSourceExpanded {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(source)
                        .font(.tt.codeXS)
                        .foregroundStyle(.tt.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(TTSpacing.xs)
                }
                .background(.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.xs))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func widgetUnavailable(_ text: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: TTRadius.sm)
                .fill(.tt.bgSubtleSecondary)
            VStack(spacing: TTSpacing.xs) {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.tt.iconFeature)
                    .foregroundStyle(.tt.iconSecondary)
                Text(text)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .frame(minHeight: 160)
    }

    private var richFileCard: some View {
        HStack(spacing: TTSpacing.sm) {
            // 本地文件：系统 SF Symbol，不叠品牌字形/色底。
            Image(systemName: fileIcon)
                .font(.tt.iconSubtitle)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(block.filename ?? block.title ?? block.resourceName ?? "文件")
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                if let size = block.fileSize {
                    Text(formatByteCount(size))
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
                // 本地交付物只有 tabtin:// 指针、无 https：文件在电脑执行设备上，手机不能预览。
                if !canPreviewFile {
                    Text("请在电脑端打开")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if canPreviewFile {
                Image(systemName: "eye")
                    .font(.tt.iconBody)
                    .foregroundStyle(.tt.iconAccent)
            }
        }
        .padding(TTSpacing.sm)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: TTRadius.sm))
        .opacity(canPreviewFile ? 1 : 0.85)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(canPreviewFile ? .isButton : [])
        .accessibilityLabel(fileAccessibilityLabel)
        .accessibilityHint(canPreviewFile ? "双击预览文件" : "请在电脑端打开")
        .onTapGesture {
            guard canPreviewFile else { return }
            previewAttachment = AttachmentBlock(
                messageId: block.messageId,
                index: block.index,
                kind: .file,
                filename: block.filename ?? block.title ?? "文件",
                mimeType: block.mimeType,
                size: block.fileSize,
                url: block.url,
                fileId: nil
            )
        }
    }

    private var richResourceCard: some View {
        HStack(spacing: TTSpacing.sm) {
            // 在线文档/表格：无白底 AppGlyph，不叠色底；其它类型仍用系统符号。
            resourceLeadingIcon

            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(block.resourceName ?? block.title ?? block.summary.ifEmpty(typeLabel))
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                if let subtitle = resourceSubtitle {
                    Text(subtitle)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if canNavigateResource {
                Text("打开")
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textAccent)
            }
        }
        .padding(TTSpacing.sm)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: TTRadius.sm))
        .opacity(canNavigateResource ? 1 : 0.65)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(canNavigateResource ? .isButton : [])
        .accessibilityLabel(resourceAccessibilityLabel)
        .accessibilityHint(canNavigateResource ? "双击打开资源" : "资源链接暂不可用")
        .onTapGesture {
            navigateResource()
        }
    }

    private var tableFooterRow: some View {
        HStack(spacing: TTSpacing.sm) {
            if let footer = footerText, !footer.isEmpty {
                Text(footer)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if !displayTableRows.isEmpty {
                Button {
                    copyTableMarkdown()
                } label: {
                    Label(tableCopied ? "已复制" : "复制表格", systemImage: tableCopied ? "checkmark" : "doc.on.doc")
                        .font(.tt.captionSemibold)
                }
                .buttonStyle(.plain)
                .foregroundStyle(tableCopied ? .tt.textSuccess : .tt.textAccent)
                .accessibilityLabel(tableCopied ? "表格已复制" : "复制表格为 Markdown")
            }
        }
    }

    private var richTable: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(displayTableRows.enumerated()), id: \.offset) { rowIndex, row in
                    HStack(spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { columnIndex, cell in
                            Text(cell.isEmpty ? " " : cell)
                                .font(rowIndex == 0 ? .tt.captionSemibold : .tt.caption)
                                .foregroundStyle(rowIndex == 0 ? .tt.textPrimary : .tt.textSecondary)
                                .lineLimit(2)
                                .frame(width: columnWidth(columnIndex), alignment: .leading)
                                .padding(.horizontal, TTSpacing.xs)
                                .padding(.vertical, rowIndex == 0 ? 7 : 8)
                                .background(rowBackground(rowIndex))
                                .overlay(alignment: .trailing) {
                                    Rectangle().fill(.tt.borderLight).frame(width: 0.5)
                                }
                        }
                    }
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(.tt.borderLight).frame(height: 0.5)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: TTRadius.xs))
            .overlay(RoundedRectangle(cornerRadius: TTRadius.xs).strokeBorder(.tt.borderLight, lineWidth: 0.5))
        }
    }

    private func imageFallback(_ text: String) -> some View {
        ZStack {
            Color.tt.bgSubtleSecondary
            VStack(spacing: TTSpacing.xs) {
                Image(systemName: "photo")
                    .font(.tt.iconFeature)
                    .foregroundStyle(.tt.iconSecondary)
                Text(text)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(TTSpacing.sm)
        }
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func rowBackground(_ rowIndex: Int) -> Color {
        if rowIndex == 0 { return .tt.bgSubtleSecondary }
        return rowIndex.isMultiple(of: 2) ? .clear : .tt.bgSubtle.opacity(0.45)
    }

    private func columnWidth(_ index: Int) -> CGFloat {
        let maxLength = displayTableRows.reduce(0) { partial, row in
            guard index < row.count else { return partial }
            return max(partial, row[index].count)
        }
        return min(max(CGFloat(maxLength) * 7 + 34, 96), 180)
    }

    private func copyTableMarkdown() {
        UIPasteboard.general.string = markdownTable
        UISelectionFeedbackGenerator().selectionChanged()
        UIAccessibility.post(notification: .announcement, argument: "表格已复制")
        tableCopied = true
        tableCopyResetTask?.cancel()
        tableCopyResetTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1500))
            tableCopied = false
        }
    }

    private var markdownTable: String {
        if let schemaMarkdown = block.tableSchema?.markdownTable(), !schemaMarkdown.isEmpty {
            return schemaMarkdown
        }
        guard let header = displayTableRows.first else { return "" }
        var lines: [String] = []
        lines.append("| " + header.map(Self.markdownCellSafe).joined(separator: " | ") + " |")
        lines.append("| " + header.map { _ in "---" }.joined(separator: " | ") + " |")
        for row in displayTableRows.dropFirst() {
            let padded = (0..<header.count).map { index -> String in
                guard index < row.count else { return "" }
                return Self.markdownCellSafe(row[index])
            }
            lines.append("| " + padded.joined(separator: " | ") + " |")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func markdownCellSafe(_ value: String) -> String {
        value
            .replacingOccurrences(of: "|", with: "\\|")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
    }

    private func navigateResource() {
        guard canNavigateResource,
              let resourceType = block.resourceType,
              let resourceId = block.resourceId else { return }
        NotificationCenter.default.post(
            name: .tabtinResourceNavigation,
            object: nil,
            userInfo: [
                "resource_type": resourceType,
                "resource_id": resourceId,
                "title": block.resourceName ?? block.title ?? block.summary,
            ]
        )
    }

    private var displayKind: RichDisplayKind {
        switch block.kind {
        case "widget":
            return .widget
        case "image":
            return .image
        case "file":
            return .file
        case "resource_ref":
            return .resource
        case "search_results":
            return .searchResults
        case "table", "table_preview":
            return .table
        default:
            if !displayTableRows.isEmpty { return .table }
            if block.url != nil, block.mimeType?.hasPrefix("image/") == true { return .image }
            if block.url != nil, block.filename != nil { return .file }
            if block.resourceId != nil { return .resource }
            return .generic
        }
    }

    private var url: URL? {
        if let fileId = block.fileId, !fileId.isEmpty {
            if resolvedFileId == fileId, let resolvedFileURL { return resolvedFileURL }
            guard let raw = block.url, FormalOssImageAsset.isHTTPURL(raw) else { return nil }
            return URL(string: raw)
        }
        guard let raw = block.url, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    private var displayTitle: String? {
        block.title?.isEmpty == false ? block.title : block.resourceName
    }

    private var searchResultsTitle: String {
        guard let query = block.query?.trimmingCharacters(in: .whitespacesAndNewlines),
              !query.isEmpty else { return "搜索结果" }
        return query
    }

    private var searchResultsCount: Int {
        block.totalCount ?? block.searchResults.count
    }

    private var visibleSearchResults: [RichSearchResult] {
        if showsAllSearchResults { return block.searchResults }
        return Array(block.searchResults.prefix(Self.collapsedSearchResultLimit))
    }

    private func searchResultMetadata(_ result: RichSearchResult) -> String? {
        var parts: [String] = []
        if let contentType = result.contentType { parts.append(contentType) }
        if let source = result.source {
            parts.append(source)
        } else if let rawURL = result.url, let host = URL(string: rawURL)?.host {
            parts.append(host)
        } else if let filePath = result.filePath {
            parts.append(filePath)
        }
        if let score = result.score, score.isFinite {
            let normalizedScore = min(max(score, 0), 1)
            parts.append("\(Int((normalizedScore * 100).rounded()))%")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var mermaidFallbackSource: String? {
        guard block.url?.isEmpty != false else { return nil }
        guard block.format?.lowercased() == "mermaid" else { return nil }
        if let source = block.mermaidSource, !source.isEmpty { return source }
        if let source = block.sourceCode, !source.isEmpty { return source }
        return nil
    }

    private var displayTableRows: [[String]] {
        block.tableSchema?.displayRows ?? block.tableRows
    }

    private var footerText: String? {
        if let footer = block.footer, !footer.isEmpty { return footer }
        guard let total = block.totalRows else { return nil }
        let rendered = max(displayTableRows.count - 1, 0)
        guard total > rendered, rendered > 0 else { return nil }
        return "显示 \(rendered) / \(total) 行"
    }

    private var resourceSubtitle: String? {
        if let space = block.spaceName, !space.isEmpty { return space }
        if let type = block.resourceType, !type.isEmpty { return typeLabel }
        return nil
    }

    private var fileAccessibilityLabel: String {
        var parts = [block.filename ?? block.title ?? "文件"]
        if let size = block.fileSize { parts.append(formatByteCount(size)) }
        if let mime = block.mimeType, !mime.isEmpty { parts.append(mime) }
        return parts.joined(separator: "，")
    }

    private var resourceAccessibilityLabel: String {
        var parts = [block.resourceName ?? block.title ?? block.summary.ifEmpty(typeLabel)]
        if let subtitle = resourceSubtitle { parts.append(subtitle) }
        return parts.joined(separator: "，")
    }

    private var canNavigateResource: Bool {
        block.resourceType?.isEmpty == false && block.resourceId?.isEmpty == false
    }

    private var canPreviewFile: Bool {
        guard let scheme = url?.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    private var fileIcon: String {
        let name = (block.filename ?? "").lowercased()
        if block.mimeType == "application/pdf" || name.hasSuffix(".pdf") { return "doc.richtext" }
        if block.mimeType?.hasPrefix("image/") == true { return "photo" }
        if name.hasSuffix(".zip") || name.hasSuffix(".rar") { return "archivebox" }
        if name.hasSuffix(".csv") || name.hasSuffix(".xlsx") { return "tablecells" }
        return "doc"
    }

    private var icon: String {
        switch block.kind {
        case "table", "table_preview": return "tablecells"
        case "file": return fileIcon
        case "resource_ref": return resourceIcon
        default:
            if block.resourceType == "tabdata" || block.resourceType == "table" { return "tablecells" }
            if block.resourceType == "tabdoc" || block.resourceType == "doc" { return "doc.text" }
            return "sparkles"
        }
    }

    @ViewBuilder
    private var resourceLeadingIcon: some View {
        let normalized = SpaceResource.normalizedType((block.resourceType ?? "").lowercased())
        switch normalized {
        case "tabdoc", "tabdata":
            CloudDocsAppIcon(itemType: normalized, size: 22)
        default:
            Image(systemName: resourceIcon)
                .font(.tt.iconSubtitle)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 22, height: 22)
        }
    }

    private var resourceIcon: String {
        switch block.resourceType {
        case "table", "tabdata": return "tablecells"
        case "doc", "tabdoc", "document": return "doc.text"
        case "slide", "tabslide": return "rectangle.on.rectangle.angled"
        case "site", "tabsite": return "globe"
        case "video": return "film"
        default: return "link"
        }
    }

    private var typeLabel: String {
        switch block.kind {
        case "table", "table_preview": return "表格预览"
        case "file": return "文件"
        case "resource_ref": return "资源引用"
        default: return "富内容"
        }
    }

    private func formatByteCount(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }

    private func presentImageGallery() {
        guard let current = RichImageGalleryItem(block: block, resolvedURL: url) else { return }
        let items = imageGallery.isEmpty ? [current] : imageGallery
        let initialId = items.first(where: { $0.url == current.url })?.id ?? current.id
        previewGallery = RichImageGalleryPreview(items: items, initialItemId: initialId)
    }
}

private struct RichImageGallerySheet: View {
    let preview: RichImageGalleryPreview
    @Environment(\.dismiss) private var dismiss
    @State private var selectedId: String

    init(preview: RichImageGalleryPreview) {
        self.preview = preview
        _selectedId = State(initialValue: preview.initialItemId)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                TabView(selection: $selectedId) {
                    ForEach(preview.items) { item in
                        VStack(spacing: TTSpacing.md) {
                            Spacer(minLength: 0)
                            AsyncImage(url: item.url) { phase in
                                switch phase {
                                case let .success(image):
                                    image
                                        .resizable()
                                        .scaledToFit()
                                case .failure:
                                    galleryPlaceholder("图片加载失败")
                                case .empty:
                                    ProgressView()
                                        .tint(.white)
                                @unknown default:
                                    galleryPlaceholder("图片暂不可用")
                                }
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)

                            if let caption = item.summary ?? item.title {
                                Text(caption)
                                    .font(.tt.meta)
                                    .foregroundStyle(.white.opacity(0.78))
                                    .multilineTextAlignment(.center)
                                    .lineLimit(3)
                                    .padding(.horizontal, TTSpacing.lg)
                            }
                            Spacer(minLength: 0)
                        }
                        .tag(item.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: preview.items.count > 1 ? .automatic : .never))
            }
            .navigationTitle(counterTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                        .foregroundStyle(.white)
                }
                if let selected = selectedItem {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: selected.url) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .foregroundStyle(.white)
                        .accessibilityLabel("分享图片链接")
                    }
                }
            }
        }
    }

    private var selectedItem: RichImageGalleryItem? {
        preview.items.first { $0.id == selectedId } ?? preview.items.first
    }

    private var counterTitle: String {
        guard preview.items.count > 1,
              let selectedIndex = preview.items.firstIndex(where: { $0.id == selectedId }) else {
            return selectedItem?.title ?? "图片"
        }
        return "\(selectedIndex + 1) / \(preview.items.count)"
    }

    private func galleryPlaceholder(_ text: String) -> some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: "photo.badge.exclamationmark")
                .font(.tt.iconEmptyMD)
            Text(text)
                .font(.tt.meta)
        }
        .foregroundStyle(.white.opacity(0.75))
    }
}

private enum RichDisplayKind {
    case widget
    case generic
    case table
    case image
    case file
    case resource
    case searchResults
}

private extension String {
    func ifEmpty(_ fallback: String) -> String {
        isEmpty ? fallback : self
    }
}
