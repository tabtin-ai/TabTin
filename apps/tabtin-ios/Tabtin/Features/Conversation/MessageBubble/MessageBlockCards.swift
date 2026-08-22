import SwiftUI
import UIKit
@preconcurrency import MarkdownUI

enum ContextRefNavigationDestination: Equatable {
    case resource(type: String, id: String)
    case externalURL(URL)
}

enum ContextRefNavigationPolicy {
    static func destination(for block: ContextRefBlock) -> ContextRefNavigationDestination? {
        let externalURL = block.url.flatMap(URL.init(string:))
        if ["web", "webpage", "search_result"].contains(block.type), let externalURL {
            return .externalURL(externalURL)
        }
        if let resourceId = block.resourceId, !resourceId.isEmpty {
            return .resource(type: resourceType(for: block.type), id: resourceId)
        }
        if let externalURL {
            return .externalURL(externalURL)
        }
        return nil
    }

    static func resourceType(for blockType: String) -> String {
        switch blockType {
        case "table", "table_selection": return "tabdata"
        case "document", "doc", "doc_selection": return "tabdoc"
        case "slide", "tabslide": return "tabslide"
        case "site", "tabsite": return "tabsite"
        case "video", "tabvideo": return "tabvideo"
        case "canvas", "whiteboard", "tabwhiteboard": return "tabwhiteboard"
        case "memo", "tabmemo": return "tabmemo"
        case "goal", "tracker", "tabtracker", "tabgoal": return "tabtracker"
        case "code", "code_file", "tabcode": return "tabcode"
        default: return blockType
        }
    }
}

// MARK: - Attachment block

struct AttachmentBlockCard: View {
    let attachment: AttachmentBlock
    var onPreview: () -> Void

    private var url: URL? {
        guard let raw = attachment.url else { return nil }
        return URL(string: raw)
    }

    @ViewBuilder var body: some View {
        if attachment.kind == .image, let url {
            imagePreview(url: url)
        } else {
            fileCard
        }
    }

    private func imagePreview(url: URL) -> some View {
        Button {
            onPreview()
        } label: {
            AsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    placeholderImage("exclamationmark.triangle")
                case .empty:
                    placeholderImage("photo")
                @unknown default:
                    placeholderImage("photo")
                }
            }
            .frame(width: 200, height: 150)
            .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("查看图片 \(attachment.filename)")
    }

    private var fileCard: some View {
        Button {
            onPreview()
        } label: {
            HStack(spacing: TTSpacing.sm) {
                Image(systemName: icon)
                    .font(.tt.iconSubtitleMedium)
                    .foregroundStyle(.tt.iconAccent)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(.tt.bgAccent.opacity(0.12)))
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(attachment.filename)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(metaText)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: TTSpacing.sm)
                Image(systemName: url == nil ? "exclamationmark.circle" : "arrow.up.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.sm)
            .frame(maxWidth: 280, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous).fill(.tt.bgSubtle))
            .overlay(RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous).strokeBorder(.tt.borderLight, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .disabled(url == nil)
        .opacity(url == nil ? 0.7 : 1)
    }

    private var icon: String {
        switch attachment.kind {
        case .image: return "photo"
        case .file:
            if attachment.mimeType?.contains("pdf") == true { return "doc.richtext" }
            return "doc"
        }
    }

    private var metaText: String {
        var parts: [String] = []
        parts.append(attachment.kind == .image ? "图片" : "文件")
        if let mimeType = attachment.mimeType, !mimeType.isEmpty {
            parts.append(mimeType)
        }
        if let size = attachment.size {
            parts.append(Self.formatBytes(size))
        }
        return parts.joined(separator: " · ")
    }

    private func placeholderImage(_ systemName: String) -> some View {
        ZStack {
            Color.tt.bgSubtleSecondary
            Image(systemName: systemName)
                .font(.tt.iconEmptyMedium)
                .foregroundStyle(.tt.textTertiary)
        }
    }

    private static func formatBytes(_ bytes: Int64) -> String {
        let value = Double(bytes)
        if value >= 1024 * 1024 {
            return String(format: "%.1f MB", value / 1024 / 1024)
        }
        if value >= 1024 {
            return String(format: "%.0f KB", value / 1024)
        }
        return "\(bytes) B"
    }
}

