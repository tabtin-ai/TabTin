import CryptoKit
import Foundation
import os
import UIKit

struct UploadResult: Sendable {
    let fileId: String
    let accessUrl: String
    let fileName: String
}

struct OSSFileAccess: Decodable, Sendable {
    let fileId: String
    let fileName: String
    let fileSize: Int64
    let mimeType: String
    let accessUrl: String?
    let cdnUrl: String?
    let resolvedUrl: String

    enum CodingKeys: String, CodingKey {
        case fileId = "file_id"
        case fileName = "file_name"
        case fileSize = "file_size"
        case mimeType = "mime_type"
        case accessUrl = "access_url"
        case cdnUrl = "cdn_url"
        case resolvedUrl = "resolved_url"
    }

    var displayUrl: String {
        [cdnUrl ?? "", accessUrl ?? "", resolvedUrl]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { $0.lowercased().hasPrefix("https://") || $0.lowercased().hasPrefix("http://") }
            ?? ""
    }
}

/// 一次直传的服务端归属范围。签名、确认与离线确认重试必须使用同一份不可变值。
struct UploadScope: Sendable, Codable, Equatable {
    let module: String
    let contextType: String
    let contextId: String
    let organizationId: String
    let isPublic: Bool
}

struct OSSPutError: Error, LocalizedError {
    let statusCode: Int
    var errorDescription: String? { "上传失败（\(statusCode)）" }
    var isServerError: Bool { (500...599).contains(statusCode) }
}

enum OSSBusinessError: String {
    case storageQuotaExceeded = "STORAGE_QUOTA_EXCEEDED"
    case billingBlocked = "BILLING_BLOCKED"
    case presignScopeMismatch = "PRESIGN_SCOPE_MISMATCH"

    static func from(_ error: Error) -> OSSBusinessError? {
        guard case APIError.apiErrorWithCode(let code, _) = error else { return nil }
        return OSSBusinessError(rawValue: code)
    }

    static func userMessage(for error: Error) -> String {
        switch from(error) {
        case .storageQuotaExceeded:
            return "存储空间已满，请清理文件或升级套餐"
        case .billingBlocked:
            return "计费异常，请检查账户状态"
        case .presignScopeMismatch:
            return "上传签名范围已失效，请重新选择图片后重试。"
        case .none:
            return error.localizedDescription
        }
    }
}

