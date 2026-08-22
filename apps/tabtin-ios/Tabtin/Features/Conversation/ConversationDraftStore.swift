import CryptoKit
import Foundation

/// 一份尚未转为正式 Session 的输入草稿所属范围。
///
/// Workspace 是实际执行现场；Project 仅是协作归属，二者不能互相代替。
/// 同一个 Organization 下的不同 Workspace / Project 必须使用不同草稿文件。
struct ConversationDraftScope: Codable, Hashable, Sendable {
    let organizationId: String
    let workspaceId: String
    let projectId: String?

    init(organizationId: String, workspaceId: String, projectId: String? = nil) throws {
        let organizationId = organizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        let workspaceId = workspaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !organizationId.isEmpty, !workspaceId.isEmpty else {
            throw ConversationDraftStoreError.invalidScope
        }

        self.organizationId = organizationId
        self.workspaceId = workspaceId
        self.projectId = projectId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    init(draft: ConversationDraftState) throws {
        try self.init(
            organizationId: draft.organizationId,
            workspaceId: draft.workspaceId,
            projectId: draft.projectId
        )
    }

    fileprivate var storageKey: String {
        let fields = [organizationId, workspaceId, projectId ?? ""]
        return fields.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
    }
}

extension ConversationDraftAttachmentReference {
    /// 从 Composer 的运行时附件生成可持久化引用；本地文件尚未上传完成时不应进入恢复快照。
    init?(attachment: ComposerLocalAttachment) {
        guard attachment.status == .ready,
              let uploadedFileId = attachment.fileId,
              !uploadedFileId.isEmpty else {
            return nil
        }

        let kind: Kind
        switch attachment.kind {
        case .photo: kind = .photo
        case .camera: kind = .camera
        case .file: kind = .file
        }
        self.init(
            id: attachment.id,
            uploadedFileId: uploadedFileId,
            name: attachment.name,
            kind: kind,
            byteCount: attachment.byteCount,
            mimeType: attachment.mimeType
        )
    }
}

/// 可安全保存到本地的附件引用。
///
/// 仅允许已经由服务端接管的 `uploadedFileId`。本地 URL、远端 URL（可能含签名参数）、
/// 上传二进制及上传错误都不属于草稿快照；恢复时由服务端以 file id 重新解析。
struct ConversationDraftAttachmentReference: Codable, Equatable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable {
        case photo
        case camera
        case file
    }

    let id: String
    let uploadedFileId: String
    let name: String
    let kind: Kind
    let byteCount: Int64?
    let mimeType: String?

    init(
        id: String,
        uploadedFileId: String,
        name: String,
        kind: Kind,
        byteCount: Int64? = nil,
        mimeType: String? = nil
    ) {
        self.id = id
        self.uploadedFileId = uploadedFileId
        self.name = name
        self.kind = kind
        self.byteCount = byteCount
        self.mimeType = mimeType
    }

    /// 恢复为可直接随首条消息发送的已上传附件。
    /// 本地文件和签名 URL 不会被重建；发送载荷只依赖服务端 `file_id`。
    func composerAttachment() -> ComposerLocalAttachment {
        let composerKind: ComposerLocalAttachment.Kind
        switch kind {
        case .photo: composerKind = .photo
        case .camera: composerKind = .camera
        case .file: composerKind = .file
        }
        return ComposerLocalAttachment(
            id: id,
            name: name,
            kind: composerKind,
            byteCount: byteCount,
            mimeType: mimeType,
            url: nil,
            isTemporary: false,
            status: .ready,
            progress: 1,
            fileId: uploadedFileId
        )
    }
}

extension ConversationDraftContextReference {
    init(contextRef: MentionContextRef) {
        self.init(
            id: contextRef.id,
            type: contextRef.type.rawValue,
            resourceId: contextRef.resourceId,
            label: contextRef.label,
            preview: contextRef.preview,
            spaceId: contextRef.spaceId,
            spaceName: contextRef.spaceName,
            tableId: contextRef.tableId
        )
    }

    /// 无法识别的历史类型安全回退为 document，避免一次坏数据阻断整个草稿恢复。
    func mentionContextRef() -> MentionContextRef {
        MentionContextRef(
            id: id,
            type: ContextRefType(rawValue: type) ?? .document,
            resourceId: resourceId,
            label: label,
            preview: preview,
            spaceId: spaceId,
            spaceName: spaceName,
            tableId: tableId
        )
    }
}

/// 草稿恢复所需的上下文资源引用。
///
/// 这是 `MentionContextRef` 的持久化投影，避免把 UI 类型或未受控对象直接写入磁盘。
struct ConversationDraftContextReference: Codable, Equatable, Hashable, Sendable {
    let id: String
    let type: String
    let resourceId: String
    let label: String
    let preview: String?
    let spaceId: String?
    let spaceName: String?
    let tableId: String?

    init(
        id: String,
        type: String,
        resourceId: String,
        label: String,
        preview: String? = nil,
        spaceId: String? = nil,
        spaceName: String? = nil,
        tableId: String? = nil
    ) {
        self.id = id
        self.type = type
        self.resourceId = resourceId
        self.label = label
        self.preview = preview
        self.spaceId = spaceId
        self.spaceName = spaceName
        self.tableId = tableId
    }
}

