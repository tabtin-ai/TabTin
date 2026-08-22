import Foundation
import Network
import UIKit

/// 已脱敏的 HTTP 计时上下文。调用方只能提供 URLRequest，记录器会立即丢弃 query/header/body。
struct DiagnosticHTTPSpan: Sendable {
    let requestID: String
    let method: String
    let hostClass: String
    let pathTemplate: String
    let requestBytes: Int?
    let retry: Bool
    let startedNanoseconds: UInt64
}

/// 移动端自有的结构化诊断账本。文件有界轮转，导出完全离线。
actor DiagnosticRecorder {
    static let shared = DiagnosticRecorder()

    private enum Stream: String, CaseIterable, Sendable {
        case app = "app-events.jsonl"
        case http = "http-events.jsonl"
        case websocket = "ws-events.jsonl"

        func rotatedName(_ generation: Int) -> String {
            rawValue.replacingOccurrences(of: ".jsonl", with: ".\(generation).jsonl")
        }
    }

    private struct Record: Encodable, Sendable {
        let timestamp: String
        let category: String
        var name: String? = nil
        var channel: String? = nil
        var phase: String? = nil
        var requestID: String? = nil
        var method: String? = nil
        var hostClass: String? = nil
        var path: String? = nil
        var statusCode: Int? = nil
        var durationMs: Int? = nil
        var requestBytes: Int? = nil
        var responseBytes: Int? = nil
        var retry: Bool? = nil
        var result: String? = nil
        var errorClass: String? = nil
        var messageType: String? = nil
        var payloadBytes: Int? = nil
        var closeCode: Int? = nil
        var attempt: Int? = nil
        var networkType: String? = nil

        enum CodingKeys: String, CodingKey {
            case timestamp, category, name, channel, phase, method, path, retry, result, attempt
            case requestID = "request_id"
            case hostClass = "host_class"
            case statusCode = "status_code"
            case durationMs = "duration_ms"
            case requestBytes = "request_bytes"
            case responseBytes = "response_bytes"
            case errorClass = "error_class"
            case messageType = "message_type"
            case payloadBytes = "payload_bytes"
            case closeCode = "close_code"
            case networkType = "network_type"
        }
    }

    private let directory: URL
    private let exportDirectory: URL
    private let encoder: JSONEncoder
    private let maxFileBytes = 1_048_576
    private let retainedGenerations = 2

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = support.appending(path: "Diagnostics", directoryHint: .isDirectory)
        exportDirectory = FileManager.default.temporaryDirectory
            .appending(path: "TabTinDiagnosticExports", directoryHint: .isDirectory)
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: exportDirectory, withIntermediateDirectories: true)
    }

    nonisolated static func captureApp(name: String, result: String? = nil, errorClass: String? = nil) {
        Task {
            await shared.append(
                .app,
                Record(
                    timestamp: Self.timestamp(),
                    category: "app",
                    name: Self.safeToken(name),
                    result: result.map(Self.safeToken),
                    errorClass: errorClass.map(Self.safeToken)
                )
            )
        }
    }

    nonisolated static func beginHTTP(_ request: URLRequest, retry: Bool = false) -> DiagnosticHTTPSpan {
        let target = DiagnosticTarget(url: request.url)
        let length = request.httpBody?.count ?? request.value(forHTTPHeaderField: "Content-Length").flatMap(Int.init)
        return DiagnosticHTTPSpan(
            requestID: UUID().uuidString,
            method: Self.safeToken(request.httpMethod?.uppercased() ?? "GET"),
            hostClass: target.hostClass,
            pathTemplate: target.pathTemplate,
            requestBytes: length,
            retry: retry,
            startedNanoseconds: DispatchTime.now().uptimeNanoseconds
        )
    }

    func finishHTTP(
        _ span: DiagnosticHTTPSpan,
        statusCode: Int?,
        responseBytes: Int?,
        errorClass: String? = nil
    ) {
        let elapsed = DispatchTime.now().uptimeNanoseconds &- span.startedNanoseconds
        append(
            .http,
            Record(
                timestamp: Self.timestamp(),
                category: "http",
                requestID: span.requestID,
                method: span.method,
                hostClass: span.hostClass,
                path: span.pathTemplate,
                statusCode: statusCode,
                durationMs: Int(elapsed / 1_000_000),
                requestBytes: span.requestBytes,
                responseBytes: responseBytes,
                retry: span.retry,
                result: errorClass != nil ? "failed" : ((statusCode ?? 0) < 400 ? "succeeded" : "http_error"),
                errorClass: errorClass.map(Self.safeToken),
                networkType: DiagnosticNetworkMonitor.shared.currentType
            )
        )
    }

    nonisolated static func captureWebSocket(
        channel: String,
        phase: String,
        messageType: String? = nil,
        payloadBytes: Int? = nil,
        result: String? = nil,
        closeCode: Int? = nil,
        attempt: Int? = nil,
        errorClass: String? = nil
    ) {
        Task {
            await shared.append(
                .websocket,
                Record(
                    timestamp: Self.timestamp(),
                    category: "websocket",
                    channel: Self.safeToken(channel),
                    phase: Self.safeToken(phase),
                    result: result.map(Self.safeToken),
                    errorClass: errorClass.map(Self.safeToken),
                    messageType: messageType.map(Self.safeToken),
                    payloadBytes: payloadBytes,
                    closeCode: closeCode,
                    attempt: attempt,
                    networkType: DiagnosticNetworkMonitor.shared.currentType
                )
            )
        }
    }

    func exportBundle() async throws -> URL {
        append(
            .app,
            Record(
                timestamp: Self.timestamp(),
                category: "app",
                name: "diagnostics_export_started"
            )
        )
        cleanupOldExports()
        let stamp = Self.fileTimestamp()
        let destination = exportDirectory.appending(path: "tabtin-ios-diagnostics-\(stamp).zip")
        let deviceInfo = await MainActor.run {
            (osVersion: UIDevice.current.systemVersion, model: UIDevice.current.model)
        }
        var entries: [StoredZipArchive.Entry] = [
            .init(name: "README.txt", data: Data(Self.readme.utf8)),
            .init(name: "meta.json", data: try metaData(deviceInfo: deviceInfo)),
        ]
        for stream in Stream.allCases {
            let active = directory.appending(path: stream.rawValue)
            entries.append(.init(name: stream.rawValue, data: (try? Data(contentsOf: active)) ?? Data()))
            for generation in 1...retainedGenerations {
                let name = stream.rotatedName(generation)
                if let data = try? Data(contentsOf: directory.appending(path: name)) {
                    entries.append(.init(name: name, data: data))
                }
            }
        }
        try StoredZipArchive.write(entries: entries, to: destination)
        append(
            .app,
            Record(
                timestamp: Self.timestamp(),
                category: "app",
                name: "diagnostics_export_succeeded"
            )
        )
        return destination
    }

    private func append(_ stream: Stream, _ record: Record) {
        guard let data = try? encoder.encode(record) else { return }
        let line = data + Data([0x0A])
        let active = directory.appending(path: stream.rawValue)
        let existingSize = (try? active.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if existingSize + line.count > maxFileBytes { rotate(stream) }
        if !FileManager.default.fileExists(atPath: active.path) {
            FileManager.default.createFile(atPath: active.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: active) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } catch {
            return
        }
    }

    private func rotate(_ stream: Stream) {
        let manager = FileManager.default
        let oldest = directory.appending(path: stream.rotatedName(retainedGenerations))
        try? manager.removeItem(at: oldest)
        if retainedGenerations > 1 {
            for generation in stride(from: retainedGenerations - 1, through: 1, by: -1) {
                let source = directory.appending(path: stream.rotatedName(generation))
                let target = directory.appending(path: stream.rotatedName(generation + 1))
                if manager.fileExists(atPath: source.path) { try? manager.moveItem(at: source, to: target) }
            }
        }
        let active = directory.appending(path: stream.rawValue)
        let first = directory.appending(path: stream.rotatedName(1))
        if manager.fileExists(atPath: active.path) { try? manager.moveItem(at: active, to: first) }
    }

    private func metaData(deviceInfo: (osVersion: String, model: String)) throws -> Data {
        let payload: [String: Any] = [
            "schema_version": 1,
            "generated_at": Self.timestamp(),
            "platform": "ios",
            "app_version": AppConfig.appVersion,
            "app_build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
            "os_version": deviceInfo.osVersion,
            "device_model": deviceInfo.model,
            "network_type": DiagnosticNetworkMonitor.shared.currentType,
        ]
        return try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    }

    private func cleanupOldExports() {
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        let files = (try? FileManager.default.contentsOfDirectory(
            at: exportDirectory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        )) ?? []
        for file in files {
            let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            if let modified, modified < cutoff { try? FileManager.default.removeItem(at: file) }
        }
    }

    private nonisolated static func safeToken(_ value: String) -> String {
        value.replacingOccurrences(of: "[^A-Za-z0-9_.:-]", with: "_", options: .regularExpression)
            .prefix(96)
            .description
    }

    private nonisolated static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private nonisolated static func fileTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date())
    }

    private static let readme = """
    TabTin iOS diagnostic bundle

    This bundle contains bounded, structured application, HTTP and WebSocket metadata.
    It intentionally excludes request/response bodies, header values, URL queries, tokens,
    prompts, chat messages, document contents and signed object-storage URLs.

    Files may include rotated generations such as http-events.1.jsonl.
    Third-party realtime channels (Centrifugo and push providers) contain semantic lifecycle events,
    not raw encrypted frames or message bodies.
    Embedded WebView subresource traffic is outside the native network ledger.
    """
}

