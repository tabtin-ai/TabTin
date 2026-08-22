import Foundation

struct NativeTabDocCommentAnchor: Codable, Equatable, Sendable {
    var version: Int
    var blockIds: [String]
    var blockType: String?
    var selectedText: String?

    enum CodingKeys: String, CodingKey {
        case version
        case blockIds = "block_ids"
        case blockType = "block_type"
        case selectedText = "selected_text"
    }

    init(
        version: Int = 1,
        blockIds: [String] = [],
        blockType: String? = nil,
        selectedText: String? = nil
    ) {
        self.version = version
        self.blockIds = blockIds
        self.blockType = blockType
        self.selectedText = selectedText
    }

    /// 服务端只保证 `version`：文档级锚点是 `{"version":1}`，块级选区也可能不带
    /// `block_ids`。Swift 合成的 `init(from:)` 会因缺键整条解码失败，导致整份评论
    /// 列表被丢弃；这里逐字段回落，与 Android `@Serializable` 默认值行为对齐。
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? container.decode(Int.self, forKey: .version)) ?? 1
        blockIds = (try? container.decode([String].self, forKey: .blockIds)) ?? []
        blockType = try? container.decode(String.self, forKey: .blockType)
        selectedText = try? container.decode(String.self, forKey: .selectedText)
    }
}

struct NativeTabDocCommentMessage: Codable, Equatable, Sendable {
    var id: String
    var threadId: String
    var kind: String
    var authorName: String
    var authorUserId: String?
    var authorAvatar: String?
    var body: String
    var isDeleted: Bool
    var createdAt: String?
    var updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case threadId = "thread_id"
        case kind
        case authorName = "author_name"
        case authorUserId = "author_user_id"
        case authorAvatar = "author_avatar"
        case body
        case isDeleted = "is_deleted"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(
        id: String,
        threadId: String = "",
        kind: String = "root",
        authorName: String = "",
        authorUserId: String? = nil,
        authorAvatar: String? = nil,
        body: String = "",
        isDeleted: Bool = false,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.kind = kind
        self.authorName = authorName
        self.authorUserId = authorUserId
        self.authorAvatar = authorAvatar
        self.body = body
        self.isDeleted = isDeleted
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? container.decode(String.self, forKey: .id)) ?? ""
        threadId = (try? container.decode(String.self, forKey: .threadId)) ?? ""
        kind = (try? container.decode(String.self, forKey: .kind)) ?? "root"
        authorName = (try? container.decode(String.self, forKey: .authorName)) ?? ""
        authorUserId = try? container.decode(String.self, forKey: .authorUserId)
        authorAvatar = try? container.decode(String.self, forKey: .authorAvatar)
        body = (try? container.decode(String.self, forKey: .body)) ?? ""
        isDeleted = (try? container.decode(Bool.self, forKey: .isDeleted)) ?? false
        createdAt = try? container.decode(String.self, forKey: .createdAt)
        updatedAt = try? container.decode(String.self, forKey: .updatedAt)
    }
}

struct NativeTabDocCommentThread: Codable, Equatable, Sendable {
    var id: String
    var documentId: String
    var scope: String
    var status: String
    var anchor: NativeTabDocCommentAnchor
    var anchorStatus: String
    var selectedText: String?
    var createdAt: String?
    var updatedAt: String?
    var messages: [NativeTabDocCommentMessage]

    enum CodingKeys: String, CodingKey {
        case id
        case documentId = "document_id"
        case scope
        case status
        case anchor
        case anchorStatus = "anchor_status"
        case selectedText = "selected_text"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case messages
    }

    init(
        id: String,
        documentId: String = "",
        scope: String,
        status: String = "open",
        anchor: NativeTabDocCommentAnchor = NativeTabDocCommentAnchor(),
        anchorStatus: String = "none",
        selectedText: String? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil,
        messages: [NativeTabDocCommentMessage] = []
    ) {
        self.id = id
        self.documentId = documentId
        self.scope = scope
        self.status = status
        self.anchor = anchor
        self.anchorStatus = anchorStatus
        self.selectedText = selectedText
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messages = messages
    }

    /// 服务端不返回顶层 `selected_text`，`anchor` 也可能是 `{}`。整条线程不能因为
    /// 一个可选字段缺失就被丢掉，否则手机端会显示成“还没有评论”。
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? container.decode(String.self, forKey: .id)) ?? ""
        documentId = (try? container.decode(String.self, forKey: .documentId)) ?? ""
        scope = (try? container.decode(String.self, forKey: .scope)) ?? "document"
        status = (try? container.decode(String.self, forKey: .status)) ?? "open"
        anchor = (try? container.decode(NativeTabDocCommentAnchor.self, forKey: .anchor))
            ?? NativeTabDocCommentAnchor()
        anchorStatus = (try? container.decode(String.self, forKey: .anchorStatus)) ?? "none"
        selectedText = try? container.decode(String.self, forKey: .selectedText)
        createdAt = try? container.decode(String.self, forKey: .createdAt)
        updatedAt = try? container.decode(String.self, forKey: .updatedAt)
        messages = (try? container.decode([NativeTabDocCommentMessage].self, forKey: .messages)) ?? []
    }
}

struct NativeTabDocCommentThreadListResponse: Codable, Equatable, Sendable {
    var threads: [NativeTabDocCommentThread]
    var capabilities: [String]

    init(threads: [NativeTabDocCommentThread] = [], capabilities: [String] = []) {
        self.threads = threads
        self.capabilities = capabilities
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threads = (try? container.decode([NativeTabDocCommentThread].self, forKey: .threads)) ?? []
        capabilities = (try? container.decode([String].self, forKey: .capabilities)) ?? []
    }
}

struct NativeTabDocCommentThreadCreateResponse: Codable, Equatable, Sendable {
    var thread: NativeTabDocCommentThread

    init(thread: NativeTabDocCommentThread) {
        self.thread = thread
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        thread = try container.decode(NativeTabDocCommentThread.self, forKey: .thread)
    }
}

enum NativeTabDocCommentAnchorKind: Equatable, Sendable {
    case document
    case block
    case orphaned
}

struct NativeTabDocCommentPresentationLabels: Equatable, Sendable {
    var documentTitle: String
    var blockTitle: String
    var orphanedTitle: String
    var anonymousAuthor: String
}

struct NativeTabDocCommentPresentation: Equatable, Identifiable, Sendable {
    var threadId: String
    var kind: NativeTabDocCommentAnchorKind
    var title: String
    var body: String
    var authorName: String
    var authorAvatarUrl: String?
    /// 头像配色的稳定种子：优先作者身份，缺失时回落昵称，永远不用线程 id。
    var authorIdentitySeed: String
    var matchedBlockId: String?
    var blockPreview: String?

    var id: String { threadId }
}
