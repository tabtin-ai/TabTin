import SwiftUI
import QuickLook

/// 云盘文件详情：签名 URL 预览 / 下载；不信任 metadata 里的长期 URL。
/// QuickLook 只打开本地下载副本（对齐 ChatFilePreviewSheet），不把远程 HTTPS 直接交给 QL。
struct CloudFileDetailScreen: View {
    let context: CloudFileDetailContext

    @Environment(\.openURL) private var openURL

    @State private var isLoadingPreview = false
    @State private var isLoadingDownload = false
    @State private var isPreparingQuickLook = false
    @State private var remotePreviewURL: URL?
    @State private var downloadURL: URL?
    @State private var previewEligible = false
    @State private var mimePreviewSafe = false
    @State private var resolvedFileName: String?
    @State private var resolvedMime: String?
    @State private var resolvedSize: Int?
    @State private var errorMessage: String?
    @State private var showCopiedToast = false
    @State private var quickLookURL: URL?
    @State private var quickLookTempFileURL: URL?
    @State private var showTrashConfirm = false
    @State private var isTrashing = false
    @State private var showCollaborators = false
    @State private var trashedNotice: CloudDriveTrashedFileNotice?
    @State private var isRestoring = false
    @State private var showPermanentDeleteConfirm = false
    @State private var isPermanentlyDeleting = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.lg) {
                header
                actions
                infoSection
            }
            .padding(TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(resolvedFileName ?? context.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !context.contextItemId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                await CloudDriveRepository.reportAccess(contextItemId: context.contextItemId)
            }
            await loadPreviewURL()
        }
        .alert(
            L10n.CloudDrive.operationFailed,
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
        .overlay(alignment: .top) {
            if showCopiedToast {
                copiedToast.transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = trashedNotice {
                detailTrashedBanner(notice)
                    .padding(.bottom, TTSpacing.md)
            }
        }
        .quickLookPreview($quickLookURL)
        .onChange(of: quickLookURL) { _, newValue in
            if newValue == nil {
                cleanupQuickLookTempFile()
            }
        }
        .onDisappear {
            cleanupQuickLookTempFile()
        }
        .confirmationDialog(
            L10n.CloudDrive.moveToTrash,
            isPresented: $showTrashConfirm,
            titleVisibility: .visible
        ) {
            Button(L10n.CloudDrive.moveToTrash, role: .destructive) {
                Task { await trashFile() }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.CloudDrive.trashFileMessage)
        }
        .confirmationDialog(
            L10n.CloudDrive.permanentDeleteTitle,
            isPresented: $showPermanentDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button(L10n.CloudDrive.permanentDeleteConfirm, role: .destructive) {
                Task { await permanentDeleteTrashedFile() }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.CloudDrive.permanentDeleteMessage(trashedNotice?.title ?? context.displayTitle))
        }
        .sheet(isPresented: $showCollaborators) {
            TabFilesCollaboratorsSheet(
                fileRecordId: context.fileRecordId,
                resourceTitle: context.displayTitle,
                canManage: context.canShare
            )
            .workbenchCapsuleTopLayer()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            if CloudFileDetailPresentation.showsLiveImage(resolvedFileKind) {
                CloudFileLiveImagePreview(
                    context: context,
                    title: resolvedFileName ?? context.displayTitle,
                    compact: false
                )
                .frame(maxWidth: .infinity)
                .frame(height: 220)
                .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous))
            } else {
                CloudDriveResourceGlyph(kind: resolvedFileKind, size: 48)
            }
            Text(resolvedFileName ?? context.displayTitle)
                .font(.tt.subtitle)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(3)
            if let preview = CloudDrivePresentationResolver.safePreviewText(context.preview) {
                Text(preview)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(TTSpacing.lg)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private var resolvedFileKind: CloudDriveFileKind {
        CloudDrivePresentationResolver.kind(
            itemType: "tabfiles",
            title: resolvedFileName ?? context.displayTitle,
            mimeType: resolvedMime ?? context.mimeType,
            fileExtension: context.fileExtension
        )
    }

    private var canPreview: Bool {
        previewEligible && remotePreviewURL != nil
    }

    private var visibleActions: [CloudFileDetailAction] {
        CloudFileDetailPresentation.actions(
            canPreview: canPreview,
            hasShareableLink: downloadURL != nil,
            canManageCollaborators: context.canShare && !context.fileRecordId.isEmpty,
            canTrash: context.canTrash && !context.fileRecordId.isEmpty && trashedNotice == nil
        )
    }

    @ViewBuilder
    private func detailAction(_ action: CloudFileDetailAction) -> some View {
        switch action {
        case .preview:
            Button {
                guard let remotePreviewURL else { return }
                Task { await openQuickLook(from: remotePreviewURL) }
            } label: {
                if isPreparingQuickLook {
                    ProgressView(L10n.CloudDrive.loadingPreview)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Label(L10n.CloudDrive.preview, systemImage: "eye")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .disabled(isPreparingQuickLook || trashedNotice != nil)
        case .openExternally:
            Button {
                if let remotePreviewURL { openURL(remotePreviewURL) }
            } label: {
                Label(L10n.CloudDrive.openExternally, systemImage: "arrow.up.right.square")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(trashedNotice != nil)
        case .download:
            Button {
                Task { await loadDownloadURL(andOpen: true) }
            } label: {
                if isLoadingDownload {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Label(L10n.CloudDrive.download, systemImage: "arrow.down.circle")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .disabled(isLoadingDownload || trashedNotice != nil)
        case .copyLink:
            if let downloadURL {
                Button { copy(downloadURL) } label: {
                    Label(L10n.CloudDrive.copyLink, systemImage: "doc.on.doc")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        case .share:
            if let downloadURL {
                ShareLink(item: downloadURL) {
                    Label(L10n.CloudDrive.systemShare, systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        case .collaborators:
            Button {
                showCollaborators = true
            } label: {
                Label(L10n.CloudDrive.manageCollaborators, systemImage: "person.2")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(trashedNotice != nil)
        case .trash:
            Button(role: .destructive) {
                showTrashConfirm = true
            } label: {
                if isTrashing {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Label(L10n.CloudDrive.moveToTrash, systemImage: "trash")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .disabled(isTrashing)
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.CloudDrive.availableActions)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)

            if isLoadingPreview {
                ProgressView(L10n.CloudDrive.loadingPreview)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if !canPreview,
                      !mimePreviewSafe || (resolvedMime.map { !CloudFilePreviewPolicy.isPreviewSafe(mimeType: $0) } ?? false) {
                Text(L10n.CloudDrive.previewUnavailable)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }

            ForEach(visibleActions, id: \.self) { action in
                detailAction(action)
            }
        }
        .buttonStyle(.bordered)
    }

    private func detailTrashedBanner(_ notice: CloudDriveTrashedFileNotice) -> some View {
        HStack(spacing: TTSpacing.sm) {
            Text(L10n.CloudDrive.trashedBanner(notice.title))
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button(L10n.CloudDrive.restore) {
                Task { await restoreTrashedFile() }
            }
            .buttonStyle(.bordered)
            .disabled(isRestoring || isPermanentlyDeleting)
            Button(L10n.CloudDrive.permanentDelete, role: .destructive) {
                showPermanentDeleteConfirm = true
            }
            .buttonStyle(.bordered)
            .disabled(isRestoring || isPermanentlyDeleting)
            Button {
                trashedNotice = nil
                dismiss()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.Common.cancel)
        }
        .padding(TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .padding(.horizontal, TTSpacing.md)
    }

    @MainActor
    private func trashFile() async {
        guard context.canTrash else { return }
        guard !context.fileRecordId.isEmpty, !context.organizationId.isEmpty else {
            errorMessage = L10n.CloudDrive.missingFileRecordId
            return
        }
        isTrashing = true
        defer { isTrashing = false }
        do {
            try await CloudDriveRepository.trashTabFile(
                organizationId: context.organizationId,
                fileRecordId: context.fileRecordId
            )
            // 留在详情页提供 restore / permanent，避免 dismiss 后无入口。
            trashedNotice = CloudDriveTrashedFileNotice(
                id: UUID().uuidString,
                fileRecordId: context.fileRecordId,
                title: context.displayTitle
            )
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    @MainActor
    private func restoreTrashedFile() async {
        guard let notice = trashedNotice else { return }
        isRestoring = true
        defer { isRestoring = false }
        do {
            _ = try await CloudDriveRepository.restoreTabFile(
                organizationId: context.organizationId,
                fileRecordId: notice.fileRecordId
            )
            trashedNotice = nil
            await loadPreviewURL()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    @MainActor
    private func permanentDeleteTrashedFile() async {
        guard let notice = trashedNotice else { return }
        isPermanentlyDeleting = true
        defer { isPermanentlyDeleting = false }
        do {
            try await CloudDriveRepository.permanentDeleteTabFile(
                organizationId: context.organizationId,
                fileRecordId: notice.fileRecordId
            )
            trashedNotice = nil
            dismiss()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private var infoSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.CloudDrive.fileInfo)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            infoRow(L10n.CloudDrive.mimeType, resolvedMime ?? context.mimeType ?? "—")
            if let sizeText = sizeText {
                infoRow(L10n.CloudDrive.fileSize, sizeText)
            }
            infoRow(
                L10n.CloudDrive.location,
                context.spaceName ?? L10n.CloudDrive.organizationCloud
            )
        }
        .padding(TTSpacing.lg)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private var sizeText: String? {
        if let resolvedSize, resolvedSize > 0 {
            return ByteCountFormatter.string(fromByteCount: Int64(resolvedSize), countStyle: .file)
        }
        return context.fileSizeText
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Text(label)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
                .frame(width: 88, alignment: .leading)
            Text(value)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }

    private var copiedToast: some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.tt.bgSuccess)
            Text(L10n.CloudDrive.linkCopied).font(.tt.meta).foregroundStyle(.tt.textPrimary)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
        .background(Capsule().fill(.tt.bgSubtle).shadow(color: .black.opacity(0.08), radius: 8, y: 4))
        .padding(.top, TTSpacing.md)
    }

    private func copy(_ url: URL) {
        UIPasteboard.general.string = url.absoluteString
        withAnimation(.spring(duration: 0.3)) { showCopiedToast = true }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.spring(duration: 0.3)) { showCopiedToast = false }
        }
    }

    private func loadPreviewURL() async {
        isLoadingPreview = true
        defer { isLoadingPreview = false }
        do {
            switch context.accessRoute {
            case .missing:
                mimePreviewSafe = CloudFilePreviewPolicy.isPreviewSafe(mimeType: context.mimeType)
                previewEligible = false
            case .fileRecord:
                let access = try await OSSUploadService.shared.resolveFile(fileId: context.fileRecordId)
                apply(access, isPreview: true)
            case .contextItem:
                let response = try await CloudDriveRepository.fetchDownloadURL(
                    organizationId: context.organizationId,
                    contextItemId: context.contextItemId,
                    previewMaxBytes: CloudFilePreviewPolicy.defaultPreviewMaxBytes
                )
                apply(response, isPreview: true)
            }
        } catch {
            // 预览失败不阻断下载入口
            mimePreviewSafe = CloudFilePreviewPolicy.isPreviewSafe(mimeType: context.mimeType)
            previewEligible = false
        }
    }

    private func loadDownloadURL(andOpen: Bool) async {
        switch context.accessRoute {
        case .missing:
            errorMessage = context.fileRecordId.isEmpty
                ? L10n.CloudDrive.missingFileRecordId
                : L10n.CloudDrive.missingOrganization
            return
        case .fileRecord:
            if let downloadURL {
                if andOpen { openURL(downloadURL) }
                return
            }
        case .contextItem:
            break
        }
        isLoadingDownload = true
        defer { isLoadingDownload = false }
        do {
            switch context.accessRoute {
            case .fileRecord:
                let access = try await OSSUploadService.shared.resolveFile(fileId: context.fileRecordId)
                apply(access, isPreview: false)
            case .contextItem:
                // 下载单独请求，不复用预览签名 URL。
                let response = try await CloudDriveRepository.fetchDownloadURL(
                    organizationId: context.organizationId,
                    contextItemId: context.contextItemId,
                    previewMaxBytes: nil
                )
                apply(response, isPreview: false)
            case .missing:
                return
            }
            if andOpen, let downloadURL {
                openURL(downloadURL)
            }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func apply(_ access: OSSFileAccess, isPreview: Bool) {
        if !access.fileName.isEmpty { resolvedFileName = access.fileName }
        if !access.mimeType.isEmpty { resolvedMime = access.mimeType }
        if access.fileSize > 0 { resolvedSize = Int(access.fileSize) }
        mimePreviewSafe = CloudFilePreviewPolicy.isPreviewSafe(
            mimeType: access.mimeType.isEmpty ? context.mimeType : access.mimeType
        )
        guard let url = URL(string: access.displayUrl), !access.displayUrl.isEmpty else { return }
        if isPreview {
            previewEligible = mimePreviewSafe
            remotePreviewURL = previewEligible ? url : nil
        }
        downloadURL = url
    }

    private func apply(_ response: CloudFileDownloadURLResponse, isPreview: Bool) {
        if let name = response.fileName, !name.isEmpty { resolvedFileName = name }
        if let mime = response.mimeType, !mime.isEmpty { resolvedMime = mime }
        if let size = response.fileSize { resolvedSize = size }
        mimePreviewSafe = response.mimePreviewSafe
            ?? CloudFilePreviewPolicy.isPreviewSafe(mimeType: response.mimeType ?? context.mimeType)
        if isPreview {
            previewEligible = response.previewEligible == true
                && mimePreviewSafe
                && CloudFilePreviewPolicy.isPreviewSafe(mimeType: response.mimeType ?? context.mimeType)
            if let raw = response.url, let url = URL(string: raw), !raw.isEmpty, previewEligible {
                remotePreviewURL = url
            } else {
                remotePreviewURL = nil
            }
        } else if let raw = response.url, let url = URL(string: raw), !raw.isEmpty {
            downloadURL = url
        }
    }

    private func openQuickLook(from remoteURL: URL) async {
        guard !isPreparingQuickLook else { return }
        isPreparingQuickLook = true
        defer { isPreparingQuickLook = false }
        do {
            let localURL = try await Self.downloadPreviewToTempFile(
                from: remoteURL,
                preferredFileName: resolvedFileName ?? context.displayTitle
            )
            cleanupQuickLookTempFile()
            quickLookTempFileURL = localURL
            quickLookURL = localURL
        } catch is CancellationError {
            return
        } catch {
            errorMessage = L10n.CloudDrive.previewPrepareFailed
        }
    }

    private func cleanupQuickLookTempFile() {
        if let fileURL = quickLookTempFileURL {
            try? FileManager.default.removeItem(at: fileURL)
            quickLookTempFileURL = nil
        }
    }

    private static func downloadPreviewToTempFile(from remoteURL: URL, preferredFileName: String) async throws -> URL {
        if remoteURL.isFileURL {
            return remoteURL
        }
        let request = URLRequest(url: remoteURL, timeoutInterval: 60)
        let span = DiagnosticRecorder.beginHTTP(request)
        let downloadedURL: URL
        let response: URLResponse
        do {
            (downloadedURL, response) = try await URLSession.shared.download(for: request)
        } catch {
            await DiagnosticRecorder.shared.finishHTTP(
                span,
                statusCode: nil,
                responseBytes: nil,
                errorClass: String(describing: type(of: error))
            )
            throw error
        }
        let bytes = (try? downloadedURL.resourceValues(forKeys: [.fileSizeKey]).fileSize)
        await DiagnosticRecorder.shared.finishHTTP(
            span,
            statusCode: (response as? HTTPURLResponse)?.statusCode,
            responseBytes: bytes
        )
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        let safeName = sanitizeFileName(preferredFileName)
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("tabtin-cloud-preview-\(UUID().uuidString)-\(safeName)")
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: downloadedURL, to: destination)
        return destination
    }

    private static func sanitizeFileName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = trimmed.isEmpty ? "preview.bin" : trimmed
        let invalid = CharacterSet(charactersIn: "/:\\?%*|\"<>")
        let cleaned = base.components(separatedBy: invalid).joined(separator: "_")
        return String(cleaned.prefix(120))
    }
}
