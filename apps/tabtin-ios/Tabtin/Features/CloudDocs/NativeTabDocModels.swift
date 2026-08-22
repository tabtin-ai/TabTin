import Foundation

enum NativeCloudResourceKind: Equatable, Sendable {
    case tabdoc
    case tabdata
    case tabslide
}

enum NativeCloudResourcePresentation: Equatable, Sendable {
    case nativeTabDoc
    case nativeTabData
    case web
}

enum NativeCloudResourcePolicy {
    static func presentation(for kind: NativeCloudResourceKind) -> NativeCloudResourcePresentation {
        switch kind {
        case .tabdoc: .nativeTabDoc
        case .tabdata: .nativeTabData
        case .tabslide: .web
        }
    }
}

struct NativeTabDocDocument: Decodable, Sendable, Equatable {
    let id: String
    let organizationId: String
    let spaceId: String?
    let title: String
    let latestVersion: Int?
    let updatedAt: String?
    let currentUserRole: String?

    enum CodingKeys: String, CodingKey {
        case id, title
        case organizationId = "organization_id"
        case spaceId = "space_id"
        case latestVersion = "latest_version"
        case updatedAt = "updated_at"
        case currentUserRole = "current_user_role"
    }

    var canEdit: Bool {
        guard let role = currentUserRole?.lowercased() else { return false }
        return ["owner", "admin", "editor"].contains(role)
    }
}

struct NativeTabDocContent: Decodable, Sendable, Equatable {
    let descriptionJSON: [String: AnyCodable]
    let descriptionMarkdown: String
    let descriptionPlaintext: String

    enum CodingKeys: String, CodingKey {
        case descriptionJSON = "description_json"
        case descriptionMarkdown = "description_markdown"
        case descriptionPlaintext = "description_plaintext"
    }
}

struct NativeTabDocDetail: Decodable, Sendable {
    let document: NativeTabDocDocument
    let content: NativeTabDocContent
}

struct NativeTabDocHistoryEntry: Decodable, Sendable, Equatable {
    let id: String
    let name: String
    let createdAt: String?
    let isSnapshot: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case createdAt = "created_at"
        case isSnapshot = "is_snapshot"
    }

    init(
        id: String,
        name: String = "",
        createdAt: String? = nil,
        isSnapshot: Bool = false
    ) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.isSnapshot = isSnapshot
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        isSnapshot = try container.decodeIfPresent(Bool.self, forKey: .isSnapshot) ?? false
    }
}

struct NativeTabDocRestoreResponse: Decodable, Sendable {
    let versionId: String?

    enum CodingKeys: String, CodingKey {
        case versionId = "version_id"
    }
}

enum NativeTabDocVersionHistoryPresentation {
    static func entryTitle(
        id: String,
        name: String,
        createdAt: String?,
        isSnapshot: Bool,
        snapshotLabel: String,
        historyVersionLabel: String
    ) -> String {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedName.isEmpty { return trimmedName }
        if isSnapshot { return snapshotLabel }
        if let createdAt, !createdAt.isEmpty {
            return String(createdAt.prefix(16)).replacingOccurrences(of: "T", with: " ")
        }
        return historyVersionLabel
    }

    static func entrySubtitle(createdAt: String?) -> String {
        guard let createdAt, !createdAt.isEmpty else { return "" }
        return String(createdAt.prefix(16)).replacingOccurrences(of: "T", with: " ")
    }
}

enum NativeCloudOrganizationBoundary {
    static func matches(resourceOrganizationId: String?, expectedOrganizationId: String) -> Bool {
        let expected = expectedOrganizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !expected.isEmpty else { return false }
        guard let resourceOrganizationId else { return false }
        let resource = resourceOrganizationId.trimmingCharacters(in: .whitespacesAndNewlines)
        return !resource.isEmpty && resource == expected
    }
}

struct NativeCloudSessionFence: Sendable {
    let userId: String
    let generation: UInt64
    let organizationId: String

    func matches(
        userId currentUserId: String?,
        generation currentGeneration: UInt64,
        organizationId currentOrganizationId: String?
    ) -> Bool {
        guard let currentUserId, !currentUserId.isEmpty else { return false }
        guard let currentOrganizationId, !currentOrganizationId.isEmpty else { return false }
        return currentUserId == userId
            && currentGeneration == generation
            && currentOrganizationId == organizationId
    }
}

struct NativeTabDocWriteResponse: Decodable, Sendable {
    let document: NativeTabDocDocument
}

struct NativeTabDocImageAssetAccess: Decodable, Sendable {
    let url: String
}

enum NativeTabDocInlineMarkKind: String, Codable, Sendable {
    case bold
    case italic
    case underline
    case strike
    case code
    case link
    case textStyle
    case highlight
    case `subscript`
    case superscript
    case unknown
}

struct NativeTabDocInlineMark: Codable, Equatable, Sendable {
    let kind: NativeTabDocInlineMarkKind
    var rawNode: [String: AnyCodable]

    static func canonical(_ kind: NativeTabDocInlineMarkKind, href: String? = nil) -> Self {
        var node: [String: AnyCodable] = ["type": AnyCodable(kind.rawValue)]
        if kind == .link, let href {
            node["attrs"] = AnyCodable(["href": href])
        }
        return Self(kind: kind, rawNode: node)
    }

    var serializedNode: [String: Any] {
        // 未知 mark 的 type 必须原样写回（如 futureMark），不能被 kind.rawValue 改成 unknown。
        if kind == .unknown {
            return rawNode.mapValues(\.value)
        }
        var node = rawNode.mapValues(\.value)
        node["type"] = kind.rawValue
        return node
    }

    var linkHref: String? {
        guard kind == .link else { return nil }
        return rawNode["attrs"]?.dictValue?["href"] as? String
    }
}

struct NativeTabDocInlineMathematics: Codable, Equatable, Sendable {
    var atomId: String
    var nodeType: String
    var valueAttribute: String
    var attrs: [String: AnyCodable]
    /// 解析时从 `latex`/`text` 抽出的源码。写回走 `span.text`，这份留给呈现层
    /// 在附件占位字符上还原身份；不要写进文档 JSON 的 attrs。
    var sourceText: String = ""
}

/// 行内图片原子。身份只由 [attrs] 承载并原样写回；`src` 是渲染期签名地址，
/// 随 attrs 带回但绝不由原生端重新生成，稳定引用是 `fileId`。
struct NativeTabDocInlineImage: Codable, Equatable, Sendable {
    var atomId: String
    var nodeType: String
    var attrs: [String: AnyCodable]

    /// 图片排不出来时的诚实降级文案，也是纯文本预览里代表这张图的可读片段。
    var placeholderText: String {
        let label = ["alt", "title", "name"].lazy
            .compactMap { attrs[$0]?.value as? String }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return label.map { "🖼 \($0)" } ?? "🖼"
    }
}

struct NativeTabDocInlineSpan: Codable, Equatable, Sendable {
    /// 富文本渲染层把行内图片替换成的附件字符（U+FFFC）。它只是呈现载体，
    /// 既不参与身份，也绝不能作为普通文本写回文档。
    static let attachmentPlaceholderCharacter = "\u{FFFC}"

    var text: String
    var marks: [NativeTabDocInlineMark]
    var mathematics: NativeTabDocInlineMathematics?
    var image: NativeTabDocInlineImage?

    init(
        text: String,
        marks: [NativeTabDocInlineMark] = [],
        mathematics: NativeTabDocInlineMathematics? = nil,
        image: NativeTabDocInlineImage? = nil
    ) {
        self.text = text
        self.marks = marks
        self.mathematics = mathematics
        self.image = image
    }

    /// 复制块时续期行内原子身份，避免副本与原文共用 atomId 而在保存时被并成一个节点。
    static func renewingInlineAtomIdentities(
        in spans: [NativeTabDocInlineSpan]
    ) -> [NativeTabDocInlineSpan] {
        var remapped: [String: String] = [:]
        func renewed(_ atomId: String) -> String {
            if let existing = remapped[atomId] { return existing }
            let fresh = UUID().uuidString
            remapped[atomId] = fresh
            return fresh
        }
        return spans.map { span in
            var mathematics = span.mathematics
            var image = span.image
            if let current = mathematics?.atomId { mathematics?.atomId = renewed(current) }
            if let current = image?.atomId { image?.atomId = renewed(current) }
            guard mathematics != nil || image != nil else { return span }
            return NativeTabDocInlineSpan(
                text: span.text,
                marks: span.marks,
                mathematics: mathematics,
                image: image
            )
        }
    }
}

/// ProseMirror 段落级对齐语义。`natural` 只表示 attrs 缺失或 JSON null，
/// 不是可接受的线上字符串；这样才能避免把 schema 缺省值误写成显式 left。
enum NativeTabDocTextAlignment: String, Codable, Equatable, Sendable {
    case natural
    case left
    case center
    case right
    case justify

    init?(proseMirrorValue rawValue: Any?) {
        guard let rawValue else {
            self = .natural
            return
        }
        if rawValue is NSNull {
            self = .natural
            return
        }
        guard let value = rawValue as? String else { return nil }
        switch value {
        case "left": self = .left
        case "center": self = .center
        case "right": self = .right
        case "justify": self = .justify
        default: return nil
        }
    }

    static func resolved(in rawNode: [String: AnyCodable]) -> Self {
        let rawValue = rawNode["attrs"]?.dictValue?["textAlign"]
        return Self(proseMirrorValue: rawValue) ?? .natural
    }
}

extension Array where Element == NativeTabDocInlineSpan {
    /// 纯文本上下文（预览 / 摘要 / 表格投影）画不出图，行内图片一律回落到诚实 alt 占位。
    /// 富文本渲染层会把图片位置换成附件字符，回采后 `span.text` 不再是人类可读文案，
    /// 所以这里以 `image` 身份为准，而不是当前 span 里恰好存着什么字符。
    var nativeTabDocPlainText: String {
        map { span in span.image?.placeholderText ?? span.text }.joined()
    }

    static func nativeTabDocPlain(_ text: String) -> Self {
        text.isEmpty ? [] : [NativeTabDocInlineSpan(text: text)]
    }
}

/// 与 ProseMirror `listItem.content = [paragraph, nestedList?]` 同构。
/// 不用 Android 的 indentLevel 扁平化：混合嵌套类型和子列表自己的 blockId
/// 都要原样挂在子树上，压平后再重建会丢其中任一者。
struct NativeTabDocNestedList: Codable, Equatable, Sendable {
    /// 与 Android `MAX_LIST_NESTING_DEPTH` 对齐。产品缩进上限是 4，
    /// 解析仍放行更深的已有文档；超过此值无法安全递归重建，整块只读。
    static let maxDepth = 20

    var kind: NativeTabDocBlockKind
    var items: [NativeTabDocListItem]
    var rawNode: [String: AnyCodable]

    init(
        kind: NativeTabDocBlockKind,
        items: [NativeTabDocListItem] = [],
        rawNode: [String: AnyCodable] = [:]
    ) {
        self.kind = kind
        self.items = items
        self.rawNode = rawNode
    }
}

struct NativeTabDocListItem: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var spans: [NativeTabDocInlineSpan]
    var isChecked: Bool
    var rawItem: [String: AnyCodable]
    var rawParagraph: [String: AnyCodable]
    var nested: NativeTabDocNestedList?

    init(
        id: UUID = UUID(),
        spans: [NativeTabDocInlineSpan] = [],
        isChecked: Bool = false,
        rawItem: [String: AnyCodable] = [:],
        rawParagraph: [String: AnyCodable] = [:],
        nested: NativeTabDocNestedList? = nil
    ) {
        self.id = id
        self.spans = spans
        self.isChecked = isChecked
        self.rawItem = rawItem
        self.rawParagraph = rawParagraph
        self.nested = nested
    }

    var text: String { spans.nativeTabDocPlainText }
    var textAlignment: NativeTabDocTextAlignment { .resolved(in: rawParagraph) }

    /// 预览 / 纯文本需要看见整棵子树，否则嵌套项在摘要里会消失。
    var descendantPlainTexts: [String] {
        [text] + (nested?.items.flatMap(\.descendantPlainTexts) ?? [])
    }
}

struct NativeTabDocImage: Codable, Equatable, Sendable {
    var source: String
    var fileId: String?
    var alt: String
    var title: String
    var width: Int?
    var height: Int?
}

