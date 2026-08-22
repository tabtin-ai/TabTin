import SwiftUI

struct CloudDriveResumeCard: View {
    let presentation: CloudDriveRowPresentation
    let onPreview: () -> Void

    init(row: CloudDriveListRow, onPreview: @escaping () -> Void) {
        self.presentation = CloudDriveRowPresentation(row: row)
        self.onPreview = onPreview
    }

    init(presentation: CloudDriveRowPresentation, onPreview: @escaping () -> Void) {
        self.presentation = presentation
        self.onPreview = onPreview
    }

    var body: some View {
        Button(action: onPreview) {
            HStack(spacing: TTSpacing.lg) {
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    Text(presentation.kind.typeLabel)
                        .font(.tt.captionSemibold)
                        .foregroundStyle(presentation.kind.accent)
                    Text(presentation.title)
                        .font(.tt.titleSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if let metadataText {
                        Text(metadataText)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(3)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)

                CloudDrivePreviewArtwork(presentation: presentation, compact: true)
                    .frame(width: 114, height: 118)
            }
            .padding(TTSpacing.lg)
            .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: TTRadius.xl, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.xl, style: .continuous)
                    .stroke(.tt.borderLight, lineWidth: 0.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            L10n.WorkbenchAppHome.continuePreviewNamed(
                presentation.kind.typeLabel,
                title: presentation.title
            )
        )
    }

    private var metadataText: String? {
        if let preview = presentation.preview { return preview }
        if let size = presentation.fileSizeBytes, size > 0 {
            return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
        }
        let rawDate = presentation.lastVisitedAt ?? presentation.updatedAt
        if let rawDate, let relative = RelativeTime.format(rawDate) { return relative }
        return nil
    }
}

struct CloudDrivePreviewSheet: View {
    let row: CloudDriveListRow
    let onContinue: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var continueOnDismiss = false