/// 新对话在首发前可恢复的最小、持久化安全快照。
struct ConversationDraftSnapshot: Codable, Equatable, Sendable {
    /// 在同一 scope 的多次保存间保持不变，可作为附件和首发重试的关联键。
    var draftId: String
    let scope: ConversationDraftScope
    var text: String
    var agentId: String?
    var modelId: String?
    /// 草稿冻结的上下文档位；建 session 后立刻写入。
    var contextTierId: String?
    /// 草稿冻结的思考强度 raw（`off` / `standard` / `deep`）。
    var thinkingMode: String?
    var agentMode: ChatAgentMode
    var approvalMode: ChatApprovalMode
    /// Session 已创建但首条消息尚未成功入队时保存，用于崩溃恢复后复用同一 Session。
    var pendingSessionId: String?
    var attachments: [ConversationDraftAttachmentReference]
    var contextReferences: [ConversationDraftContextReference]
    var createdAt: Date
    var updatedAt: Date

    init(
        draftId: String = UUID().uuidString,
        scope: ConversationDraftScope,
        text: String,
        agentId: String? = nil,
        modelId: String? = nil,
        contextTierId: String? = nil,
        thinkingMode: String? = nil,
        agentMode: ChatAgentMode = .agent,
        approvalMode: ChatApprovalMode = .alwaysAsk,
        pendingSessionId: String? = nil,
        attachments: [ConversationDraftAttachmentReference] = [],
        contextReferences: [ConversationDraftContextReference] = [],
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.draftId = draftId
        self.scope = scope
        self.text = text
        self.agentId = agentId
        self.modelId = modelId
        self.contextTierId = contextTierId
        self.thinkingMode = thinkingMode
        self.agentMode = agentMode
        self.approvalMode = approvalMode
        self.pendingSessionId = pendingSessionId
        self.attachments = attachments
        self.contextReferences = contextReferences
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

enum ConversationDraftStoreError: Error, Equatable, Sendable {
    case invalidScope
    case applicationSupportUnavailable
    case unsupportedSchemaVersion(Int)
}

/// Application Support 中的草稿仓库。
///
/// 每个 scope 保存为一个独立 JSON 文件。Actor 将同进程读改写串行化，`Data.WritingOptions.atomic`
/// 则保证进程在写入中断时，旧文件仍然完整。调用方可注入 `baseDirectory`，以便测试和预览隔离。
actor ConversationDraftStore {
    private struct StoredDocument: Codable, Sendable {
        let schemaVersion: Int
        let draft: ConversationDraftSnapshot
    }

    private static let schemaVersion = 1

    private let baseDirectory: URL
    private let fileManager: FileManager

    init(baseDirectory: URL? = nil, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            guard let applicationSupport = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw ConversationDraftStoreError.applicationSupportUnavailable
            }
            self.baseDirectory = applicationSupport
                .appendingPathComponent("TabTin", isDirectory: true)
                .appendingPathComponent("ConversationDrafts", isDirectory: true)
        }
    }

    /// 加载指定范围的草稿；不存在时返回 `nil`。
    func load(scope: ConversationDraftScope) throws -> ConversationDraftSnapshot? {
        let fileURL = fileURL(for: scope)
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }

        let document = try decoder().decode(StoredDocument.self, from: Data(contentsOf: fileURL))
        guard document.schemaVersion == Self.schemaVersion else {
            throw ConversationDraftStoreError.unsupportedSchemaVersion(document.schemaVersion)
        }
        return document.draft
    }

    /// 保存草稿。若该 scope 已有草稿，强制沿用原 `draftId` 与创建时间，避免更新时漂移。
    @discardableResult
    func save(_ draft: ConversationDraftSnapshot) throws -> ConversationDraftSnapshot {
        let existing = try load(scope: draft.scope)
        var persisted = draft
        persisted.draftId = existing?.draftId ?? draft.draftId
        persisted.createdAt = existing?.createdAt ?? draft.createdAt
        persisted.updatedAt = .now

        try fileManager.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        let data = try encoder().encode(
            StoredDocument(schemaVersion: Self.schemaVersion, draft: persisted)
        )
        let destination = fileURL(for: persisted.scope)
        try data.write(to: destination, options: .atomic)

        // 在真机上让系统的数据保护机制接管文件；测试临时目录不支持该属性时不影响存储。
        try? fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: destination.path
        )
        return persisted
    }

    /// 明确丢弃用户取消的新对话草稿。重复调用是安全的。
    func discard(scope: ConversationDraftScope) throws {
        let fileURL = fileURL(for: scope)
        guard fileManager.fileExists(atPath: fileURL.path) else { return }
        try fileManager.removeItem(at: fileURL)
    }

    /// 在首发已成功转为正式 Session 后调用，语义上等同于消费该草稿。
    func markSessionCreated(scope: ConversationDraftScope) throws {
        try discard(scope: scope)
    }

    private func fileURL(for scope: ConversationDraftScope) -> URL {
        let digest = SHA256.hash(data: Data(scope.storageKey.utf8))
        let filename = digest.map { String(format: "%02x", $0) }.joined() + ".json"
        return baseDirectory.appendingPathComponent(filename, isDirectory: false)
    }

    private func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        // 秒级 Double 保留草稿排序需要的子秒精度；草稿身份由稳定 draftId 保证。
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
