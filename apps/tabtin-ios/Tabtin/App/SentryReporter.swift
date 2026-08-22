import Foundation
import CryptoKit
import Sentry
import UIKit

/// iOS 端 Sentry 错误监控接入（，errors-only）。
/// DSN 由 Debug 页填写并本地保存；未填写时不上报。
/// 字段契约（tags 白名单 / 脱敏红线）：`docs/agent/error-context-schema.md`。
enum SentryReporter {
    static func start() {
        apply(dsn: SentryDSN.stored, persist: false)
        IOSDiagnosticUploader.shared.start()
    }

    @discardableResult
    static func apply(dsn raw: String, persist: Bool = true) -> Bool {
        guard SentryDSN.isValid(raw) else { return false }
        let dsn = SentryDSN.normalize(raw)
        if persist { SentryDSN.stored = dsn }
        SentrySDK.close()
        guard !dsn.isEmpty else { return true }
        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = currentEnvironment
            options.releaseName = "tabtin-ios@\(AppConfig.appVersion)"
            options.tracesSampleRate = 0
            options.sendDefaultPii = false
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            #if DEBUG
            options.debug = true
            #endif
            options.beforeSend = { event in
                let scrubbed = SentryScrub.scrub(event)
                DiagnosticRecorder.captureApp(
                    name: "sentry_error",
                    result: "captured"
                )
                return scrubbed
            }
        }
        return true
    }

    /// 本地开发和测试预设统一归 test；只有正式服务归 production。
    /// 与 `AppConfig.configuredAPIBaseURL` 的 test/production 判定同源，保证
    /// Sentry `environment` 与实际连接的后端环境一致，排障时不会对错服务器查日志。
    private static var currentEnvironment: String {
        #if DEBUG
        return "test"
        #else
        let preset = DebugEnvironmentStore.preset
        return preset == .production ? "production" : "test"
        #endif
    }
}

struct IOSPendingDiagnostic: Codable, Equatable {
    let diagnosticBundleId: UUID
    let organizationId: String
    let clientInstallId: String

    enum CodingKeys: String, CodingKey {
        case diagnosticBundleId
        case organizationId
        case clientInstallId
    }

    func backfilled(organizationId: String) -> IOSPendingDiagnostic {
        guard self.organizationId.isEmpty, !organizationId.isEmpty else { return self }
        return IOSPendingDiagnostic(
            diagnosticBundleId: diagnosticBundleId,
            organizationId: organizationId,
            clientInstallId: clientInstallId
        )
    }
}

enum IOSDiagnosticCompletionDisposition: Equatable {
    case recoverable
    case terminal
}

func diagnosticCompletionDisposition(statusCode: Int, responseBody: Data) -> IOSDiagnosticCompletionDisposition {
    if statusCode == 404 { return .recoverable }
    guard statusCode == 409 else { return .terminal }
    let message = (try? JSONSerialization.jsonObject(with: responseBody)) as? [String: Any]
    if message?["detail"] as? String == "uploaded object not found" {
        return .recoverable
    }
    return .terminal
}

private enum StoredZip {
    static func encode(filename: String, content: Data) -> Data {
        let name = Data(filename.utf8)
        let checksum = crc32(content)
        var output = Data()
        output.appendLE(UInt32(0x04034b50))
        output.appendLE(UInt16(20)); output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
        output.appendLE(UInt16(0)); output.appendLE(UInt16(0)); output.appendLE(checksum)
        output.appendLE(UInt32(content.count)); output.appendLE(UInt32(content.count))
        output.appendLE(UInt16(name.count)); output.appendLE(UInt16(0)); output.append(name); output.append(content)
        let centralOffset = output.count
        output.appendLE(UInt32(0x02014b50)); output.appendLE(UInt16(20)); output.appendLE(UInt16(20))
        output.appendLE(UInt16(0)); output.appendLE(UInt16(0)); output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
        output.appendLE(checksum); output.appendLE(UInt32(content.count)); output.appendLE(UInt32(content.count))
        output.appendLE(UInt16(name.count)); output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
        output.appendLE(UInt16(0)); output.appendLE(UInt16(0)); output.appendLE(UInt32(0)); output.appendLE(UInt32(0))
        output.append(name)
        let centralSize = output.count - centralOffset
        output.appendLE(UInt32(0x06054b50)); output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
        output.appendLE(UInt16(1)); output.appendLE(UInt16(1)); output.appendLE(UInt32(centralSize))
        output.appendLE(UInt32(centralOffset)); output.appendLE(UInt16(0))
        return output
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffff_ffff
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ (0xedb8_8320 & (0 &- (crc & 1))) }
        }
        return crc ^ 0xffff_ffff
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

