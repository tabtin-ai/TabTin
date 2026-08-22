import Foundation
import AVKit
import os
import PDFKit
import QuickLook
import SwiftUI
import UIKit

struct ChatAttachmentPreviewSheet: View {
    let attachment: AttachmentBlock
    @Environment(\.dismiss) private var dismiss
    @StateObject private var loader: AttachmentPreviewLoader
    @State private var shareItem: AttachmentShareItem?

    private var url: URL? {
        guard let raw = attachment.url else { return nil }
        return URL(string: raw)
    }

    init(attachment: AttachmentBlock) {
        self.attachment = attachment
        _loader = StateObject(wrappedValue: AttachmentPreviewLoader(attachment: attachment))
    }

    var body: some View {
        NavigationStack {
            Group {
                if previewKind == .pdf {
                    downloadablePreview { localURL in
                        PDFAttachmentPreview(url: localURL)
                    }
                } else if previewKind == .quickLook {
                    downloadablePreview { localURL in
                        QuickLookAttachmentPreview(url: localURL)
                    }
                } else if let url, previewKind == .media {
                    MediaAttachmentPreview(url: url, filename: attachment.filename)
                } else if attachment.kind == .image, let url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFit()
                        case .failure:
                            unavailable("图片加载失败")
                        case .empty:
                            ProgressView()
                        @unknown default:
                            unavailable("图片加载失败")
                        }
                    }
                    .padding(TTSpacing.lg)
                } else {
                    UnsupportedAttachmentPreview(
                        filename: attachment.filename,
                        icon: icon,
                        metaText: metaText,
                        onShare: shareAttachment,
                        onOpenOriginal: openOriginalURL
                    )
                }
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle("附件预览")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    if let url {
                        Button {
                            shareAttachment()
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("分享附件")
                        Button {
                            UIApplication.shared.open(url)
                        } label: {
                            Image(systemName: "arrow.up.right")
                        }
                        .accessibilityLabel("打开原始链接")
                    }
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("关闭附件预览")
                }
            }
            .sheet(item: $shareItem) { item in
                AttachmentActivityView(items: [item.url])
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onDisappear {
            loader.cleanup()
        }
    }

    @ViewBuilder
    private func downloadablePreview<Content: View>(
        @ViewBuilder content: @escaping (URL) -> Content
    ) -> some View {
        switch loader.state {
        case .idle, .loading:
            VStack(spacing: TTSpacing.md) {
                ProgressView()
                Text("正在准备预览…")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .task { await loader.loadIfNeeded() }
        case .loaded(let localURL):
            content(localURL)
        case .failed(let message):
            AttachmentPreviewFailure(
                message: message,
                onRetry: { Task { await loader.reload() } },
                onShare: shareAttachment
            )
        }
    }

    private func unavailable(_ text: String) -> some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: "exclamationmark.triangle")
                .font(.tt.iconEmpty)
            Text(text)
                .font(.tt.meta)
        }
        .foregroundStyle(.tt.textTertiary)
    }

    private var icon: String {
        if attachment.mimeType?.contains("pdf") == true { return "doc.richtext" }
        if previewKind == .media { return "play.rectangle" }
        if previewKind == .quickLook { return "doc.text" }
        return attachment.kind == .image ? "photo" : "doc"
    }

    private var previewKind: AttachmentPreviewKind {
        AttachmentPreviewKind(filename: attachment.filename, mimeType: attachment.mimeType)
    }

    private var metaText: String {
        var parts: [String] = []
        if let mimeType = attachment.mimeType, !mimeType.isEmpty { parts.append(mimeType) }
        if let size = attachment.size { parts.append(Self.formatBytes(size)) }
        return parts.isEmpty ? "文件" : parts.joined(separator: " · ")
    }

    private static func formatBytes(_ bytes: Int64) -> String {
        let value = Double(bytes)
        if value >= 1024 * 1024 { return String(format: "%.1f MB", value / 1024 / 1024) }
        if value >= 1024 { return String(format: "%.0f KB", value / 1024) }
        return "\(bytes) B"
    }

    private func shareAttachment() {
        guard let target = loader.resolvedSharingURL ?? url else { return }
        shareItem = AttachmentShareItem(url: target)
    }

    private func openOriginalURL() {
        guard let url else { return }
        UIApplication.shared.open(url)
    }
}

private struct AttachmentShareItem: Identifiable {
    let id: String
    let url: URL

    init(url: URL) {
        self.id = url.absoluteString
        self.url = url
    }
}

