import os
import SwiftUI
import UIKit

/// 消息发送者标签（普通成员灰色；Agent 带 sparkles + accent）。文本气泡与附件气泡共用。
/// `clock` 为组首时分，跟在昵称旁（对齐 Electron 组首 meta）。
struct IMMessageSenderLabel: View {
    let senderName: String
    let isAgent: Bool
    var clock: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if isAgent { Image(systemName: "sparkles").font(.tt.iconCaption) }
            Text(senderName).font(.tt.captionMedium)
            if let clock, !clock.isEmpty {
                Text(clock)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .monospacedDigit()
            }
        }
        .foregroundStyle(isAgent ? Color.tt.bgAccent : Color.tt.textSecondary)
    }
}

/// 组首且无私聊发送者名时（DM / 自己发的），单独展示时分戳。
struct IMMessageClockLabel: View {
    let clock: String
    let isMine: Bool

    var body: some View {
        HStack(spacing: 6) {
            if isMine { Spacer(minLength: 0) }
            Text(clock)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
                .monospacedDigit()
            if !isMine { Spacer(minLength: 0) }
        }
        .padding(.horizontal, 4)
        .accessibilityLabel(clock)
    }
}

/// 图片 / 文件消息气泡（Phase D）：复用文本气泡的左右对齐与发送者标签，
/// 主体换成附件视图，正文非空时作为图注展示在下方。
struct IMAttachmentBubble: View {
    let message: IMMessage
    let conversationId: String
    let isMine: Bool
    let isAgent: Bool
    let showsSenderName: Bool
    var clock: String? = nil
    var readProgress: IMReadReceipt? = nil
    var service: IMConversationServing = IMConversationService()

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if isMine { Spacer(minLength: 40) }
            if isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                if showsSenderName && !message.senderName.isEmpty {
                    IMMessageSenderLabel(senderName: message.senderName, isAgent: isAgent, clock: clock)
                }
                IMAttachmentView(message: message, conversationId: conversationId, service: service)
                if !message.content.isEmpty && message.codexSessionCard == nil {
                    Text(message.content)
                        .font(.tt.body)
                        .foregroundStyle(isMine ? Color.tt.textOnAccent : Color.tt.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            isMine ? Color.tt.bgAccent : Color.tt.bgSubtle,
                            in: RoundedRectangle(cornerRadius: 16)
                        )
                }
            }
            if !isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            if !isMine { Spacer(minLength: 40) }
        }
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
    }
}

/// 附件主体：懒加载预签下载 URL（不落库，进入视图时现换）。
/// image → 缩略图，点开全屏查看；file → 文件卡片，点开应用内附件预览。
struct IMAttachmentView: View {
    let message: IMMessage
    let conversationId: String
    var service: IMConversationServing = IMConversationService()

    @State private var attachment: IMAttachmentURL?
    @State private var loadFailed = false
    @State private var imageLoadFailed = false
    @State private var selectedImageURLIndex = 0
    @State private var attemptedLookupAfterImageFailure = false
    @State private var showFullImage = false
    @State private var previewAttachment: AttachmentBlock?

    private let imageThumbnailMaxSize = CGSize(width: 220, height: 220)
    private let attachmentLoadTimeoutNanos: UInt64 = 12_000_000_000
    private static let logger = Logger(subsystem: "com.tabtin.mobile", category: "IMAttachment")

    var body: some View {
        Group {
            if message.isImageAttachment {
                imageContent
            } else {
                fileCard
            }
        }
        .task { await load(preferInline: true) }
        .task(id: message.attachmentCacheKey) {
            try? await Task.sleep(nanoseconds: attachmentLoadTimeoutNanos)
            if !Task.isCancelled, attachment == nil {
                loadFailed = true
            }
        }
        .fullScreenCover(item: $previewAttachment) { attachment in
            ChatAttachmentPreviewSheet(attachment: attachment)
        }
    }