struct IOSDiagnosticUploadState: Codable, Equatable {
    enum Phase: String, Codable {
        case uploading
        case awaitingCompletion
    }

    var phase: Phase
    let serverBundleId: String
    let sha256: String
    let size: Int

    func awaitingCompletionAfterTaskLoss() -> IOSDiagnosticUploadState {
        return IOSDiagnosticUploadState(
            phase: .awaitingCompletion,
            serverBundleId: serverBundleId,
            sha256: sha256,
            size: size
        )
    }
}

private final class IOSDiagnosticUploader: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = IOSDiagnosticUploader()

    private let flushLock = NSLock()
    private var isFlushing = false
    private var completingZipPaths = Set<String>()

    private struct UploadSession: Decodable {
        let bundleId: String
        let uploadUrl: String
        let uploadMethod: String?
        let uploadFields: [String: String]?
    }
    private struct Completion: Codable {
        let serverBundleId: String
        let localJSONPath: String
        let zipPath: String
        let statePath: String
        let uploadBodyPath: String?
        let sha256: String
        let size: Int
    }

    private lazy var backgroundSession: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: "com.tabtin.diagnostics.upload")
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func start() {
        _ = backgroundSession
        Task { try? await flush() }
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.scheduleFlush()
        }
    }

    func scheduleFlush() { Task { try? await flush() } }

    private func beginFlush() -> Bool {
        flushLock.lock()
        defer { flushLock.unlock() }
        guard !isFlushing else { return false }
        isFlushing = true
        return true
    }

    private func endFlush() {
        flushLock.lock()
        isFlushing = false
        flushLock.unlock()
    }

    private func setCompleting(_ zipPath: String, _ completing: Bool) {
        flushLock.lock()
        if completing {
            completingZipPaths.insert(zipPath)
        } else {
            completingZipPaths.remove(zipPath)
        }
        flushLock.unlock()
    }

    private func isCompleting(_ zipPath: String) -> Bool {
        flushLock.lock()
        defer { flushLock.unlock() }
        return completingZipPaths.contains(zipPath)
    }

    private func flush() async throws {
        guard beginFlush() else { return }
        defer { endFlush() }
        guard let token = KeychainService.shared.getAccessToken(), !token.isEmpty else { return }
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("diagnostics-v1", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let activeZipPaths = await activeUploadZipPaths()
        for jsonURL in files where jsonURL.pathExtension == "json" && jsonURL.lastPathComponent != "session.json" {
            let zipURL = jsonURL.deletingPathExtension().appendingPathExtension("zip")
            let stateURL = jsonURL.deletingPathExtension().appendingPathExtension("upload-state")
            if activeZipPaths.contains(zipURL.path) || isCompleting(zipURL.path) { continue }
            let persistedState = loadState(from: stateURL)
            if let state = persistedState, state.phase == .awaitingCompletion {
                requestCompletion(
                    Completion(
                        serverBundleId: state.serverBundleId,
                        localJSONPath: jsonURL.path,
                        zipPath: zipURL.path,
                        statePath: stateURL.path,
                        uploadBodyPath: nil,
                        sha256: state.sha256,
                        size: state.size
                    ),
                    token: token
                )
                continue
            }
            if let state = persistedState, state.phase == .uploading {
                let orphanedUploadBody = jsonURL.deletingPathExtension().appendingPathExtension("upload-body")
                try? FileManager.default.removeItem(at: orphanedUploadBody)
                try saveState(state.awaitingCompletionAfterTaskLoss(), to: stateURL)
                requestCompletion(
                    Completion(
                        serverBundleId: state.serverBundleId,
                        localJSONPath: jsonURL.path,
                        zipPath: zipURL.path,
                        statePath: stateURL.path,
                        uploadBodyPath: nil,
                        sha256: state.sha256,
                        size: state.size
                    ),
                    token: token
                )
                continue
            }
            if FileManager.default.fileExists(atPath: stateURL.path) {
                try? FileManager.default.removeItem(at: stateURL)
            }
            try? FileManager.default.removeItem(at: zipURL)
            guard let json = try? Data(contentsOf: jsonURL),
                  let pending = try? JSONDecoder().decode(IOSPendingDiagnostic.self, from: json),
                  !pending.organizationId.isEmpty else { continue }
            let zip = StoredZip.encode(filename: "meta.json", content: json)
            let sha = SHA256Digest.hex(zip)
            let session = try await createSession(pending: pending, bytes: zip.count, sha256: sha, token: token)
            try zip.write(to: zipURL, options: .atomic)
            try saveState(
                IOSDiagnosticUploadState(
                    phase: .uploading,
                    serverBundleId: session.bundleId,
                    sha256: sha,
                    size: zip.count
                ),
                to: stateURL
            )
            var request = URLRequest(url: URL(string: session.uploadUrl)!)
            let uploadBodyURL: URL
            if session.uploadMethod == "POST" {
                let boundary = "tabtin-diagnostic-\(UUID().uuidString.lowercased())"
                request.httpMethod = "POST"
                request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
                uploadBodyURL = jsonURL.deletingPathExtension().appendingPathExtension("upload-body")
                try multipartBody(
                    fields: session.uploadFields ?? [:],
                    fileName: "\(pending.diagnosticBundleId.uuidString.lowercased()).zip",
                    fileData: zip,
                    boundary: boundary
                ).write(to: uploadBodyURL, options: .atomic)
            } else {
                request.httpMethod = "PUT"
                request.setValue("application/zip", forHTTPHeaderField: "Content-Type")
                uploadBodyURL = zipURL
            }
            let task = backgroundSession.uploadTask(with: request, fromFile: uploadBodyURL)
            task.taskDescription = String(data: try JSONEncoder().encode(Completion(
                serverBundleId: session.bundleId,
                localJSONPath: jsonURL.path,
                zipPath: zipURL.path,
                statePath: stateURL.path,
                uploadBodyPath: uploadBodyURL == zipURL ? nil : uploadBodyURL.path,
                sha256: sha,
                size: zip.count
            )), encoding: .utf8)
            task.resume()
        }
    }

    private func activeUploadZipPaths() async -> Set<String> {
        await withCheckedContinuation { continuation in
            backgroundSession.getAllTasks { tasks in
                let paths = tasks.compactMap { task -> String? in
                    guard let raw = task.taskDescription?.data(using: .utf8),
                          let completion = try? JSONDecoder().decode(Completion.self, from: raw) else { return nil }
                    return completion.zipPath
                }
                continuation.resume(returning: Set(paths))
            }
        }
    }

    private func createSession(pending: IOSPendingDiagnostic, bytes: Int, sha256: String, token: String) async throws -> UploadSession {
        var request = URLRequest(url: URL(string: AppConfig.apiBaseURL)!.appendingPathComponent("diagnostics/bundles"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "organization_id": pending.organizationId,
            "client_install_id": pending.clientInstallId,
            "expected_size": bytes,
            "expected_sha256": sha256,
            "content_type": "application/zip",
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UploadSession.self, from: data)
    }

    private func multipartBody(
        fields: [String: String],
        fileName: String,
        fileData: Data,
        boundary: String
    ) -> Data {
        var body = Data()
        for (key, value) in fields {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".utf8))
            body.append(Data("\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".utf8))
        body.append(Data("Content-Type: application/zip\r\n\r\n".utf8))
        body.append(fileData)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    private func loadState(from url: URL) -> IOSDiagnosticUploadState? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(IOSDiagnosticUploadState.self, from: data)
    }

    private func saveState(_ state: IOSDiagnosticUploadState, to url: URL) throws {
        try JSONEncoder().encode(state).write(to: url, options: .atomic)
    }

    private func requestCompletion(_ completion: Completion, token: String) {
        guard !isCompleting(completion.zipPath) else { return }
        var request = URLRequest(url: URL(string: AppConfig.apiBaseURL)!.appendingPathComponent("diagnostics/bundles/\(completion.serverBundleId)/complete"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["sha256": completion.sha256, "size": completion.size])
        setCompleting(completion.zipPath, true)
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            defer { self?.setCompleting(completion.zipPath, false) }
            guard let status = (response as? HTTPURLResponse)?.statusCode else { return }
            if diagnosticCompletionDisposition(statusCode: status, responseBody: data ?? Data()) == .recoverable {
                if let uploadBodyPath = completion.uploadBodyPath {
                    try? FileManager.default.removeItem(atPath: uploadBodyPath)
                }
                try? FileManager.default.removeItem(atPath: completion.zipPath)
                try? FileManager.default.removeItem(atPath: completion.statePath)
                self?.scheduleFlush()
                return
            }
            if status == 409 {
                try? FileManager.default.removeItem(atPath: completion.localJSONPath)
                try? FileManager.default.removeItem(atPath: completion.zipPath)
                try? FileManager.default.removeItem(atPath: completion.statePath)
                if let uploadBodyPath = completion.uploadBodyPath {
                    try? FileManager.default.removeItem(atPath: uploadBodyPath)
                }
                return
            }
            guard (200..<300).contains(status) else { return }
            try? FileManager.default.removeItem(atPath: completion.localJSONPath)
            try? FileManager.default.removeItem(atPath: completion.zipPath)
            try? FileManager.default.removeItem(atPath: completion.statePath)
            if let uploadBodyPath = completion.uploadBodyPath {
                try? FileManager.default.removeItem(atPath: uploadBodyPath)
            }
        }.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let raw = task.taskDescription?.data(using: .utf8),
              let completion = try? JSONDecoder().decode(Completion.self, from: raw) else { return }
        guard error == nil,
              let status = (task.response as? HTTPURLResponse)?.statusCode,
              (200..<300).contains(status) else {
            if let uploadBodyPath = completion.uploadBodyPath {
                try? FileManager.default.removeItem(atPath: uploadBodyPath)
            }
            try? FileManager.default.removeItem(atPath: completion.zipPath)
            try? FileManager.default.removeItem(atPath: completion.statePath)
            return
        }
        if let uploadBodyPath = completion.uploadBodyPath {
            try? FileManager.default.removeItem(atPath: uploadBodyPath)
        }
        let stateURL = URL(fileURLWithPath: completion.statePath)
        do {
            try saveState(
                IOSDiagnosticUploadState(
                    phase: .awaitingCompletion,
                    serverBundleId: completion.serverBundleId,
                    sha256: completion.sha256,
                    size: completion.size
                ),
                to: stateURL
            )
        } catch {
            return
        }
        guard let token = KeychainService.shared.getAccessToken(), !token.isEmpty else { return }
        requestCompletion(completion, token: token)
    }
}

private enum SHA256Digest {
    static func hex(_ data: Data) -> String {
        return CryptoKit.SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// iOS 严重故障的最小可恢复现场。只保存结构化白名单，不写 prompt、文档、请求体或 token。
enum IOSDiagnosticRuntime {
    private struct SessionMarker: Codable {
        let sessionId: UUID
        let startedAt: Date
        let status: String
        let organizationId: String?
        let clientInstallId: String?
    }

    private struct Snapshot: Codable {
        let schemaVersion: Int
        let diagnosticBundleId: UUID
        let createdAt: Date
        let errorCategory: String
        let errorCode: String
        let handledBy: String
        let appVersion: String
        let buildNumber: String
        let gitSha: String?
        let platform: String
        let runtime: String
        let organizationId: String
        let clientInstallId: String
    }

    private static let queue = DispatchQueue(label: "com.tabtin.diagnostics", qos: .utility)
    private static let maxSnapshots = 5
    private static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("diagnostics-v1", isDirectory: true)
    }

    private static var markerURL: URL { directory.appendingPathComponent("session.json") }

    @MainActor
    static func start() {
        let organizationId = WorkspaceStore.shared.selectedOrganization?.id ?? ""
        let clientInstallId = ObservabilityInstallId.current()
        queue.async {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if let data = try? Data(contentsOf: markerURL),
               let previous = try? JSONDecoder().decode(SessionMarker.self, from: data),
               previous.status == "running" {
                _ = persist(
                    category: "ABNORMAL_TERMINATION",
                    code: "PREVIOUS_SESSION_UNCLEAN_EXIT",
                    handledBy: "next_start_recovery",
                    organizationId: previous.organizationId ?? "",
                    clientInstallId: previous.clientInstallId ?? clientInstallId
                )
            }
            writeMarker(status: "running", organizationId: organizationId, clientInstallId: clientInstallId)
            prune()
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: nil
        ) { _ in
            Task { @MainActor in markClean() }
        }
    }

    @discardableResult
    @MainActor
    static func capture(category: String, code: String, handledBy: String) -> String {
        let id = UUID()
        let organizationId = WorkspaceStore.shared.selectedOrganization?.id ?? ""
        let clientInstallId = ObservabilityInstallId.current()
        queue.async {
            _ = persist(
                id: id,
                category: category,
                code: code,
                handledBy: handledBy,
                organizationId: organizationId,
                clientInstallId: clientInstallId
            )
            prune()
            IOSDiagnosticUploader.shared.scheduleFlush()
        }
        return id.uuidString.lowercased()
    }

    @MainActor
    static func markClean() {
        let organizationId = WorkspaceStore.shared.selectedOrganization?.id ?? ""
        let clientInstallId = ObservabilityInstallId.current()
        queue.async {
            writeMarker(status: "clean", organizationId: organizationId, clientInstallId: clientInstallId)
        }
    }

    static func updateOrganization(_ organizationId: String?) {
        let resolvedOrganizationId = organizationId ?? ""
        let clientInstallId = ObservabilityInstallId.current()
        queue.async {
            writeMarker(
                status: "running",
                organizationId: resolvedOrganizationId,
                clientInstallId: clientInstallId
            )
            guard !resolvedOrganizationId.isEmpty else { return }
            let files = (try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )) ?? []
            for url in files where url.pathExtension == "json" && url.lastPathComponent != markerURL.lastPathComponent {
                guard let data = try? Data(contentsOf: url),
                      let snapshot = try? JSONDecoder().decode(IOSPendingDiagnostic.self, from: data),
                      snapshot.organizationId.isEmpty,
                      let updated = try? JSONEncoder().encode(snapshot.backfilled(organizationId: resolvedOrganizationId))
                else { continue }
                try? updated.write(to: url, options: .atomic)
            }
            IOSDiagnosticUploader.shared.scheduleFlush()
        }
    }

    private static func persist(
        id: UUID = UUID(),
        category: String,
        code: String,
        handledBy: String,
        organizationId: String,
        clientInstallId: String
    ) -> UUID {
        let snapshot = Snapshot(
            schemaVersion: 1,
            diagnosticBundleId: id,
            createdAt: Date(),
            errorCategory: category,
            errorCode: code,
            handledBy: handledBy,
            appVersion: AppConfig.appVersion,
            buildNumber: ObservabilityBuildMetadata.buildNumber,
            gitSha: ObservabilityBuildMetadata.gitSha,
            platform: "ios",
            runtime: "ios-native",
            organizationId: organizationId,
            clientInstallId: clientInstallId
        )
        if let data = try? JSONEncoder().encode(snapshot) {
            try? data.write(to: directory.appendingPathComponent("\(id.uuidString.lowercased()).json"), options: .atomic)
        }
        return id
    }

    private static func writeMarker(status: String, organizationId: String, clientInstallId: String) {
        let marker = SessionMarker(
            sessionId: UUID(),
            startedAt: Date(),
            status: status,
            organizationId: organizationId,
            clientInstallId: clientInstallId
        )
        if let data = try? JSONEncoder().encode(marker) {
            try? data.write(to: markerURL, options: .atomic)
        }
    }

    private static func prune() {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.creationDateKey],
            options: [.skipsHiddenFiles]
        ))?.filter { $0.pathExtension == "json" && $0.lastPathComponent != markerURL.lastPathComponent } ?? []
        let sorted = urls.sorted {
            let left = (try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            let right = (try? $1.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            return left < right
        }
        for url in sorted.dropLast(maxSnapshots) { try? FileManager.default.removeItem(at: url) }
    }
}