private struct AttachmentActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = UIView()
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct UnsupportedAttachmentPreview: View {
    let filename: String
    let icon: String
    let metaText: String
    let onShare: () -> Void
    let onOpenOriginal: () -> Void

    var body: some View {
        VStack(spacing: TTSpacing.md) {
            Spacer(minLength: 0)

            Image(systemName: icon)
                .font(.tt.iconEmptyHero)
                .foregroundStyle(.tt.iconAccent)

            Text(filename)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(3)

            Text(metaText)
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)

            Text("此类型暂不支持应用内预览，可以分享保存或交给其他应用处理。")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, TTSpacing.lg)

            HStack(spacing: TTSpacing.sm) {
                Button(action: onShare) {
                    Label("分享文件", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)

                Button(action: onOpenOriginal) {
                    Label("打开链接", systemImage: "arrow.up.right")
                }
                .buttonStyle(.bordered)
            }

            Spacer(minLength: 0)
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct AttachmentPreviewFailure: View {
    let message: String
    let onRetry: () -> Void
    let onShare: () -> Void

    var body: some View {
        VStack(spacing: TTSpacing.md) {
            Image(systemName: "exclamationmark.triangle")
                .font(.tt.iconEmptyMD)
                .foregroundStyle(.tt.textCritical)

            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)

            HStack(spacing: TTSpacing.sm) {
                Button(action: onRetry) {
                    Label("重试", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)

                Button(action: onShare) {
                    Label("分享", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct MediaAttachmentPreview: View {
    let url: URL
    let filename: String

    @State private var player: AVPlayer?
    @State private var failedObserver: NSObjectProtocol?
    @State private var interruptionObserver: NSObjectProtocol?
    @State private var statusTask: Task<Void, Never>?
    @State private var playbackError: String?
    @State private var wasPlayingBeforeInterruption = false

    var body: some View {
        Group {
            if let playbackError {
                VStack(spacing: TTSpacing.md) {
                    Image(systemName: "play.slash")
                        .font(.tt.iconEmptyMD)
                        .foregroundStyle(.tt.textCritical)
                    Text(playbackError)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .multilineTextAlignment(.center)
                    Button {
                        setupPlayer()
                    } label: {
                        Label("重试", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.tt.bgAccent)
                }
                .padding(TTSpacing.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let player {
                VideoPlayer(player: player)
                    .background(.black)
            } else {
                VStack(spacing: TTSpacing.sm) {
                    ProgressView()
                    Text("正在准备播放…")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                    Text(filename)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear(perform: setupPlayer)
        .onDisappear(perform: teardownPlayer)
    }

    private func setupPlayer() {
        teardownPlayer()
        playbackError = nil
        ChatPreviewAudioSession.activatePlayback()

        let item = AVPlayerItem(url: url)
        let nextPlayer = AVPlayer(playerItem: item)

        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { _ in
            Task { @MainActor in
                playbackError = "媒体播放失败，请检查网络后重试。"
            }
        }

        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { notification in
            let typeRaw = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? UInt.max
            let optionsRaw = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
            let wasPlaying = nextPlayer.timeControlStatus == .playing
            Task { @MainActor in
                handleInterruption(
                    typeRaw: typeRaw,
                    optionsRaw: optionsRaw,
                    wasPlaying: wasPlaying,
                    player: nextPlayer
                )
            }
        }

        statusTask = Task {
            for _ in 0..<100 {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
                await MainActor.run {
                    if item.status == .failed, playbackError == nil {
                        playbackError = "媒体播放失败，请检查网络后重试。"
                    }
                }
            }
            await MainActor.run {
                guard !Task.isCancelled else { return }
                if item.status != .readyToPlay && playbackError == nil {
                    playbackError = "媒体加载超时，请检查网络后重试。"
                }
            }
        }

        player = nextPlayer
    }

    private func teardownPlayer() {
        statusTask?.cancel()
        statusTask = nil
        player?.pause()
        player = nil
        if let failedObserver {
            NotificationCenter.default.removeObserver(failedObserver)
            self.failedObserver = nil
        }
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        ChatPreviewAudioSession.deactivatePlayback()
    }

    private func handleInterruption(
        typeRaw: UInt,
        optionsRaw: UInt,
        wasPlaying: Bool,
        player: AVPlayer
    ) {
        guard let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            wasPlayingBeforeInterruption = wasPlaying
            player.pause()
        case .ended:
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            if wasPlayingBeforeInterruption, options.contains(.shouldResume) {
                player.play()
            }
            wasPlayingBeforeInterruption = false
        @unknown default:
            break
        }
    }
}

private enum ChatPreviewAudioSession {
    static func activatePlayback() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // 播放器自身仍会给用户展示失败态；这里不阻断预览 UI。
        }
    }

    static func deactivatePlayback() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

@MainActor
private final class AttachmentPreviewLoader: ObservableObject {
    enum State {
        case idle
        case loading
        case loaded(URL)
        case failed(String)
    }

    @Published var state: State = .idle

    private let attachment: AttachmentBlock
    private let originalURL: URL?
    private let previewKind: AttachmentPreviewKind
    private var downloadTask: Task<Void, Never>?
    private var downloadedFileURL: URL?

    init(attachment: AttachmentBlock) {
        self.attachment = attachment
        self.originalURL = attachment.url.flatMap(URL.init(string:))
        self.previewKind = AttachmentPreviewKind(filename: attachment.filename, mimeType: attachment.mimeType)
    }

    var resolvedSharingURL: URL? {
        downloadedFileURL ?? originalURL
    }

    func loadIfNeeded() async {
        guard case .idle = state else { return }
        await runDownload()
    }

    func reload() async {
        downloadTask?.cancel()
        downloadTask = nil
        await runDownload()
    }

    func cleanup() {
        downloadTask?.cancel()
        downloadTask = nil
        if let downloadedFileURL {
            Self.removeFile(at: downloadedFileURL)
            self.downloadedFileURL = nil
        }
    }

    private func runDownload() async {
        guard originalURL != nil else {
            state = .failed("附件链接为空，无法预览。")
            return
        }
        let task = Task { @MainActor in
            await load()
        }
        downloadTask = task
        await task.value
        if downloadTask == task {
            downloadTask = nil
        }
    }

    private func load() async {
        guard let originalURL else {
            state = .failed("附件链接为空，无法预览。")
            return
        }

        if originalURL.isFileURL {
            do {
                try await validatePreviewableFile(at: originalURL)
                state = .loaded(originalURL)
            } catch {
                state = .failed(Self.fileInvalidMessage)
            }
            return
        }

        state = .loading
        if let existing = downloadedFileURL {
            Self.removeFile(at: existing)
            downloadedFileURL = nil
        }

        do {
            let request = URLRequest(url: originalURL, timeoutInterval: 60)
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
            try Task.checkCancellation()
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                if http.statusCode == 410 {
                    state = .failed("此资源已不存在，无法预览。")
                    return
                }
                if http.statusCode == 401 || http.statusCode == 403 {
                    state = .failed("此链接已失效或已过期，请让 Agent 重新生成。")
                    return
                }
                throw URLError(.badServerResponse)
            }

            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("tabtin-preview-\(UUID().uuidString)-\(safePreviewFilename())")
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: downloadedURL, to: destination)

            var keepDestination = false
            defer {
                if !keepDestination {
                    Self.removeFile(at: destination)
                }
            }
            try await validatePreviewableFile(at: destination)
            downloadedFileURL = destination
            state = .loaded(destination)
            keepDestination = true
        } catch is CancellationError {
            return
        } catch let error as URLError {
            state = .failed(Self.message(for: error))
        } catch {
            state = .failed(Self.fileInvalidMessage)
        }
    }

    private func validatePreviewableFile(at url: URL) async throws {
        if previewKind == .quickLook, !QLPreviewController.canPreview(url as NSURL) {
            throw URLError(.cannotOpenFile)
        }
        let kind = previewKind
        try await Task.detached(priority: .userInitiated) {
            if kind == .pdf, PDFDocument(url: url) == nil {
                throw URLError(.cannotDecodeContentData)
            }
        }.value
    }

    private static var fileInvalidMessage: String {
        "文件预览失败，请检查文件是否完整。"
    }

    private static func message(for error: URLError) -> String {
        switch error.code {
        case .timedOut:
            return "下载超时，请检查网络后重试。文件可能较大或当前网络较慢。"
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
            return "当前无法连接网络，请检查后重试。"
        case .cannotConnectToHost, .dnsLookupFailed, .cannotFindHost:
            return "无法连接到服务器，请稍后重试。"
        case .cannotDecodeContentData, .cannotDecodeRawData, .cannotOpenFile, .dataLengthExceedsMaximum:
            return "文件内容无法解析，可能已损坏或格式不支持。"
        case .cannotCreateFile, .cannotWriteToFile, .cannotCloseFile, .cannotMoveFile:
            return "保存预览文件失败，请检查设备存储空间。"
        default:
            return "文件预览失败，请检查网络或稍后重试。"
        }
    }

    private static func removeFile(at url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    private func safePreviewFilename() -> String {
        var filename = safeFilename(attachment.filename)
        if !filename.contains(".") {
            switch previewKind {
            case .pdf:
                filename += ".pdf"
            case .quickLook:
                filename += ".txt"
            case .media, .unsupported:
                break
            }
        }
        return filename
    }

    private func safeFilename(_ filename: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:?%*|\"<>")
        let parts = filename.components(separatedBy: invalid).filter { !$0.isEmpty }
        let safe = parts.joined(separator: "-")
        return safe.isEmpty ? "preview-file" : safe
    }
}

private enum AttachmentPreviewKind: Sendable {
    case pdf
    case quickLook
    case media
    case unsupported

    init(filename: String, mimeType: String?) {
        let ext = filename.split(separator: ".").last.map { String($0).lowercased() } ?? ""
        let mime = mimeType?.lowercased() ?? ""
        if ext == "pdf" || mime == "application/pdf" {
            self = .pdf
        } else if mime.hasPrefix("audio/") || mime.hasPrefix("video/")
                    || ["mp3", "m4a", "aac", "wav", "caf", "mp4", "mov", "m4v"].contains(ext) {
            self = .media
        } else if ["doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "txt", "rtf"].contains(ext) {
            self = .quickLook
        } else {
            self = .unsupported
        }
    }
}

private struct PDFAttachmentPreview: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .clear
        view.document = PDFDocument(url: url)
        return view
    }

    func updateUIView(_ uiView: PDFView, context: Context) {
        if uiView.document?.documentURL != url {
            uiView.document = PDFDocument(url: url)
        }
    }
}

private struct QuickLookAttachmentPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url {
            context.coordinator.url = url
            controller.reloadData()
        }
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) {
            self.url = url
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}