struct ContextRefBlockCard: View {
    let block: ContextRefBlock

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            contextRefLeadingIcon
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(typeLabel)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                Text(block.label)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                if let preview = block.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
                if let locationHint = displayLocationHint {
                    Text(locationHint)
                        .font(.tt.codeXS)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if canNavigate {
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .padding(TTSpacing.sm)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
        .contentShape(RoundedRectangle(cornerRadius: TTRadius.sm))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(canNavigate ? .isButton : [])
        .accessibilityHint(canNavigate ? "双击打开引用资源" : "")
        .onTapGesture {
            navigate()
        }
    }

    private var typeLabel: String {
        switch block.type {
        case "web", "webpage", "search_result": return "网页引用"
        case "table_selection", "table": return "表格引用"
        case "doc_selection", "document", "doc": return "文档引用"
        case "slide", "tabslide": return "演示引用"
        case "design", "tabdesign": return "设计引用"
        case "video", "tabvideo": return "视频引用"
        case "site", "tabsite": return "站点引用"
        case "folder": return "文件夹引用"
        case "code_file", "code", "tabcode": return "代码引用"
        case "memo", "tabmemo": return "笔记引用"
        case "goal", "tracker", "tabtracker", "tabgoal": return "任务引用"
        case "canvas", "whiteboard", "tabwhiteboard": return "画板引用"
        default: return "上下文引用"
        }
    }

    private var canNavigate: Bool {
        block.resourceId?.isEmpty == false || block.url?.isEmpty == false
    }

    private var navigationResourceType: String {
        ContextRefNavigationPolicy.resourceType(for: block.type)
    }

    private var displayLocationHint: String? {
        if let locationHint = block.locationHint, !locationHint.isEmpty {
            return locationHint
        }
        var parts: [String] = []
        if !block.rowIds.isEmpty {
            parts.append(block.rowIds.count == 1 ? "记录 \(block.rowIds[0])" : "\(block.rowIds.count) 条记录")
        }
        if !block.fieldIds.isEmpty {
            parts.append(block.fieldIds.count == 1 ? "字段 \(block.fieldIds[0])" : "\(block.fieldIds.count) 个字段")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func navigate() {
        guard let destination = ContextRefNavigationPolicy.destination(for: block) else { return }
        switch destination {
        case let .externalURL(url):
            guard UIApplication.shared.canOpenURL(url) else { return }
            UIApplication.shared.open(url)
        case let .resource(resourceType, resourceId):
            postResourceNavigation(resourceType: resourceType, resourceId: resourceId)
        }
    }

    private func postResourceNavigation(resourceType: String, resourceId: String) {
        var userInfo: [String: Any] = [
            "resource_type": resourceType,
            "resource_id": resourceId,
            "label": block.label,
        ]
        if let locationHint = displayLocationHint {
            userInfo["location_hint"] = locationHint
        }
        if let tableId = block.tableId, !tableId.isEmpty {
            userInfo["table_id"] = tableId
        }
        if let docId = block.docId, !docId.isEmpty {
            userInfo["doc_id"] = docId
        }
        if !block.rowIds.isEmpty {
            userInfo["row_ids"] = block.rowIds
        }
        if !block.fieldIds.isEmpty {
            userInfo["field_ids"] = block.fieldIds
        }
        NotificationCenter.default.post(
            name: .tabtinResourceNavigation,
            object: nil,
            userInfo: userInfo
        )
    }

    @ViewBuilder
    private var contextRefLeadingIcon: some View {
        switch SpaceResource.normalizedType(navigationResourceType) {
        case "tabdoc", "tabdata":
            // 在线文档/表格：无白底 AppGlyph，不叠色底。
            CloudDocsAppIcon(itemType: navigationResourceType, size: 22)
        default:
            Image(systemName: icon)
                .font(.tt.iconBodyMedium)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 22, height: 22)
        }
    }

    private var icon: String {
        switch block.type {
        case "web", "webpage", "search_result": return "globe"
        case "table_selection", "table": return "tablecells"
        case "doc_selection", "document", "doc": return "doc.text"
        case "slide", "tabslide": return "rectangle.on.rectangle.angled"
        case "design", "tabdesign": return "paintpalette"
        case "video", "tabvideo": return "film"
        case "site", "tabsite": return "globe"
        case "folder": return "folder"
        case "code_file", "code", "tabcode": return "chevron.left.forwardslash.chevron.right"
        case "memo", "tabmemo": return "note.text"
        case "goal", "tracker", "tabtracker", "tabgoal": return "target"
        case "canvas", "whiteboard", "tabwhiteboard": return "scribble.variable"
        default: return "link"
        }
    }
}