    private var presentation: CloudDriveRowPresentation { .init(row: row) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.xl) {
                    CloudDrivePreviewArtwork(presentation: presentation, compact: false)
                        .frame(maxWidth: .infinity)
                        .frame(height: 248)

                    VStack(alignment: .leading, spacing: TTSpacing.sm) {
                        HStack(spacing: TTSpacing.sm) {
                            CloudDriveResourceGlyph(kind: presentation.kind, size: 40)
                            Text(presentation.title)
                                .font(.tt.subtitleSemibold)
                                .foregroundStyle(.tt.textPrimary)
                                .lineLimit(3)
                        }
                        if let metadataText {
                            Text(metadataText)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                        }
                        if let preview = presentation.preview,
                           [.tabdoc, .word, .pdf, .text].contains(presentation.kind) {
                            Text(preview)
                                .font(presentation.kind == .text ? .tt.codeSM : .tt.body)
                                .foregroundStyle(.tt.textSecondary)
                                .lineLimit(6)
                        }
                    }
                }
                .padding(TTSpacing.lg)
            }
            .background(.tt.bgCanvasDefault)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: TTSpacing.md) {
                    Button(L10n.WorkbenchAppHome.previewLater) { dismiss() }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    Button {
                        continueOnDismiss = true
                        dismiss()
                    } label: {
                        Text(L10n.WorkbenchAppHome.continueHandle)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.md)
                .background(.tt.bgCanvasDefault)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.close) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onDisappear {
            guard continueOnDismiss else { return }
            continueOnDismiss = false
            onContinue()
        }
    }

    private var metadataText: String? {
        var parts: [String] = []
        if let size = presentation.fileSizeBytes, size > 0 {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
        }
        if let rawDate = presentation.lastVisitedAt ?? presentation.updatedAt,
           let relative = RelativeTime.format(rawDate) {
            parts.append(relative)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct CloudDrivePreviewArtwork: View {
    let presentation: CloudDriveRowPresentation
    let compact: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: compact ? TTRadius.lg : TTRadius.xl, style: .continuous)
                .fill(presentation.kind.accent.opacity(0.10))
            if presentation.kind == .image {
                CloudFileLiveImagePreview(
                    context: presentation.accessContext,
                    title: presentation.title,
                    compact: compact
                )
            } else {
                artwork
                    .padding(compact ? TTSpacing.sm : TTSpacing.xxl)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: compact ? TTRadius.lg : TTRadius.xl, style: .continuous))
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var artwork: some View {
        switch presentation.kind {
        case .tabdoc, .word, .pdf, .text:
            documentArtwork
        case .tabdata, .spreadsheet:
            tableArtwork
        case .image:
            EmptyView()
        case .presentation:
            presentationArtwork
        case .audio:
            audioArtwork
        case .video:
            Image(systemName: "play.rectangle.fill")
                .font(compact ? .tt.iconEmpty : .tt.iconEmptyHero)
                .foregroundStyle(presentation.kind.accent)
        case .archive:
            Image(systemName: "archivebox.fill")
                .font(compact ? .tt.iconEmpty : .tt.iconEmptyHero)
                .foregroundStyle(presentation.kind.accent)
        case .folder, .file:
            Image(systemName: presentation.kind.systemImage)
                .font(compact ? .tt.iconEmpty : .tt.iconEmptyHero)
                .foregroundStyle(presentation.kind.accent)
        }
    }

    private var documentArtwork: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack {
                CloudDriveResourceGlyph(kind: presentation.kind, size: compact ? 32 : 40)
                Spacer()
                if let badge = documentBadge {
                    Text(badge)
                        .font(.tt.captionSemibold)
                        .foregroundStyle(presentation.kind.accent)
                }
            }
            if let preview = presentation.preview {
                Text(preview)
                    .font(presentation.kind == .text ? .tt.codeSM : .tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(compact ? 4 : 7)
                    .multilineTextAlignment(.leading)
            } else {
                Text(L10n.CloudDrive.previewUnavailable)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
    }

    private var tableArtwork: some View {
        TabularPreviewArtwork(
            title: presentation.title,
            content: TabularPreviewContent(previewText: presentation.preview),
            accent: presentation.kind.accent,
            compact: compact
        )
    }

    private var presentationArtwork: some View {
        ZStack {
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .fill(.tt.bgBubbleIncoming)
            HStack(alignment: .bottom, spacing: TTSpacing.sm) {
                Circle()
                    .trim(from: 0, to: 0.72)
                    .stroke(presentation.kind.accent, lineWidth: compact ? 6 : 10)
                    .rotationEffect(.degrees(-90))
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    RoundedRectangle(cornerRadius: TTRadius.xs)
                        .fill(presentation.kind.accent.opacity(0.55))
                    RoundedRectangle(cornerRadius: TTRadius.xs)
                        .fill(presentation.kind.accent.opacity(0.28))
                        .frame(maxWidth: compact ? 44 : 72)
                }
            }
            .padding(TTSpacing.lg)
        }
    }

    private var audioArtwork: some View {
        HStack(alignment: .center, spacing: TTSpacing.xs) {
            ForEach(Array([18, 34, 54, 28, 68, 42, 58, 24, 48, 32].enumerated()), id: \.offset) { _, height in
                Capsule()
                    .fill(presentation.kind.accent)
                    .frame(width: TTSpacing.sm, height: CGFloat(height))
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var documentBadge: String? {
        switch presentation.kind {
        case .pdf: return "PDF"
        case .word: return "DOC"
        case .text: return "TXT"
        default: return nil
        }
    }
}

struct CloudFileLiveImagePreview: View {
    let context: CloudFileDetailContext
    let title: String
    let compact: Bool

    @State private var imageURL: URL?

    var body: some View {
        Group {
            if let imageURL {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    default:
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .task(id: CloudFileSignedPreviewPolicy.cacheKey(for: context)) {
            imageURL = await CloudFileSignedPreviewStore.shared.url(for: context)
        }
    }

    private var placeholder: some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(compact ? .tt.iconEmpty : .tt.iconEmptyHero)
                .foregroundStyle(CloudDriveFileKind.image.accent)
            Text(L10n.CloudDrive.previewUnavailable)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

actor CloudFileSignedPreviewStore {
    static let shared = CloudFileSignedPreviewStore()

    private var cache: [String: URL] = [:]

    func url(for context: CloudFileDetailContext) async -> URL? {
        guard let key = CloudFileSignedPreviewPolicy.cacheKey(for: context) else { return nil }
        if let cached = cache[key] { return cached }
        guard let resolved = await Self.resolve(context) else { return nil }
        cache[key] = resolved
        return resolved
    }

    private static func resolve(_ context: CloudFileDetailContext) async -> URL? {
        do {
            switch context.accessRoute {
            case .contextItem:
                let response = try await CloudDriveRepository.fetchDownloadURL(
                    organizationId: context.organizationId,
                    contextItemId: context.contextItemId,
                    previewMaxBytes: CloudFileSignedPreviewPolicy.previewMaxBytes
                )
                return CloudFileSignedPreviewPolicy.httpURL(from: response.url ?? "")
            case .fileRecord:
                let access = try await OSSUploadService.shared.resolveFile(fileId: context.fileRecordId)
                return CloudFileSignedPreviewPolicy.httpURL(from: access.displayUrl)
            case .missing:
                return nil
            }
        } catch {
            return nil
        }
    }
}

struct TabularPreviewArtwork: View {
    let title: String?
    let content: TabularPreviewContent
    let accent: Color
    let compact: Bool

    private var columns: [String?] {
        if content.fieldNames.isEmpty {
            return Array(repeating: nil, count: compact ? 3 : 4)
        }
        return content.fieldNames.map(Optional.some)
    }

    var body: some View {
        VStack(spacing: 1) {
            if !compact, let title, !title.isEmpty {
                Text(title)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.vertical, TTSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(accent.opacity(0.16), in: RoundedRectangle(cornerRadius: TTRadius.xs))
            }

            HStack(spacing: 1) {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, field in
                    Group {
                        if let field {
                            Text(field)
                                .font(.tt.captionSemibold)
                                .foregroundStyle(accent)
                                .lineLimit(1)
                                .padding(.horizontal, TTSpacing.xs)
                        } else {
                            Color.clear
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: compact ? 30 : 40, alignment: .leading)
                    .background(accent.opacity(0.24), in: RoundedRectangle(cornerRadius: TTRadius.xs))
                }
            }

            Group {
                if let previewText = content.previewText {
                    Text(previewText)
                        .font(compact ? .tt.caption : .tt.body)
                        .foregroundStyle(.tt.textSecondary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(compact ? 3 : 5)
                        .padding(TTSpacing.md)
                } else if content.fieldNames.isEmpty {
                    Text(L10n.WorkbenchAppHome.tableRowsUnavailable)
                        .font(compact ? .tt.caption : .tt.body)
                        .foregroundStyle(.tt.textTertiary)
                        .padding(TTSpacing.md)
                } else {
                    Color.clear
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: TTRadius.xs))

            ForEach(0..<(compact ? 1 : 2), id: \.self) { _ in
                HStack(spacing: 1) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, _ in
                        RoundedRectangle(cornerRadius: TTRadius.xs)
                            .fill(Color.tt.bgBubbleIncoming)
                            .frame(maxWidth: .infinity, minHeight: compact ? 22 : 30)
                    }
                }
            }
        }
        .padding(TTSpacing.xs)
        .background(accent.opacity(0.25), in: RoundedRectangle(cornerRadius: TTRadius.md))
    }
}