enum NativeTabDocTableContentSummaryKind: String, Codable, Equatable, Sendable {
    case whiteboard
    case embeddedTable
    case embeddedHTML
    case video
    case complexContent
}

enum NativeTabDocTableProjectionPart: Codable, Equatable, Sendable {
    case literal(String)
    case summary(kind: NativeTabDocTableContentSummaryKind, title: String?)
}

/// 复杂单元格的语义投影。模型层只保存结构和原始标题，产品语言在 UI/复制边界注入。
struct NativeTabDocTableProjection: Codable, Equatable, Sendable {
    var parts: [NativeTabDocTableProjectionPart] = []

    var hasVisibleContent: Bool {
        parts.contains { part in
            switch part {
            case .literal(let value): !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .summary: true
            }
        }
    }

    var unlocalizedText: String {
        rendered { _ in "" }
    }

    func rendered(
        labelFor: (NativeTabDocTableContentSummaryKind) -> String
    ) -> String {
        parts.map { part in
            switch part {
            case .literal(let value):
                value
            case .summary(let kind, let title):
                [labelFor(kind), title ?? ""]
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .joined(separator: " ")
            }
        }.joined()
    }

    func appending(_ other: Self) -> Self {
        Self(parts: parts + other.parts)
    }

    func indentingContinuation(with prefix: String) -> Self {
        Self(parts: parts.map { part in
            guard case .literal(let value) = part else { return part }
            return .literal(value.replacingOccurrences(of: "\n", with: "\n\(prefix)"))
        })
    }

    static func literal(_ value: String) -> Self {
        value.isEmpty ? Self() : Self(parts: [.literal(value)])
    }

    static func summary(
        _ kind: NativeTabDocTableContentSummaryKind,
        title: String? = nil
    ) -> Self {
        Self(parts: [.summary(kind: kind, title: title)])
    }

    static func joined(_ projections: [Self], separator: String) -> Self {
        let visible = projections.filter(\.hasVisibleContent)
        var result = Self()
        for (index, projection) in visible.enumerated() {
            if index > 0 { result = result.appending(.literal(separator)) }
            result = result.appending(projection)
        }
        return result
    }
}

struct NativeTabDocTableCell: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var spans: [NativeTabDocInlineSpan]
    var isHeader: Bool
    var rawCell: [String: AnyCodable]
    var rawParagraph: [String: AnyCodable]
    /// 复杂内容只投影为可读文本，保存时必须原样保留 rawCell。
    /// Optional 保持已落盘旧草稿的 Codable 兼容。
    var isReadOnlyProjection: Bool? = nil
    /// 新草稿保存语义投影；旧草稿缺失时仍回退到 spans/rawCell。
    var projection: NativeTabDocTableProjection? = nil

    init(
        id: UUID = UUID(),
        spans: [NativeTabDocInlineSpan] = [],
        isHeader: Bool = false,
        rawCell: [String: AnyCodable] = [:],
        rawParagraph: [String: AnyCodable] = [:],
        isReadOnlyProjection: Bool? = nil,
        projection: NativeTabDocTableProjection? = nil
    ) {
        self.id = id
        self.spans = spans
        self.isHeader = isHeader
        self.rawCell = rawCell
        self.rawParagraph = rawParagraph
        self.isReadOnlyProjection = isReadOnlyProjection
        self.projection = projection
    }

    var text: String { spans.nativeTabDocPlainText }
    var textAlignment: NativeTabDocTextAlignment { .resolved(in: rawParagraph) }
}

struct NativeTabDocTableRow: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var cells: [NativeTabDocTableCell]
    var rawRow: [String: AnyCodable]

    init(
        id: UUID = UUID(),
        cells: [NativeTabDocTableCell],
        rawRow: [String: AnyCodable] = [:]
    ) {
        self.id = id
        self.cells = cells
        self.rawRow = rawRow
    }
}

struct NativeTabDocTable: Codable, Equatable, Sendable {
    var rows: [NativeTabDocTableRow]
    /// 旧版草稿只记录表级投影状态；新版同时记录到具体单元格。
    /// Optional 保持已落盘草稿的 Codable 兼容。
    var isReadOnlyProjection: Bool? = nil
    /// 合并、超限等结构只能作为整表只读投影展示；保存时必须回写 block.rawNode。
    /// Optional 保持旧草稿的 Codable 兼容。
    var preservesWholeTable: Bool? = nil

    static func empty(rowCount: Int = 3, columnCount: Int = 2) -> Self {
        Self(rows: (0..<rowCount).map { row in
            NativeTabDocTableRow(cells: (0..<columnCount).map { _ in
                NativeTabDocTableCell(isHeader: row == 0)
            })
        })
    }

    var columnCount: Int { rows.map(\.cells.count).max() ?? 0 }

    /// 用于只读摘要的 ProseMirror 逻辑列数；合并单元格按 colspan 占用的列数计算。
    /// 编辑操作仍使用 `columnCount`，避免把只读合并格误当成可写的物理单元格。
    var presentationColumnCount: Int {
        rows.map { row in
            row.cells.reduce(0) { width, cell in
                let attrs = cell.rawCell["attrs"]?.dictValue
                let colspan = attrs?["colspan"] as? Int ?? 1
                return width + max(colspan, 1)
            }
        }.max() ?? 0
    }

    /// 旧草稿无法识别哪些格子是复杂投影，整张表必须继续原样序列化。
    var requiresWholeTablePreservation: Bool {
        preservesWholeTable == true
            || (isReadOnlyProjection == true
                && rows.contains { row in
                    row.cells.contains { $0.isReadOnlyProjection == nil }
                })
    }

    var projectedCellCount: Int {
        let cells = rows.flatMap(\.cells)
        if requiresWholeTablePreservation { return cells.count }
        return cells.filter { $0.isReadOnlyProjection == true }.count
    }

    var hasProjectedCells: Bool { projectedCellCount > 0 }

    var canAddRow: Bool {
        !requiresWholeTablePreservation && rows.count < 100
    }

    var canAddColumn: Bool {
        !requiresWholeTablePreservation && columnCount < 20
    }

    func isCellReadOnly(_ cell: NativeTabDocTableCell) -> Bool {
        requiresWholeTablePreservation || cell.isReadOnlyProjection == true
    }

    var copyText: String {
        rows
            .map { $0.cells.map(\.text).joined(separator: "\t") }
            .joined(separator: "\n")
    }
}

enum NativeTabDocUnsupportedContentKind: Equatable, Sendable {
    case whiteboard
    case embeddedTable
    case embeddedHTML
    case video

    init?(rawType: String) {
        switch rawType {
        case "tabwhiteboard": self = .whiteboard
        case "tabdataBlock": self = .embeddedTable
        case "htmlBlock": self = .embeddedHTML
        case "youtube": self = .video
        default: return nil
        }
    }
}

enum NativeTabDocBlockKind: Hashable, Sendable {
    case paragraph
    case heading(level: Int)
    case bulletList
    case orderedList(start: Int)
    case taskList
    case blockquote
    case codeBlock
    case image
    case table
    case divider
    case unsupported(type: String)

    var isSupported: Bool {
        if case .unsupported = self { return false }
        return true
    }

    var allowsInlineEditing: Bool {
        switch self {
        case .paragraph, .heading, .blockquote, .codeBlock: true
        default: false
        }
    }
}

extension NativeTabDocBlockKind: Codable {
    private enum CodingKeys: String, CodingKey { case type, level, start }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "paragraph": self = .paragraph
        case "heading": self = .heading(level: try container.decode(Int.self, forKey: .level))
        case "bulletList": self = .bulletList
        case "orderedList": self = .orderedList(start: try container.decode(Int.self, forKey: .start))
        case "taskList": self = .taskList
        case "blockquote": self = .blockquote
        case "codeBlock": self = .codeBlock
        case "image": self = .image
        case "table": self = .table
        case "divider": self = .divider
        default: self = .unsupported(type: type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .paragraph:
            try container.encode("paragraph", forKey: .type)
        case .heading(let level):
            try container.encode("heading", forKey: .type)
            try container.encode(level, forKey: .level)
        case .bulletList:
            try container.encode("bulletList", forKey: .type)
        case .orderedList(let start):
            try container.encode("orderedList", forKey: .type)
            try container.encode(start, forKey: .start)
        case .taskList:
            try container.encode("taskList", forKey: .type)
        case .blockquote:
            try container.encode("blockquote", forKey: .type)
        case .codeBlock:
            try container.encode("codeBlock", forKey: .type)
        case .image:
            try container.encode("image", forKey: .type)
        case .table:
            try container.encode("table", forKey: .type)
        case .divider:
            try container.encode("divider", forKey: .type)
        case .unsupported(let type):
            try container.encode(type, forKey: .type)
        }
    }
}

