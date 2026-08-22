import Foundation

/// 会话角色。后端 role 字符串收敛为三类；未知值并入 system（兜底渲染）。
enum ChatRole: String, Sendable {
    case user
    case assistant
    case system
}

/// 思考段。**身份 = messageId + content_block index 复合键**：agentic 多 message 子轮里
/// content_block index 会从 0 重置，单凭 index 会跨子轮撞号——必须带 messageId 区分。
struct ThinkingSegment: Identifiable, Hashable, Sendable {
    var messageId: String? = nil
    let index: Int
    var text: String
    var completed: Bool
    /// 本机首次收到该 thinking block 的时间。wire 暂无 block timestamp，因此只作为
    /// 客户端过程反馈与耗时展示；历史消息没有可靠时间时保持 nil，不伪造时长。
    var startedAt: Date? = nil
    /// 收到 content_block_stop / message_stop / stream done 的本机时间。
    var stoppedAt: Date? = nil
    var id: String { "think_\(messageId ?? "_")_\(index)" }

    var elapsedSeconds: TimeInterval? {
        guard let startedAt, let stoppedAt else { return nil }
        return max(0, stoppedAt.timeIntervalSince(startedAt))
    }
}

/// 工具调用块。input_json 为累积的 input_json_delta；finalized 对应 content_block_stop。
/// toolCallId 全局唯一，直接作身份（无需 messageId 复合）。
enum ToolExecutionPhase: String, Hashable, Sendable {
    /// 工具参数仍在生成，尚未收到 runtime 的 tool_started。
    case preparing
    case running
    case succeeded
    case failed

    var isRunning: Bool { self == .preparing || self == .running }
    var isTerminal: Bool { self == .succeeded || self == .failed }
}

enum ToolApprovalSource: String, Hashable, Sendable {
    case user
    case standingRule
}

struct ToolCall: Identifiable, Hashable, Sendable {
    let toolCallId: String
    let index: Int
    var name: String
    var inputJson: String
    var finalized: Bool
    /// 工具执行结果文本（tool_result 回填，按 toolCallId 配对）。nil 表示尚未返回 / 未回填。
    var resultText: String? = nil
    /// 执行是否失败（tool_result.is_error）。
    var isError: Bool = false
    /// runtime 工具执行相位。nil 仅用于旧历史数据，按 finalized/result 兼容推断。
    var executionPhase: ToolExecutionPhase? = nil
    /// 长任务的最新输出快照；tool_progress 覆盖，ssh_output 按增量追加。
    var progressText: String? = nil
    var progressOutputBytes: Int? = nil
    var progressIsTruncated: Bool = false
    var durationMs: Int? = nil
    /// Runtime 输出扫描命中可疑内容时保持为 true，终态/历史覆盖不得降级。
    var hasSuspiciousOutput: Bool = false
    /// 本次工具执行是用户当场批准或命中“始终允许”规则。
    var approvalSource: ToolApprovalSource? = nil
    var errorKind: String? = nil
    /// step / monitor 等 runtime 元事件投影为工具行时使用原始可读标题。
    var runtimeTitle: String? = nil
    var taskId: String? = nil
    /// tool_result / lifecycle notice 的 presentation.kind；文生图为 `media_image_generation`。
    var presentationKind: String? = nil
    /// presentation.data.prompt（截断预览，可空）。
    var presentationPrompt: String? = nil
    var id: String { toolCallId }
    /// 是否已有可展示的结果（用于决定工具卡是否可展开看输出）。
    var hasResult: Bool { resultText?.isEmpty == false }

    var isMediaImageGeneration: Bool {
        presentationKind == "media_image_generation"
    }

    var resolvedExecutionPhase: ToolExecutionPhase {
        if let executionPhase { return executionPhase }
        if isError { return .failed }
        if hasResult { return .succeeded }
        return finalized ? .succeeded : .preparing
    }

    var isExecutionRunning: Bool { resolvedExecutionPhase.isRunning }
    var hasLiveOutput: Bool { progressText?.isEmpty == false }

    /// 运行中优先展示实时快照；终态优先展示最终 tool_result。
    var visibleOutputText: String? {
        if isExecutionRunning, let progressText, !progressText.isEmpty {
            return progressText
        }
        if let resultText, !resultText.isEmpty {
            return resultText
        }
        return progressText?.isEmpty == false ? progressText : nil
    }
}

/// 正文块。每个 text content_block 独立成段，不再把整轮正文拼成一坨。
/// 同思考段：身份 = messageId + index 复合键，避免跨子轮撞号。
struct TextBlock: Identifiable, Hashable, Sendable {
    var messageId: String? = nil
    let index: Int
    var text: String
    var citations: [Citation] = []
    var id: String { "text_\(messageId ?? "_")_\(index)" }
}

struct AttachmentBlock: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable {
        case image
        case file
    }

    var messageId: String? = nil
    let index: Int
    let kind: Kind
    let filename: String
    let mimeType: String?
    let size: Int64?
    let url: String?
    let fileId: String?

    var id: String { "attachment_\(messageId ?? "_")_\(index)_\(fileId ?? filename)" }
}