struct DiagnosticTarget: Sendable {
    let hostClass: String
    let pathTemplate: String

    init(url: URL?) {
        let host = url?.host?.lowercased() ?? ""
        let resolvedHostClass = switch host {
        case "api-test.example.com", "api.example.com": "tabtin-api"
        case let value where value.contains("centrifugo") && value.hasSuffix(".example.com"): "tabtin-realtime"
        case let value where value.hasSuffix(".example.com"): "tabtin-service"
        case let value where value.contains("myqcloud.com") || value.contains("tencent"): "tencent-cloud"
        case let value where value.contains("aliyuncs.com") || value.contains("oss-"): "object-storage"
        case "localhost": "local-development"
        case "": "unknown"
        default: "external"
        }
        hostClass = resolvedHostClass
        let rawPath = url?.path.isEmpty == false ? url?.path ?? "/" : "/"
        let templatedPath = rawPath.split(separator: "/", omittingEmptySubsequences: false)
            .map { segment in
                let value = String(segment)
                if value.range(of: "^[0-9]{2,}$", options: .regularExpression) != nil
                    || value.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$", options: .regularExpression) != nil
                    || value.range(of: "^[A-Za-z0-9_-]{24,}$", options: .regularExpression) != nil {
                    return ":id"
                }
                return String(value.prefix(80))
            }
            .joined(separator: "/")
            .prefix(512)
            .description
        pathTemplate = switch resolvedHostClass {
        case "object-storage": "/:object"
        case "tencent-cloud": "/:sdk"
        case "external": "/external"
        default: templatedPath
        }
    }
}