struct NativeTabDocBlock: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var kind: NativeTabDocBlockKind
    var spans: [NativeTabDocInlineSpan]
    var listItems: [NativeTabDocListItem]
    var image: NativeTabDocImage?
    var table: NativeTabDocTable?
    var rawNode: [String: AnyCodable]

    init(
        id: UUID = UUID(),
        kind: NativeTabDocBlockKind,
        text: String = "",
        spans: [NativeTabDocInlineSpan]? = nil,
        listItems: [NativeTabDocListItem] = [],
        image: NativeTabDocImage? = nil,
        table: NativeTabDocTable? = nil,
        rawNode: [String: AnyCodable] = [:]
    ) {
        self.id = id
        self.kind = kind
        self.spans = spans ?? .nativeTabDocPlain(text)
        self.listItems = listItems
        self.image = image
        self.table = table
        self.rawNode = rawNode
    }

    var text: String {
        get { spans.nativeTabDocPlainText }
        set { spans = .nativeTabDocPlain(newValue) }
    }

    /// 评论锚点只用 ProseMirror 持久 `blockId`，不用运行期 UUID。
    var persistentBlockId: String? {
        let attributes = rawNode["attrs"]?.dictValue ?? [:]
        if let blockId = attributes["blockId"] as? String, !blockId.isEmpty {
            return blockId
        }
        if let legacyId = attributes["id"] as? String, !legacyId.isEmpty {
            return legacyId
        }
        return nil
    }

    var textAlignment: NativeTabDocTextAlignment {
        switch kind {
        case .paragraph, .heading, .image:
            return .resolved(in: rawNode)
        case .blockquote:
            guard let children = rawNode["content"]?.arrayValue as? [[String: Any]],
                  children.count == 1,
                  let paragraph = children.first
            else { return .natural }
            let rawValue = (paragraph["attrs"] as? [String: Any])?["textAlign"]
            return NativeTabDocTextAlignment(proseMirrorValue: rawValue) ?? .natural
        default:
            return .natural
        }
    }

    static func new(kind: NativeTabDocBlockKind) -> NativeTabDocBlock {
        switch kind {
        case .bulletList, .orderedList, .taskList:
            return NativeTabDocBlock(kind: kind, listItems: [NativeTabDocListItem()])
        case .table:
            return NativeTabDocBlock(kind: .table, table: .empty())
        case .divider:
            return NativeTabDocBlock(
                kind: .divider,
                rawNode: ["type": AnyCodable("horizontalRule")]
            )
        default:
            return NativeTabDocBlock(kind: kind)
        }
    }

    /// 移动端把“只含一张图片的段落”投影成图片卡；持久化仍遵守 ProseMirror 的
    /// paragraph -> inline image 契约，不能创建顶层 image 节点。
    static func uploadedImageParagraph(source: String, fileId: String, alt: String) -> NativeTabDocBlock {
        let image = NativeTabDocImage(
            source: source,
            fileId: fileId,
            alt: alt,
            title: "",
            width: nil,
            height: nil
        )
        let imageNode: [String: Any] = [
            "type": "image",
            "attrs": [
                "src": source,
                "fileId": fileId,
                "alt": alt,
            ],
        ]
        return NativeTabDocBlock(
            kind: .image,
            image: image,
            rawNode: [
                "type": AnyCodable("paragraph"),
                "content": AnyCodable([imageNode]),
            ]
        )
    }

    /// 与桌面端复制块保持同一身份语义：内容和非身份属性保留，所有节点锚点交给
    /// 后续保存链路重新生成。否则原块与副本会共享 blockId，批注和精准块操作会串块。
    func duplicatedForInsertion() -> NativeTabDocBlock {
        NativeTabDocBlock(
            kind: kind,
            spans: NativeTabDocInlineSpan.renewingInlineAtomIdentities(in: spans),
            listItems: Self.duplicatingListItems(listItems),
            image: image,
            table: table.map { table in
                NativeTabDocTable(
                    rows: table.rows.map { row in
                        NativeTabDocTableRow(
                            cells: row.cells.map { cell in
                                NativeTabDocTableCell(
                                    spans: cell.spans,
                                    isHeader: cell.isHeader,
                                    rawCell: Self.removingNodeIdentities(from: cell.rawCell),
                                    rawParagraph: Self.removingNodeIdentities(from: cell.rawParagraph),
                                    isReadOnlyProjection: cell.isReadOnlyProjection,
                                    projection: cell.projection
                                )
                            },
                            rawRow: Self.removingNodeIdentities(from: row.rawRow)
                        )
                    },
                    isReadOnlyProjection: table.isReadOnlyProjection,
                    preservesWholeTable: table.preservesWholeTable
                )
            },
            rawNode: Self.removingNodeIdentities(from: rawNode)
        )
    }

    /// 移动端只提供不会压平内容的类型转换。多项列表可在列表类型之间互转；
    /// 只有无子列表的单项才能转成单个文本块，否则会丢掉整棵嵌套子树。
    var conversionOptions: [NativeTabDocBlockKind] {
        let inlineKinds: [NativeTabDocBlockKind] = [
            .paragraph,
            .heading(level: 1),
            .heading(level: 2),
            .heading(level: 3),
            .blockquote,
            .codeBlock,
        ]
        let listKinds: [NativeTabDocBlockKind] = [
            .bulletList,
            .orderedList(start: 1),
            .taskList,
        ]
        let candidates: [NativeTabDocBlockKind]
        switch kind {
        case .paragraph, .heading, .blockquote, .codeBlock:
            candidates = inlineKinds + listKinds
        case .bulletList, .orderedList, .taskList:
            // 带子列表的单项若压成段落/标题，整棵子树会从文档里消失。
            let canFlattenToInline = listItems.count == 1 && listItems[0].nested == nil
            candidates = listKinds + (canFlattenToInline ? inlineKinds : [])
        case .image, .table, .divider, .unsupported:
            candidates = []
        }
        return candidates.filter { candidate in
            candidate != kind
                && (candidate != .codeBlock || canConvertToCodeBlockWithoutDroppingSemantics)
        }
    }

    func converted(to target: NativeTabDocBlockKind) -> NativeTabDocBlock? {
        guard conversionOptions.contains(target) else { return nil }
        let preservedRawNode = rawNodeKeepingTopLevelIdentity
        switch target {
        case .paragraph, .heading, .blockquote, .codeBlock:
            guard let sourceSpans = convertibleInlineSpans else { return nil }
            return NativeTabDocBlock(
                id: id,
                kind: target,
                spans: sourceSpans,
                rawNode: convertedInlineRawNode(
                    from: preservedRawNode,
                    target: target,
                    textAlignmentAttribute: convertibleTextAlignmentAttribute
                )
            )
        case .bulletList, .orderedList, .taskList:
            let sourceItems: [(
                spans: [NativeTabDocInlineSpan],
                isChecked: Bool,
                textAlignmentAttribute: AnyCodable?,
                rawItem: [String: AnyCodable],
                rawParagraph: [String: AnyCodable]?,
                nested: NativeTabDocNestedList?
            )]
            switch kind {
            case .bulletList, .orderedList, .taskList:
                sourceItems = listItems.map {
                    (
                        $0.spans,
                        $0.isChecked,
                        Self.textAlignmentAttribute(in: $0.rawParagraph),
                        $0.rawItem,
                        $0.rawParagraph,
                        $0.nested
                    )
                }
            case .paragraph, .heading, .blockquote, .codeBlock:
                sourceItems = [(spans, false, convertibleTextAlignmentAttribute, [:], nil, nil)]
            default:
                return nil
            }
            let keepsCheckedState = target == .taskList && kind == .taskList
            return NativeTabDocBlock(
                id: id,
                kind: target,
                listItems: sourceItems.map { item in
                    NativeTabDocListItem(
                        spans: item.spans,
                        isChecked: keepsCheckedState && item.isChecked,
                        rawItem: Self.listItemRawNodeKeepingIdentity(item.rawItem),
                        rawParagraph: item.rawParagraph.map {
                            Self.listParagraphRawNodeKeepingIdentityAndAlignment(
                                $0,
                                textAlignmentAttribute: item.textAlignmentAttribute
                            )
                        } ?? Self.rawParagraph(
                            textAlignmentAttribute: item.textAlignmentAttribute
                        ),
                        nested: item.nested
                    )
                },
                rawNode: preservedRawNode
            )
        case .image, .table, .divider, .unsupported:
            return nil
        }
    }

    private var canConvertToCodeBlockWithoutDroppingSemantics: Bool {
        guard convertibleTextAlignment == .natural,
              let sourceSpans = convertibleInlineSpans
        else { return false }
        return sourceSpans.allSatisfy {
            $0.marks.isEmpty && $0.mathematics == nil && $0.image == nil
        }
    }

    private var convertibleTextAlignment: NativeTabDocTextAlignment? {
        switch kind {
        case .paragraph, .heading, .blockquote, .codeBlock:
            textAlignment
        case .bulletList, .orderedList, .taskList:
            listItems.count == 1 && listItems[0].nested == nil ? listItems[0].textAlignment : nil
        default:
            nil
        }
    }

    private var convertibleTextAlignmentAttribute: AnyCodable? {
        switch kind {
        case .paragraph, .heading:
            return Self.textAlignmentAttribute(in: rawNode)
        case .blockquote:
            guard let children = rawNode["content"]?.arrayValue as? [[String: Any]],
                  children.count == 1,
                  let paragraph = children.first
            else { return nil }
            return Self.textAlignmentAttribute(in: paragraph.mapValues(AnyCodable.init))
        case .bulletList, .orderedList, .taskList:
            guard listItems.count == 1, listItems[0].nested == nil else { return nil }
            return Self.textAlignmentAttribute(in: listItems[0].rawParagraph)
        case .codeBlock:
            return nil
        default:
            return nil
        }
    }

    private func convertedInlineRawNode(
        from preservedRawNode: [String: AnyCodable],
        target: NativeTabDocBlockKind,
        textAlignmentAttribute: AnyCodable?
    ) -> [String: AnyCodable] {
        var node = preservedRawNode
        switch target {
        case .paragraph, .heading:
            var attributes = node["attrs"]?.dictValue ?? [:]
            if let textAlignmentAttribute {
                attributes["textAlign"] = textAlignmentAttribute.value
            }
            if !attributes.isEmpty {
                node["attrs"] = AnyCodable(attributes)
            }
        case .blockquote:
            node["content"] = AnyCodable([
                Self.rawParagraph(
                    textAlignmentAttribute: textAlignmentAttribute
                ).mapValues(\.value),
            ])
        case .codeBlock:
            break
        default:
            break
        }
        return node
    }

    private static func rawParagraph(
        textAlignmentAttribute: AnyCodable?
    ) -> [String: AnyCodable] {
        var paragraph: [String: AnyCodable] = ["type": AnyCodable("paragraph")]
        if let textAlignmentAttribute {
            paragraph["attrs"] = AnyCodable([
                "textAlign": textAlignmentAttribute.value,
            ])
        }
        return paragraph
    }

    private static func textAlignmentAttribute(
        in rawNode: [String: AnyCodable]
    ) -> AnyCodable? {
        guard let value = rawNode["attrs"]?.dictValue?["textAlign"] else { return nil }
        return AnyCodable(value)
    }

    private var convertibleInlineSpans: [NativeTabDocInlineSpan]? {
        switch kind {
        case .paragraph, .heading, .blockquote, .codeBlock:
            spans
        case .bulletList, .orderedList, .taskList:
            listItems.count == 1 && listItems[0].nested == nil ? listItems[0].spans : nil
        default:
            nil
        }
    }

    private var rawNodeKeepingTopLevelIdentity: [String: AnyCodable] {
        guard let attributes = rawNode["attrs"]?.dictValue else { return [:] }
        let identity = attributes.filter { Self.topLevelIdentityKeys.contains($0.key) }
        return identity.isEmpty ? [:] : ["attrs": AnyCodable(identity)]
    }

    private static func listItemRawNodeKeepingIdentity(
        _ rawItem: [String: AnyCodable]
    ) -> [String: AnyCodable] {
        guard let attributes = rawItem["attrs"]?.dictValue else { return [:] }
        let identity = attributes.filter { Self.topLevelIdentityKeys.contains($0.key) }
        return identity.isEmpty ? [:] : ["attrs": AnyCodable(identity)]
    }

    private static func listParagraphRawNodeKeepingIdentityAndAlignment(
        _ rawParagraph: [String: AnyCodable],
        textAlignmentAttribute: AnyCodable?
    ) -> [String: AnyCodable] {
        let sourceAttributes = rawParagraph["attrs"]?.dictValue ?? [:]
        var attributes = sourceAttributes.filter { Self.topLevelIdentityKeys.contains($0.key) }
        if let textAlignmentAttribute {
            attributes["textAlign"] = textAlignmentAttribute.value
        }
        return attributes.isEmpty ? [:] : ["attrs": AnyCodable(attributes)]
    }

    private static let topLevelIdentityKeys: Set<String> = ["blockId", "id"]
    private static let duplicateIdentityKeys: Set<String> = [
        "blockId", "id", "itemId", "taskId", "todoId", "rowId", "cellId",
    ]

    private static func removingNodeIdentities(
        from raw: [String: AnyCodable]
    ) -> [String: AnyCodable] {
        let cleaned = removingNodeIdentities(from: raw.mapValues(\.value))
        guard let dictionary = cleaned as? [String: Any] else { return [:] }
        return dictionary.mapValues(AnyCodable.init)
    }

    private static func removingNodeIdentities(from value: Any) -> Any {
        if let dictionary = value as? [String: Any] {
            var cleaned: [String: Any] = [:]
            for (key, nested) in dictionary where !duplicateIdentityKeys.contains(key) {
                cleaned[key] = removingNodeIdentities(from: nested)
            }
            return cleaned
        }
        if let array = value as? [Any] {
            return array.map(removingNodeIdentities(from:))
        }
        return value
    }

    /// 复制必须连嵌套子树一起换新身份，否则副本与原块会共享同一批 blockId。
    private static func duplicatingListItems(
        _ items: [NativeTabDocListItem]
    ) -> [NativeTabDocListItem] {
        items.map { item in
            NativeTabDocListItem(
                spans: NativeTabDocInlineSpan.renewingInlineAtomIdentities(in: item.spans),
                isChecked: item.isChecked,
                rawItem: removingNodeIdentities(from: item.rawItem),
                rawParagraph: removingNodeIdentities(from: item.rawParagraph),
                nested: item.nested.map { nested in
                    NativeTabDocNestedList(
                        kind: nested.kind,
                        items: duplicatingListItems(nested.items),
                        rawNode: removingNodeIdentities(from: nested.rawNode)
                    )
                }
            )
        }
    }

    var serializedNode: [String: Any] {
        guard kind.isSupported else { return rawNode.mapValues(\.value) }
        if case .table = kind, table?.requiresWholeTablePreservation == true {
            return rawNode.mapValues(\.value)
        }
        var node = rawNode.mapValues(\.value)
        switch kind {
        case .paragraph:
            node["type"] = "paragraph"
            node["content"] = Self.inlineNodes(from: spans)
        case .heading(let level):
            node["type"] = "heading"
            var attrs = node["attrs"] as? [String: Any] ?? [:]
            attrs["level"] = min(max(level, 1), 6)
            node["attrs"] = attrs
            node["content"] = Self.inlineNodes(from: spans)
        case .blockquote:
            node["type"] = "blockquote"
            var paragraph = quoteParagraph ?? ["type": "paragraph"]
            paragraph["content"] = Self.inlineNodes(from: spans)
            node["content"] = [paragraph]
        case .codeBlock:
            node["type"] = "codeBlock"
            node["content"] = text.isEmpty ? [] : [["type": "text", "text": text]]
        case .bulletList, .orderedList, .taskList:
            node = serializedListNode(from: node)
        case .image:
            node["type"] = "paragraph"
            node["content"] = [preservedInlineImageNode ?? canonicalInlineImageNode]
        case .table:
            node["type"] = "table"
            node["content"] = serializedTableRows
        case .divider:
            node["type"] = "horizontalRule"
            node.removeValue(forKey: "content")
        case .unsupported:
            break
        }
        return node
    }

    /// 已有图片的元数据在首期原生页只读；保存其它块时原样带回 image 节点，
    /// 包括当前客户端不理解的附加 attrs。新上传图片才使用 canonical fallback。
    private var preservedInlineImageNode: [String: Any]? {
        guard rawNode["type"]?.stringValue == "paragraph",
              let children = rawNode["content"]?.arrayValue as? [[String: Any]],
              children.count == 1,
              children[0]["type"] as? String == "image"
        else { return nil }
        return children[0]
    }

    private var canonicalInlineImageNode: [String: Any] {
        guard let image else { return ["type": "image", "attrs": [:]] }
        var attrs: [String: Any] = ["src": image.source]
        if let fileId = image.fileId, !fileId.isEmpty { attrs["fileId"] = fileId }
        if !image.alt.isEmpty { attrs["alt"] = image.alt }
        if !image.title.isEmpty { attrs["title"] = image.title }
        if let width = image.width { attrs["width"] = width }
        if let height = image.height { attrs["height"] = height }
        return ["type": "image", "attrs": attrs]
    }

    private var quoteParagraph: [String: Any]? {
        guard case .blockquote = kind,
              let children = rawNode["content"]?.arrayValue as? [[String: Any]],
              children.count == 1,
              children[0]["type"] as? String == "paragraph"
        else { return nil }
        return children[0]
    }

    private func serializedListNode(from original: [String: Any]) -> [String: Any] {
        Self.serializedListNode(kind: kind, items: listItems, original: original)
    }

    private static func serializedListNode(
        kind: NativeTabDocBlockKind,
        items: [NativeTabDocListItem],
        original: [String: Any]
    ) -> [String: Any] {
        var node = original
        let listType: String
        let itemType: String
        switch kind {
        case .orderedList(let start):
            listType = "orderedList"
            itemType = "listItem"
            var attrs = node["attrs"] as? [String: Any] ?? [:]
            attrs["start"] = max(start, 1)
            node["attrs"] = attrs
        case .taskList:
            listType = "taskList"
            itemType = "taskItem"
        default:
            listType = "bulletList"
            itemType = "listItem"
        }
        node["type"] = listType
        node["content"] = items.map { item in
            var itemNode = item.rawItem.mapValues(\.value)
            itemNode["type"] = itemType
            if itemType == "taskItem" {
                var attrs = itemNode["attrs"] as? [String: Any] ?? [:]
                attrs["checked"] = item.isChecked
                itemNode["attrs"] = attrs
            }
            var paragraph = item.rawParagraph.mapValues(\.value)
            paragraph["type"] = "paragraph"
            paragraph["content"] = inlineNodes(from: item.spans)
            var content: [[String: Any]] = [paragraph]
            if let nested = item.nested {
                content.append(
                    serializedListNode(
                        kind: nested.kind,
                        items: nested.items,
                        original: nested.rawNode.mapValues(\.value)
                    )
                )
            }
            itemNode["content"] = content
            return itemNode
        }
        return node
    }

    private var serializedTableRows: [[String: Any]] {
        guard let table else { return [] }
        return table.rows.map { row in
            var rowNode = row.rawRow.mapValues(\.value)
            rowNode["type"] = "tableRow"
            rowNode["content"] = row.cells.map { cell in
                // 旧草稿已经在 serializedNode 入口整表返回；走到这里的只会是
                // 新版逐格投影，避免为每个格子重复扫描整张表。
                if cell.isReadOnlyProjection == true {
                    return cell.rawCell.mapValues(\.value)
                }
                var cellNode = cell.rawCell.mapValues(\.value)
                cellNode["type"] = cell.isHeader ? "tableHeader" : "tableCell"
                var paragraph = cell.rawParagraph.mapValues(\.value)
                paragraph["type"] = "paragraph"
                paragraph["content"] = Self.inlineNodes(from: cell.spans)
                cellNode["content"] = [paragraph]
                return cellNode
            }
            return rowNode
        }
    }

    private static func inlineNodes(from spans: [NativeTabDocInlineSpan]) -> [[String: Any]] {
        var nodes: [[String: Any]] = []
        var pendingMathematics: (payload: NativeTabDocInlineMathematics, text: String)?
        var pendingImage: (payload: NativeTabDocInlineImage, length: Int)?

        func flushMathematics() {
            guard let pending = pendingMathematics else { return }
            var attrs = pending.payload.attrs.mapValues(\.value)
            attrs[pending.payload.valueAttribute] = pending.text
            nodes.append([
                "type": pending.payload.nodeType,
                "attrs": attrs,
            ])
            pendingMathematics = nil
        }

        // 图片身份来自 attrs，占位文字不参与写回；占位被整段删光才等于删除这张图片。
        func flushImage() {
            guard let pending = pendingImage else { return }
            if pending.length > 0 {
                nodes.append([
                    "type": pending.payload.nodeType,
                    "attrs": pending.payload.attrs.mapValues(\.value),
                ])
            }
            pendingImage = nil
        }

        for span in spans {
            if let image = span.image {
                flushMathematics()
                if let pending = pendingImage,
                   pending.payload.atomId == image.atomId,
                   pending.payload.nodeType == image.nodeType,
                   pending.payload.attrs == image.attrs {
                    pendingImage = (image, pending.length + span.text.count)
                } else {
                    flushImage()
                    pendingImage = (image, span.text.count)
                }
                continue
            }
            flushImage()
            if let mathematics = span.mathematics {
                if let pending = pendingMathematics,
                   pending.payload.atomId == mathematics.atomId,
                   pending.payload.nodeType == mathematics.nodeType,
                   pending.payload.valueAttribute == mathematics.valueAttribute,
                   pending.payload.attrs == mathematics.attrs {
                    pendingMathematics = (mathematics, pending.text + span.text)
                } else {
                    flushMathematics()
                    pendingMathematics = (mathematics, span.text)
                }
                continue
            }
            flushMathematics()
            // 附件字符只是行内图片的渲染载体。若它随复制粘贴脱离了图片身份漂到普通文本上，
            // 必须在写回前剥掉，否则文档里会多出一个用户看不见也删不掉的字符。
            let sanitized = span.text.replacingOccurrences(
                of: NativeTabDocInlineSpan.attachmentPlaceholderCharacter,
                with: ""
            )
            let lines = sanitized.split(separator: "\n", omittingEmptySubsequences: false)
            for (index, line) in lines.enumerated() {
                if index > 0 { nodes.append(["type": "hardBreak"]) }
                guard !line.isEmpty else { continue }
                var textNode: [String: Any] = ["type": "text", "text": String(line)]
                if !span.marks.isEmpty {
                    textNode["marks"] = span.marks.map(\.serializedNode)
                }
                nodes.append(textNode)
            }
        }
        flushImage()
        flushMathematics()
        return nodes
    }

    /// 复杂块仍需在原生页逐块可读。正文优先；无正文的媒体/嵌入块从常见属性提取摘要，
    /// 最差也由 UI 展示节点类型，不把复杂文档折叠成一张空提示卡。
    var readablePreview: String? {
        let values = [text]
            + listItems.map { item in
                item.descendantPlainTexts
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .joined(separator: " ")
            }
            + (table?.rows.flatMap { $0.cells.map(\.text) } ?? [])
            + [image?.alt ?? ""]
        if let value = values.first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let nested = Self.recursiveText(in: rawNode.mapValues(\.value)), !nested.isEmpty {
            return nested
        }
        guard let attributes = rawNode["attrs"]?.dictValue else { return nil }
        let previewKeys: [String]
        let rejectedPreviewValues: Set<String>
        if case .unsupported(let rawType) = kind,
           NativeTabDocUnsupportedContentKind(rawType: rawType) != nil {
            // 已知嵌入块的第二行只从产品标题字段投影。实现层 URL/ID 不作为回退，
            // 标题候选若只是这些敏感值的别名也会跳过；无安全标题时走 label-only。
            previewKeys = ["title", "name", "alt", "label"]
            let sensitiveKeys = ["tableId", "viewId", "canvasId", "fileId", "src", "href", "url"]
            let sensitiveAliases = sensitiveKeys.compactMap { key -> String? in
                guard let value = attributes[key] as? String else { return nil }
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            rejectedPreviewValues = Set([rawType] + sensitiveAliases)
        } else {
            previewKeys = ["title", "name", "alt", "label", "href", "url", "src"]
            rejectedPreviewValues = []
        }
        for key in previewKeys {
            if let value = attributes[key] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty, !rejectedPreviewValues.contains(trimmed) { return trimmed }
            }
        }
        return nil
    }

    private static func recursiveText(in node: [String: Any]) -> String? {
        let type = node["type"] as? String
        if type == "text", let text = node["text"] as? String { return text }
        if type == "hardBreak" { return "\n" }
        guard let children = node["content"] as? [[String: Any]] else { return nil }
        let isInlineFlow = children.allSatisfy { child in
            guard let childType = child["type"] as? String else { return false }
            return childType == "text" || childType == "hardBreak"
        }
        let value = children
            .compactMap(recursiveText(in:))
            .joined(separator: isInlineFlow ? "" : " ")
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct NativeTabDocEditorFocusDestination: Equatable, Sendable {
    let editorId: UUID
    let caretPosition: Int
}

struct NativeTabDocBackspaceResult: Equatable, Sendable {
    var blocks: [NativeTabDocBlock]
    let focus: NativeTabDocEditorFocusDestination?
    let didMutate: Bool
}

/// 块首 Delete 的唯一结构策略。文本组件只负责识别键盘动作；这里负责在不丢失
/// 富文本、代码块或嵌套列表身份的前提下合并相邻编辑器，并返回下一处光标位置。
enum NativeTabDocBackspacePolicy {
    static func mergeBlockWithPrevious(
        blocks: [NativeTabDocBlock],
        blockId: UUID
    ) -> NativeTabDocBackspaceResult {
        var updated = blocks
        guard let index = updated.firstIndex(where: { $0.id == blockId }),
              index > updated.startIndex,
              updated[index].kind.allowsInlineEditing
        else { return unchanged(blocks) }

        let current = updated[index]
        let previousIndex = updated.index(before: index)
        let previous = updated[previousIndex]

        if previous.kind.allowsInlineEditing,
           (current.text.isEmpty || canMerge(previous: previous.kind, current: current.kind)) {
            let caret = utf16Length(previous.text)
            updated[previousIndex].spans.append(contentsOf: current.spans)
            updated.remove(at: index)
            return changed(updated, editorId: previous.id, caret: caret)
        }

        if isList(previous.kind),
           !isCode(current.kind),
           let previousItem = lastListItem(in: previous.listItems) {
            let caret = utf16Length(previousItem.text)
            guard updateListItem(
                in: &updated[previousIndex].listItems,
                id: previousItem.id,
                spans: previousItem.spans + current.spans
            ) else { return unchanged(blocks) }
            updated.remove(at: index)
            return changed(updated, editorId: previousItem.id, caret: caret)
        }

        return unchanged(blocks)
    }

    static func mergeListItemWithPrevious(
        blocks: [NativeTabDocBlock],
        blockId: UUID,
        itemId: UUID
    ) -> NativeTabDocBackspaceResult {
        var updated = blocks
        guard let blockIndex = updated.firstIndex(where: { $0.id == blockId }),
              isList(updated[blockIndex].kind),
              let current = listItem(in: updated[blockIndex].listItems, id: itemId),
              current.nested == nil
        else { return unchanged(blocks) }

        let flattened = flattenedListItems(in: updated[blockIndex].listItems)
        guard let itemIndex = flattened.firstIndex(where: { $0.id == itemId }) else {
            return unchanged(blocks)
        }

        if itemIndex > flattened.startIndex {
            let previous = flattened[flattened.index(before: itemIndex)]
            let caret = utf16Length(previous.text)
            guard updateListItem(
                in: &updated[blockIndex].listItems,
                id: previous.id,
                spans: previous.spans + current.spans
            ), removeListItem(in: &updated[blockIndex].listItems, id: current.id)
            else { return unchanged(blocks) }
            return changed(updated, editorId: previous.id, caret: caret)
        }

        guard blockIndex > updated.startIndex else { return unchanged(blocks) }
        let previousBlockIndex = updated.index(before: blockIndex)
        let previousBlock = updated[previousBlockIndex]
        let focus: NativeTabDocEditorFocusDestination

        if canMergeListItem(into: previousBlock.kind) {
            let caret = utf16Length(previousBlock.text)
            updated[previousBlockIndex].spans.append(contentsOf: current.spans)
            focus = NativeTabDocEditorFocusDestination(
                editorId: previousBlock.id,
                caretPosition: caret
            )
        } else if isList(previousBlock.kind),
                  let previousItem = lastListItem(in: previousBlock.listItems) {
            let caret = utf16Length(previousItem.text)
            guard updateListItem(
                in: &updated[previousBlockIndex].listItems,
                id: previousItem.id,
                spans: previousItem.spans + current.spans
            ) else { return unchanged(blocks) }
            focus = NativeTabDocEditorFocusDestination(
                editorId: previousItem.id,
                caretPosition: caret
            )
        } else {
            return unchanged(blocks)
        }

        guard removeListItem(in: &updated[blockIndex].listItems, id: current.id) else {
            return unchanged(blocks)
        }
        if updated[blockIndex].listItems.isEmpty {
            updated.remove(at: blockIndex)
        }
        return NativeTabDocBackspaceResult(blocks: updated, focus: focus, didMutate: true)
    }

    private static func canMerge(
        previous: NativeTabDocBlockKind,
        current: NativeTabDocBlockKind
    ) -> Bool {
        previous.allowsInlineEditing
            && current.allowsInlineEditing
            && isCode(previous) == isCode(current)
    }

    private static func canMergeListItem(into kind: NativeTabDocBlockKind) -> Bool {
        kind.allowsInlineEditing && !isCode(kind)
    }

    private static func isCode(_ kind: NativeTabDocBlockKind) -> Bool {
        if case .codeBlock = kind { return true }
        return false
    }

    private static func isList(_ kind: NativeTabDocBlockKind) -> Bool {
        switch kind {
        case .bulletList, .orderedList, .taskList: true
        default: false
        }
    }

    private static func utf16Length(_ text: String) -> Int {
        (text as NSString).length
    }

    private static func flattenedListItems(
        in items: [NativeTabDocListItem]
    ) -> [NativeTabDocListItem] {
        items.flatMap { item in
            [item] + flattenedListItems(in: item.nested?.items ?? [])
        }
    }

    private static func lastListItem(
        in items: [NativeTabDocListItem]
    ) -> NativeTabDocListItem? {
        guard let last = items.last else { return nil }
        return lastListItem(in: last.nested?.items ?? []) ?? last
    }

    private static func listItem(
        in items: [NativeTabDocListItem],
        id: UUID
    ) -> NativeTabDocListItem? {
        for item in items {
            if item.id == id { return item }
            if let nested = listItem(in: item.nested?.items ?? [], id: id) { return nested }
        }
        return nil
    }

    private static func updateListItem(
        in items: inout [NativeTabDocListItem],
        id: UUID,
        spans: [NativeTabDocInlineSpan]
    ) -> Bool {
        for index in items.indices {
            if items[index].id == id {
                items[index].spans = spans
                return true
            }
            guard var nested = items[index].nested else { continue }
            if updateListItem(in: &nested.items, id: id, spans: spans) {
                items[index].nested = nested
                return true
            }
        }
        return false
    }

    private static func removeListItem(
        in items: inout [NativeTabDocListItem],
        id: UUID
    ) -> Bool {
        if let index = items.firstIndex(where: { $0.id == id }) {
            items.remove(at: index)
            return true
        }
        for index in items.indices {
            guard var nested = items[index].nested else { continue }
            if removeListItem(in: &nested.items, id: id) {
                items[index].nested = nested.items.isEmpty ? nil : nested
                return true
            }
        }
        return false
    }

    private static func unchanged(_ blocks: [NativeTabDocBlock]) -> NativeTabDocBackspaceResult {
        NativeTabDocBackspaceResult(blocks: blocks, focus: nil, didMutate: false)
    }

    private static func changed(
        _ blocks: [NativeTabDocBlock],
        editorId: UUID,
        caret: Int
    ) -> NativeTabDocBackspaceResult {
        NativeTabDocBackspaceResult(
            blocks: blocks,
            focus: NativeTabDocEditorFocusDestination(
                editorId: editorId,
                caretPosition: caret
            ),
            didMutate: true
        )
    }
}

struct NativeTabDocBody: Codable, Equatable, Sendable {
    var rootAttributes: [String: AnyCodable]
    var blocks: [NativeTabDocBlock]
    /// 非数组或混合类型的 root content 无法安全投影成块；保留原值并锁定原生编辑，
    /// 避免 compactMap 静默丢节点后再覆盖服务端正文。
    var preservedRootContent: AnyCodable? = nil

    static func parse(
        json: [String: AnyCodable],
        markdownFallback: String
    ) -> NativeTabDocBody {
        if let rawContent = json["content"] {
            guard let rawNodes = rawContent.arrayValue else {
                return opaqueDocument(json: json, rawContent: rawContent)
            }
            let nodes = rawNodes.compactMap { $0 as? [String: Any] }
            guard nodes.count == rawNodes.count else {
                return opaqueDocument(json: json, rawContent: rawContent)
            }
            var root = json
            root.removeValue(forKey: "content")
            return NativeTabDocBody(
                rootAttributes: root,
                blocks: nodes.map(parseNode)
            )
        }
        return NativeTabDocBody(
            rootAttributes: ["type": AnyCodable("doc")],
            blocks: parseMarkdown(markdownFallback)
        )
    }

    /// 将表格单元格的 block content 包装成一个只读的迷你云文档。
    /// 这里只复用原生文档解析/渲染模型，不把内容转成 Markdown，也不改变 rawCell。
    static func parseTableCellContent(
        _ rawCell: [String: AnyCodable]
    ) -> NativeTabDocBody? {
        guard let rawContent = rawCell["content"]?.arrayValue,
              let content = rawContent as? [[String: Any]],
              !content.isEmpty
        else { return nil }
        return parse(
            json: [
                "type": AnyCodable("doc"),
                "content": AnyCodable(content),
            ],
            markdownFallback: ""
        )
    }

    var serializedJSON: [String: AnyCodable] {
        var root = rootAttributes
        root["type"] = root["type"] ?? AnyCodable("doc")
        root["content"] = preservedRootContent ?? AnyCodable(blocks.map(\.serializedNode))
        return root
    }

    var markdown: String {
        blocks.compactMap(Self.markdown(for:)).joined(separator: "\n\n")
    }

    var plaintext: String {
        blocks.compactMap { block in
            switch block.kind {
            case .paragraph, .heading, .blockquote, .codeBlock:
                return block.text
            case .bulletList, .orderedList, .taskList:
                return block.listItems
                    .flatMap(\.descendantPlainTexts)
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n")
            case .image:
                if block.image?.alt.isEmpty == false { return block.image?.alt }
                if let fileId = block.image?.fileId, !fileId.isEmpty {
                    return "tabtin-file://asset/\(fileId)"
                }
                return block.image?.source
            case .table:
                return block.table?.rows.map { $0.cells.map(\.text).joined(separator: "\t") }.joined(separator: "\n")
            case .divider:
                return "---"
            case .unsupported:
                return block.readablePreview
            }
        }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    var hasUnsupportedBlocks: Bool {
        preservedRootContent != nil || blocks.contains { !$0.kind.isSupported }
    }

    var projectedTableCellCount: Int {
        blocks.compactMap(\.table).reduce(0) { $0 + $1.projectedCellCount }
    }

    var hasProjectedTableCells: Bool { projectedTableCellCount > 0 }

    private static func opaqueDocument(
        json: [String: AnyCodable],
        rawContent: AnyCodable
    ) -> NativeTabDocBody {
        var root = json
        root.removeValue(forKey: "content")
        return NativeTabDocBody(
            rootAttributes: root,
            blocks: [NativeTabDocBlock(
                kind: .unsupported(type: "document"),
                rawNode: [
                    "type": AnyCodable("document"),
                    "content": rawContent,
                ]
            )],
            preservedRootContent: rawContent
        )
    }

    private static func parseNode(_ raw: [String: Any]) -> NativeTabDocBlock {
        let node = raw.mapValues(AnyCodable.init)
        let type = raw["type"] as? String ?? "unknown"
        switch type {
        case "paragraph":
            guard hasSafeTextBlockAttributes(raw) else { return unsupported(raw, type: type) }
            if let children = raw["content"] as? [[String: Any]],
               children.count == 1,
               children[0]["type"] as? String == "image" {
                guard textAlignment(in: raw) == .natural else {
                    return unsupported(raw, type: type)
                }
                return parseStandaloneImageParagraph(raw, imageNode: children[0])
                    ?? unsupported(raw, type: type)
            }
            guard let spans = parseInlineSpans(raw["content"], allowUnknownRange: true)
            else { return unsupported(raw, type: type) }
            return NativeTabDocBlock(kind: .paragraph, spans: spans, rawNode: node)
        case "heading":
            let attrs = raw["attrs"] as? [String: Any]
            let level = attrs?["level"] as? Int ?? 1
            guard hasSafeTextBlockAttributes(raw, additionalKeys: ["level"]),
                  (1...6).contains(level),
                  let spans = parseInlineSpans(raw["content"])
            else {
                return unsupported(raw, type: type)
            }
            return NativeTabDocBlock(kind: .heading(level: level), spans: spans, rawNode: node)
        case "bulletList":
            guard hasSafeIdentityOnlyContainerAttributes(raw) else {
                return unsupported(raw, type: type)
            }
            return parseList(raw, kind: .bulletList) ?? unsupported(raw, type: type)
        case "orderedList":
            guard let start = safeOrderedListStart(raw) else {
                return unsupported(raw, type: type)
            }
            return parseList(raw, kind: .orderedList(start: start))
                ?? unsupported(raw, type: type)
        case "taskList":
            guard hasSafeIdentityOnlyContainerAttributes(raw) else {
                return unsupported(raw, type: type)
            }
            return parseList(raw, kind: .taskList) ?? unsupported(raw, type: type)
        case "blockquote":
            guard hasSafeIdentityOnlyContainerAttributes(raw),
                  let children = raw["content"] as? [[String: Any]],
                  children.count == 1,
                  children[0]["type"] as? String == "paragraph",
                  hasSafeTextBlockAttributes(children[0]),
                  let spans = parseInlineSpans(children[0]["content"])
            else { return unsupported(raw, type: type) }
            return NativeTabDocBlock(kind: .blockquote, spans: spans, rawNode: node)
        case "codeBlock":
            guard let text = parseCodeText(raw["content"]) else { return unsupported(raw, type: type) }
            return NativeTabDocBlock(kind: .codeBlock, text: text, rawNode: node)
        case "table":
            guard let table = parseTable(raw) else { return unsupported(raw, type: type) }
            return NativeTabDocBlock(kind: .table, table: table, rawNode: node)
        case "horizontalRule", "divider":
            return NativeTabDocBlock(kind: .divider, rawNode: node)
        default:
            return unsupported(raw, type: type)
        }
    }

    private static func parseStandaloneImageParagraph(
        _ paragraph: [String: Any],
        imageNode: [String: Any]
    ) -> NativeTabDocBlock? {
        guard imageNode["type"] as? String == "image",
              let attrs = imageNode["attrs"] as? [String: Any],
              imageNode["content"] == nil,
              isEmptyMarks(imageNode["marks"]),
              let source = optionalString(attrs["src"]),
              let fileId = optionalString(attrs["fileId"] ?? attrs["file_id"]),
              let alt = optionalString(attrs["alt"]),
              let title = optionalString(attrs["title"]),
              let width = optionalInt(attrs["width"]),
              let height = optionalInt(attrs["height"]),
              !source.isEmpty || !fileId.isEmpty
        else { return nil }
        return NativeTabDocBlock(
            kind: .image,
            image: NativeTabDocImage(
                source: source,
                fileId: fileId.isEmpty ? nil : fileId,
                alt: alt,
                title: title,
                width: width,
                height: height
            ),
            rawNode: paragraph.mapValues(AnyCodable.init)
        )
    }

    private static func isEmptyMarks(_ raw: Any?) -> Bool {
        guard let raw else { return true }
        if raw is NSNull { return true }
        guard let marks = raw as? [Any] else { return false }
        return marks.isEmpty
    }

    /// 只放行节点身份、heading level 与 ProseMirror 的四个精确 textAlign 值。
    /// 大小写漂移、错误类型和其它 attrs 都代表未知语义，必须局部只读保留。
    private static func hasSafeTextBlockAttributes(
        _ raw: [String: Any],
        additionalKeys: Set<String> = []
    ) -> Bool {
        guard let rawAttributes = raw["attrs"] else { return true }
        guard let attributes = rawAttributes as? [String: Any] else { return false }
        let allowedKeys = Set(["id", "blockId", "textAlign"]).union(additionalKeys)
        guard Set(attributes.keys).isSubset(of: allowedKeys) else { return false }
        for identityKey in ["id", "blockId"] {
            if let value = attributes[identityKey], !(value is String) { return false }
        }
        return NativeTabDocTextAlignment(
            proseMirrorValue: attributes["textAlign"]
        ) != nil
    }

    private static func textAlignment(in raw: [String: Any]) -> NativeTabDocTextAlignment? {
        let rawValue = (raw["attrs"] as? [String: Any])?["textAlign"]
        return NativeTabDocTextAlignment(proseMirrorValue: rawValue)
    }

    /// nil / JSON null 表示 schema 默认值；其它错误类型必须让整段降级为只读。
    private static func optionalString(_ raw: Any?) -> String? {
        guard let raw else { return "" }
        if raw is NSNull { return "" }
        return raw as? String
    }

    private static func optionalInt(_ raw: Any?) -> Int?? {
        guard let raw else { return .some(nil) }
        if raw is NSNull { return .some(nil) }
        guard let value = raw as? Int else { return nil }
        return .some(value)
    }

    private static let containerIdentityKeys: Set<String> = ["id", "blockId"]

    private static func hasSafeIdentityOnlyContainerAttributes(
        _ raw: [String: Any]
    ) -> Bool {
        guard Set(raw.keys).isSubset(of: ["type", "attrs", "content"]),
              let attributes = safeAttributes(in: raw),
              Set(attributes.keys).isSubset(of: containerIdentityKeys)
        else { return false }
        return hasSafeContainerIdentities(attributes)
    }

    private static func safeOrderedListStart(_ raw: [String: Any]) -> Int? {
        guard Set(raw.keys).isSubset(of: ["type", "attrs", "content"]),
              let attributes = safeAttributes(in: raw),
              Set(attributes.keys).isSubset(
                  of: containerIdentityKeys.union(["start", "type"])
              ),
              hasSafeContainerIdentities(attributes)
        else { return nil }

        if let listStyle = attributes["type"] {
            guard listStyle is NSNull,
                  let startValue = attributes["start"],
                  exactInteger(startValue) == 1
            else { return nil }
            return 1
        }

        guard let startValue = attributes["start"] else { return 1 }
        if startValue is NSNull { return 1 }
        guard let start = exactInteger(startValue), start >= 1 else { return nil }
        return start
    }

    private static func hasSafeContainerIdentities(
        _ attributes: [String: Any]
    ) -> Bool {
        containerIdentityKeys.allSatisfy { key in
            guard let value = attributes[key] else { return true }
            return value is String
        }
    }

    private static func safeAttributes(in raw: [String: Any]) -> [String: Any]? {
        guard let rawAttributes = raw["attrs"] else { return [:] }
        if rawAttributes is NSNull { return [:] }
        return rawAttributes as? [String: Any]
    }

    private static func exactInteger(_ value: Any) -> Int? {
        if type(of: value) == Bool.self
            || type(of: value) == Double.self
            || type(of: value) == Float.self {
            return nil
        }
        if type(of: value) == Int.self, let integer = value as? Int { return integer }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded() == double else { return nil }
        return Int(exactly: double)
    }

    private static func exactBoolean(_ value: Any) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else { return nil }
        return number.boolValue
    }

    /// 项的子节点必须是「一个段落」或「一个段落 + 一个同构子列表」。
    /// 任何无法原样重建的形态都返回 nil，让整块降级只读，避免保存时改写文档。
    private static func parseList(_ raw: [String: Any], kind: NativeTabDocBlockKind) -> NativeTabDocBlock? {
        guard let items = parseListItems(raw, kind: kind, depth: 0) else { return nil }
        return NativeTabDocBlock(
            kind: kind,
            listItems: items,
            rawNode: raw.mapValues(AnyCodable.init)
        )
    }

    private static func parseNestedList(
        _ raw: [String: Any],
        depth: Int
    ) -> NativeTabDocNestedList? {
        guard depth <= NativeTabDocNestedList.maxDepth else { return nil }
        guard let kind = parseListKind(raw),
              let items = parseListItems(raw, kind: kind, depth: depth)
        else { return nil }
        return NativeTabDocNestedList(
            kind: kind,
            items: items,
            rawNode: raw.mapValues(AnyCodable.init)
        )
    }

    private static func parseListKind(_ raw: [String: Any]) -> NativeTabDocBlockKind? {
        switch raw["type"] as? String {
        case "bulletList":
            guard hasSafeIdentityOnlyContainerAttributes(raw) else { return nil }
            return .bulletList
        case "orderedList":
            guard let start = safeOrderedListStart(raw) else { return nil }
            return .orderedList(start: start)
        case "taskList":
            guard hasSafeIdentityOnlyContainerAttributes(raw) else { return nil }
            return .taskList
        default:
            return nil
        }
    }

    private static func parseListItems(
        _ raw: [String: Any],
        kind: NativeTabDocBlockKind,
        depth: Int
    ) -> [NativeTabDocListItem]? {
        guard let children = raw["content"] as? [[String: Any]], !children.isEmpty else { return nil }
        let expectsTask: Bool = if case .taskList = kind { true } else { false }
        var items: [NativeTabDocListItem] = []
        for item in children {
            let itemType = item["type"] as? String
            guard itemType == (expectsTask ? "taskItem" : "listItem"),
                  hasSafeListItemAttributes(item, expectsTask: expectsTask),
                  let itemChildren = item["content"] as? [[String: Any]],
                  (1...2).contains(itemChildren.count),
                  let paragraph = itemChildren.first,
                  paragraph["type"] as? String == "paragraph",
                  hasSafeTextBlockAttributes(paragraph),
                  let spans = parseInlineSpans(paragraph["content"])
            else { return nil }

            var nested: NativeTabDocNestedList?
            if itemChildren.count == 2 {
                guard let parsed = parseNestedList(itemChildren[1], depth: depth + 1) else {
                    return nil
                }
                nested = parsed
            }

            let attrs = item["attrs"] as? [String: Any] ?? [:]
            items.append(NativeTabDocListItem(
                spans: spans,
                isChecked: attrs["checked"].flatMap(exactBoolean) ?? false,
                rawItem: item.mapValues(AnyCodable.init),
                rawParagraph: paragraph.mapValues(AnyCodable.init),
                nested: nested
            ))
        }
        return items
    }

    private static func hasSafeListItemAttributes(
        _ item: [String: Any],
        expectsTask: Bool
    ) -> Bool {
        guard Set(item.keys).isSubset(of: ["type", "attrs", "content"]),
              let attributes = safeAttributes(in: item)
        else { return false }

        let allowedKeys = expectsTask
            ? containerIdentityKeys.union(["checked", "todoId"])
            : containerIdentityKeys
        guard Set(attributes.keys).isSubset(of: allowedKeys),
              hasSafeContainerIdentities(attributes)
        else { return false }

        if let todoId = attributes["todoId"], !(todoId is NSNull) { return false }
        if let checked = attributes["checked"],
           !(checked is NSNull),
           exactBoolean(checked) == nil {
            return false
        }
        return true
    }

    /// 普通表格定义为：矩形 tableRow → tableCell/tableHeader → 单 paragraph，且无合并单元格。
    /// 合并、非矩形或超限表格仍投影为局部只读表格块，完整 rawNode 由 block 原样保存，
    /// 不再因为一个表格连带锁住同文档的普通正文。
    private static func parseTable(_ raw: [String: Any]) -> NativeTabDocTable? {
        guard let rawRows = raw["content"] as? [[String: Any]], !rawRows.isEmpty else {
            return nil
        }
        var rows: [NativeTabDocTableRow] = []
        var expectedColumns: Int?
        var isReadOnlyProjection = false
        var preservesWholeTable = rawRows.count > 100
        for rawRow in rawRows.prefix(100) {
            guard rawRow["type"] as? String == "tableRow",
                  let rawCells = rawRow["content"] as? [[String: Any]],
                  !rawCells.isEmpty
            else { return nil }
            if rawCells.count > 20 || (expectedColumns != nil && expectedColumns != rawCells.count) {
                preservesWholeTable = true
            }
            expectedColumns = rawCells.count
            var cells: [NativeTabDocTableCell] = []
            for rawCell in rawCells.prefix(20) {
                let cellType = rawCell["type"] as? String
                guard ["tableCell", "tableHeader"].contains(cellType),
                      let content = rawCell["content"] as? [[String: Any]],
                      !content.isEmpty
                else { return nil }
                if !hasSafeTableCellShapeAttributes(rawCell) {
                    preservesWholeTable = true
                }
                let paragraph = content.count == 1 && content[0]["type"] as? String == "paragraph"
                    ? content[0]
                    : nil
                let displaySpans = paragraph.flatMap { parseInlineSpans($0["content"]) }
                let editableSpans = paragraph.flatMap { paragraph -> [NativeTabDocInlineSpan]? in
                    guard hasSafeTextBlockAttributes(paragraph) else { return nil }
                    return parseEditableTableParagraph(paragraph["content"])
                }
                let projection = displaySpans == nil
                    ? projectedTableCell(content)
                    : nil
                let projectionText = projection?.unlocalizedText ?? ""
                let spans = displaySpans
                    ?? (projectionText.isEmpty ? [] : [NativeTabDocInlineSpan(text: projectionText)])
                cells.append(NativeTabDocTableCell(
                    spans: spans,
                    isHeader: cellType == "tableHeader",
                    rawCell: rawCell.mapValues(AnyCodable.init),
                    rawParagraph: paragraph?.mapValues(AnyCodable.init) ?? [:],
                    isReadOnlyProjection: editableSpans == nil,
                    projection: projection
                ))
                if editableSpans == nil { isReadOnlyProjection = true }
            }
            rows.append(NativeTabDocTableRow(
                cells: cells,
                rawRow: rawRow.mapValues(AnyCodable.init)
            ))
        }
        return NativeTabDocTable(
            rows: rows,
            isReadOnlyProjection: (isReadOnlyProjection || preservesWholeTable) ? true : nil,
            preservesWholeTable: preservesWholeTable ? true : nil
        )
    }

    /// 单元格维度决定表格坐标映射。只有 schema 缺省值或精确整数 1 才能进入
    /// 简单表格；字符串、布尔、浮点及其它未知 attrs 形态都必须整表原样保留。
    private static func hasSafeTableCellShapeAttributes(
        _ rawCell: [String: Any]
    ) -> Bool {
        guard let rawAttributes = rawCell["attrs"] else { return true }
        if rawAttributes is NSNull { return true }
        guard let attributes = rawAttributes as? [String: Any] else { return false }
        for key in ["colspan", "rowspan"] {
            guard let value = attributes[key] else { continue }
            if value is NSNull { continue }
            guard isExactUnitTableDimension(value) else { return false }
        }
        return true
    }

    private static func isExactUnitTableDimension(_ value: Any) -> Bool {
        if type(of: value) == Bool.self
            || type(of: value) == Double.self
            || type(of: value) == Float.self {
            return false
        }
        if type(of: value) == Int.self, let integer = value as? Int {
            return integer == 1
        }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return false }
        let double = number.doubleValue
        return double.isFinite && double.rounded() == double && double == 1
    }

    /// 表格格不能复用 parseInlineSpans：那会把公式格放进来，保存时 atom 身份会变形。
    /// 已知 marks 可进编辑；空数组或未知 mark 必须只读，否则保存时会省略或丢字段。
    private static func parseEditableTableParagraph(_ rawContent: Any?) -> [NativeTabDocInlineSpan]? {
        guard let rawContent else { return [] }
        guard let children = rawContent as? [[String: Any]] else { return nil }
        var spans: [NativeTabDocInlineSpan] = []
        for child in children {
            let type = child["type"] as? String ?? ""
            if type == "hardBreak" {
                guard Set(child.keys) == ["type"] else { return nil }
                spans.append(NativeTabDocInlineSpan(text: "\n"))
                continue
            }
            guard type == "text",
                  Set(child.keys).isSubset(of: ["type", "text", "marks"]),
                  let text = child["text"] as? String,
                  !text.contains("\n")
            else { return nil }
            var marks: [NativeTabDocInlineMark] = []
            if let rawMarks = child["marks"] {
                // marks: [] 保存时会被省略，导致 raw 形态变化，必须逐格只读。
                guard let decoded = rawMarks as? [[String: Any]], !decoded.isEmpty else {
                    return nil
                }
                for rawMark in decoded {
                    guard let mark = parseMark(rawMark) else { return nil }
                    marks.append(mark)
                }
            }
            if !text.isEmpty { spans.append(NativeTabDocInlineSpan(text: text, marks: marks)) }
        }
        return spans
    }

    private static func projectedTableCell(
        _ content: [[String: Any]]
    ) -> NativeTabDocTableProjection {
        .joined(content.map { projectedTableBlock($0, depth: 0) }, separator: "\n")
    }

    private static func projectedTableBlock(
        _ node: [String: Any],
        depth: Int
    ) -> NativeTabDocTableProjection {
        guard depth <= 20 else { return .literal("…") }
        let type = node["type"] as? String ?? ""
        switch type {
        case "text":
            return .literal(node["text"] as? String ?? "")
        case "hardBreak":
            return .literal("\n")
        case "paragraph", "heading", "codeBlock":
            return projectedTableInlineChildren(node, depth: depth + 1)
        case "blockquote", "listItem", "taskItem":
            return projectedTableBlockChildren(node, depth: depth + 1)
        case "bulletList", "orderedList", "taskList":
            return projectedTableList(node, type: type, depth: depth + 1)
        case "image":
            let label = projectedTableAttribute(node, keys: ["alt", "title", "name"])
            return .literal(label.map { "🖼 \($0)" } ?? "🖼")
        case "htmlBlock":
            return projectedTableProductSummary(node, kind: .embeddedHTML)
        case "tabwhiteboard":
            return projectedTableProductSummary(node, kind: .whiteboard)
        case "tabdataBlock", "tabdataEmbed":
            return projectedTableProductSummary(node, kind: .embeddedTable)
        case "youtube", "video":
            return projectedTableProductSummary(node, kind: .video)
        default:
            let children = projectedTableBlockChildren(node, depth: depth + 1)
            if children.hasVisibleContent { return children }
            return .summary(.complexContent)
        }
    }

    private static func projectedTableProductSummary(
        _ node: [String: Any],
        kind: NativeTabDocTableContentSummaryKind
    ) -> NativeTabDocTableProjection {
        .summary(
            kind,
            title: projectedTableAttribute(node, keys: ["title", "name", "label", "alt"])
        )
    }

    private static func projectedTableInlineChildren(
        _ node: [String: Any],
        depth: Int
    ) -> NativeTabDocTableProjection {
        guard let children = node["content"] as? [[String: Any]] else { return .init() }
        return .joined(children.map { projectedTableBlock($0, depth: depth) }, separator: "")
    }

    private static func projectedTableBlockChildren(
        _ node: [String: Any],
        depth: Int
    ) -> NativeTabDocTableProjection {
        guard let children = node["content"] as? [[String: Any]] else { return .init() }
        return .joined(children.map { projectedTableBlock($0, depth: depth) }, separator: "\n")
    }

    private static func projectedTableList(
        _ node: [String: Any],
        type: String,
        depth: Int
    ) -> NativeTabDocTableProjection {
        guard let items = node["content"] as? [[String: Any]] else { return .init() }
        let start = (node["attrs"] as? [String: Any])?["start"] as? Int ?? 1
        let projections = items.enumerated().map { index, item in
            let itemProjection = projectedTableBlock(item, depth: depth)
            let checked = ((item["attrs"] as? [String: Any])?["checked"] as? Bool) == true
            let marker: String = switch type {
            case "orderedList": "\(start + index)."
            case "taskList": checked ? "☑" : "☐"
            default: "•"
            }
            return NativeTabDocTableProjection.literal("\(marker) ")
                .appending(itemProjection.indentingContinuation(with: "  "))
        }
        return .joined(projections, separator: "\n")
    }

    private static func projectedTableAttribute(_ node: [String: Any], keys: [String]) -> String? {
        guard let attributes = node["attrs"] as? [String: Any] else { return nil }
        for key in keys {
            if let value = attributes[key] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    private static func parseInlineSpans(
        _ rawContent: Any?,
        allowUnknownRange: Bool = false
    ) -> [NativeTabDocInlineSpan]? {
        guard let rawContent else { return [] }
        guard let children = rawContent as? [[String: Any]] else { return nil }
        var spans: [NativeTabDocInlineSpan] = []
        for child in children {
            let type = child["type"] as? String ?? ""
            if type == "hardBreak" {
                guard Set(child.keys).isSubset(of: ["type"]) else { return nil }
                spans.append(NativeTabDocInlineSpan(text: "\n"))
                continue
            }
            if type == "image" {
                guard let image = parseInlineImageAtom(child) else { return nil }
                spans.append(NativeTabDocInlineSpan(
                    text: image.placeholderText,
                    image: image
                ))
                continue
            }
            if ["mathematics", "math", "math_inline"].contains(type) {
                guard isEditableCanonicalMathematics(child),
                      let parsed = parseMathematicsAtom(child)
                else { return nil }
                spans.append(NativeTabDocInlineSpan(
                    text: parsed.sourceText,
                    mathematics: parsed.payload
                ))
                continue
            }
            guard type == "text",
                  Set(child.keys).isSubset(of: ["type", "text", "marks"]),
                  let text = child["text"] as? String
            else { return nil }
            var marks: [NativeTabDocInlineMark] = []
            let rawMarks: [[String: Any]]
            if let raw = child["marks"] {
                // marks: [] 保存时会被省略，必须整段只读。
                guard let decoded = raw as? [[String: Any]], !decoded.isEmpty else {
                    return nil
                }
                rawMarks = decoded
            } else {
                rawMarks = []
            }
            for rawMark in rawMarks {
                guard let mark = parseMark(rawMark, allowUnknownRange: allowUnknownRange)
                else { return nil }
                marks.append(mark)
            }
            if !text.isEmpty { spans.append(NativeTabDocInlineSpan(text: text, marks: marks)) }
        }
        return spans
    }

    /// 行内图片能否进原生编辑模型。attrs 会整体带进模型再原样写回，因此只放行
    /// 值类型可无损重建的已知键；未知键或结构化值继续把整块降为局部只读。
    private static func parseInlineImageAtom(_ raw: [String: Any]) -> NativeTabDocInlineImage? {
        guard raw["type"] as? String == "image",
              Set(raw.keys).isSubset(of: ["type", "attrs"]),
              let attrs = raw["attrs"] as? [String: Any],
              Set(attrs.keys).isSubset(of: inlineImageAttributeKeys),
              let source = optionalString(attrs["src"]),
              let fileId = optionalString(attrs["fileId"] ?? attrs["file_id"]),
              optionalString(attrs["alt"]) != nil,
              optionalString(attrs["title"]) != nil,
              optionalInt(attrs["width"]) != nil,
              optionalInt(attrs["height"]) != nil,
              !source.isEmpty || !fileId.isEmpty
        else { return nil }
        return NativeTabDocInlineImage(
            atomId: UUID().uuidString,
            nodeType: "image",
            attrs: attrs.mapValues(AnyCodable.init)
        )
    }

    private static let inlineImageAttributeKeys: Set<String> = [
        "src", "fileId", "file_id", "alt", "title", "width", "height",
    ]

    private static func isEditableCanonicalMathematics(_ raw: [String: Any]) -> Bool {
        guard raw["type"] as? String == "mathematics",
              Set(raw.keys).isSubset(of: ["type", "attrs"]),
              raw.keys.contains("attrs"),
              let attrs = raw["attrs"] as? [String: Any],
              Set(attrs.keys).isSubset(of: ["latex", "display"]),
              let latex = attrs["latex"] as? String,
              !latex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return false }
        guard let display = attrs["display"] else { return true }
        if display is NSNull { return true }
        return isJSONBooleanFalse(display)
    }

    private static func isJSONBooleanFalse(_ value: Any) -> Bool {
        CFGetTypeID(value as AnyObject) == CFBooleanGetTypeID()
            && (value as? Bool) == false
    }

    private static func parseMathematicsAtom(
        _ raw: [String: Any]
    ) -> (payload: NativeTabDocInlineMathematics, sourceText: String)? {
        guard let type = raw["type"] as? String,
              ["mathematics", "math", "math_inline"].contains(type),
              let attrs = raw["attrs"] as? [String: Any]
        else { return nil }
        let latex = attrs["latex"] as? String
        let text = attrs["text"] as? String
        let valueAttribute: String
        let sourceText: String
        switch (latex, text) {
        case (let latex?, nil) where !latex.isEmpty:
            valueAttribute = "latex"
            sourceText = latex
        case (nil, let text?) where !text.isEmpty:
            valueAttribute = "text"
            sourceText = text
        default:
            return nil
        }
        var remainder = attrs
        remainder.removeValue(forKey: "latex")
        remainder.removeValue(forKey: "text")
        return (
            NativeTabDocInlineMathematics(
                atomId: UUID().uuidString,
                nodeType: type,
                valueAttribute: valueAttribute,
                attrs: remainder.mapValues(AnyCodable.init),
                sourceText: sourceText
            ),
            sourceText
        )
    }

    private static func parseMark(
        _ raw: [String: Any],
        allowUnknownRange: Bool = false
    ) -> NativeTabDocInlineMark? {
        guard Set(raw.keys).isSubset(of: ["type", "attrs"]),
              let type = raw["type"] as? String,
              !type.isEmpty
        else {
            return nil
        }
        let kind: NativeTabDocInlineMarkKind
        switch type {
        case "bold", "strong": kind = .bold
        case "italic", "em": kind = .italic
        case "underline": kind = .underline
        case "strike": kind = .strike
        case "code": kind = .code
        case "link":
            guard let attrs = raw["attrs"] as? [String: Any],
                  let href = attrs["href"] as? String,
                  !href.isEmpty,
                  Set(attrs.keys) == ["href"]
                    || (Set(attrs.keys) == ["href", "target"]
                        && attrs["target"] as? String == "_blank")
            else {
                return nil
            }
            kind = .link
        case "textStyle", "highlight":
            guard Set(raw.keys) == ["type", "attrs"],
                  let attrs = raw["attrs"] as? [String: Any],
                  Set(attrs.keys) == ["color"],
                  let color = attrs["color"] as? String,
                  color.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil
                    || (type == "highlight" && color == "yellow")
            else {
                return nil
            }
            kind = type == "textStyle" ? .textStyle : .highlight
        case "subscript", "superscript":
            guard Set(raw.keys) == ["type"] else { return nil }
            kind = type == "subscript" ? .subscript : .superscript
        default:
            guard allowUnknownRange, isReconstructibleUnknownMark(raw) else { return nil }
            return NativeTabDocInlineMark(
                kind: .unknown,
                rawNode: raw.mapValues(AnyCodable.init)
            )
        }
        var canonical = raw
        canonical["type"] = kind.rawValue
        return NativeTabDocInlineMark(kind: kind, rawNode: canonical.mapValues(AnyCodable.init))
    }

    /// 只放行能完整重建的未知 mark：type 非空，attrs 若存在必须是非空对象。
    private static func isReconstructibleUnknownMark(_ raw: [String: Any]) -> Bool {
        guard Set(raw.keys).isSubset(of: ["type", "attrs"]),
              let type = raw["type"] as? String,
              !type.isEmpty
        else { return false }
        guard let attrs = raw["attrs"] else { return true }
        guard let object = attrs as? [String: Any], !object.isEmpty else { return false }
        return true
    }

    private static func parseCodeText(_ rawContent: Any?) -> String? {
        guard let rawContent else { return "" }
        guard let children = rawContent as? [[String: Any]] else { return nil }
        guard children.allSatisfy({
            $0["type"] as? String == "text"
                && $0["text"] is String
                && $0["marks"] == nil
                && Set($0.keys).isSubset(of: ["type", "text"])
        }) else { return nil }
        return children.compactMap { $0["text"] as? String }.joined()
    }

    private static func unsupported(_ raw: [String: Any], type: String) -> NativeTabDocBlock {
        NativeTabDocBlock(
            kind: .unsupported(type: type),
            rawNode: raw.mapValues(AnyCodable.init)
        )
    }

    private static func markdown(for block: NativeTabDocBlock) -> String? {
        switch block.kind {
        case .paragraph:
            return renderInline(block.spans)
        case .heading(let level):
            return "\(String(repeating: "#", count: level)) \(renderInline(block.spans))"
        case .bulletList, .orderedList, .taskList:
            return markdown(forListItems: block.listItems, kind: block.kind, indent: 0)
        case .blockquote:
            return block.text.components(separatedBy: .newlines).map { "> \($0)" }.joined(separator: "\n")
        case .codeBlock:
            return "```\n\(block.text)\n```"
        case .image:
            guard let image = block.image else { return nil }
            let source = image.fileId.flatMap { $0.isEmpty ? nil : "tabtin-file://asset/\($0)" }
                ?? image.source
            return "![\(image.alt)](\(source))"
        case .table:
            guard let table = block.table, let first = table.rows.first else { return nil }
            var lines = table.rows.map { "| \($0.cells.map { renderInline($0.spans) }.joined(separator: " | ")) |" }
            lines.insert("| \(first.cells.map { _ in "---" }.joined(separator: " | ")) |", at: 1)
            return lines.joined(separator: "\n")
        case .divider:
            return "---"
        case .unsupported:
            return nil
        }
    }

    private static func markdown(
        forListItems items: [NativeTabDocListItem],
        kind: NativeTabDocBlockKind,
        indent: Int
    ) -> String {
        let prefix = String(repeating: "  ", count: indent)
        return items.enumerated().map { index, item in
            let line: String
            switch kind {
            case .orderedList(let start):
                line = "\(prefix)\(start + index). \(renderInline(item.spans))"
            case .taskList:
                line = "\(prefix)- [\(item.isChecked ? "x" : " ")] \(renderInline(item.spans))"
            default:
                line = "\(prefix)- \(renderInline(item.spans))"
            }
            guard let nested = item.nested else { return line }
            let nestedMarkdown = markdown(
                forListItems: nested.items,
                kind: nested.kind,
                indent: indent + 1
            )
            return nestedMarkdown.isEmpty ? line : "\(line)\n\(nestedMarkdown)"
        }.joined(separator: "\n")
    }

    private static func renderInline(_ spans: [NativeTabDocInlineSpan]) -> String {
        spans.map { span in
            var value = span.text
            for mark in span.marks {
                switch mark.kind {
                case .bold: value = "**\(value)**"
                case .italic: value = "*\(value)*"
                case .underline: break
                case .strike: value = "~~\(value)~~"
                case .code: value = "`\(value)`"
                case .link:
                    if let href = mark.linkHref { value = "[\(value)](\(href))" }
                case .textStyle, .highlight, .subscript, .superscript, .unknown:
                    break
                }
            }
            return value
        }.joined()
    }

    private static func parseMarkdown(_ markdown: String) -> [NativeTabDocBlock] {
        markdown
            .components(separatedBy: "\n\n")
            .compactMap { paragraph -> NativeTabDocBlock? in
                let trimmed = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return nil }
                if let heading = heading(from: trimmed) {
                    return NativeTabDocBlock(kind: .heading(level: heading.level), text: heading.text)
                }
                if trimmed.hasPrefix("> ") {
                    return NativeTabDocBlock(kind: .blockquote, text: String(trimmed.dropFirst(2)))
                }
                return NativeTabDocBlock(kind: .paragraph, text: trimmed)
            }
    }

    private static func heading(from text: String) -> (level: Int, text: String)? {
        let hashes = text.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), text.dropFirst(hashes).first == " " else { return nil }
        return (hashes, String(text.dropFirst(hashes + 1)))
    }
}