actor OSSUploadService {
    static let shared = OSSUploadService()

    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "OSSUpload")
    // 旧队列未持久化完整 scope，升级后不迁移，避免对同一 object key 无限失败重试。
    private static let legacyPendingConfirmsKey = "com.tabtin.oss.pendingConfirms"
    private static let pendingConfirmsKey = "com.tabtin.oss.pendingConfirms.v2"
    private static let confirmMaxRetries = 3
    private static let apiRetryMax = 3
    private static let putRetryMax = 3
    private static let retryBaseDelay: UInt64 = 500_000_000
    private static let hashChunkSize = 2 * 1024 * 1024

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.waitsForConnectivity = true
        return URLSession(configuration: config)
    }()

    private init() {
        UserDefaults.standard.removeObject(forKey: Self.legacyPendingConfirmsKey)
    }

    func directUpload(
        data: Data,
        fileName: String,
        contentType: String,
        folder: String = "chat/attachments",
        scope: UploadScope,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> UploadResult {
        try Task.checkCancellation()
        let sha256Hex = Self.computeFileHash(data: data)

        let presign: PresignResponse = try await withAPIRetry {
            try Task.checkCancellation()
            return try await APIClient.shared.post(
                path: Endpoints.OSS.presignUpload,
                body: Self.makePresignBody(
                    fileName: fileName,
                    folder: folder,
                    contentType: contentType,
                    fileSize: data.count,
                    sha256Hex: sha256Hex,
                    scope: scope
                )
            )
        }

        if presign.instant {
            guard let fileId = presign.fileId else { throw APIError.apiError("秒传响应缺少文件 ID") }
            return UploadResult(
                fileId: fileId,
                accessUrl: presign.accessUrl ?? presign.cdnUrl ?? "",
                fileName: presign.fileName ?? fileName
            )
        }

        guard let presignedUrl = presign.presignedUrl else { throw APIError.apiError("上传地址为空") }
        guard let objectKey = presign.objectKey else { throw APIError.apiError("上传对象为空") }

        try await uploadToOSS(
            presignedUrl: presignedUrl,
            data: data,
            contentType: contentType,
            onProgress: onProgress
        )

        do {
            let confirm: ConfirmResponse = try await withAPIRetry {
                try Task.checkCancellation()
                return try await APIClient.shared.post(
                    path: Endpoints.OSS.confirmUpload,
                    body: Self.makeConfirmBody(
                        objectKey: objectKey,
                        fileName: fileName,
                        fileSize: data.count,
                        contentType: contentType,
                        sha256Hex: sha256Hex,
                        scope: scope
                    )
                )
            }
            return UploadResult(
                fileId: confirm.fileId,
                accessUrl: confirm.accessUrl ?? confirm.cdnUrl ?? "",
                fileName: confirm.fileName ?? fileName
            )
        } catch {
            if !Task.isCancelled && !Self.isPresignScopeMismatch(error) {
                persistPendingConfirm(PendingConfirmEntry(
                    objectKey: objectKey,
                    fileName: fileName,
                    fileSize: data.count,
                    contentType: contentType,
                    sha256Hex: sha256Hex,
                    scope: scope
                ))
            }
            throw error
        }
    }

    func directUpload(
        fileURL: URL,
        fileName: String,
        contentType: String,
        folder: String = "chat/attachments",
        scope: UploadScope,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> UploadResult {
        try Task.checkCancellation()
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        guard let fileSize = attrs[.size] as? Int, fileSize > 0 else {
            throw APIError.apiError("文件为空或不可读取")
        }
        let sha256Hex = try Self.computeFileHash(fileURL: fileURL, fileSize: fileSize)

        let presign: PresignResponse = try await withAPIRetry {
            try Task.checkCancellation()
            return try await APIClient.shared.post(
                path: Endpoints.OSS.presignUpload,
                body: Self.makePresignBody(
                    fileName: fileName,
                    folder: folder,
                    contentType: contentType,
                    fileSize: fileSize,
                    sha256Hex: sha256Hex,
                    scope: scope
                )
            )
        }

        if presign.instant {
            guard let fileId = presign.fileId else { throw APIError.apiError("秒传响应缺少文件 ID") }
            return UploadResult(
                fileId: fileId,
                accessUrl: presign.accessUrl ?? presign.cdnUrl ?? "",
                fileName: presign.fileName ?? fileName
            )
        }

        guard let presignedUrl = presign.presignedUrl else { throw APIError.apiError("上传地址为空") }
        guard let objectKey = presign.objectKey else { throw APIError.apiError("上传对象为空") }

        try await uploadToOSS(
            presignedUrl: presignedUrl,
            fileURL: fileURL,
            contentType: contentType,
            contentLength: fileSize,
            onProgress: onProgress
        )

        do {
            let confirm: ConfirmResponse = try await withAPIRetry {
                try Task.checkCancellation()
                return try await APIClient.shared.post(
                    path: Endpoints.OSS.confirmUpload,
                    body: Self.makeConfirmBody(
                        objectKey: objectKey,
                        fileName: fileName,
                        fileSize: fileSize,
                        contentType: contentType,
                        sha256Hex: sha256Hex,
                        scope: scope
                    )
                )
            }
            return UploadResult(
                fileId: confirm.fileId,
                accessUrl: confirm.accessUrl ?? confirm.cdnUrl ?? "",
                fileName: confirm.fileName ?? fileName
            )
        } catch {
            if !Task.isCancelled && !Self.isPresignScopeMismatch(error) {
                persistPendingConfirm(PendingConfirmEntry(
                    objectKey: objectKey,
                    fileName: fileName,
                    fileSize: fileSize,
                    contentType: contentType,
                    sha256Hex: sha256Hex,
                    scope: scope
                ))
            }
            throw error
        }
    }

    func deleteFile(fileId: String) async {
        do {
            let _: MessageResponse = try await APIClient.shared.delete(path: Endpoints.OSS.file(fileId))
        } catch {
            logger.error("delete uploaded file failed: \(error.localizedDescription)")
        }
    }

    /// 用 file_id 换取当前用户可访问的新鲜签名地址；冻结快照绝不保存会过期的 URL。
    func resolveFile(fileId: String) async throws -> OSSFileAccess {
        try await APIClient.shared.get(path: Endpoints.OSS.file(fileId))
    }

    func deactivateUsage(fileId: String, module: String, contextType: String, contextId: String) async {
        do {
            let _: MessageResponse = try await APIClient.shared.post(
                path: Endpoints.OSS.deactivateUsage,
                body: [
                    "file_id": fileId,
                    "module": module,
                    "context_type": contextType,
                    "context_id": contextId,
                ]
            )
        } catch {
            logger.error("deactivate usage failed: \(error.localizedDescription)")
        }
    }

    func retryPendingConfirms() async {
        let queue = loadPendingConfirms()
        guard !queue.isEmpty else { return }
        var remaining: [PendingConfirmEntry] = []

        for var entry in queue {
            if entry.retryCount >= Self.confirmMaxRetries { continue }
            do {
                let _: ConfirmResponse = try await APIClient.shared.post(
                    path: Endpoints.OSS.confirmUpload,
                    body: Self.makeConfirmBody(
                        objectKey: entry.objectKey,
                        fileName: entry.fileName,
                        fileSize: entry.fileSize,
                        contentType: entry.contentType,
                        sha256Hex: entry.sha256Hex,
                        scope: entry.scope
                    )
                )
            } catch {
                if Self.isPresignScopeMismatch(error) {
                    logger.warning("discard pending confirm with mismatched scope: \(entry.objectKey, privacy: .private)")
                } else {
                    entry.retryCount += 1
                    remaining.append(entry)
                }
            }
        }

        savePendingConfirms(remaining)
    }

    private func uploadToOSS(
        presignedUrl: String,
        data: Data,
        contentType: String,
        onProgress: (@Sendable (Double) -> Void)?
    ) async throws {
        try await withPutRetry { isRetry in
            guard let url = URL(string: presignedUrl) else { throw APIError.invalidURL }
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.setValue("\(data.count)", forHTTPHeaderField: "Content-Length")
            let diagnosticSpan = DiagnosticRecorder.beginHTTP(request, retry: isRetry)

            let taskId = await beginBackgroundTask()
            defer { Task { await endBackgroundTask(taskId) } }
            let response: URLResponse
            do {
                if let onProgress {
                    let delegate = UploadProgressDelegate(onProgress: onProgress)
                    let progressSession = URLSession(
                        configuration: session.configuration,
                        delegate: delegate,
                        delegateQueue: nil
                    )
                    defer { progressSession.finishTasksAndInvalidate() }
                    (_, response) = try await progressSession.upload(for: request, from: data)
                } else {
                    (_, response) = try await session.upload(for: request, from: data)
                }
            } catch {
                await DiagnosticRecorder.shared.finishHTTP(
                    diagnosticSpan,
                    statusCode: nil,
                    responseBytes: nil,
                    errorClass: String(describing: type(of: error))
                )
                throw error
            }
            await DiagnosticRecorder.shared.finishHTTP(
                diagnosticSpan,
                statusCode: (response as? HTTPURLResponse)?.statusCode,
                responseBytes: 0
            )
            try Self.validatePutResponse(response)
        }
    }

    private func uploadToOSS(
        presignedUrl: String,
        fileURL: URL,
        contentType: String,
        contentLength: Int,
        onProgress: (@Sendable (Double) -> Void)?
    ) async throws {
        try await withPutRetry { isRetry in
            guard let url = URL(string: presignedUrl) else { throw APIError.invalidURL }
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.setValue("\(contentLength)", forHTTPHeaderField: "Content-Length")
            let diagnosticSpan = DiagnosticRecorder.beginHTTP(request, retry: isRetry)

            let taskId = await beginBackgroundTask()
            defer { Task { await endBackgroundTask(taskId) } }
            let response: URLResponse
            do {
                if let onProgress {
                    let delegate = UploadProgressDelegate(onProgress: onProgress)
                    let progressSession = URLSession(
                        configuration: session.configuration,
                        delegate: delegate,
                        delegateQueue: nil
                    )
                    defer { progressSession.finishTasksAndInvalidate() }
                    (_, response) = try await progressSession.upload(for: request, fromFile: fileURL)
                } else {
                    (_, response) = try await session.upload(for: request, fromFile: fileURL)
                }
            } catch {
                await DiagnosticRecorder.shared.finishHTTP(
                    diagnosticSpan,
                    statusCode: nil,
                    responseBytes: nil,
                    errorClass: String(describing: type(of: error))
                )
                throw error
            }
            await DiagnosticRecorder.shared.finishHTTP(
                diagnosticSpan,
                statusCode: (response as? HTTPURLResponse)?.statusCode,
                responseBytes: 0
            )
            try Self.validatePutResponse(response)
        }
    }

    private func withAPIRetry<T>(operation: () async throws -> T) async throws -> T {
        var lastError: Error?
        for attempt in 0..<Self.apiRetryMax {
            do { return try await operation() } catch {
                lastError = error
                if OSSBusinessError.from(error) != nil || error is CancellationError {
                    throw error
                }
                if case APIError.unauthorized = error { throw error }
                if attempt < Self.apiRetryMax - 1 {
                    try? await Task.sleep(nanoseconds: Self.retryBaseDelay * UInt64(1 << attempt))
                }
            }
        }
        throw lastError ?? APIError.apiError("上传失败")
    }

    private func withPutRetry(operation: (Bool) async throws -> Void) async throws {
        var lastError: Error?
        for attempt in 0..<Self.putRetryMax {
            do { try await operation(attempt > 0); return } catch {
                lastError = error
                if error is CancellationError { throw error }
                if let put = error as? OSSPutError, !put.isServerError { throw error }
                if attempt < Self.putRetryMax - 1 {
                    try? await Task.sleep(nanoseconds: Self.retryBaseDelay * UInt64(1 << attempt))
                }
            }
        }
        throw lastError ?? APIError.apiError("上传失败")
    }

    private static func validatePutResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.networkError(URLError(.badServerResponse))
        }
        guard (200...299).contains(http.statusCode) else {
            throw OSSPutError(statusCode: http.statusCode)
        }
    }

    static func computeFileHash(data: Data) -> String {
        let size = data.count
        let input: Data
        if size <= hashChunkSize * 4 {
            input = data
        } else {
            var combined = Data()
            combined.append(data.prefix(hashChunkSize))
            combined.append(data.suffix(hashChunkSize))
            combined.append(Data(String(size).utf8))
            input = combined
        }
        return SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
    }

    static func computeFileHash(fileURL: URL, fileSize: Int) throws -> String {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        if fileSize <= hashChunkSize * 4 {
            let data = try handle.readToEnd() ?? Data()
            return computeFileHash(data: data)
        }

        let head = try handle.read(upToCount: hashChunkSize) ?? Data()
        try handle.seek(toOffset: UInt64(max(0, fileSize - hashChunkSize)))
        let tail = try handle.read(upToCount: hashChunkSize) ?? Data()
        var combined = Data()
        combined.append(head)
        combined.append(tail)
        combined.append(Data(String(fileSize).utf8))
        return SHA256.hash(data: combined).map { String(format: "%02x", $0) }.joined()
    }

    @MainActor
    private func beginBackgroundTask() -> UIBackgroundTaskIdentifier {
        let box = TaskIDBox()
        box.id = UIApplication.shared.beginBackgroundTask(withName: "OSSUpload") {
            UIApplication.shared.endBackgroundTask(box.id)
        }
        return box.id
    }

    @MainActor
    private func endBackgroundTask(_ taskId: UIBackgroundTaskIdentifier) {
        guard taskId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(taskId)
    }

    private func persistPendingConfirm(_ entry: PendingConfirmEntry) {
        var queue = loadPendingConfirms()
        queue.append(entry)
        savePendingConfirms(queue)
    }

    private func loadPendingConfirms() -> [PendingConfirmEntry] {
        guard let data = UserDefaults.standard.data(forKey: Self.pendingConfirmsKey),
              let queue = try? JSONDecoder().decode([PendingConfirmEntry].self, from: data) else {
            return []
        }
        return queue
    }

    private func savePendingConfirms(_ queue: [PendingConfirmEntry]) {
        if queue.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.pendingConfirmsKey)
        } else if let data = try? JSONEncoder().encode(queue) {
            UserDefaults.standard.set(data, forKey: Self.pendingConfirmsKey)
        }
    }

    private struct PendingConfirmEntry: Codable, Sendable {
        let objectKey: String
        let fileName: String
        let fileSize: Int
        let contentType: String
        let sha256Hex: String
        let scope: UploadScope
        var retryCount = 0
    }

    private nonisolated static func makePresignBody(
        fileName: String,
        folder: String,
        contentType: String,
        fileSize: Int,
        sha256Hex: String,
        scope: UploadScope
    ) -> sending [String: Any] {
        [
            "filename": fileName,
            "folder": folder,
            "content_type": contentType,
            "file_size": fileSize,
            "file_hash": sha256Hex,
            "module": scope.module,
            "context_type": scope.contextType,
            "context_id": scope.contextId,
            "organization_id": scope.organizationId,
            "is_public": scope.isPublic,
        ]
    }

    private nonisolated static func makeConfirmBody(
        objectKey: String,
        fileName: String,
        fileSize: Int,
        contentType: String,
        sha256Hex: String,
        scope: UploadScope
    ) -> sending [String: Any] {
        let body: [String: Any] = [
            "object_key": objectKey,
            "file_name": fileName,
            "file_size": fileSize,
            "content_type": contentType,
            "file_hash": sha256Hex,
            "module": scope.module,
            "context_type": scope.contextType,
            "context_id": scope.contextId,
            "organization_id": scope.organizationId,
            "is_public": scope.isPublic,
        ]
        return body
    }

    private nonisolated static func isPresignScopeMismatch(_ error: Error) -> Bool {
        guard case APIError.apiErrorWithCode(code: "PRESIGN_SCOPE_MISMATCH", message: _) = error else {
            return false
        }
        return true
    }
}

private final class TaskIDBox: @unchecked Sendable {
    var id: UIBackgroundTaskIdentifier = .invalid
}

private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}

private struct PresignResponse: Decodable {
    let instant: Bool
    let objectKey: String?
    let presignedUrl: String?
    let accessUrl: String?
    let cdnUrl: String?
    let fileId: String?
    let fileName: String?

    enum CodingKeys: String, CodingKey {
        case instant
        case objectKey = "object_key"
        case presignedUrl = "presigned_url"
        case accessUrl = "access_url"
        case cdnUrl = "cdn_url"
        case fileId = "file_id"
        case fileName = "file_name"
    }
}

private struct ConfirmResponse: Decodable {
    let fileId: String
    let accessUrl: String?
    let cdnUrl: String?
    let fileName: String?

    enum CodingKeys: String, CodingKey {
        case fileId = "file_id"
        case accessUrl = "access_url"
        case cdnUrl = "cdn_url"
        case fileName = "file_name"
    }
}