    private func load(preferInline: Bool) async {
        guard attachment == nil, !loadFailed else { return }
        let cacheKey = message.attachmentCacheKey
        if let cached = await IMAttachmentURLMemoryCache.shared.value(for: cacheKey) {
            attachment = cached
            return
        }
        if preferInline, let inline = message.inlineAttachmentURL {
            await IMAttachmentURLMemoryCache.shared.set(inline, for: cacheKey)
            attachment = inline
            return
        }
        // 附件按 file_id 经 OSS 权限接口换链；传输游标不映射 Django 消息主键。
        guard let fileId = message.attachmentFileId, !fileId.isEmpty else {
            Self.logger.error(
                "IM attachment unresolved conversation=\(conversationId, privacy: .public) message=\(message.id) error=missing file_id"
            )
            loadFailed = true
            return
        }
        do {
            let file = try await OSSUploadService.shared.resolveFile(fileId: fileId)
            let loaded = IMAttachmentURL(
                downloadURL: file.resolvedUrl,
                fileName: file.fileName,
                expiresIn: 0
            )
            guard !loaded.downloadURL.isEmpty else {
                loadFailed = true
                return
            }
            await IMAttachmentURLMemoryCache.shared.set(loaded, for: cacheKey)
            attachment = loaded
        } catch is CancellationError {
            return
        } catch {
            Self.logger.error(
                "IM attachment file fallback failed conversation=\(conversationId, privacy: .public) message=\(message.id) file=\(fileId, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
            )
            loadFailed = true
        }
    }

    // MARK: - 图片

    @ViewBuilder
    private var imageContent: some View {
        let imageURLs = attachment?.displayURLs ?? []
        if let url = imageURLs[safe: selectedImageURLIndex].flatMap(URL.init(string:)), !imageLoadFailed {
            Button { showFullImage = true } label: {
                IMRemoteAttachmentImage(
                    url: url,
                    maxSize: imageThumbnailMaxSize,
                    onFailure: handleImageFailure
                )
            }
            .buttonStyle(.plain)
            .fullScreenCover(isPresented: $showFullImage) {
                IMImageViewer(url: url)
            }
        } else if loadFailed || imageLoadFailed {
            imagePlaceholder(systemName: "exclamationmark.triangle")
        } else {
            imagePlaceholder(systemName: nil)
        }
    }

    private func handleImageFailure() {
        let imageURLs = attachment?.displayURLs ?? []
        if selectedImageURLIndex < imageURLs.index(before: imageURLs.endIndex) {
            selectedImageURLIndex += 1
            return
        }
        guard !attemptedLookupAfterImageFailure,
              message.attachmentLookupMessageId != nil || message.attachmentFileId != nil
        else {
            imageLoadFailed = true
            return
        }
        attemptedLookupAfterImageFailure = true
        selectedImageURLIndex = 0
        imageLoadFailed = false
        loadFailed = false
        attachment = nil
        Task { await load(preferInline: false) }
    }