struct NativeTabDocDraft: Codable, Equatable, Sendable {
    let title: String
    let body: NativeTabDocBody
    let baseVersion: Int?
    let baseUpdatedAt: String?
}

struct NativeTabDocDraftStore {
    private let store: UserDefaults
    private static let prefix = "native_tabdoc_draft_v1"

    init(store: UserDefaults = .standard) {
        self.store = store
    }

    func save(_ draft: NativeTabDocDraft, documentId: String, userId: String, organizationId: String) throws {
        store.set(try JSONEncoder().encode(draft), forKey: key(documentId, userId, organizationId))
    }

    func load(documentId: String, userId: String, organizationId: String) -> NativeTabDocDraft? {
        guard let data = store.data(forKey: key(documentId, userId, organizationId)) else { return nil }
        return try? JSONDecoder().decode(NativeTabDocDraft.self, from: data)
    }

    func remove(documentId: String, userId: String, organizationId: String) {
        store.removeObject(forKey: key(documentId, userId, organizationId))
    }

    func removeAll() {
        for key in store.dictionaryRepresentation().keys
        where key.hasPrefix("\(Self.prefix).") || key.hasPrefix("\(Self.prefix)_") {
            store.removeObject(forKey: key)
        }
    }

    private func key(_ documentId: String, _ userId: String, _ organizationId: String) -> String {
        Self.storageKey(
            prefix: Self.prefix,
            userId: userId,
            organizationId: organizationId,
            resourceId: documentId
        )
    }