private final class DiagnosticNetworkMonitor: @unchecked Sendable {
    static let shared = DiagnosticNetworkMonitor()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var value = "unknown"

    var currentType: String {
        lock.withLock { value }
    }

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let next = if path.status != .satisfied {
                "offline"
            } else if path.usesInterfaceType(.wifi) {
                "wifi"
            } else if path.usesInterfaceType(.cellular) {
                "cellular"
            } else if path.usesInterfaceType(.wiredEthernet) {
                "ethernet"
            } else {
                "other"
            }
            self?.lock.withLock { self?.value = next }
        }
        monitor.start(queue: DispatchQueue(label: "com.tabtin.mobile.diagnostics.network"))
    }
}

enum StoredZipArchive {
    struct Entry: Sendable {
        let name: String
        let data: Data
    }

    private struct CentralEntry {
        let name: Data
        let crc: UInt32
        let size: UInt32
        let offset: UInt32
    }

    static func write(entries: [Entry], to destination: URL) throws {
        var archive = Data()
        var central: [CentralEntry] = []
        let (dosTime, dosDate) = Date().dosTimestamp
        for entry in entries {
            let name = Data(entry.name.utf8)
            let crc = CRC32.checksum(entry.data)
            let size = UInt32(entry.data.count)
            let offset = UInt32(archive.count)
            archive.appendLittleEndian(UInt32(0x04034b50))
            archive.appendLittleEndian(UInt16(20))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(dosTime)
            archive.appendLittleEndian(dosDate)
            archive.appendLittleEndian(crc)
            archive.appendLittleEndian(size)
            archive.appendLittleEndian(size)
            archive.appendLittleEndian(UInt16(name.count))
            archive.appendLittleEndian(UInt16(0))
            archive.append(name)
            archive.append(entry.data)
            central.append(.init(name: name, crc: crc, size: size, offset: offset))
        }
        let centralOffset = UInt32(archive.count)
        for entry in central {
            archive.appendLittleEndian(UInt32(0x02014b50))
            archive.appendLittleEndian(UInt16(20))
            archive.appendLittleEndian(UInt16(20))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(dosTime)
            archive.appendLittleEndian(dosDate)
            archive.appendLittleEndian(entry.crc)
            archive.appendLittleEndian(entry.size)
            archive.appendLittleEndian(entry.size)
            archive.appendLittleEndian(UInt16(entry.name.count))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(UInt16(0))
            archive.appendLittleEndian(UInt32(0))
            archive.appendLittleEndian(entry.offset)
            archive.append(entry.name)
        }
        let centralSize = UInt32(archive.count) - centralOffset
        archive.appendLittleEndian(UInt32(0x06054b50))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(central.count))
        archive.appendLittleEndian(UInt16(central.count))
        archive.appendLittleEndian(centralSize)
        archive.appendLittleEndian(centralOffset)
        archive.appendLittleEndian(UInt16(0))
        try archive.write(to: destination, options: .atomic)
    }
}

private enum CRC32 {
    static let table: [UInt32] = (0..<256).map { value in
        var crc = UInt32(value)
        for _ in 0..<8 { crc = (crc & 1) == 1 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1 }
        return crc
    }

    static func checksum(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data { crc = (crc >> 8) ^ table[Int((crc ^ UInt32(byte)) & 0xFF)] }
        return crc ^ 0xFFFFFFFF
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

private extension Date {
    var dosTimestamp: (UInt16, UInt16) {
        let components = Calendar(identifier: .gregorian).dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: self
        )
        let year = max(1980, components.year ?? 1980)
        let month = components.month ?? 1
        let day = components.day ?? 1
        let hour = components.hour ?? 0
        let minute = components.minute ?? 0
        let second = components.second ?? 0
        let encodedDate = ((year - 1980) << 9) | (month << 5) | day
        let encodedTime = (hour << 11) | (minute << 5) | (second / 2)
        return (UInt16(encodedTime), UInt16(encodedDate))
    }
}