    private func imagePlaceholder(systemName: String?) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(.tt.bgSubtle)
            if let systemName {
                Image(systemName: systemName).font(.tt.iconEmpty).foregroundStyle(.tt.textSecondary)
            } else {
                ProgressView()
            }
        }
        .frame(width: imageThumbnailMaxSize.width, height: imageThumbnailMaxSize.height)
    }

    // MARK: - 文件（紧凑横版分色卡，与 Android / Electron 扩展名色一致）

    private var fileCard: some View {
        let style = IMFileCardStyle.resolve(fileName: fileName, isUnavailable: loadFailed)
        let codexCard = message.codexSessionCard
        let canOpen = attachment != nil && !loadFailed
        let isLoading = attachment == nil && !loadFailed

        return Button {
            guard let attachment, !attachment.downloadURL.isEmpty else { return }
            previewAttachment = AttachmentBlock(
                messageId: String(message.id),
                index: 0,
                kind: .file,
                filename: fileName,
                mimeType: message.metadata?.fileType,
                size: message.attachmentFileSize.map(Int64.init),
                url: attachment.downloadURL,
                fileId: message.attachmentFileId
            )
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(codexCard?.sessionName ?? fileName)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.72))
                            .lineLimit(1)
                    }
                    if let workingDirectory = codexCard?.suggestedWorkingDirectory {
                        Text("建议工作目录：\(workingDirectory)")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.white.opacity(0.68))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 6) {
                    Text(codexCard == nil ? style.badge : "CODEX")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.4)
                        .foregroundStyle(.white.opacity(0.92))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.black.opacity(0.16), in: Capsule())

                    Group {
                        if loadFailed {
                            Color.clear.frame(width: IMFileCardStyle.actionSize, height: IMFileCardStyle.actionSize)
                        } else if isLoading {
                            ProgressView()
                                .tint(.white)
                                .frame(width: IMFileCardStyle.actionSize, height: IMFileCardStyle.actionSize)
                        } else if canOpen {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: IMFileCardStyle.actionSize, height: IMFileCardStyle.actionSize)
                                .background(Color.white.opacity(0.22), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: IMFileCardStyle.cardMaxWidth, minHeight: IMFileCardStyle.cardMinHeight, alignment: .leading)
            .background(style.background, in: RoundedRectangle(cornerRadius: IMFileCardStyle.cardCornerRadius))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canOpen)
        .accessibilityLabel(Text(codexCardAccessibilityLabel(styleBadge: style.badge)))
        .accessibilityHint(Text(loadFailed ? "文件不可用" : "打开文件"))
    }

    private var fileName: String {
        let name = message.attachmentFileName
        if !name.isEmpty { return name }
        return attachment?.fileName.isEmpty == false ? attachment!.fileName : "附件"
    }

    private var subtitle: String {
        if loadFailed { return "文件不可用" }
        if message.codexSessionCard != nil {
            let size = message.attachmentFileSize.flatMap { value in
                value > 0 ? ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file) : nil
            }
            return ["Codex 会话", size, "ZIP"].compactMap { $0 }.joined(separator: " · ")
        }
        if let size = message.attachmentFileSize, size > 0 {
            return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
        }
        return ""
    }

    private func codexCardAccessibilityLabel(styleBadge: String) -> String {
        guard let card = message.codexSessionCard else { return "\(fileName), \(styleBadge)" }
        return "Codex 会话，\(card.sessionName)，可下载 ZIP 文件"
    }
}

private actor IMAttachmentURLMemoryCache {
    static let shared = IMAttachmentURLMemoryCache()
    private let maxEntries = 128
    private var values: [String: IMAttachmentURL] = [:]
    private var order: [String] = []

    func value(for key: String) -> IMAttachmentURL? {
        values[key]
    }

    func set(_ value: IMAttachmentURL, for key: String) {
        guard !key.isEmpty else { return }
        values[key] = value
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > maxEntries {
            let removed = order.removeFirst()
            values.removeValue(forKey: removed)
        }
    }
}

private extension IMMessage {
    var attachmentCacheKey: String {
        let stableId = attachmentLookupMessageId.map(String.init)
            ?? attachmentFileId
            ?? String(id)
        return "\(conversationId):\(stableId)"
    }

    var inlineAttachmentURL: IMAttachmentURL? {
        let urls = metadata?.inlineAttachmentURLs ?? []
        guard let url = urls.first else { return nil }
        return IMAttachmentURL(
            downloadURL: url,
            fileName: attachmentFileName,
            expiresIn: 0,
            candidateURLs: Array(urls.dropFirst())
        )
    }
}

private struct IMRemoteAttachmentImage: View {
    let url: URL
    let maxSize: CGSize
    let onFailure: () -> Void

    @State private var image: UIImage?
    @State private var failed = false