    private static func storageKey(
        prefix: String,
        userId: String,
        organizationId: String,
        resourceId: String
    ) -> String {
        let identity = [userId, organizationId, resourceId].map { component in
            Data(component.utf8)
                .base64EncodedString()
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "=", with: "")
        }
        return ([prefix] + identity).joined(separator: ".")
    }
}

enum NativeTabDocSaveFailure: Equatable, Sendable {
    case conflict
    case permissionDenied
    case resourceUnavailable
    case retryable
    case terminal
}

enum NativeTabDocSaveFailurePolicy {
    static func resolve(_ error: Error) -> NativeTabDocSaveFailure {
        if case APIError.serverError(let status, _) = error {
            if status == 409 { return .conflict }
            if status == 403 { return .permissionDenied }
            if status == 404 { return .resourceUnavailable }
            if (400..<500).contains(status) { return .terminal }
        }
        return .retryable
    }

    static func requiresDetailRevalidationAfterWriteFailure(_ error: Error) -> Bool {
        let failure = resolve(error)
        return failure == .permissionDenied || failure == .resourceUnavailable
    }

    static func mustPurgeLocalDraftAfterReadFailure(_ error: Error) -> Bool {
        requiresDetailRevalidationAfterWriteFailure(error)
    }
}

enum NativeTabDocConflictRebasePolicy {
    /// 409 后只允许把“服务端补齐节点身份或 schema 缺省属性”的版本推进视为当前会话回声。
    /// 标题、节点顺序、文本、格式、非默认属性以及所有未知字段仍严格比较。
    static func remoteMatchesCommittedSnapshot(
        remoteTitle: String,
        remoteBody: NativeTabDocBody,
        committedTitle: String,
        committedBody: NativeTabDocBody
    ) -> Bool {
        remoteTitle == committedTitle
            && normalize(remoteBody.serializedJSON.mapValues(\.value))
                == normalize(committedBody.serializedJSON.mapValues(\.value))
    }

