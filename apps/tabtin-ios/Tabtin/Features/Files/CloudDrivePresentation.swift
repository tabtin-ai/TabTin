import Foundation
import SwiftUI

struct TabularPreviewContent: Equatable, Sendable {
    let fieldNames: [String]
    let previewText: String?

    init(fieldNames: [String] = [], previewText: String?) {
        let visibleFields = Array(fieldNames.compactMap(Self.normalized).prefix(3))
        let visiblePreview = Self.normalized(previewText)
        if visibleFields.isEmpty,
           let inferredFields = Self.schemaFields(from: visiblePreview) {
            self.fieldNames = inferredFields
            self.previewText = nil
        } else {
            self.fieldNames = visibleFields
            self.previewText = visiblePreview
        }
    }

    var hasContent: Bool { !fieldNames.isEmpty || previewText != nil }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private static func schemaFields(from preview: String?) -> [String]? {
        guard let preview, preview.contains("|") else { return nil }
        let fields = preview.split(separator: "|", omittingEmptySubsequences: true)
            .compactMap { part -> String? in
                let value = String(part)
                    .replacingOccurrences(of: #"\s*/?\.{3}\s*$"#, with: "", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return value.isEmpty ? nil : value
            }
        guard fields.count >= 2 else { return nil }
        return Array(fields.prefix(3))
    }
}

/// 云盘文件的展示分类。资源类型只决定 TabTin 原生资源，普通文件由 MIME 优先、扩展名兜底。
enum CloudDriveFileKind: String, Equatable, Sendable {
    case folder
    case tabdoc
    case tabdata
    case image
    case pdf
    case word
    case spreadsheet
    case presentation
    case text
    case audio
    case video
    case archive
    case file
}

enum CloudDrivePresentationResolver {
    static func safePreviewText(_ value: String?) -> String? {
        guard let text = value?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        let lowered = text.lowercased()
        guard !lowered.hasPrefix("http://"),
              !lowered.hasPrefix("https://"),
              !lowered.hasPrefix("//"),
              !lowered.hasPrefix("data:"),
              !lowered.hasPrefix("blob:") else { return nil }
        return text
    }

    static func kind(
        itemType: String?,
        title: String?,
        mimeType: String?,
        fileExtension: String?
    ) -> CloudDriveFileKind {
        switch SpaceResource.normalizedType(normalized(itemType)) {
        case "tabdoc": return .tabdoc
        case "tabdata": return .tabdata
        default: break
        }

        if let mimeKind = kind(forMIME: normalizedMIME(mimeType)) {
            return mimeKind
        }

        let suffix = normalizedExtension(fileExtension, title: title)
        switch suffix {
        case "jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "bmp", "tif", "tiff", "svg", "avif":
            return .image
        case "pdf":
            return .pdf
        case "doc", "docx", "pages", "rtf", "odt":
            return .word
        case "xls", "xlsx", "csv", "tsv", "ods", "numbers":
            return .spreadsheet
        case "ppt", "pptx", "key", "odp":
            return .presentation
        case "txt", "md", "markdown", "json", "jsonl", "code", "xml", "yaml", "yml", "toml", "ini", "cfg",
             "conf", "log", "swift", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt",
             "kts", "c", "cc", "cpp", "h", "hpp", "css", "scss", "html", "htm", "sh", "zsh", "bash", "sql":
            return .text
        case "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus":
            return .audio
        case "mp4", "mov", "m4v", "avi", "mkv", "webm", "mpeg", "mpg":
            return .video
        case "zip", "rar", "7z", "tar", "gz", "tgz", "bz", "bz2", "xz":
            return .archive
        default:
            return .file
        }
    }

    private static func kind(forMIME mime: String?) -> CloudDriveFileKind? {
        guard let mime, !mime.isEmpty else { return nil }
        if mime.hasPrefix("image/") { return .image }
        if mime == "application/pdf" { return .pdf }
        if mime.hasPrefix("audio/") { return .audio }
        if mime.hasPrefix("video/") { return .video }

        switch mime {
        case "application/msword",
             "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
             "application/vnd.apple.pages", "application/rtf", "application/vnd.oasis.opendocument.text":
            return .word
        case "application/vnd.ms-excel",
             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
             "application/vnd.apple.numbers", "application/vnd.oasis.opendocument.spreadsheet",
             "text/csv", "application/csv":
            return .spreadsheet
        case "application/vnd.ms-powerpoint",
             "application/vnd.openxmlformats-officedocument.presentationml.presentation",
             "application/vnd.apple.keynote", "application/vnd.oasis.opendocument.presentation":
            return .presentation
        case "application/json", "application/ld+json", "application/xml", "application/javascript",
             "application/x-javascript", "application/sql", "application/x-httpd-php", "application/x-sh",
             "application/x-yaml":
            return .text
        case "application/zip", "application/x-zip-compressed", "application/vnd.rar",
             "application/x-rar-compressed", "application/x-7z-compressed", "application/x-tar",
             "application/gzip", "application/x-gzip", "application/x-bzip", "application/x-bzip2",
             "application/x-compressed-tar", "application/x-xz":
            return .archive
        default:
            return mime.hasPrefix("text/") ? .text : nil
        }
    }

