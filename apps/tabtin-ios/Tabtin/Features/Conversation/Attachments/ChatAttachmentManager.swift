import AVFoundation
import Foundation
import os
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - 附件管理

enum ChatAttachmentUploadConfig {
    static let maxAttachments = 10
    static let maxRetryCount = 3
    static let maxConcurrentUploads = 3
    static let imageMaxSize: Int64 = 20 * 1024 * 1024
    static let fileMaxSize: Int64 = 50 * 1024 * 1024
    static let mediaMaxSize: Int64 = 200 * 1024 * 1024
    static let largeFileThreshold: Int64 = 10 * 1024 * 1024
    static let imageMaxDimension: CGFloat = 2048
    static let jpegQuality: CGFloat = 0.82
    static let cameraJpegQuality: CGFloat = 0.95
    static let skipCompressionMimes: Set<String> = ["image/gif", "image/svg+xml"]

    private static let acceptedImageTypes: Set<String> = [
        "image/jpeg", "image/jpg", "image/png", "image/gif",
        "image/webp", "image/bmp", "image/avif", "image/svg+xml",
        "image/heic", "image/heif", "image/apng", "image/tiff",
    ]

    private static let acceptedFileTypes: Set<String> = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/plain", "text/csv", "text/markdown", "text/x-markdown",
        "application/json", "application/zip",
    ]

    private static let acceptedMediaTypes: Set<String> = [
        "video/mp4", "video/webm", "video/quicktime",
        "audio/mpeg", "audio/wav", "audio/mp3", "audio/ogg", "audio/webm",
    ]

    private static let extensionToMime: [String: String] = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
        "avif": "image/avif", "svg": "image/svg+xml", "heic": "image/heic",
        "heif": "image/heif", "pdf": "application/pdf", "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt": "application/vnd.ms-powerpoint",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt": "text/plain", "csv": "text/csv", "md": "text/markdown",
        "json": "application/json", "zip": "application/zip",
        "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
        "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    ]

    static func guessMimeType(from url: URL) -> String {
        if let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType {
            return mime
        }
        return extensionToMime[url.pathExtension.lowercased()] ?? "application/octet-stream"
    }

    /// 依据字节魔数识别相册/系统返回的图片真实格式，避免把 PNG/HEIC 伪装成 `.jpg` + `image/jpeg`
    /// 造成扩展名/MIME 与字节内容不符。返回的 MIME/扩展名与 `prepareImageData` 的转码产物对齐：
    /// - PNG：保持 `image/png` / `png`（转码仍输出 PNG）
    /// - GIF：保持 `image/gif` / `gif`（跳过压缩、保留动画）
    /// - 其余（JPEG/HEIC/WEBP/BMP/TIFF…）：统一按 `image/jpeg` / `jpg`（上传前转码为 JPEG）
    static func detectImageFormat(from data: Data) -> (mimeType: String, fileExtension: String) {
        let head = [UInt8](data.prefix(12))
        func matches(_ signature: [UInt8], at offset: Int = 0) -> Bool {
            guard head.count >= offset + signature.count else { return false }
            return zip(signature.indices, signature).allSatisfy { head[offset + $0.0] == $0.1 }
        }
        if matches([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return ("image/png", "png") }
        if matches([0x47, 0x49, 0x46, 0x38]) { return ("image/gif", "gif") }
        return ("image/jpeg", "jpg")
    }

    static func isImageType(_ mime: String) -> Bool {
        acceptedImageTypes.contains(mime.lowercased())
    }

    static func isMediaType(_ mime: String) -> Bool {
        acceptedMediaTypes.contains(mime.lowercased())
    }

    static func maxSize(for mime: String) -> Int64 {
        if isImageType(mime) { return imageMaxSize }
        if isMediaType(mime) { return mediaMaxSize }
        return fileMaxSize
    }

    static func validate(mimeType: String, size: Int64) -> String? {
        let mime = mimeType.lowercased()
        let accepted = acceptedImageTypes.union(acceptedFileTypes).union(acceptedMediaTypes)
        guard accepted.contains(mime) else {
            return "暂不支持 \(mimeType) 类型的附件。"
        }
        guard size > 0 else {
            return "文件为空或不可读取。"
        }
        let maxSize = maxSize(for: mime)
        guard size <= maxSize else {
            return "附件过大，最大支持 \(formatBytes(maxSize))。"
        }
        return nil
    }

    static func formatBytes(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}

@MainActor
@Observable
final class ChatAttachmentManager {
    private(set) var attachments: [ComposerLocalAttachment] = []

    @ObservationIgnored private var uploadTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private static let uploadLimiter = ChatAttachmentUploadLimiter(
        limit: ChatAttachmentUploadConfig.maxConcurrentUploads
    )

    var remainingSlots: Int {
        max(0, ChatAttachmentUploadConfig.maxAttachments - attachments.count)
    }

    func readyBlockPayloads() -> [[String: Any]] {
        attachments.compactMap { $0.readyBlockPayload() }
    }

    /// 恢复磁盘草稿中已由服务端接管的附件引用。
    /// 未完成上传的本地临时文件不会进入草稿仓库，因此这里不会偷偷重启上传。
    func restoreUploadedAttachments(_ restored: [ComposerLocalAttachment]) {
        uploadTasks.values.forEach { $0.cancel() }
        uploadTasks.removeAll()
        attachments = Array(restored.prefix(ChatAttachmentUploadConfig.maxAttachments))
    }

    /// 时间线重写后把原消息附件放回 Composer，同时保留用户已在输入框中添加的附件与上传任务。
    /// 恢复路径宁可暂时超过常规新增上限，也不能静默丢弃任一份尚未发送的用户资料。
    func mergeRestoredAttachments(_ restored: [ComposerLocalAttachment]) {
        let existingIDs = Set(attachments.map(\.id))
        attachments.append(contentsOf: restored.filter { !existingIDs.contains($0.id) })
    }

    func addPhoto(data: Data, filename: String, scope: UploadScope) -> String? {
        // 相册/系统图片是原始字节（可能是 PNG/HEIC）：按内容识别真实格式，扩展名与 MIME 对齐，
        // 不再无条件伪装成 `.jpg` + `image/jpeg`。
        let format = ChatAttachmentUploadConfig.detectImageFormat(from: data)
        let base = (filename as NSString).deletingPathExtension
        let resolvedName = "\(base.isEmpty ? "image" : base).\(format.fileExtension)"
        return addImageData(
            data,
            filename: resolvedName,
            mimeType: format.mimeType,
            kind: .photo,
            scope: scope
        )
    }

    func addCameraImage(_ image: UIImage, scope: UploadScope) -> String? {
        guard let data = image.jpegData(compressionQuality: ChatAttachmentUploadConfig.cameraJpegQuality),
              !data.isEmpty else {
            return "相机图片读取失败。"
        }
        let filename = "camera_\(Int(Date().timeIntervalSince1970)).jpg"
        return addImageData(
            data,
            filename: filename,
            mimeType: "image/jpeg",
            kind: .camera,
            scope: scope
        )
    }

    func addFile(url: URL, scope: UploadScope) -> String? {
        guard remainingSlots > 0 else {
            return "最多只能添加 \(ChatAttachmentUploadConfig.maxAttachments) 个附件。"
        }

        let didAccess = url.startAccessingSecurityScopedResource()
        defer {
            if didAccess { url.stopAccessingSecurityScopedResource() }
        }

        let filename = url.lastPathComponent.isEmpty ? "attachment" : url.lastPathComponent
        let mimeType = ChatAttachmentUploadConfig.guessMimeType(from: url)
        guard let size = fileSize(at: url) else {
            return "文件为空或不可读取。"
        }
        if let validationError = ChatAttachmentUploadConfig.validate(mimeType: mimeType, size: size) {
            return validationError
        }

        let localURL: URL
        do {
            localURL = try copyToTemporaryFile(from: url, filename: filename)
        } catch {
            return "附件暂存失败：\(error.localizedDescription)"
        }

        let attachment = ComposerLocalAttachment(
            id: UUID().uuidString,
            name: filename,
            kind: .file,
            byteCount: size,
            mimeType: mimeType,
            url: localURL,
            isTemporary: true
        )
        appendAndUpload(attachment, scope: scope)
        return nil
    }

    func retryAttachment(_ id: String, scope: UploadScope) -> String? {
        guard let attachment = attachments.first(where: { $0.id == id }) else { return nil }
        guard attachment.status == .error else { return nil }
        guard attachment.retryCount < ChatAttachmentUploadConfig.maxRetryCount else {
            markAttachmentFailed(id: id, message: "重试次数已达上限，请移除后重新选择。")
            return nil
        }
        updateAttachment(id) { item in
            item.retryCount += 1
            item.progress = 0
            item.errorMessage = nil
        }
        startUpload(id: id, scope: scope)
        return nil
    }

    func removeAttachment(
        _ id: String,
        contextId: String,
        deactivateUploaded: Bool = true,
        uploadScope: UploadScope? = nil
    ) {
        guard let attachment = attachments.first(where: { $0.id == id }) else { return }
        uploadTasks.removeValue(forKey: id)?.cancel()
        cleanupAttachment(
            attachment,
            contextId: contextId,
            deactivateUploaded: deactivateUploaded,
            uploadScope: uploadScope
        )
        attachments.removeAll { $0.id == id }
    }

    /// 取消并移除所有尚未完成的上传。
    ///
    /// 已经 ready 的服务端文件和 error 项保留在 Composer：前者可继续发送，后者仍可让用户
    /// 选择重试或单项移除。这样“取消全部上传”不会默默丢掉已经明确添加的资料。
    func cancelAndRemoveAllUploads(contextId: String) {
        let cancellableIDs = AttachmentUploadPolicy.cancellableAttachmentIDs(in: attachments)
        guard !cancellableIDs.isEmpty else { return }
        for id in cancellableIDs {
            removeAttachment(id, contextId: contextId)
        }
    }

    func clear(contextId: String, deactivateUploaded: Bool = true, uploadScope: UploadScope? = nil) {
        uploadTasks.values.forEach { $0.cancel() }
        uploadTasks.removeAll()
        attachments.forEach {
            cleanupAttachment(
                $0,
                contextId: contextId,
                deactivateUploaded: deactivateUploaded,
                uploadScope: uploadScope
            )
        }
        attachments.removeAll()
    }

    private func addImageData(
        _ data: Data,
        filename: String,
        mimeType: String,
        kind: ComposerLocalAttachment.Kind,
        scope: UploadScope
    ) -> String? {
        guard remainingSlots > 0 else {
            return "最多只能添加 \(ChatAttachmentUploadConfig.maxAttachments) 个附件。"
        }
        if let validationError = ChatAttachmentUploadConfig.validate(mimeType: mimeType, size: Int64(data.count)) {
            return validationError
        }
        let url: URL
        do {
            url = try writeTemporaryAttachment(data: data, filename: filename)
        } catch {
            return "附件暂存失败：\(error.localizedDescription)"
        }
        let attachment = ComposerLocalAttachment(
            id: UUID().uuidString,
            name: filename,
            kind: kind,
            byteCount: Int64(data.count),
            mimeType: mimeType,
            url: url,
            isTemporary: true
        )
        appendAndUpload(attachment, scope: scope)
        return nil
    }

    private func appendAndUpload(_ attachment: ComposerLocalAttachment, scope: UploadScope) {
        attachments.append(attachment)
        startUpload(id: attachment.id, scope: scope)
    }

    private func startUpload(id: String, scope: UploadScope) {
        uploadTasks[id]?.cancel()
        updateAttachment(id) { attachment in
            attachment.status = .uploading
            attachment.progress = 0.05
            attachment.errorMessage = nil
        }
        uploadTasks[id] = Task { [weak self] in
            await self?.performUpload(id: id, scope: scope)
        }
    }

    private func performUpload(id: String, scope: UploadScope) async {
        await Self.uploadLimiter.wait()
        guard let attachment = attachments.first(where: { $0.id == id }) else {
            await Self.uploadLimiter.signal()
            return
        }
        guard let url = attachment.url else {
            markAttachmentFailed(id: id, message: "附件不可访问：\(attachment.name)")
            uploadTasks.removeValue(forKey: id)
            await Self.uploadLimiter.signal()
            return
        }

        do {
            try Task.checkCancellation()
            updateAttachment(id) { $0.progress = 0.15 }

            let result: UploadResult
            if attachment.kind == .file {
                result = try await OSSUploadService.shared.directUpload(
                    fileURL: url,
                    fileName: attachment.name,
                    contentType: attachment.mimeType ?? "application/octet-stream",
                    folder: "chat/attachments",
                    scope: scope,
                    onProgress: progressHandler(for: id, base: 0.15, range: 0.8)
                )
            } else {
                let prepared = try await Self.prepareImageData(
                    url: url,
                    fallbackMimeType: attachment.mimeType
                )
                try Task.checkCancellation()
                updateAttachment(id) { $0.progress = 0.45 }
                result = try await OSSUploadService.shared.directUpload(
                    data: prepared.data,
                    fileName: attachment.name,
                    contentType: prepared.contentType,
                    folder: "chat/attachments",
                    scope: scope,
                    onProgress: progressHandler(for: id, base: 0.45, range: 0.5)
                )
            }

            try Task.checkCancellation()
            updateAttachment(id) { item in
                item.status = .ready
                item.progress = 1
                item.fileId = result.fileId
                item.remoteURL = result.accessUrl
                item.errorMessage = nil
            }
        } catch is CancellationError {
            // 用户移除附件或离开会话时取消上传，不把取消态暴露给用户。
        } catch {
            markAttachmentFailed(id: id, message: OSSBusinessError.userMessage(for: error))
        }

        uploadTasks.removeValue(forKey: id)
        await Self.uploadLimiter.signal()
    }

    private func progressHandler(
        for id: String,
        base: Double,
        range: Double
    ) -> @Sendable (Double) -> Void {
        { [weak self] progress in
            Task { @MainActor in
                let clamped = min(max(progress, 0), 1)
                let mapped = base + clamped * range
                self?.updateAttachment(id) { item in
                    guard item.status == .uploading else { return }
                    item.progress = max(item.progress, mapped)
                }
            }
        }
    }

    private func updateAttachment(_ id: String, mutate: (inout ComposerLocalAttachment) -> Void) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        mutate(&attachments[index])
    }

    private func markAttachmentFailed(id: String, message: String) {
        updateAttachment(id) { attachment in
            attachment.status = .error
            attachment.progress = 0
            attachment.errorMessage = message
            attachment.fileId = nil
            attachment.remoteURL = nil
        }
    }

    private func cleanupAttachment(
        _ attachment: ComposerLocalAttachment,
        contextId: String,
        deactivateUploaded: Bool,
        uploadScope: UploadScope? = nil
    ) {
        if attachment.isTemporary, let url = attachment.url {
            try? FileManager.default.removeItem(at: url)
        }
        guard deactivateUploaded,
              attachment.status == .ready,
              let fileId = attachment.fileId else { return }
        Task {
            await OSSUploadService.shared.deactivateUsage(
                fileId: fileId,
                module: uploadScope?.module ?? "chat",
                contextType: uploadScope?.contextType ?? "message",
                contextId: uploadScope?.contextId ?? contextId
            )
        }
    }

    private func fileSize(at url: URL) -> Int64? {
        guard let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64,
              size > 0 else {
            return nil
        }
        return size
    }

    private func copyToTemporaryFile(from url: URL, filename: String) throws -> URL {
        let destination = temporaryDirectory()
            .appendingPathComponent("\(UUID().uuidString)-\(safeFilename(filename))")
        try FileManager.default.copyItem(at: url, to: destination)
        return destination
    }

    private func writeTemporaryAttachment(data: Data, filename: String) throws -> URL {
        let destination = temporaryDirectory()
            .appendingPathComponent("\(UUID().uuidString)-\(safeFilename(filename))")
        try data.write(to: destination, options: [.atomic])
        return destination
    }

    private func temporaryDirectory() -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("tabtin-composer", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func safeFilename(_ filename: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:")
            .union(.newlines)
            .union(.controlCharacters)
        let cleaned = filename.components(separatedBy: invalid).joined(separator: "_")
        return cleaned.isEmpty ? "attachment" : cleaned
    }

    private struct PreparedImageData: Sendable {
        let data: Data
        let contentType: String
    }

    nonisolated private static func prepareImageData(
        url: URL,
        fallbackMimeType: String?
    ) async throws -> PreparedImageData {
        try await Task.detached(priority: .userInitiated) {
            var data = try Data(contentsOf: url)
            var contentType = fallbackMimeType ?? "image/jpeg"
            if !ChatAttachmentUploadConfig.skipCompressionMimes.contains(contentType),
               let image = UIImage(data: data),
               let compressed = compressImage(image, mimeType: contentType) {
                data = compressed
                contentType = contentType == "image/png" ? "image/png" : "image/jpeg"
            }
            return PreparedImageData(data: data, contentType: contentType)
        }.value
    }

    nonisolated private static func compressImage(_ image: UIImage, mimeType: String) -> Data? {
        var output = image
        let maxDim = ChatAttachmentUploadConfig.imageMaxDimension
        if image.size.width > maxDim || image.size.height > maxDim {
            let scale = min(maxDim / image.size.width, maxDim / image.size.height)
            let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            output = renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        }
        if mimeType == "image/png" { return output.pngData() }
        return output.jpegData(compressionQuality: ChatAttachmentUploadConfig.jpegQuality)
    }
}

private actor ChatAttachmentUploadLimiter {
    private let limit: Int
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(limit: Int) {
        self.limit = max(1, limit)
    }

    func wait() async {
        if active < limit {
            active += 1
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func signal() {
        if waiters.isEmpty {
            active = max(0, active - 1)
        } else {
            waiters.removeFirst().resume()
        }
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onPick: (UIImage?) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick, dismiss: dismiss)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = .camera
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onPick: (UIImage?) -> Void
        let dismiss: DismissAction

        init(onPick: @escaping (UIImage?) -> Void, dismiss: DismissAction) {
            self.onPick = onPick
            self.dismiss = dismiss
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            onPick(info[.originalImage] as? UIImage)
            dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onPick(nil)
            dismiss()
        }
    }
}