    private indirect enum NormalizedJSON: Equatable {
        case null
        case boolean(Bool)
        case integer(Int)
        case decimal(Double)
        case string(String)
        case array([NormalizedJSON])
        case object([String: NormalizedJSON])
        case unsupported(String)
    }

    private static func normalize(_ value: Any) -> NormalizedJSON {
        if let dictionary = value as? [String: Any] {
            var normalized: [String: NormalizedJSON] = [:]
            let nodeType = dictionary["type"] as? String
            for (key, nested) in dictionary where key != generatedBlockIdKey {
                if key == attributesKey, let attributes = nested as? [String: Any] {
                    let normalizedAttributes = normalizeAttributes(attributes, nodeType: nodeType)
                    if normalizedAttributes.isEmpty { continue }
                    normalized[key] = .object(normalizedAttributes)
                    continue
                }
                let normalizedNested = normalize(nested)
                if key == attributesKey, normalizedNested == .object([:]) {
                    continue
                }
                normalized[key] = normalizedNested
            }
            return .object(normalized)
        }
        if let array = value as? [Any] {
            return .array(array.map(normalize))
        }
        if value is NSNull { return .null }
        if let boolean = value as? Bool { return .boolean(boolean) }
        if let integer = value as? Int { return .integer(integer) }
        if let decimal = value as? Double { return .decimal(decimal) }
        if let string = value as? String { return .string(string) }
        return .unsupported(String(describing: value))
    }