    init(url: URL, maxSize: CGSize, onFailure: @escaping () -> Void) {
        self.url = url
        self.maxSize = maxSize
        self.onFailure = onFailure
        _image = State(initialValue: IMRemoteAttachmentImageCache.shared.image(for: url))
    }

    var body: some View {
        Group {
            if let image {
                let size = displaySize(for: image)
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size.width, height: size.height)
            } else if failed {
                imageFailurePlaceholder
            } else {
                imageLoadingPlaceholder
            }
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task(id: url) {
            if let cached = IMRemoteAttachmentImageCache.shared.image(for: url) {
                image = cached
                failed = false
                return
            }
            image = nil
            failed = false
            do {
                let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 12)
                let span = DiagnosticRecorder.beginHTTP(request)
                let data: Data
                let response: URLResponse
                do {
                    (data, response) = try await URLSession.shared.data(for: request)
                } catch {
                    await DiagnosticRecorder.shared.finishHTTP(
                        span,
                        statusCode: nil,
                        responseBytes: nil,
                        errorClass: String(describing: type(of: error))
                    )
                    throw error
                }
                await DiagnosticRecorder.shared.finishHTTP(
                    span,
                    statusCode: (response as? HTTPURLResponse)?.statusCode,
                    responseBytes: data.count
                )
                guard let loaded = UIImage(data: data) else {
                    throw URLError(.cannotDecodeContentData)
                }
                if !Task.isCancelled {
                    IMRemoteAttachmentImageCache.shared.set(loaded, for: url)
                    image = loaded
                }
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled {
                    failed = true
                    onFailure()
                }
            }
        }
    }

    private func displaySize(for image: UIImage) -> CGSize {
        let original = image.size
        guard original.width > 0, original.height > 0 else { return maxSize }
        let scale = min(maxSize.width / original.width, maxSize.height / original.height)
        return CGSize(
            width: max(1, original.width * scale),
            height: max(1, original.height * scale)
        )
    }

    private var imageLoadingPlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(.tt.bgSubtle)
            ProgressView()
        }
        .frame(width: maxSize.width, height: maxSize.height)
    }

    private var imageFailurePlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(.tt.bgSubtle)
            Image(systemName: "exclamationmark.triangle")
                .font(.tt.iconEmpty)
                .foregroundStyle(.tt.textSecondary)
        }
        .frame(width: maxSize.width, height: maxSize.height)
    }
}

private final class IMRemoteAttachmentImageCache: @unchecked Sendable {
    static let shared = IMRemoteAttachmentImageCache()

    private let cache: NSCache<NSString, UIImage>

    private init() {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 80
        cache.totalCostLimit = 48 * 1024 * 1024
        self.cache = cache
    }

    func image(for url: URL) -> UIImage? {
        cache.object(forKey: key(for: url))
    }

    func set(_ image: UIImage, for url: URL) {
        let pixelCount = Int(image.size.width * image.scale * image.size.height * image.scale)
        cache.setObject(image, forKey: key(for: url), cost: max(1, pixelCount * 4))
    }

    private func key(for url: URL) -> NSString {
        url.absoluteString as NSString
    }
}

private extension Array {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

/// 全屏图片查看器：适配屏幕 + 双指缩放 + 双击复位，点关闭或下滑退出。
struct IMImageViewer: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                        .scaleEffect(scale)
                        .gesture(
                            MagnificationGesture()
                                .onChanged { scale = max(1, $0) }
                                .onEnded { _ in withAnimation { scale = max(1, min(scale, 4)) } }
                        )
                        .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2 } }
                case .failure:
                    Image(systemName: "photo").font(.tt.iconEmptyHero).foregroundStyle(.white.opacity(0.6))
                default:
                    ProgressView().tint(.white)
                }
            }
        }
        .overlay(alignment: .topTrailing) {
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.tt.iconEmpty)
                    .foregroundStyle(.white.opacity(0.9))
                    .padding()
            }
        }
    }
}