enum RichTableValue: Codable, Hashable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([RichTableValue])
    case object([String: RichTableValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([RichTableValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: RichTableValue].self) {
            self = .object(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    static func fromAny(_ value: Any?) -> RichTableValue {
        switch value {
        case .none, .some(_ as NSNull):
            return .null
        case let value as Bool:
            return .bool(value)
        case let value as Int:
            return .int(value)
        case let value as Int64:
            return .int(Int(value))
        case let value as Double:
            return .double(value)
        case let value as NSNumber:
            return .double(value.doubleValue)
        case let value as String:
            return .string(value)
        case let value as [Any]:
            return .array(value.map(Self.fromAny))
        case let value as [String: Any]:
            return .object(value.mapValues(Self.fromAny))
        default:
            return .string(String(describing: value ?? ""))
        }
    }

    var displayText: String {
        switch self {
        case .string(let value):
            return value
        case .int(let value):
            return String(value)
        case .double(let value):
            return value == value.rounded() ? String(format: "%.0f", value) : String(value)
        case .bool(let value):
            return value ? "✓" : "✗"
        case .array(let values):
            return values.map(\.displayText).filter { !$0.isEmpty }.joined(separator: ", ")
        case .object(let object):
            if let label = object["label"]?.displayText, !label.isEmpty { return label }
            if let value = object["value"]?.displayText, !value.isEmpty { return value }
            return jsonLikeString
        case .null:
            return ""
        }
    }

    private var jsonLikeString: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(self),
              let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text.count > 80 ? String(text.prefix(80)) + "…" : text
    }
}

struct RichTableColumn: Codable, Hashable, Sendable {
    let key: String
    let label: String
}

struct RichTableSchema: Codable, Hashable, Sendable {
    let columns: [RichTableColumn]
    let rows: [[String: RichTableValue]]

    var displayRows: [[String]] {
        guard !columns.isEmpty else { return [] }
        var matrix = [columns.map(\.label)]
        matrix.append(contentsOf: rows.map { row in
            columns.map { row[$0.key]?.displayText ?? "" }
        })
        return matrix
    }

    func markdownTable(rowLimit: Int? = nil) -> String {
        let matrix: [[String]]
        if let rowLimit {
            let all = displayRows
            matrix = all.isEmpty ? [] : [all[0]] + Array(all.dropFirst().prefix(rowLimit))
        } else {
            matrix = displayRows
        }
        guard let header = matrix.first else { return "" }
        var lines: [String] = []
        lines.append("| " + header.map(Self.markdownCellSafe).joined(separator: " | ") + " |")
        lines.append("| " + header.map { _ in "---" }.joined(separator: " | ") + " |")
        for row in matrix.dropFirst() {
            let padded = (0..<header.count).map { index -> String in
                guard index < row.count else { return "" }
                return Self.markdownCellSafe(row[index])
            }
            lines.append("| " + padded.joined(separator: " | ") + " |")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    static func fromPayload(_ payload: [String: Any]?) -> RichTableSchema? {
        guard let payload else { return nil }
        if let rows = payload["rows"] as? [[String: Any]], !rows.isEmpty {
            let columns = parseColumns(payload["columns"], fallbackRows: rows)
            return build(columns: columns, rows: rows)
        }
        if let rows = payload["records"] as? [[String: Any]], !rows.isEmpty {
            let columns = parseColumns(payload["columns"], fallbackRows: rows)
            return build(columns: columns, rows: rows)
        }
        if let rows = payload["rows"] as? [[Any]], !rows.isEmpty {
            return buildArrayRows(columnsValue: payload["columns"], rows: rows)
        }
        if let rows = payload["data"] as? [[Any]], !rows.isEmpty {
            return buildArrayRows(columnsValue: payload["columns"], rows: rows)
        }
        return nil
    }

    private static func build(columns: [RichTableColumn], rows: [[String: Any]]) -> RichTableSchema? {
        guard !columns.isEmpty else { return nil }
        return RichTableSchema(
            columns: columns,
            rows: rows.map { row in
                row.reduce(into: [String: RichTableValue]()) { acc, pair in
                    acc[pair.key] = RichTableValue.fromAny(pair.value)
                }
            }
        )
    }

    private static func buildArrayRows(columnsValue: Any?, rows: [[Any]]) -> RichTableSchema? {
        guard !rows.isEmpty else { return nil }
        let maxColumns = rows.map(\.count).max() ?? 0
        let labels = parseArrayColumnLabels(columnsValue, maxColumns: maxColumns)
        let columns = labels.enumerated().map { index, label in
            RichTableColumn(key: String(index), label: label)
        }
        return RichTableSchema(
            columns: columns,
            rows: rows.map { row in
                row.enumerated().reduce(into: [String: RichTableValue]()) { acc, pair in
                    acc[String(pair.offset)] = RichTableValue.fromAny(pair.element)
                }
            }
        )
    }

    private static func parseColumns(_ value: Any?, fallbackRows: [[String: Any]]) -> [RichTableColumn] {
        if let columns = value as? [[String: Any]], !columns.isEmpty {
            return columns.compactMap { column in
                let key = stringValue(column["key"])
                    ?? stringValue(column["id"])
                    ?? stringValue(column["name"])
                guard let key, !key.isEmpty else { return nil }
                let label = stringValue(column["label"])
                    ?? stringValue(column["title"])
                    ?? stringValue(column["name"])
                    ?? key
                return RichTableColumn(key: key, label: label)
            }
        }
        if let columns = value as? [String], !columns.isEmpty {
            return columns.map { RichTableColumn(key: $0, label: $0) }
        }
        let keys = Array(fallbackRows.flatMap(\.keys)).reduce(into: [String]()) { acc, key in
            if !acc.contains(key) { acc.append(key) }
        }
        return keys.map { RichTableColumn(key: $0, label: $0) }
    }

    private static func parseArrayColumnLabels(_ value: Any?, maxColumns: Int) -> [String] {
        if let columns = value as? [[String: Any]], !columns.isEmpty {
            let labels = columns.map { column in
                stringValue(column["label"])
                    ?? stringValue(column["title"])
                    ?? stringValue(column["name"])
                    ?? stringValue(column["key"])
                    ?? ""
            }
            if !labels.allSatisfy(\.isEmpty) { return labels }
        }
        if let columns = value as? [String], !columns.isEmpty {
            return columns
        }
        return (0..<maxColumns).map { "Column \($0 + 1)" }
    }

    private static func stringValue(_ value: Any?) -> String? {
        switch value {
        case let string as String:
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }

    private static func markdownCellSafe(_ value: String) -> String {
        value
            .replacingOccurrences(of: "|", with: "\\|")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
    }
}

/// `search_results` 富内容的单条结果。字段与 Electron `RichSearchResults`
/// 消费的协议保持一致，避免 iOS 把搜索产物降级成含糊的“富内容”兜底卡。
struct RichSearchResult: Codable, Hashable, Sendable {
    let title: String?
    let url: String?
    let snippet: String?
    let score: Double?
    let contentType: String?
    let filePath: String?
    let source: String?
    let favicon: String?

    static func fromPayload(_ value: Any?) -> [RichSearchResult] {
        guard let items = value as? [Any] else { return [] }
        return items.compactMap { item in
            guard let object = item as? [String: Any] else { return nil }
            return RichSearchResult(
                title: stringValue(object["title"]),
                url: stringValue(object["url"]),
                snippet: stringValue(object["snippet"]),
                score: doubleValue(object["score"]),
                contentType: stringValue(object["content_type"]),
                filePath: stringValue(object["file_path"]),
                source: stringValue(object["source"]),
                favicon: stringValue(object["favicon"])
            )
        }
    }

    private static func stringValue(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        let candidate: Double?
        switch value {
        case let number as NSNumber: candidate = number.doubleValue
        case let number as Double: candidate = number
        case let number as Int: candidate = Double(number)
        case let string as String: candidate = Double(string)
        default: candidate = nil
        }
        guard let candidate, candidate.isFinite else { return nil }
        return candidate
    }
}

struct RichContentBlock: Identifiable, Hashable, Sendable {
    var messageId: String? = nil
    let index: Int
    let kind: String
    let summary: String
    let title: String?
    let groupId: String?
    let tableRows: [[String]]
    let tableSchema: RichTableSchema?
    let footer: String?
    let resourceType: String?
    let resourceName: String?
    let resourceId: String?
    let spaceName: String?
    let url: String?
    let filename: String?
    let mimeType: String?
    let fileSize: Int64?
    let totalRows: Int?
    let widgetId: String?
    let format: String?
    let sourceCode: String?
    let mermaidSource: String?
    let query: String?
    let searchResults: [RichSearchResult]
    let totalCount: Int?
    /// 正式 OSS 资产的稳定身份。展示地址必须按需刷新，不能把资源 URI 当网络 URL。
    var fileId: String? = nil
    var sourceToolUseId: String? = nil
    var artifactKind: String? = nil
    var relativePath: String? = nil

    var id: String { "rich_\(messageId ?? "_")_\(index)_\(groupId ?? kind)" }
}

enum MediaImageArtifactDedup {
    static func shouldSuppressPreview(tool: ToolCall, formalToolUseIds: Set<String>) -> Bool {
        tool.isMediaImageGeneration && formalToolUseIds.contains(tool.toolCallId)
    }
}

struct FormalOssImageAsset: Equatable, Sendable {
    let fileId: String
    let fallbackURL: String?

    static func from(kind: String, payload: [String: Any]?) -> FormalOssImageAsset? {
        guard kind == "image",
              let payload,
              payload["artifact_kind"] as? String == "oss_file",
              let fileId = ((payload["file_id"] as? String) ?? (payload["fileId"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !fileId.isEmpty else { return nil }

        let fallbackURL = [
            "resolved_url", "access_url", "cdn_url", "image_url",
            "file_url", "remote_url", "url",
        ].compactMap { payload[$0] as? String }
            .first(where: Self.isHTTPURL)
        return FormalOssImageAsset(fileId: fileId, fallbackURL: fallbackURL)
    }

    static func isHTTPURL(_ raw: String) -> Bool {
        guard let scheme = URLComponents(string: raw)?.scheme?.lowercased() else { return false }
        return scheme == "https" || scheme == "http"
    }
}

struct ContextRefBlock: Identifiable, Hashable, Sendable {
    var messageId: String? = nil
    let index: Int
    let type: String
    let resourceId: String?
    let url: String?
    let tableId: String?
    let docId: String?
    let rowIds: [String]
    let fieldIds: [String]
    let label: String
    let preview: String?
    let spaceId: String?
    let spaceName: String?
    let locationHint: String?

    var id: String {
        let locator = resourceId
            ?? tableId
            ?? docId
            ?? url
            ?? rowIds.first
            ?? fieldIds.first
            ?? label
        return "context_\(messageId ?? "_")_\(index)_\(locator)"
    }
}

/// 有序内容块时间轴的单元：text / thinking / tool 三类，统一按 content_block `index` 排序。
///
/// 取代旧「分桶」模型（text 拼一段 + thinking[] + toolCalls[] 固定顺序渲染）。
/// 真实流序（思考A→正文a→工具→思考B→正文b）由 index 还原，与 Electron / dev/ios BlockTimeline 一致。
enum MessageBlock: Identifiable, Hashable, Sendable {
    case text(TextBlock)
    case thinking(ThinkingSegment)
    case tool(ToolCall)
    case attachment(AttachmentBlock)
    case richContent(RichContentBlock)
    case contextRef(ContextRefBlock)

    /// content_block index，决定时间轴排序。
    var index: Int {
        switch self {
        case let .text(b): return b.index
        case let .thinking(s): return s.index
        case let .tool(t): return t.index
        case let .attachment(a): return a.index
        case let .richContent(r): return r.index
        case let .contextRef(c): return c.index
        }
    }

    /// ForEach 稳定且**全局唯一**的 id：text/thinking 用 messageId+index 复合键
    /// （见 TextBlock / ThinkingSegment.id），tool 用 toolCallId。
    /// 重复 id 会让 SwiftUI ForEach 行为未定义（重复渲染 / 布局抖动）——这是上一版的 bug 根因。
    var id: String {
        switch self {
        case let .text(b): return b.id
        case let .thinking(s): return s.id
        case let .tool(t): return "tool_\(t.toolCallId)"
        case let .attachment(a): return a.id
        case let .richContent(r): return r.id
        case let .contextRef(c): return c.id
        }
    }
}

/// 一条会话消息（视图模型态，非后端持久化 schema）。
///
/// 刻意精简：只承载移动端当前会渲染的字段（正文 / 思考 / 工具调用 / 流式态 / 错误），
/// 不复刻旧 ChatMessage 的富内容 / checkpoint / usage 等几十个字段——那些随对应渲染
/// 能力 Phase 增量补。`id` 为本地稳定 id（user=client_event_id，assistant=本地生成），
/// `serverId` / `persistedId` 在收到回执 / 落库事件后回填，供历史去重与后续重连对齐。
struct ChatMessage: Identifiable, Hashable, Sendable {
    let id: String
    var serverId: String?
    var persistedId: String?
    var clientEventId: String?
    var sourceClientEventId: String?
    let role: ChatRole
    /// 协议 `message_kind`（如 `compaction_summary`）。本地缓存可能为空，此时靠正文 marker 兜底。
    var messageKind: String?
    var senderUserId: String?
    var senderDisplayName: String?
    /// 本条 assistant 消息的实际执行 Agent。它是历史事实，不随会话下一轮默认 Agent 改写。
    var agentId: String?
    /// 有序内容块时间轴（**唯一真源**）：text / thinking / tool 按 content_block index 穿插。
    /// 直播（ConversationProjector）与历史（MessageHistoryMapper）都维护这一份有序序列，
    /// 渲染按真实流序还原（思考A→正文a→工具→思考B→正文b），与 Electron 一致。
    var blocks: [MessageBlock]
    var isStreaming: Bool
    var stopReason: String?
    var errorMessage: String?
    /// 非阻断 HITL inline 卡：Plan 草稿提案（用户点「执行」走 REST + 续聊）。
    var planProposal: PlanProposal?
    /// 非阻断 HITL inline 卡：模式切换提案（用户点「切到 Agent」走切模式 + 续聊）。
    var modeSwitchProposal: ModeSwitchProposal?
    /// inline 卡是否已被用户处理（执行 / 忽略）：处理后按钮收起，避免重复触发。
    var proposalResolved: Bool
    /// 后端 checkpoint 记录。用于显示可回滚 badge，并驱动 rewind preview。
    var checkpointRecord: ChatCheckpointRecord?
    /// Agent run id。未来资源级 rollback / revert history 可按 run 维度操作。
    var agentRunId: String?
    /// 子 Agent transcript 归属 id。主时间线应过滤非空值，避免子消息泄漏成父会话气泡。
    var subagentRunId: String?
    /// 错误分类/编码：billing、member limit 等阻断类 banner 使用。
    var errorCategory: String?
    var errorCode: String?
    var errorClass: String?
    var suggestedAction: String?
    /// 协议 `metadata.triggered_by`（如 `push-notification`）。本地缓存可能为空，靠正文兜底。
    var triggeredBy: String?
    let createdAt: Date

    /// 统一构造：优先用有序 `blocks`（时间轴路径）；否则把便利参数 text/thinking/toolCalls
    /// 折叠成 blocks（user/system 单段文本 + 简单测试场景）。两路不会同时给。
    init(
        id: String,
        serverId: String? = nil,
        persistedId: String? = nil,
        clientEventId: String? = nil,
        sourceClientEventId: String? = nil,
        role: ChatRole,
        messageKind: String? = nil,
        senderUserId: String? = nil,
        senderDisplayName: String? = nil,
        agentId: String? = nil,
        blocks: [MessageBlock] = [],
        text: String = "",
        thinking: [ThinkingSegment] = [],
        toolCalls: [ToolCall] = [],
        isStreaming: Bool = false,
        stopReason: String? = nil,
        errorMessage: String? = nil,
        planProposal: PlanProposal? = nil,
        modeSwitchProposal: ModeSwitchProposal? = nil,
        proposalResolved: Bool = false,
        checkpointRecord: ChatCheckpointRecord? = nil,
        agentRunId: String? = nil,
        subagentRunId: String? = nil,
        errorCategory: String? = nil,
        errorCode: String? = nil,
        errorClass: String? = nil,
        suggestedAction: String? = nil,
        triggeredBy: String? = nil,
        createdAt: Date = .now
    ) {
        if !blocks.isEmpty {
            self.blocks = blocks
        } else {
            var composed: [MessageBlock] = []
            if !text.isEmpty { composed.append(.text(TextBlock(index: 0, text: text))) }
            composed.append(contentsOf: thinking.map(MessageBlock.thinking))
            composed.append(contentsOf: toolCalls.map(MessageBlock.tool))
            self.blocks = composed
        }
        self.id = id
        self.serverId = serverId
        self.persistedId = persistedId
        self.clientEventId = clientEventId
        self.sourceClientEventId = sourceClientEventId
        self.role = role
        self.messageKind = messageKind
        self.senderUserId = senderUserId
        self.senderDisplayName = senderDisplayName
        self.agentId = agentId
        self.isStreaming = isStreaming
        self.stopReason = stopReason
        self.errorMessage = errorMessage
        self.planProposal = planProposal
        self.modeSwitchProposal = modeSwitchProposal
        self.proposalResolved = proposalResolved
        self.checkpointRecord = checkpointRecord
        self.agentRunId = agentRunId
        self.subagentRunId = subagentRunId
        self.errorCategory = errorCategory
        self.errorCode = errorCode
        self.errorClass = errorClass
        self.suggestedAction = suggestedAction
        self.triggeredBy = triggeredBy
        self.createdAt = createdAt
    }

    // MARK: - 派生视图（滚动信号 / 历史 / 单测断言）

    /// 全部正文块按时间轴拼接（user/system 即单段；assistant 为多段正文之和）。
    var text: String {
        blocks.reduce(into: "") { acc, b in if case let .text(t) = b { acc += t.text } }
    }
    /// 全部思考段（保持时间轴顺序）。
    var thinking: [ThinkingSegment] {
        blocks.compactMap { if case let .thinking(s) = $0 { return s } else { return nil } }
    }
    /// 全部工具调用块（保持时间轴顺序）。
    var toolCalls: [ToolCall] {
        blocks.compactMap { if case let .tool(t) = $0 { return t } else { return nil } }
    }

    var isUser: Bool { role == .user }
    var isAssistant: Bool { role == .assistant }
    var isSystem: Bool { role == .system }
    /// Agent 切换事实会保留在服务端历史中供审计，但当前身份已经由消息头像和
    /// Composer 展示，不应再作为重复的系统胶囊占用聊天时间线。
    var isRedundantAgentSwitchNotice: Bool {
        guard isSystem else { return false }
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return content == "切换当前 Agent" || content.hasPrefix("Agent 已切换成")
    }
    var isSubagentTranscript: Bool { !(subagentRunId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
    /// Runtime 注入的内部 user-role 上下文——LLM history 保留，但用户不应在聊天流里
    /// 看到自己“发送”了这些内容。`ChatMessage` 不持久化 `message_kind`，因此本地缓存
    /// 用内容特征兜底；网络历史和 live event 会优先使用协议字段过滤。
    ///
    /// 压缩检查点（`compaction_summary`）**不是**内部上下文：要进时间线，但以 pill
    /// 展示（见 `isCompactionSummary`），禁止当用户气泡渲染摘要正文。
    var isInternalContext: Bool {
        InternalUserContextVisibility.isHidden(messageKind: messageKind, text: nil)
            || ((isUser || isSystem) && InternalUserContextVisibility.isHidden(text: text))
    }
    /// 对齐 Electron `isPushNotificationMessage`：后台任务完成唤起下一轮的伪用户消息。
    var isPushNotification: Bool {
        (isUser || isSystem) && PushNotificationVisibility.isPushNotification(triggeredBy: triggeredBy, text: text)
    }
    /// 纯子代理完成通知：桌面 fold 进聚合卡，主时间线整条抑制。
    var shouldHidePushNotification: Bool {
        (isUser || isSystem) && PushNotificationVisibility.shouldHideFromTimeline(triggeredBy: triggeredBy, text: text)
    }
    /// 对齐 Electron `isCompactionSummaryPresentation`：居中 History pill，不渲染摘要正文。
    var isCompactionSummary: Bool {
        CompactionSummaryPresentation.isPresentation(messageKind: messageKind, text: text)
    }
    /// 历史去重 / 重连对齐用的有效 id：落库 id 优先，其次服务端回执 id，最后本地 id。
    var effectiveId: String { persistedId ?? serverId ?? id }
    var canonicalClientEventId: String? {
        firstNonBlank(
            clientEventId,
            isUser && serverId == nil && persistedId == nil ? id : nil
        )
    }
    var identityKeys: Set<String> {
        Set([id, serverId, persistedId, effectiveId, canonicalClientEventId].compactMap {
            guard let value = $0?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        })
    }

    private func firstNonBlank(_ values: String?...) -> String? {
        values.first {
            guard let value = $0?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            return !value.isEmpty
        } ?? nil
    }
}

/// 对用户隐藏、但仍参与 Runtime 历史的内部 user-role 上下文。
///
/// `message_kind` 是主契约；文本前缀仅用于修复已经被旧 Django relay 降级为 `llm`
/// 的存量记录，以及没有保存 message_kind 的本地缓存。
///
/// 压缩检查点不在此列——见 `CompactionSummaryPresentation`（进时间线、pill 展示）。
enum InternalUserContextVisibility {
    private static let hiddenKinds: Set<String> = [
        "environment_context",
        "agent_profile_context",
        "system_prompt_context",
        "external_archive_context",
    ]

    private static let hiddenPrefixes = [
        "<context type=\"environment\"",
        "<context type='environment'",
        "<context type=\"agent-profile\"",
        "<context type='agent-profile'",
        "<context type=\"external-archive\"",
        "<context type='external-archive'",
        "<identity",
    ]

    static func isHidden(
        messageKind: String? = nil,
        text: String?,
        isShareBriefing: Bool = false,
        isShareContract: Bool = false
    ) -> Bool {
        if isShareBriefing || isShareContract {
            return true
        }
        if let messageKind, hiddenKinds.contains(messageKind) {
            return true
        }
        guard let text else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return hiddenPrefixes.contains(where: { trimmed.hasPrefix($0) })
    }
}

/// 对齐 Electron `PushNotificationBubble` / `parsePushNotification`：
/// 后台 shell / 子 Agent 完成注入的 user-role 消息，对用户应显示为系统通知卡，
/// 绝不能当「我发的」气泡。纯子代理完成按桌面 fold 策略从主时间线抑制。
enum PushNotificationVisibility {
    static let triggeredByValue = "push-notification"

    enum Outcome: Equatable {
        case success
        case stopped
        case failed
    }

    struct ParsedTask: Equatable {
        enum Kind: Equatable { case shell, subagent }
        var kind: Kind
        var title: String
        var description: String?
        var outcome: Outcome
        var killedReason: String?
        var status: String?
    }

    struct Parsed: Equatable {
        var tasks: [ParsedTask]
        var shellCount: Int
        var subagentCount: Int
        var failedCount: Int
    }

    static func isPushNotification(triggeredBy: String?, text: String?) -> Bool {
        if triggeredBy == triggeredByValue { return true }
        guard let text else { return false }
        return text.contains("<task-notification")
    }

    static func shouldHideFromTimeline(triggeredBy: String?, text: String?) -> Bool {
        guard isPushNotification(triggeredBy: triggeredBy, text: text) else { return false }
        guard let parsed = parse(text) else { return false }
        return parsed.subagentCount > 0 && parsed.shellCount == 0
    }

    static func displaySummary(triggeredBy: String?, text: String?) -> String {
        if let parsed = parse(text) {
            return buildSummary(parsed)
        }
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "系统通知" : trimmed
    }

    static func parse(_ content: String?) -> Parsed? {
        guard let content, !content.isEmpty else { return nil }
        guard let blockRe = try? NSRegularExpression(
            pattern: #"<task-notification(\s+kind="([^"]*)")?\s*>([\s\S]*?)</task-notification>"#,
            options: []
        ) else { return nil }
        let fullRange = NSRange(content.startIndex..<content.endIndex, in: content)
        let matches = blockRe.matches(in: content, options: [], range: fullRange)
        var tasks: [ParsedTask] = []
        var shellCount = 0
        var subagentCount = 0
        var failedCount = 0
        for match in matches {
            let kindAttr: String = {
                guard match.numberOfRanges > 2,
                      match.range(at: 2).location != NSNotFound,
                      let range = Range(match.range(at: 2), in: content) else { return "" }
                return String(content[range])
            }()
            guard match.numberOfRanges > 3,
                  let innerRange = Range(match.range(at: 3), in: content) else { continue }
            let inner = String(content[innerRange])
            if kindAttr == "subagent-completed" {
                let label = extractTag(inner, "label") ?? ""
                let status = extractTag(inner, "status")
                let outcome = subagentOutcome(status)
                tasks.append(ParsedTask(
                    kind: .subagent,
                    title: label,
                    description: nil,
                    outcome: outcome,
                    killedReason: nil,
                    status: status
                ))
                subagentCount += 1
                if outcome == .failed { failedCount += 1 }
            } else {
                let command = extractTag(inner, "command") ?? ""
                let description = extractTag(inner, "description")
                let exitedBy = extractTag(inner, "exited-by")
                let killedReason = extractTag(inner, "killed-reason")
                let outcome = shellOutcome(exitedBy: exitedBy, killedReason: killedReason)
                tasks.append(ParsedTask(
                    kind: .shell,
                    title: command,
                    description: description,
                    outcome: outcome,
                    killedReason: killedReason,
                    status: nil
                ))
                shellCount += 1
                if outcome == .failed { failedCount += 1 }
            }
        }
        guard !tasks.isEmpty else { return nil }
        return Parsed(
            tasks: tasks,
            shellCount: shellCount,
            subagentCount: subagentCount,
            failedCount: failedCount
        )
    }

    static func buildSummary(_ parsed: Parsed) -> String {
        if parsed.tasks.count == 1, let task = parsed.tasks.first {
            if task.kind == .shell {
                let command = compactCommand(task.description ?? task.title)
                let label = command.isEmpty ? "后台命令" : command
                switch task.outcome {
                case .success: return "后台命令完成：\(label)"
                case .stopped: return "后台命令已停止：\(label)"
                case .failed:
                    if task.killedReason != nil {
                        return "后台命令已终止：\(label)"
                    }
                    return "后台命令失败：\(label)"
                }
            }
            let name = compactCommand(task.title)
            let label = name.isEmpty ? "子 Agent" : name
            switch task.outcome {
            case .success: return "子 Agent 完成：\(label)"
            case .stopped: return "子 Agent 已停止：\(label)"
            case .failed: return "子 Agent 异常结束：\(label)"
            }
        }
        if parsed.failedCount > 0 {
            return "\(parsed.tasks.count) 个后台任务完成（\(parsed.failedCount) 个异常）"
        }
        return "\(parsed.tasks.count) 个后台任务完成"
    }

    private static let neutralKilledReasons: Set<String> = ["kill_tool", "user_interrupt"]

    private static func shellOutcome(exitedBy: String?, killedReason: String?) -> Outcome {
        if let killedReason {
            return neutralKilledReasons.contains(killedReason) ? .stopped : .failed
        }
        if exitedBy == "exec_failure" || exitedBy == "signal" { return .failed }
        return .success
    }

    private static func subagentOutcome(_ status: String?) -> Outcome {
        if status == "completed" { return .success }
        if status == "cancelled" { return .stopped }
        return .failed
    }

    private static func extractTag(_ block: String, _ tag: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: "<\(tag)>([\\s\\S]*?)</\(tag)>",
            options: []
        ) else { return nil }
        let range = NSRange(block.startIndex..<block.endIndex, in: block)
        guard let match = regex.firstMatch(in: block, options: [], range: range),
              match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: block) else { return nil }
        return unescapeXml(String(block[valueRange]).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func unescapeXml(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func compactCommand(_ value: String, limit: Int = 48) -> String {
        let firstLine = value.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if firstLine.count > limit {
            return String(firstLine.prefix(limit - 1)) + "…"
        }
        return firstLine
    }
}

/// 对齐 Electron `compactionSummaryPresentation.ts`：压缩检查点以分隔 pill 展示，禁止摘要正文。
enum CompactionSummaryPresentation {
    /// 流式「正在压缩」占位行（非服务端消息）。
    static let inProgressMessageId = "__compaction_in_progress__"

    /// 与 agent-runtime `SUMMARY_HEADER` / `SUMMARY_FOOTER` 同文。
    private static let summaryHeaderMarker = "[对话摘要]"
    private static let summaryEndMarker = "[摘要结束]"

    static func isPresentation(messageKind: String?, text: String?) -> Bool {
        if messageKind == "compaction_summary" { return true }
        guard let text else { return false }
        return text.contains(summaryHeaderMarker) && text.contains(summaryEndMarker)
    }

    static func isInProgressPlaceholder(_ message: ChatMessage) -> Bool {
        message.id == inProgressMessageId
    }
}

// MARK: - 工具风险分级（移植自 tabtin-ios ToolRiskClassifier）

/// 工具风险级别：仅服务于「连续低风险工具折叠成组」的渲染策略，不直接着色 UI。
/// 紧凑 / 卡片的决策和图标、摘要共用 `ToolPresentation` 描述符，避免两份工具名清单
/// 随着后端别名增长而漂移。
enum ToolRiskClassifier {
    static func isLowRisk(_ toolName: String) -> Bool {
        ToolPresentation.of(toolName).timelineStyle == .compact
    }
}

// MARK: - 工具展示元数据（图标 / 动词 / 输入摘要）

/// 工具在会话时间线中的信息密度。只读观察和已由其它 block 呈现产物的调用使用
/// 无底色 step row；会产生副作用、需要确认或必须保留本行结果证据的调用保留卡片。
enum ToolTimelineStyle: Equatable, Sendable {
    case compact
    case card
}

/// 时间线工具行的状态词典。运行态由摘要文字自身的扫光表达，不再追加第二段
/// “正在调用 / 正在执行”；失败才保留一个明确结果。
enum ToolTimelineStatusPresentation {
    static func label(for phase: ToolExecutionPhase) -> String? {
        switch phase {
        case .preparing, .running: return nil
        case .failed: return "失败"
        case .succeeded: return nil
        }
    }

    static func usesShimmer(for phase: ToolExecutionPhase) -> Bool {
        phase.isRunning
    }
}

/// 时间线上工具行是否需要一段常驻警示。
///
/// 详情抽屉化后，安全护栏命中不再能靠「自动展开」表达——自动弹层会打断用户。
/// 改为：可疑输出与失败在时间线行上常驻可见的标记，用户自己决定何时点开抽屉复核。
enum ToolStepAlertPresentation {
    static func needsInlineAlert(for tool: ToolCall) -> Bool {
        tool.hasSuspiciousOutput || tool.isError
    }
}

/// 时间线「对象」槽从 input JSON 取什么。路径取 basename，命令取第一段，未知工具走 generic。
enum ToolTimelineDetailKind: Equatable, Sendable {
    case path
    case command
    case query
    case url
    case sql
    case generic
    case none
}

/// 抽屉里一条已人话的输入字段。
struct ToolInputRow: Equatable, Sendable {
    let label: String
    let value: String
}

/// 工具卡的「友好呈现」：按工具名归类出 Electron 注册表使用的 Lucide 图标名、
/// 本地化兜底动词，以及从 input JSON 提取摘要所需的字段。
struct ToolPresentation {
    /// Electron `toolCardRegistry` / `iconMap` 使用的 Lucide export 名。
    let icon: String
    let verb: String
    /// 从 input JSON 里按序尝试提取摘要的候选 key。
    let summaryKeys: [String]
    /// 注册表层面的默认视觉密度；运行时审批/可疑输出会在 `timelineStyle(for:)` 升级为卡片。
    let timelineStyle: ToolTimelineStyle
    let detailKind: ToolTimelineDetailKind
    /// 未知工具 / MCP 用原始名解析 server；已映射工具保持空串。
    let sourceName: String

    init(
        icon: String,
        verb: String,
        summaryKeys: [String],
        timelineStyle: ToolTimelineStyle = .card,
        detailKind: ToolTimelineDetailKind? = nil,
        sourceName: String = ""
    ) {
        self.icon = icon
        self.verb = verb
        self.summaryKeys = summaryKeys
        self.timelineStyle = timelineStyle
        self.detailKind = detailKind ?? Self.inferredDetailKind(for: summaryKeys)
        self.sourceName = sourceName
    }

    private static func inferredDetailKind(for summaryKeys: [String]) -> ToolTimelineDetailKind {
        if summaryKeys.isEmpty { return .none }
        if summaryKeys == pathKeys { return .path }
        if summaryKeys == cmdKeys { return .command }
        if summaryKeys == sqlKeys { return .sql }
        if summaryKeys == queryKeys { return .query }
        if summaryKeys == urlKeys { return .url }
        return .generic
    }

    private static let pathKeys = ["path", "file_path", "filePath", "filename", "file", "target_file"]
    private static let cmdKeys = ["command", "cmd", "script"]
    private static let queryKeys = ["query", "q", "search_term", "keyword"]
    private static let patternKeys = ["pattern", "regex", "glob"]
    private static let urlKeys = ["url", "uri", "link"]
    private static let sqlKeys = ["sql", "statement"]

    static func of(_ name: String) -> ToolPresentation {
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        switch normalized {
        // Electron: Terminal
        case "bash", "shell", "execute_command", "terminal_execute",
             "run_terminal_command", "execute_in_terminal", "exec_command",
             "write_stdin", "read_thread_terminal", "terminal_open", "terminal_write",
             "terminal_read", "terminal_list":
            return .init(icon: "Terminal", verb: L10n.Agent.toolExecuteCommand, summaryKeys: cmdKeys)
        // Electron: Server
        case "ssh_execute", "ssh":
            return .init(icon: "Server", verb: L10n.Agent.toolSSH, summaryKeys: cmdKeys)

        // Electron: FileText
        case "file_read", "read_file", "read", "document_read", "parse_document":
            return .init(icon: "FileText", verb: L10n.Agent.toolReadFile, summaryKeys: pathKeys, timelineStyle: .compact)
        case "file_write", "write_file", "create_file", "write":
            return .init(icon: "FileText", verb: L10n.Agent.toolWriteFile, summaryKeys: pathKeys)
        // Electron: FilePenLine
        case "file_edit", "apply_diff", "edit_file", "edit", "multiedit",
             "apply_patch", "str_replace":
            return .init(icon: "FilePenLine", verb: L10n.Agent.toolEditFile, summaryKeys: pathKeys)
        // Electron: FileX2
        case "file_delete", "delete_file":
            return .init(icon: "FileX2", verb: L10n.Agent.toolDeleteFile, summaryKeys: pathKeys)

        // Electron: Database
        case "execute_sql", "sql_execute", "sql_query", "table_query":
            return .init(icon: "Database", verb: L10n.Agent.toolQuery, summaryKeys: sqlKeys)
        // Electron: Search
        case "web_search", "search", "websearch":
            return .init(icon: "Search", verb: L10n.Agent.toolWebSearch, summaryKeys: queryKeys, timelineStyle: .compact)
        // Electron: Globe
        case "web_fetch", "fetch_url", "webfetch", "browse_url", "tabs_info":
            return .init(icon: "Globe", verb: L10n.Agent.toolFetchWeb, summaryKeys: urlKeys, timelineStyle: .compact)
        case "grep", "glob", "code_search", "semantic_search", "code_grep",
             "greptool", "globtool", "searchfiles", "code_glob",
             "code_semantic_search", "list_files", "skills_read", "skills_search",
             "rag_search", "memory_search":
            return .init(
                icon: "Search",
                verb: L10n.Agent.toolCodeSearch,
                summaryKeys: patternKeys + queryKeys + pathKeys,
                timelineStyle: .compact
            )

        // Electron: GitBranch / GitCompare
        case "git_status":
            return .init(icon: "GitBranch", verb: L10n.Agent.toolGitStatus, summaryKeys: pathKeys, timelineStyle: .compact)
        case "git_diff":
            return .init(icon: "GitCompare", verb: L10n.Agent.toolGitDiff, summaryKeys: pathKeys, timelineStyle: .compact)

        // Electron: CheckCircle2 / Bot / HelpCircle
        case "todo_read", "todo_write":
            return .init(icon: "CheckCircle2", verb: L10n.Agent.toolUpdateTodo, summaryKeys: [])
        case "task", "dispatch", "dispatch_agent", "delegate_task", "subagent",
             "subagent_run", "agent":
            return .init(icon: "Bot", verb: L10n.Agent.toolDispatchTask, summaryKeys: ["description", "prompt", "task"])
        case "ask_user", "ask_form", "request_approval":
            return .init(icon: "HelpCircle", verb: L10n.Agent.toolAskUser, summaryKeys: ["question", "prompt", "title"])

        // Electron: NotebookPen / Trash2
        case "memory_write":
            return .init(icon: "NotebookPen", verb: L10n.Agent.toolWriteMemory, summaryKeys: ["content", "text"])
        case "memory_delete":
            return .init(icon: "Trash2", verb: L10n.Agent.toolDeleteMemory, summaryKeys: ["memory_id", "id"])

        // Electron presentation descriptors.
        case "show_widget":
            return .init(icon: "LayoutTemplate", verb: L10n.Agent.toolShowWidget, summaryKeys: ["title", "name"], timelineStyle: .compact)
        case "present_to_user":
            return .init(icon: "Sparkles", verb: L10n.Agent.toolPresentResult, summaryKeys: ["title", "summary"], timelineStyle: .compact)

        default:
            if let device = devicePresentation(normalized) { return device }
            if let tabApp = tabAppPresentation(normalized) { return tabApp }
            if normalized.contains("record") || normalized.contains("table") {
                return .init(
                    icon: "Database",
                    verb: L10n.Agent.toolGeneric,
                    summaryKeys: ["table", "table_id", "record_id"],
                    sourceName: normalized
                )
            }
            return .init(
                icon: "Wrench",
                verb: L10n.Agent.toolGeneric,
                summaryKeys: pathKeys + cmdKeys + queryKeys,
                sourceName: normalized
            )
        }
    }

    /// 对齐 Electron `compactInlineTools`：只读调用保留真实图标、工具名和一句摘要；
    /// 副作用 / 审批 / 输出审计走卡片。审批回执和可疑输出属于用户需要复核的证据，
    /// 即使原工具通常可紧凑显示，也必须升级为卡片。
    static func timelineStyle(for tool: ToolCall) -> ToolTimelineStyle {
        if tool.approvalSource != nil || tool.hasSuspiciousOutput {
            return .card
        }
        return of(tool.name).timelineStyle
    }

    /// 对齐 Electron deviceToolCards 的 Lucide 图标名。
    private static func devicePresentation(_ name: String) -> ToolPresentation? {
        let descriptor: (String, String)?
        switch name {
        case "get_device_info": descriptor = ("Smartphone", L10n.Agent.toolDeviceInfo)
        case "get_battery_info": descriptor = ("Battery", L10n.Agent.toolBatteryInfo)
        case "get_network_info": descriptor = ("Wifi", L10n.Agent.toolNetworkInfo)
        case "read_contacts", "search_contacts": descriptor = ("ContactRound", L10n.Agent.toolReadContacts)
        case "read_sms": descriptor = ("MessageSquare", L10n.Agent.toolReadSms)
        case "send_sms": descriptor = ("Send", L10n.Agent.toolSendSms)
        case "read_call_log": descriptor = ("Phone", L10n.Agent.toolReadCallLog)
        case "make_call": descriptor = ("PhoneCall", L10n.Agent.toolMakeCall)
        case "read_calendar": descriptor = ("Calendar", L10n.Agent.toolReadCalendar)
        case "read_notifications": descriptor = ("Bell", L10n.Agent.toolReadNotifications)
        case "list_installed_apps": descriptor = ("AppWindow", L10n.Agent.toolListApps)
        case "read_media": descriptor = ("Images", L10n.Agent.toolReadMedia)
        case "get_location": descriptor = ("MapPin", L10n.Agent.toolGetLocation)
        case "screen_capture": descriptor = ("ScanLine", L10n.Agent.toolScreenCapture)
        case "screen_snapshot": descriptor = ("MonitorSmartphone", L10n.Agent.toolScreenSnapshot)
        case "screen_ui_tree": descriptor = ("Network", L10n.Agent.toolScreenUiTree)
        case "screen_tap", "screen_tap_area", "screen_tap_element":
            descriptor = ("MousePointerClick", L10n.Agent.toolScreenTap)
        case "screen_swipe": descriptor = ("MoveHorizontal", L10n.Agent.toolScreenSwipe)
        case "screen_long_press", "screen_long_press_element":
            descriptor = ("Hand", L10n.Agent.toolScreenLongPress)
        case "screen_find_element", "screen_get_context":
            descriptor = ("Search", L10n.Agent.toolFindElement)
        case "screen_type_in_element", "screen_type_text":
            descriptor = ("Keyboard", L10n.Agent.toolTypeText)
        case "screen_type_secret": descriptor = ("Lock", L10n.Agent.toolTypeSecret)
        case "screen_key_event": descriptor = ("Command", L10n.Agent.toolKeyEvent)
        case "screen_wait_for_idle", "screen_wait_for_element":
            descriptor = ("Hourglass", L10n.Agent.toolWaitIdle)
        case "screen_open_app", "screen_launch_app":
            descriptor = ("AppWindow", L10n.Agent.toolOpenApp)
        case "screen_force_stop": descriptor = ("Square", L10n.Agent.toolStopApp)
        case "set_system_setting", "get_system_setting":
            descriptor = ("Settings", L10n.Agent.toolSystemSetting)
        case "set_stealth_mode": descriptor = ("EyeOff", L10n.Agent.toolStealthMode)
        case "launch_intent": descriptor = ("ExternalLink", L10n.Agent.toolLaunchIntent)
        case "save_to_device": descriptor = ("HardDriveDownload", L10n.Agent.toolSaveToDevice)
        case "get_automation_status": descriptor = ("Activity", L10n.Agent.toolAutomationStatus)
        default: descriptor = nil
        }
        guard let descriptor else { return nil }
        return .init(
            icon: descriptor.0,
            verb: descriptor.1,
            summaryKeys: pathKeys + queryKeys + urlKeys
        )
    }

    /// TabTin 内置 App 的工具名持续增长；按 App + 动作语义做通用映射，避免新工具回退成扳手。
    private static func tabAppPresentation(_ name: String) -> ToolPresentation? {
        guard name.hasPrefix("tab") else { return nil }

        let icon: String
        let verb: String
        let timelineStyle: ToolTimelineStyle
        if name.contains("search") || name.contains("_get_") || name.contains("_list_") {
            icon = "Search"
            verb = L10n.Agent.toolFindContent
            timelineStyle = .compact
        } else if name.contains("delete") || name.contains("archive") || name.contains("trash") {
            icon = "Trash2"
            verb = L10n.Agent.toolRemoveContent
            timelineStyle = .card
        } else if name.contains("restore") || name.contains("rollback") {
            icon = "RefreshCw"
            verb = L10n.Agent.toolRestoreContent
            timelineStyle = .card
        } else if name.contains("create") || name.contains("insert") || name.contains("add_") {
            icon = "PlusCircle"
            verb = L10n.Agent.toolCreateContent
            timelineStyle = .card
        } else if name.contains("update") || name.contains("edit") || name.contains("write") {
            icon = "FilePenLine"
            verb = L10n.Agent.toolUpdateContent
            timelineStyle = .card
        } else if name.contains("publish") || name.contains("share") || name.contains("grant") {
            icon = "Sparkles"
            verb = L10n.Agent.toolPublishContent
            timelineStyle = .card
        } else if name.hasPrefix("tabdoc_") {
            icon = "FileText"
            verb = L10n.Agent.toolHandleDoc
            timelineStyle = .card
        } else if name.hasPrefix("tabmemo_") {
            icon = "FileText"
            verb = L10n.Agent.toolHandleMemo
            timelineStyle = .card
        } else if name.hasPrefix("tabsite_") {
            icon = "Globe"
            verb = L10n.Agent.toolHandleSite
            timelineStyle = .card
        } else if name.hasPrefix("tabdata_") {
            icon = "Database"
            verb = L10n.Agent.toolHandleTable
            timelineStyle = .card
        } else {
            icon = "Wrench"
            verb = L10n.Agent.toolGeneric
            timelineStyle = .card
        }
        return .init(
            icon: icon,
            verb: verb,
            summaryKeys: ["title", "name", "id", "resource_id"] + pathKeys + queryKeys,
            timelineStyle: timelineStyle
        )
    }

    /// 从 input JSON 里提取一句摘要（命中 summaryKeys 的第一个字符串值）。
    /// 流式未完成的半截 JSON 解析失败时返回 nil（header 只显示动词）。
    func summary(from inputJson: String) -> String? {
        guard !summaryKeys.isEmpty else { return nil }
        guard let data = inputJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let nestedObjects = [obj, obj["kwargs"], obj["args"], obj["input"]]
            .compactMap { $0 as? [String: Any] }
        for object in nestedObjects {
            for key in summaryKeys {
                if let value = object[key] as? String {
                    let str = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !str.isEmpty { return str }
                }
                if let value = object[key] as? NSNumber {
                    return value.stringValue
                }
            }
        }
        return nil
    }

    /// 会话时间线只展示一句“AI 正在做什么”。
    /// 1. 非空 `runtimeTitle`
    /// 2. input 里的 description / summary / title（模型散文，不再拼 ` · 对象`）
    /// 3. 有对象时 `"动词 · 对象"`
    /// 4. 否则只显示动词
    func timelineLabel(from inputJson: String, runtimeTitle: String? = nil) -> String {
        if let runtimeTitle = Self.nonBlank(runtimeTitle) {
            return runtimeTitle
        }
        if let description = value(
            for: ["description", "summary", "title"],
            from: inputJson
        ) {
            return description
        }
        if let detail = timelineDetail(from: inputJson) {
            return "\(verb) · \(detail)"
        }
        return verb
    }

    /// 时间线对象槽：basename / 命令第一段 / host / SQL 摘要 / MCP server。纯函数，不读 UI 状态。
    func timelineDetail(from inputJson: String) -> String? {
        switch detailKind {
        case .none:
            return nil
        case .path:
            guard let path = value(for: Self.pathKeys, from: inputJson) else { return nil }
            return Self.pathBasename(path)
        case .command:
            guard let command = value(for: Self.cmdKeys, from: inputJson) else { return nil }
            return Self.commandDetail(command)
        case .query:
            guard let query = value(for: Self.patternKeys + Self.queryKeys, from: inputJson) else {
                return nil
            }
            return Self.truncate(query, 30)
        case .url:
            guard let url = value(for: Self.urlKeys, from: inputJson) else { return nil }
            return Self.urlHost(url)
        case .sql:
            guard let sql = value(for: Self.sqlKeys, from: inputJson) else { return nil }
            return Self.sqlDetail(sql)
        case .generic:
            if let server = Self.mcpServerName(from: sourceName) {
                return server
            }
            guard let hit = summary(from: inputJson) else { return nil }
            return Self.truncate(hit, 40)
        }
    }

    /// 抽屉默认展示：已知 key 的人话标签 + 截断值。原始 JSON 不进默认正文。
    func humanizedInputRows(from inputJson: String) -> [ToolInputRow] {
        let groups: [([String], String)] = [
            (Self.pathKeys, L10n.Agent.toolKeyFile),
            (Self.cmdKeys, L10n.Agent.toolKeyCommand),
            (Self.patternKeys + Self.queryKeys, L10n.Agent.toolKeyQuery),
            (Self.urlKeys, L10n.Agent.toolKeyURL),
            (Self.sqlKeys, L10n.Agent.toolKeySQL),
        ]
        var rows: [ToolInputRow] = []
        var seenLabels = Set<String>()
        for (keys, label) in groups {
            guard let value = value(for: keys, from: inputJson),
                  seenLabels.insert(label).inserted else { continue }
            rows.append(ToolInputRow(label: label, value: Self.truncate(value, 80)))
        }
        return rows
    }

    private func value(for keys: [String], from inputJson: String) -> String? {
        guard let data = inputJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let nestedObjects = [obj, obj["kwargs"], obj["args"], obj["input"]]
            .compactMap { $0 as? [String: Any] }
        for object in nestedObjects {
            for key in keys {
                if let value = Self.nonBlank(object[key] as? String) {
                    return value
                }
            }
        }
        return nil
    }

    private static func nonBlank(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func truncate(_ raw: String, _ limit: Int) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        return String(trimmed.prefix(max(0, limit - 1))) + "…"
    }

    private static func pathBasename(_ path: String) -> String? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let unified = trimmed.replacingOccurrences(of: "\\", with: "/")
        let base = (unified as NSString).lastPathComponent
        return nonBlank(base)
    }

    private static func commandDetail(_ command: String) -> String? {
        var rest = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let cdPrefix = #"^\s*cd\s+(?:'[^']+'|"[^"]+"|\S+)\s*&&\s*"#
        while let range = rest.range(of: cdPrefix, options: [.regularExpression, .caseInsensitive]) {
            rest.removeSubrange(range)
            rest = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let first = rest.split(whereSeparator: \.isWhitespace).first else { return nil }
        return truncate(String(first), 40)
    }

    private static func urlHost(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let host = URLComponents(string: trimmed)?.host, !host.isEmpty {
            return host
        }
        if let host = URLComponents(string: "https://\(trimmed)")?.host, !host.isEmpty {
            return host
        }
        return truncate(trimmed, 40)
    }

    private static func sqlDetail(_ sql: String) -> String? {
        let tokens = sql
            .split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .map(String.init)
        guard let keyword = tokens.first else { return nil }
        let tableHints: Set<String> = ["FROM", "INTO", "UPDATE", "TABLE"]
        var table: String?
        if tokens.count > 1 {
            for index in 0..<(tokens.count - 1) {
                guard tableHints.contains(tokens[index].uppercased()) else { continue }
                let candidate = tokens[index + 1]
                    .trimmingCharacters(in: CharacterSet(charactersIn: "`\"'[];,"))
                if !candidate.isEmpty {
                    table = candidate
                    break
                }
            }
        }
        let summary = table.map { "\(keyword.uppercased()) \($0)" } ?? keyword.uppercased()
        return truncate(summary, 40)
    }

    private static func mcpServerName(from toolName: String) -> String? {
        let parts = toolName.components(separatedBy: "__")
        guard parts.count >= 3, parts[0] == "mcp" else { return nil }
        return nonBlank(parts[1])
    }

    /// 美化 input JSON（缩进 + 排序键）；解析失败回退原文。
    static func prettyJSON(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                  withJSONObject: obj,
                  options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
              ),
              let str = String(data: pretty, encoding: .utf8)
        else { return trimmed }
        return str
    }
}