    private static func normalizeAttributes(
        _ attributes: [String: Any],
        nodeType: String?
    ) -> [String: NormalizedJSON] {
        var normalized: [String: NormalizedJSON] = [:]
        for (key, value) in attributes where key != generatedBlockIdKey {
            if isKnownSchemaDefault(key: key, value: value, nodeType: nodeType) { continue }
            normalized[key] = normalize(value)
        }
        return normalized
    }

    /// 协作层的 ProseMirror schema 会把缺省属性显式写回 JSON。这里只忽略 schema
    /// 明确定义的默认值；同名属性一旦带非默认值，仍按真实内容变化处理。
    private static func isKnownSchemaDefault(
        key: String,
        value: Any,
        nodeType: String?
    ) -> Bool {
        switch nodeType {
        case "paragraph", "heading":
            return key == "textAlign" && value is NSNull
        case "codeBlock":
            return key == "language" && value is NSNull
        case "taskItem":
            return key == "todoId" && value is NSNull
        case "tableCell", "tableHeader":
            if key == "colwidth" { return value is NSNull }
            if key == "colspan" || key == "rowspan" { return integer(value) == 1 }
            return false
        case "image":
            return ["fileId", "alt", "title", "width", "height"].contains(key)
                && value is NSNull
        default:
            return false
        }
    }