    private static func normalizedMIME(_ value: String?) -> String? {
        guard let value else { return nil }
        let mime = value.split(separator: ";", maxSplits: 1).first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return mime?.isEmpty == false ? mime : nil
    }

    private static func normalizedExtension(_ explicit: String?, title: String?) -> String {
        let supplied = normalized(explicit).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        if !supplied.isEmpty { return supplied }
        guard let title else { return "" }
        return (title as NSString).pathExtension
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private static func normalized(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }
}

struct CloudDriveRowPresentation: Equatable, Sendable {
    let kind: CloudDriveFileKind
    let title: String
    let preview: String?
    let fileSizeBytes: Int?
    let updatedAt: String?
    let lastVisitedAt: String?
    let organizationId: String
    let contextItemId: String
    let fileRecordId: String

    init(row: CloudDriveListRow) {
        switch row {
        case .folder:
            kind = .folder
            title = row.title
            preview = nil
            fileSizeBytes = nil
            updatedAt = nil
            lastVisitedAt = nil
            organizationId = ""
            contextItemId = ""
            fileRecordId = ""
        case let .resource(resource):
            kind = CloudDrivePresentationResolver.kind(
                itemType: resource.itemType,
                title: resource.fileName ?? resource.title,
                mimeType: resource.mimeType,
                fileExtension: resource.fileExtension
            )
            title = row.title
            preview = CloudDrivePresentationResolver.safePreviewText(resource.preview)
            fileSizeBytes = resource.fileSizeBytes
            updatedAt = resource.updatedAt
            lastVisitedAt = resource.lastVisitedAt
            organizationId = resource.organizationId ?? ""
            contextItemId = resource.contextItemId
            fileRecordId = resource.fileRecordId ?? resource.resourceId
        case let .shared(resource):
            kind = CloudDrivePresentationResolver.kind(
                itemType: Self.nonempty(resource.itemType) ?? resource.resourceType.itemType,
                title: SpaceResource.metadataString(resource.metadata, keys: ["file_name", "filename", "name"]) ?? resource.title,
                mimeType: SpaceResource.metadataString(resource.metadata, keys: ["mime_type", "mime", "content_type"]),
                fileExtension: SpaceResource.metadataString(resource.metadata, keys: ["file_extension", "extension", "ext"])
            )
            title = row.title
            preview = CloudDrivePresentationResolver.safePreviewText(resource.preview)
            fileSizeBytes = SpaceResource.metadataInt(resource.metadata, keys: ["size", "file_size", "size_bytes", "bytes"])
            updatedAt = resource.updatedAt
            lastVisitedAt = nil
            organizationId = resource.organizationId
            contextItemId = resource.contextItemId ?? ""
            fileRecordId = resource.fileRecordId ?? resource.resourceId
        }
    }

    init(output: TaskWorkbenchOutput, organizationId: String) {
        if let resource = output.resource {
            self.init(row: .resource(resource))
            return
        }
        self.init(
            kind: CloudDrivePresentationResolver.kind(
                itemType: "tabfiles",
                title: output.title,
                mimeType: output.mimeType,
                fileExtension: nil
            ),
            title: output.title,
            preview: CloudDrivePresentationResolver.safePreviewText(output.preview),
            fileSizeBytes: nil,
            updatedAt: nil,
            lastVisitedAt: nil,
            organizationId: organizationId,
            contextItemId: "",
            fileRecordId: output.resourceId
        )
    }

    private init(
        kind: CloudDriveFileKind,
        title: String,
        preview: String?,
        fileSizeBytes: Int?,
        updatedAt: String?,
        lastVisitedAt: String?,
        organizationId: String,
        contextItemId: String,
        fileRecordId: String
    ) {
        self.kind = kind
        self.title = title
        self.preview = preview
        self.fileSizeBytes = fileSizeBytes
        self.updatedAt = updatedAt
        self.lastVisitedAt = lastVisitedAt
        self.organizationId = organizationId
        self.contextItemId = contextItemId
        self.fileRecordId = fileRecordId
    }

    var accessContext: CloudFileDetailContext {
        CloudFileDetailContext(
            contextItemId: contextItemId,
            fileRecordId: fileRecordId,
            organizationId: organizationId,
            title: title
        )
    }

