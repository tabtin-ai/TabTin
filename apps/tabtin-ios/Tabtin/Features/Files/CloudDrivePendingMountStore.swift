import Foundation
import os

extension Notification.Name {
    /// `CloudDrivePendingMountStore` 持久化内容变化（enqueue / remove / retry 成功）。
    /// 已打开的 `CloudDriveViewModel` 据此刷新 pending 计数与列表。
    static let cloudDrivePendingMountStoreDidChange = Notification.Name(
        "com.tabtin.clouddrive.pendingMount.didChange"
    )
}

/// OSS confirm 成功、Organization TabFiles mount 失败时的待挂载任务。
/// 不要求用户重新选本地文件；mount 服务端对 org+fileRecord 幂等。
struct CloudDrivePendingMountTask: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let fileRecordId: String
    let organizationId: String
    /// `nil` 表示挂到根目录。
    let collectionId: String?
    let title: String
    var lastError: String?
    var updatedAt: Date

    init(
        id: String = UUID().uuidString,
        fileRecordId: String,
        organizationId: String,
        collectionId: String?,
        title: String,
        lastError: String? = nil,
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.fileRecordId = fileRecordId
        self.organizationId = organizationId
        self.collectionId = collectionId
        self.title = title
        self.lastError = lastError
        self.updatedAt = updatedAt
    }
}

actor CloudDrivePendingMountStore {
    static let shared = CloudDrivePendingMountStore()

    private static let defaultsKey = "com.tabtin.clouddrive.pendingMount.v1"
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "CloudDrivePendingMount")

    private init() {}

    func all() -> [CloudDrivePendingMountTask] {
        load()
    }

    func enqueue(_ task: CloudDrivePendingMountTask) {
        var items = load()
        items.removeAll {
            $0.fileRecordId == task.fileRecordId
                && $0.organizationId == task.organizationId
                && $0.collectionId == task.collectionId
        }
        items.append(task)
        save(items)
        logger.info("Enqueued pendingMount fileRecord=\(task.fileRecordId, privacy: .public)")
    }

    func remove(fileRecordId: String, organizationId: String) {
        var items = load()
        items.removeAll {
            $0.fileRecordId == fileRecordId && $0.organizationId == organizationId
        }
        save(items)
    }

    func updateError(id: String, message: String) {
        var items = load()
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        items[idx].lastError = message
        items[idx].updatedAt = Date()
        save(items)
    }

    /// 重试全部待挂载；成功的会移除。不记录签名 URL / 本地路径。
    @discardableResult
    func retryAll() async -> [SpaceResource] {
        let snapshot = load()
        guard !snapshot.isEmpty else { return [] }
        var mounted: [SpaceResource] = []
        for task in snapshot {
            do {
                let item = try await CloudDriveRepository.mountUploadedFile(
                    organizationId: task.organizationId,
                    fileRecordId: task.fileRecordId,
                    collectionId: task.collectionId,
                    title: task.title
                )
                remove(fileRecordId: task.fileRecordId, organizationId: task.organizationId)
                mounted.append(item)
            } catch {
                guard !error.isCancellation else { continue }
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                updateError(id: task.id, message: message)
                logger.warning("pendingMount retry failed id=\(task.id, privacy: .public)")
            }
        }
        return mounted
    }

    #if DEBUG
    func replaceAllForTesting(_ tasks: [CloudDrivePendingMountTask]) {
        save(tasks)
    }

    func clearForTesting() {
        save([])
    }
    #endif

    private func load() -> [CloudDrivePendingMountTask] {
        guard let data = UserDefaults.standard.data(forKey: Self.defaultsKey) else { return [] }
        return (try? JSONDecoder().decode([CloudDrivePendingMountTask].self, from: data)) ?? []
    }

    private func save(_ items: [CloudDrivePendingMountTask]) {
        guard let data = try? JSONEncoder().encode(items) else { return }
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        NotificationCenter.default.post(name: .cloudDrivePendingMountStoreDidChange, object: nil)
    }
}
