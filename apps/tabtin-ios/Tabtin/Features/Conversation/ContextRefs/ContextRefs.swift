import Foundation
import AVKit
import os
import PDFKit
import QuickLook
import SwiftUI
import UIKit

// MARK: - Context refs

enum ContextRefType: String, Hashable, Sendable {
    case table
    case document
    case field
    case slide
    case design
    case video
    case site
    case folder
    /// 云盘 / TabFiles：wire `type=file` + `file_id` = FileRecordID。
    case file
    case memo
    case tracker
    case whiteboard
    case code

    static func fromItemType(_ rawType: String) -> ContextRefType {
        switch rawType {
        case "tabdata", "table":
            return .table
        case "tabdoc", "document":
            return .document
        case "field":
            return .field
        case "tabslide", "slide", "ppt":
            return .slide
        case "tabdesign", "design":
            return .design
        case "tabvideo", "video":
            return .video
        case "tabsite", "site":
            return .site
        case "tabfiles", "file":
            return .file
        case "folder", "tabfolder":
            return .folder
        case "tabmemo", "memo":
            return .memo
        case "tabtracker", "tabgoal", "goal":
            return .tracker
        case "tabwhiteboard", "canvas", "whiteboard":
            return .whiteboard
        case "tabcode", "code":
            return .code
        default:
            return .document
        }
    }

    var wireType: String {
        switch self {
        case .table, .field:
            return "table_selection"
        case .document:
            return "doc_selection"
        case .tracker:
            return "goal"
        case .whiteboard:
            return "canvas"
        case .file:
            return "file"
        default:
            return rawValue
        }
    }

    var resourceType: String {
        switch self {
        case .table, .field: return "tabdata"
        case .document: return "tabdoc"
        case .slide: return "tabslide"
        case .design: return "tabdesign"
        case .video: return "tabvideo"
        case .site: return "tabsite"
        case .folder: return "tabfolder"
        case .file: return "tabfiles"
        case .memo: return "tabmemo"
        case .tracker: return "tabtracker"
        case .whiteboard: return "tabwhiteboard"
        case .code: return "tabcode"
        }
    }
}

struct MentionContextRef: Identifiable, Hashable, Sendable {
    let id: String
    let type: ContextRefType
    let resourceId: String
    let label: String
    let preview: String?
    let spaceId: String?
    let spaceName: String?
    let tableId: String?

    init(
        id: String = "ref-\(UUID().uuidString.prefix(8))",
        type: ContextRefType,
        resourceId: String,
        label: String,
        preview: String? = nil,
        spaceId: String? = nil,
        spaceName: String? = nil,
        tableId: String? = nil
    ) {
        self.id = id
        self.type = type
        self.resourceId = resourceId
        self.label = label
        self.preview = preview
        self.spaceId = spaceId
        self.spaceName = spaceName
        self.tableId = tableId
    }

    func blockPayload() -> [String: Any] {
        var payload: [String: Any] = [
            "type": type.wireType,
            "preview": preview ?? label,
            "label": label,
            "resource_id": resourceId,
        ]
        switch type {
        case .table:
            payload["table_id"] = resourceId
        case .field:
            payload["table_id"] = tableId
            payload["field_ids"] = [resourceId]
            payload["location_hint"] = "字段 \(resourceId)"
        case .document:
            payload["doc_id"] = resourceId
        case .file:
            //  / Electron ENCODE_BY_REF_TYPE['file']：关键 ID 必须是 FileRecordID。
            payload["file_id"] = resourceId
        default:
            break
        }
        if let spaceId { payload["space_id"] = spaceId }
        if let spaceName { payload["space_name"] = spaceName }
        return payload
    }
}

extension SpaceResource {
    func toMentionContextRef(fallbackSpaceName: String?) -> MentionContextRef {
        let refType = ContextRefType.fromItemType(normalizedType)
        return MentionContextRef(
            type: refType,
            resourceId: resourceId,
            label: displayTitle,
            preview: preview,
            spaceId: spaceId,
            spaceName: spaceName ?? fallbackSpaceName,
            tableId: metadata?["table_id"]?.stringValue
        )
    }
}

struct ContextRefChip: View {
    let ref: MentionContextRef
    var onOpen: (() -> Void)? = nil
    var onRemove: () -> Void

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            if let onOpen {
                Button(action: onOpen) {
                    content
                }
                .buttonStyle(.plain)
                .accessibilityLabel("打开\(ref.label)")
            } else {
                content
            }
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, 5)
        .background(Capsule().fill(.tt.bgSubtle))
        .overlay(Capsule().strokeBorder(.tt.borderLight, lineWidth: 0.5))
    }

    private var content: some View {
        HStack(spacing: TTSpacing.xs) {
            ContextResourceIcon(
                itemType: ref.type.resourceType,
                title: ref.label,
                size: 14
            )
            Text(ref.label)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
        }
    }

}

/// Composer 上下文资源图标：云文档 / 多维表使用 TabTin 无白底 glyph；普通文件按
/// MIME / 扩展名复用云盘分类；其余内置资源复用同一套 App 资产。
struct ContextResourceIcon: View {
    let itemType: String
    let title: String?
    let mimeType: String?
    let fileExtension: String?
    var size: CGFloat = 22