    private static func integer(_ value: Any) -> Int? {
        if value is Bool { return nil }
        if let integer = value as? Int { return integer }
        if let number = value as? NSNumber {
            let double = number.doubleValue
            return double.rounded() == double ? Int(double) : nil
        }
        return nil
    }

    private static let generatedBlockIdKey = "blockId"
    private static let attributesKey = "attrs"
}

enum NativeTabDocDraftBaselineResolution: Equatable, Sendable {
    case resume(version: Int?, updatedAt: String?)
    case conflict(version: Int?, updatedAt: String?)
}

enum NativeTabDocDraftBaselinePolicy {
    static func resolve(
        draftVersion: Int?,
        draftUpdatedAt: String?,
        remoteVersion: Int?,
        remoteUpdatedAt: String?
    ) -> NativeTabDocDraftBaselineResolution {
        let versionChanged = draftVersion != nil && remoteVersion != nil && draftVersion != remoteVersion
        let timestampChanged = draftVersion == nil
            && remoteVersion == nil
            && draftUpdatedAt != nil
            && remoteUpdatedAt != nil
            && draftUpdatedAt != remoteUpdatedAt
        let baseline: NativeTabDocDraftBaselineResolution = versionChanged || timestampChanged
            ? .conflict(version: draftVersion, updatedAt: draftUpdatedAt)
            : .resume(version: draftVersion ?? remoteVersion, updatedAt: draftUpdatedAt ?? remoteUpdatedAt)
        return baseline
    }
}

enum NativeTabDocEditPolicy {
    /// 原生保存会逐块序列化：无法表达的块用 rawNode 原样写回，支持块仍可编辑。
    /// 只有 root content 无法拆成块，或整篇没有任何安全块时才 fail closed；空文档
    /// 仍允许从原生页开始编辑。与 Android 的逐块只读契约保持一致。
    static func allowsWholeDocumentEdit(_ body: NativeTabDocBody) -> Bool {
        guard body.preservedRootContent == nil else { return false }
        return body.blocks.isEmpty || body.blocks.contains { $0.kind.isSupported }
    }
}

enum NativeTabDocLocalDraftRecoveryPolicy {
    /// 云端身份和版本尚未核验时，只允许暴露已持久化草稿的只读副本。
    static func canView(documentLoaded: Bool, hasLocalDraft: Bool) -> Bool {
        !documentLoaded && hasLocalDraft
    }
}

enum NativeTabDocFullEditorPreparation: Equatable, Sendable {
    case open
    case saveFirst
    case confirmDiscard
}

enum NativeTabDocFullEditorPolicy {
    static func preparation(
        isDirty: Bool,
        saveState: NativeTabDocSaveState
    ) -> NativeTabDocFullEditorPreparation {
        guard isDirty else { return .open }
        switch saveState {
        case .conflict, .permissionDenied:
            return .confirmDiscard
        default:
            return .saveFirst
        }
    }
}