    fileprivate static func nonempty(_ value: String?) -> String? {
        guard let text = value?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
}

private extension SharedResourceType {
    var itemType: String {
        switch self {
        case .doc: return "tabdoc"
        case .table: return "tabdata"
        case .file: return "tabfiles"
        }
    }
}

enum CloudDriveResumeProjector {
    static func mostRecentlyVisited(in resources: [SpaceResource]) -> SpaceResource? {
        resources.compactMap { resource -> (SpaceResource, Date)? in
            guard resource.canView != false,
                  resource.appRoute != nil,
                  let value = resource.lastVisitedAt,
                  let date = ISO8601DateParser.date(from: value) else { return nil }
            return (resource, date)
        }
        .max { $0.1 < $1.1 }?.0
    }
}

enum CloudDriveHomeVisibilityPolicy {
    static func shouldShowResumeHero(
        scope: CloudDriveScope,
        isSearching: Bool,
        isAtRoot: Bool
    ) -> Bool {
        scope != .shared && !isSearching && isAtRoot
    }

    static func shouldShowQuickActions(
        scope: CloudDriveScope,
        isSearching: Bool
    ) -> Bool {
        scope != .shared && !isSearching
    }
}

extension CloudDriveFileKind {
    var typeLabel: String {
        switch self {
        case .folder: return "文件夹"
        case .tabdoc: return "云文档"
        case .tabdata: return "多维表"
        case .image: return "图片"
        case .pdf: return "PDF"
        case .word: return "文稿"
        case .spreadsheet: return "表格"
        case .presentation: return "演示"
        case .text: return "文本与代码"
        case .audio: return "音频"
        case .video: return "视频"
        case .archive: return "压缩包"
        case .file: return "文件"
        }
    }

    var systemImage: String {
        switch self {
        case .folder: return "folder.fill"
        case .tabdoc: return "doc.text.fill"
        case .tabdata: return "tablecells.fill"
        case .image: return "photo.fill"
        case .pdf: return "doc.richtext.fill"
        case .word: return "doc.text.fill"
        case .spreadsheet: return "tablecells.fill"
        case .presentation: return "rectangle.on.rectangle.angled"
        case .text: return "doc.plaintext.fill"
        case .audio: return "waveform"
        case .video: return "play.rectangle.fill"
        case .archive: return "archivebox.fill"
        case .file: return "doc.fill"
        }
    }

    var accent: Color {
        switch self {
        case .folder, .presentation, .archive: return .tt.textWarning
        case .tabdoc, .image, .word, .video: return .tt.textRunning
        case .tabdata, .spreadsheet, .audio: return .tt.textSuccess
        case .pdf: return .tt.textCritical
        case .text, .file: return .tt.textSecondary
        }
    }
}

struct CloudDriveResourceGlyph: View {
    let kind: CloudDriveFileKind
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .fill(kind.accent.opacity(0.12))
            CloudDriveResourceIcon(kind: kind, size: size * 0.56)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// 云盘资源的裸内容图标。Composer 引用候选与云盘缩略图共用同一分类和符号，
/// 但不重复套背景；TabDoc / TabData 固定使用无白底 AppGlyph 资产。
struct CloudDriveResourceIcon: View {
    let kind: CloudDriveFileKind
    var size: CGFloat = 22

    var body: some View {
        if kind == .tabdoc {
            AppIconImage(reference: .asset("AppGlyphTabdoc"), size: size)
        } else if kind == .tabdata {
            AppIconImage(reference: .asset("AppGlyphTabdata"), size: size)
        } else {
            Image(systemName: kind.systemImage)
                .resizable()
                .scaledToFit()
                .foregroundStyle(kind.accent)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

struct CloudDriveAppChrome: View {
    let title: String
    let subtitle: String?
    let usesCloseIcon: Bool
    let onDismiss: () -> Void
    let onCreate: () -> Void

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            chromeButton(
                systemImage: usesCloseIcon ? "xmark" : "chevron.left",
                label: usesCloseIcon ? L10n.Common.close : L10n.WorkbenchAppHome.backToWorkbench,
                action: onDismiss
            )
            Spacer(minLength: TTSpacing.sm)
            VStack(spacing: TTSpacing.xxs) {
                Text(title)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            Spacer(minLength: TTSpacing.sm)
            chromeButton(
                systemImage: "plus",
                label: L10n.CloudDrive.actionsTitle,
                action: onCreate
            )
        }
        .padding(.horizontal, TTSpacing.md)
        .frame(minHeight: 60)
        .background(.tt.bgCanvasDefault)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(.tt.borderLight)
                .frame(height: 0.5)
        }
    }

    private func chromeButton(systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.tt.iconSubtitle)
                .foregroundStyle(.tt.iconPrimary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct CloudDriveQuickActionButton: View {
    let title: String
    let systemImage: String
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: TTSpacing.sm) {
                Image(systemName: systemImage)
                    .font(.tt.iconSubtitle)
                    .foregroundStyle(isEnabled ? .tt.textAccent : .tt.textDisabled)
                    .frame(width: 32, height: 32)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
                Text(title)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(isEnabled ? .tt.textPrimary : .tt.textDisabled)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(TTSpacing.md)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous)
                    .stroke(.tt.borderLight, lineWidth: 0.5)
            }
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
    }
}