    init(resource: SpaceResource, size: CGFloat = 22) {
        itemType = resource.normalizedType
        title = resource.fileName ?? resource.displayTitle
        mimeType = resource.mimeType
        fileExtension = resource.fileExtension
        self.size = size
    }

    init(
        itemType: String,
        title: String? = nil,
        mimeType: String? = nil,
        fileExtension: String? = nil,
        size: CGFloat = 22
    ) {
        self.itemType = itemType
        self.title = title
        self.mimeType = mimeType
        self.fileExtension = fileExtension
        self.size = size
    }

    var body: some View {
        let normalized = SpaceResource.normalizedType(itemType)
        if normalized == "tabdoc" || normalized == "tabdata" || normalized == "tabfiles" {
            CloudDriveResourceIcon(
                kind: CloudDrivePresentationResolver.kind(
                    itemType: normalized,
                    title: title,
                    mimeType: mimeType,
                    fileExtension: fileExtension
                ),
                size: size
            )
        } else {
            AppIconImage(
                reference: AppIconResolver.resolveContentGlyph(
                    appId: normalized == "tabsite" ? "tabweb" : normalized,
                    manifestIcon: SpaceResource.icon(forType: normalized)
                ),
                size: size
            )
        }
    }
}

struct ContextRefPickerSheet: View {
    let spaceId: String
    let spaceName: String
    var onSelect: (MentionContextRef) -> Void
    var onClose: () -> Void

    @State private var viewModel: WorkbenchViewModel

    init(
        spaceId: String,
        spaceName: String,
        onSelect: @escaping (MentionContextRef) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.spaceId = spaceId
        self.spaceName = spaceName
        self.onSelect = onSelect
        self.onClose = onClose
        _viewModel = State(initialValue: WorkbenchViewModel(spaceId: spaceId))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.resources.isEmpty {
                    ProgressView("加载上下文…")
                } else if viewModel.resources.isEmpty {
                    ContentUnavailableView("暂无可引用内容", systemImage: "link")
                } else {
                    List(viewModel.resources) { resource in
                        Button {
                            onSelect(resource.toMentionContextRef(fallbackSpaceName: spaceName))
                            onClose()
                        } label: {
                            HStack(spacing: TTSpacing.sm) {
                                ContextResourceIcon(resource: resource)
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                    Text(resource.displayTitle)
                                        .font(.tt.body)
                                        .foregroundStyle(.tt.textPrimary)
                                    Text(resource.typeLabel)
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textTertiary)
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("添加上下文")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", action: onClose)
                }
            }
            .task { await viewModel.load() }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

struct MentionPopover: View {
    let resources: [SpaceResource]
    let query: String
    let currentSpaceName: String?
    var onSelect: (MentionContextRef) -> Void
    var onDismiss: () -> Void

    private var filtered: [SpaceResource] {
        let keyword = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let candidates = resources
            .filter { !$0.isArchived.orFalse }
            .sorted {
                if ($0.isPinned ?? false) != ($1.isPinned ?? false) { return ($0.isPinned ?? false) }
                return $0.sortTimestamp > $1.sortTimestamp
            }
        guard !keyword.isEmpty else { return Array(candidates.prefix(24)) }
        return Array(candidates.filter {
            $0.displayTitle.lowercased().contains(keyword)
                || $0.typeLabel.lowercased().contains(keyword)
        }.prefix(24))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "at")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.iconAccent)
                Text(query.isEmpty ? "引用上下文" : "搜索 \(query)")
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textTertiary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xs)

            Divider().overlay(Color.tt.borderLight.opacity(0.5))

            if filtered.isEmpty {
                VStack(spacing: TTSpacing.xs) {
                    Image(systemName: "magnifyingglass")
                        .font(.tt.iconSubtitle)
                    Text(resources.isEmpty ? "暂无可引用内容" : "没有匹配的内容")
                        .font(.tt.caption)
                }
                .foregroundStyle(.tt.textTertiary)
                .frame(maxWidth: .infinity)
                .padding(TTSpacing.md)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered) { resource in
                            Button {
                                onSelect(resource.toMentionContextRef(fallbackSpaceName: currentSpaceName))
                            } label: {
                                HStack(spacing: TTSpacing.sm) {
                                    ContextResourceIcon(resource: resource, size: 20)
                                        .frame(width: 24, height: 24)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(resource.displayTitle)
                                            .font(.tt.meta)
                                            .foregroundStyle(.tt.textPrimary)
                                            .lineLimit(1)
                                        HStack(spacing: 4) {
                                            Text(resource.typeLabel)
                                            if let name = resource.spaceName ?? currentSpaceName, !name.isEmpty {
                                                Text("·")
                                                Text(name)
                                            }
                                        }
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textTertiary)
                                        .lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, TTSpacing.sm)
                                .padding(.vertical, TTSpacing.xs)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 260)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .fill(.tt.bgCanvasDefault)
                .shadow(color: .black.opacity(0.14), radius: 14, x: 0, y: 4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        )
    }
}

private extension Optional where Wrapped == Bool {
    var orFalse: Bool { self ?? false }
}
