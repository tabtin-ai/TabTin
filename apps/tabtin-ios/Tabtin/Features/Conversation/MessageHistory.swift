import Foundation

/// `GET /chat/sessions/{id}/messages` 单条持久化消息（裁剪版，只取移动端当前会渲染的字段）。
/// content_blocks_json 是异构块数组（text/thinking/tool_use/tool_result/image/...），用 AnyCodable
/// 承载，由 MessageHistoryMapper 解析成精简 ChatMessage。
struct SessionMessageDTO: Decodable, Sendable {
    let id: String?
    let role: String?
    let agentId: String?
    let senderUserId: String?
    let senderDisplayName: String?
    let content: String?
    let contentBlocksJson: [AnyCodable]?
    let messageKind: String?
    let createdAt: String?
    let updatedAt: String?
    let checkpointRecord: ChatCheckpointRecord?
    let agentRunId: String?
    let errorCategory: String?
    let errorCode: String?
    let errorClass: String?
    let suggestedAction: String?
    let clientEventId: String?
    let subagentRunId: String?
    let metadata: [String: AnyCodable]?

    enum CodingKeys: String, CodingKey {
        case id, role, content
        case agentId = "agent_id"
        case senderUserId = "sender_user_id"
        case senderDisplayName = "sender_display_name"
        case contentBlocksJson = "content_blocks_json"
        case messageKind = "message_kind"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case checkpointRecord = "checkpoint_record"
        case agentRunId = "agent_run_id"
        case errorCategory = "error_category"
        case errorCode = "error_code"
        case errorClass = "error_class"
        case suggestedAction = "suggested_action"
        case clientEventId = "client_event_id"
        case subagentRunId = "subagent_run_id"
        case metadata
    }
}

struct MessageHistoryResponse: Decodable, Sendable {
    let messages: [SessionMessageDTO]
    let total: Int?
    let hasMore: Bool?
    let oldestId: String?
    let newestId: String?
    let serverTimestamp: String?

    enum CodingKeys: String, CodingKey {
        case messages, total
        case hasMore = "has_more"
        case oldestId = "oldest_id"
        case newestId = "newest_id"
        case serverTimestamp = "server_timestamp"
    }
}

/// 纯映射：持久化消息 → 视图模型态 ChatMessage（可单测）。
///
/// 本期渲染范围对齐直播路径（ConversationProjector）：正文 text / 思考 thinking / 工具调用 tool_use。
/// tool_result / image / rich_content 等块本期不展开（与直播一致，留待富内容 Phase）。
enum MessageHistoryMapper {
    static func map(_ dtos: [SessionMessageDTO]) -> [ChatMessage] {
        var messages = dtos
            .filter(isMainTimelineMessage)
            .compactMap(mapOne)
        // tool_result 常落在后续 user 消息；同消息 parseBlocks 合并不到时，按 toolCallId 回填。
        // 回填仍读原始 dtos——合成 carrier 已从主时间线剔除，但不能丢结果文本。
        attachCrossMessageToolResults(from: dtos, into: &messages)
        // 对齐 Electron：tool_result 归并进 tool_use 后，空壳消息不得再占列表位，
        // 否则会切断 MessageListRenderUnit 的跨消息「执行详情」合并。
        return messages.filter { !$0.isTimelineTransparent }
    }

    /// 对齐直播 `ConversationProjector`：跨气泡把 tool_result 填回 tool_use。
    private static func attachCrossMessageToolResults(
        from dtos: [SessionMessageDTO],
        into messages: inout [ChatMessage]
    ) {
        var resultsByToolId: [String: (
            text: String,
            isError: Bool,
            presentationKind: String?,
            presentationPrompt: String?
        )] = [:]
        for dto in dtos {
            for block in dto.contentBlocksJson ?? [] {
                guard let dict = block.dictValue,
                      dict["type"] as? String == "tool_result" else { continue }
                let toolId = ((dict["tool_use_id"] as? String) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !toolId.isEmpty else { continue }
                let text = ToolResultText.from(any: dict["content"])
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let presentation = Self.presentationFields(from: dict)
                resultsByToolId[toolId] = (
                    text: text,
                    isError: (dict["is_error"] as? Bool) ?? false,
                    presentationKind: presentation.kind,
                    presentationPrompt: presentation.prompt
                )
            }
        }
        guard !resultsByToolId.isEmpty else { return }

        for messageIndex in messages.indices {
            for blockIndex in messages[messageIndex].blocks.indices {
                guard case var .tool(tool) = messages[messageIndex].blocks[blockIndex] else {
                    continue
                }
                let existing = tool.resultText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard existing.isEmpty, let result = resultsByToolId[tool.toolCallId] else {
                    continue
                }
                tool.resultText = result.text
                tool.isError = result.isError
                tool.finalized = true
                tool.presentationKind = result.presentationKind ?? tool.presentationKind
                tool.presentationPrompt = result.presentationPrompt ?? tool.presentationPrompt
                messages[messageIndex].blocks[blockIndex] = .tool(tool)
            }
        }
    }

    static func mapOne(_ dto: SessionMessageDTO) -> ChatMessage? {
        guard let id = dto.id, !id.isEmpty else { return nil }
        let role = ChatRole(rawValue: dto.role ?? "") ?? .system
        let createdAt = parseDate(dto.createdAt) ?? .now

        // 按 content_block 真实顺序构建有序时间轴 blocks（text / thinking / tool 穿插），
        // 不再分桶——历史回放与直播渲染顺序一致。
        var blocks = parseBlocks(dto.contentBlocksJson, messageId: id)

        if role == .user, blocks.isEmpty {
            let text = (dto.content?.isEmpty == false) ? dto.content! : extractText(dto.contentBlocksJson)
            if !text.isEmpty {
                blocks.append(.text(TextBlock(messageId: id, index: 0, text: text)))
            }
        }

        // 无任何可渲染块时退回 content；但要过滤 Django derive_text_summary 写入的占位文案
        // （纯非 text 块消息的 content 是 "[工具调用]/[富内容]/[思考中]" 占位，不能当正文渲染）。
        // SYNC: Electron TEXT_SUMMARY_PLACEHOLDERS / Django derive_text_summary。
        if blocks.isEmpty,
           let content = dto.content, !content.isEmpty, !isTextSummaryPlaceholder(content) {
            blocks.append(.text(TextBlock(messageId: id, index: 0, text: content)))
        }

        return ChatMessage(
            id: id, serverId: id, persistedId: id,
            clientEventId: clientEventId(from: dto),
            sourceClientEventId: dto.metadata?["source_client_event_id"]?.stringValue,
            role: role,
            messageKind: dto.messageKind,
            senderUserId: dto.senderUserId,
            senderDisplayName: dto.senderDisplayName,
            agentId: dto.agentId,
            blocks: blocks, isStreaming: false,
            errorMessage: dto.errorCategory == nil ? nil : dto.content,
            checkpointRecord: dto.checkpointRecord,
            agentRunId: dto.agentRunId,
            subagentRunId: dto.subagentRunId,
            errorCategory: dto.errorCategory,
            errorCode: dto.errorCode,
            errorClass: dto.errorClass,
            suggestedAction: dto.suggestedAction,
            triggeredBy: dto.metadata?["triggered_by"]?.stringValue,
            createdAt: createdAt
        )
    }

    private static func isMainTimelineMessage(_ dto: SessionMessageDTO) -> Bool {
        guard firstNonBlank(dto.subagentRunId) == nil else { return false }
        // 对齐 Electron messageTimelineOrder：tool_result 归并进 tool_use fragment，
        // 合成 user carrier 不再单独占时间线——否则会切开相邻「执行详情 · N 步」。
        if isSyntheticToolResultCarrier(dto) { return false }
        if isLegacyWebSearchArtifact(dto) { return false }
        let text = firstNonBlank(dto.content) ?? extractText(dto.contentBlocksJson)
        if dto.role == ChatRole.system.rawValue,
           dto.metadata?["system_fact"]?.stringValue == "agent_switched"
            || text == "切换当前 Agent"
            || text.hasPrefix("Agent 已切换成") {
            return false
        }
        // 纯子代理完成 push：桌面 fold 进聚合卡，主时间线整条抑制。
        if dto.role == ChatRole.user.rawValue,
           PushNotificationVisibility.shouldHideFromTimeline(
               triggeredBy: dto.metadata?["triggered_by"]?.stringValue,
               text: text
           ) {
            return false
        }
        return !InternalUserContextVisibility.isHidden(
            messageKind: dto.messageKind,
            text: text,
            isShareBriefing: dto.metadata?["share_briefing"]?.boolValue == true,
            isShareContract: dto.metadata?["share_contract"]?.boolValue == true
        )
    }

    /// 旧服务把 web_search 结果额外落成一条 tool_artifact 产物气泡，与工具卡里的结果重复。
    /// SYNC: Electron `webSearchArtifactPolicy.shouldHideLegacyWebSearchArtifactMessage`。
    private static func isLegacyWebSearchArtifact(_ dto: SessionMessageDTO) -> Bool {
        guard dto.messageKind == "tool_artifact",
              firstNonBlank(dto.content) == nil else { return false }
        let raw = dto.contentBlocksJson ?? []
        guard !raw.isEmpty else { return false }
        return raw.allSatisfy { block in
            guard let d = block.dictValue,
                  let type = d["type"] as? String,
                  type == "tabtin_rich_content" || type == "rich_content",
                  (d["kind"] as? String) == "search_results",
                  let summary = d["summary"] as? String else { return false }
            return summary.range(
                of: #"^web_search\s*:"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
        }
    }

    /// 仅承载 tool_result / web_search_tool_result 的合成 user 行（无真实用户正文）。
    private static func isSyntheticToolResultCarrier(_ dto: SessionMessageDTO) -> Bool {
        guard dto.role == ChatRole.user.rawValue else { return false }
        let raw = dto.contentBlocksJson ?? []
        guard !raw.isEmpty else { return false }
        var sawToolResult = false
        for block in raw {
            guard let dict = block.dictValue, let type = dict["type"] as? String else { continue }
            switch type {
            case "tool_result", "mcp_tool_result", "web_search_tool_result":
                sawToolResult = true
            case "text":
                let text = ((dict["text"] as? String) ?? (dict["content"] as? String) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { return false }
            default:
                return false
            }
        }
        return sawToolResult
    }

    private static func clientEventId(from dto: SessionMessageDTO) -> String? {
        firstNonBlank(
            dto.clientEventId,
            dto.metadata?["client_message_id"]?.stringValue,
            dto.metadata?["client_event_id"]?.stringValue
        )
    }

    private static func parseBlocks(_ rawBlocks: [AnyCodable]?, messageId id: String) -> [MessageBlock] {
        var blocks: [MessageBlock] = []
        // 同消息内已有 web_search 结果块时，工具卡的展开区就是这份结果的唯一归宿。
        let carriesWebSearchToolResult = (rawBlocks ?? []).contains {
            ($0.dictValue?["type"] as? String) == "web_search_tool_result"
        }
        for (idx, block) in (rawBlocks ?? []).enumerated() {
            guard let d = block.dictValue else { continue }
            switch d["type"] as? String {
            case "text":
                let t = (d["text"] as? String) ?? (d["content"] as? String) ?? ""
                let citations = parseCitations(d["citations"])
                if !t.isEmpty || !citations.isEmpty {
                    blocks.append(.text(TextBlock(messageId: id, index: idx, text: t, citations: citations)))
                }
            case "thinking":
                let t = (d["thinking"] as? String) ?? (d["text"] as? String) ?? ""
                if !t.isEmpty { blocks.append(.thinking(ThinkingSegment(messageId: id, index: idx, text: t, completed: true))) }
            case "tool_use":
                let toolId = (d["tool_use_id"] as? String) ?? (d["id"] as? String) ?? "tool_\(idx)"
                let name = (d["name"] as? String) ?? "tool"
                blocks.append(.tool(ToolCall(
                    toolCallId: toolId, index: idx, name: name,
                    inputJson: serializeInput(d["input"]), finalized: true
                )))
            case "server_tool_use":
                // Anthropic Web Search 使用 server_tool_use；在移动端同样投影为工具卡。
                let toolId = (d["id"] as? String) ?? "server_tool_\(idx)"
                let name = (d["name"] as? String) ?? "web_search"
                blocks.append(.tool(ToolCall(
                    toolCallId: toolId, index: idx, name: name,
                    inputJson: serializeInput(d["input"]), finalized: true
                )))
            case "tool_result":
                // 结果并入同消息内对应 tool_use 卡的输出区（不单独成块）。
                let toolId = (d["tool_use_id"] as? String) ?? ""
                guard let bi = blocks.firstIndex(where: {
                    if case let .tool(t) = $0 { return t.toolCallId == toolId } else { return false }
                }), case var .tool(t) = blocks[bi] else { continue }
                t.resultText = ToolResultText.from(any: d["content"])
                t.isError = (d["is_error"] as? Bool) ?? false
                let presentation = presentationFields(from: d)
                t.presentationKind = presentation.kind ?? t.presentationKind
                t.presentationPrompt = presentation.prompt ?? t.presentationPrompt
                blocks[bi] = .tool(t)
            case "web_search_tool_result":
                // 搜索结果归属到对应 server_tool_use 的展开区，绝不单独生成一条消息块。
                let toolId = (d["tool_use_id"] as? String) ?? ""
                guard let bi = blocks.firstIndex(where: {
                    if case let .tool(t) = $0 { return t.toolCallId == toolId } else { return false }
                }), case var .tool(t) = blocks[bi] else { continue }
                t.resultText = serializeInput(d["content"])
                blocks[bi] = .tool(t)
            case "image", "file":
                let kind: AttachmentBlock.Kind = (d["type"] as? String) == "image" ? .image : .file
                let filename = (d["filename"] as? String)
                    ?? (d["name"] as? String)
                    ?? ((d["url"] as? String).flatMap { URL(string: $0)?.lastPathComponent })
                    ?? (kind == .image ? "图片" : "文件")
                let size = int64Value(d["size"] ?? d["file_size"])
                blocks.append(.attachment(AttachmentBlock(
                    messageId: id,
                    index: idx,
                    kind: kind,
                    filename: filename,
                    mimeType: d["mime_type"] as? String,
                    size: size,
                    url: (d["url"] as? String) ?? (d["remote_url"] as? String),
                    fileId: (d["file_id"] as? String) ?? (d["fileId"] as? String)
                )))
            case "tabtin_rich_content":
                let payload = d["payload"] as? [String: Any]
                let title = (payload?["title"] as? String)
                    ?? (payload?["name"] as? String)
                    ?? (payload?["filename"] as? String)
                    ?? (d["title"] as? String)
                let richKind = (payload?["kind"] as? String)
                    ?? (d["kind"] as? String)
                    ?? (payload?["type"] as? String)
                    ?? "rich_content"
                // rag / semantic 等独立 search_results 仍需映射为富内容块；
                // 只有与 web_search 结果同处一条消息时才会重复成第二张搜索卡。
                if richKind == "search_results", carriesWebSearchToolResult {
                    continue
                }
                let tableSchema = RichTableSchema.fromPayload(payload)
                let formalImage = FormalOssImageAsset.from(kind: richKind, payload: payload)
                blocks.append(.richContent(RichContentBlock(
                    messageId: id,
                    index: idx,
                    kind: richKind,
                    summary: (d["summary"] as? String) ?? (payload?["summary"] as? String) ?? "",
                    title: title,
                    groupId: (d["group_id"] as? String) ?? (d["groupId"] as? String),
                    tableRows: tableSchema?.displayRows ?? parseTableRows(payload),
                    tableSchema: tableSchema,
                    footer: (payload?["footer"] as? String) ?? (payload?["truncated_footer"] as? String),
                    resourceType: payload?["resource_type"] as? String,
                    resourceName: (payload?["resource_name"] as? String) ?? (payload?["name"] as? String),
                    resourceId: (payload?["resource_id"] as? String) ?? (payload?["id"] as? String),
                    spaceName: payload?["space_name"] as? String,
                    url: formalImage?.fallbackURL
                        ?? ((formalImage == nil ? payload?["url"] as? String : nil)
                            ?? (payload?["image_url"] as? String)
                            ?? (payload?["file_url"] as? String)
                            ?? (payload?["remote_url"] as? String)),
                    filename: (payload?["filename"] as? String) ?? (payload?["file_name"] as? String),
                    mimeType: payload?["mime_type"] as? String,
                    fileSize: int64Value(payload?["file_size"] ?? payload?["size"]),
                    totalRows: intValue(payload?["total_rows"] ?? payload?["total"]),
                    widgetId: (payload?["widget_id"] as? String) ?? (payload?["widgetId"] as? String),
                    format: payload?["format"] as? String,
                    sourceCode: (payload?["source_code"] as? String) ?? (payload?["sourceCode"] as? String),
                    mermaidSource: (payload?["mermaid_source"] as? String) ?? (payload?["mermaidSource"] as? String),
                    query: payload?["query"] as? String,
                    searchResults: RichSearchResult.fromPayload(payload?["search_results"]),
                    totalCount: intValue(payload?["total_count"] ?? payload?["total"]),
                    fileId: formalImage?.fileId
                        ?? (payload?["file_id"] as? String)
                        ?? (payload?["fileId"] as? String),
                    sourceToolUseId: payload?["source_tool_use_id"] as? String,
                    artifactKind: payload?["artifact_kind"] as? String,
                    relativePath: payload?["relative_path"] as? String
                )))
            case "tabtin_source_ref":
                if let ref = sourceRefContextBlock(payload: d, messageId: id, index: idx) {
                    blocks.append(.contextRef(ref))
                }
            case "table_selection", "doc_selection", "slide", "design", "video", "site", "folder", "code_file", "memo", "goal":
                let label = (d["label"] as? String)
                    ?? (d["title"] as? String)
                    ?? (d["preview"] as? String)
                    ?? "上下文引用"
                let blockType = (d["type"] as? String) ?? "context"
                blocks.append(.contextRef(ContextRefBlock(
                    messageId: id,
                    index: idx,
                    type: blockType,
                    resourceId: contextResourceId(blockType: blockType, payload: d),
                    url: stringValue(d["url"]),
                    tableId: stringValue(d["table_id"] ?? d["tableId"]),
                    docId: stringValue(d["doc_id"] ?? d["docId"]),
                    rowIds: stringArray(d["row_ids"] ?? d["rowIds"]) ?? [],
                    fieldIds: stringArray(d["field_ids"] ?? d["fieldIds"]) ?? [],
                    label: label,
                    preview: d["preview"] as? String,
                    spaceId: d["space_id"] as? String,
                    spaceName: d["space_name"] as? String,
                    locationHint: contextLocationHint(payload: d)
                )))
            default:
                continue
            }
        }
        return blocks
    }

    // MARK: - Helpers

    /// Django derive_text_summary / Electron TEXT_SUMMARY_PLACEHOLDERS 的三占位，
    /// 落库在纯非 text 块消息的 content 字段，渲染时必须过滤。
    private static let textSummaryPlaceholders: Set<String> = ["[工具调用]", "[富内容]", "[思考中]"]

    /// 从历史 tool_result 字典解析 presentation.kind / data.prompt。
    private static func presentationFields(from dict: [String: Any]) -> (kind: String?, prompt: String?) {
        guard let presentation = dict["presentation"] as? [String: Any] else {
            return (nil, nil)
        }
        let kind = presentation["kind"] as? String
        let prompt = (presentation["data"] as? [String: Any])?["prompt"] as? String
        return (kind, prompt)
    }

    private static func isTextSummaryPlaceholder(_ content: String) -> Bool {
        textSummaryPlaceholders.contains(content.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func extractText(_ blocks: [AnyCodable]?) -> String {
        var text = ""
        for block in blocks ?? [] {
            guard let d = block.dictValue, (d["type"] as? String) == "text" else { continue }
            text += (d["text"] as? String) ?? (d["content"] as? String) ?? ""
        }
        return text
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        values.first {
            guard let value = $0?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            return !value.isEmpty
        } ?? nil
    }

    private static func serializeInput(_ input: Any?) -> String {
        guard let input, JSONSerialization.isValidJSONObject(input),
              let data = try? JSONSerialization.data(
                withJSONObject: input,
                options: [.withoutEscapingSlashes]
              ),
              let str = String(data: data, encoding: .utf8) else { return "" }
        return str
    }

    private static func int64Value(_ value: Any?) -> Int64? {
        if let int = value as? Int { return Int64(int) }
        if let int64 = value as? Int64 { return int64 }
        if let double = value as? Double { return Int64(double) }
        if let string = value as? String { return Int64(string) }
        return nil
    }

    private static func parseCitations(_ value: Any?) -> [Citation] {
        guard let rawItems = value as? [[String: Any]] else { return [] }
        return rawItems.compactMap { raw in
            guard let type = raw["type"] as? String else { return nil }
            return Citation(
                type: type,
                citedText: raw["cited_text"] as? String ?? raw["citedText"] as? String ?? "",
                documentIndex: intValue(raw["document_index"] ?? raw["documentIndex"]) ?? 0,
                documentTitle: raw["document_title"] as? String ?? raw["documentTitle"] as? String,
                sourceTitle: raw["source_title"] as? String ?? raw["sourceTitle"] as? String,
                sourceUrl: raw["source_url"] as? String ?? raw["sourceURL"] as? String ?? raw["url"] as? String,
                sourceName: raw["source_name"] as? String ?? raw["sourceName"] as? String ?? raw["source"] as? String,
                sourceId: raw["source_id"] as? String ?? raw["sourceId"] as? String,
                sourceType: raw["source_type"] as? String ?? raw["sourceType"] as? String,
                page: intValue(raw["page"]),
                startLine: intValue(raw["start_line"] ?? raw["startLine"] ?? raw["line"] ?? raw["line_number"]),
                endLine: intValue(raw["end_line"] ?? raw["endLine"]),
                chunkId: raw["chunk_id"] as? String ?? raw["chunkId"] as? String,
                metadata: jsonObject(raw["metadata"]),
                startCharIndex: intValue(raw["start_char_index"] ?? raw["startCharIndex"]) ?? 0,
                endCharIndex: intValue(raw["end_char_index"] ?? raw["endCharIndex"]) ?? 0
            )
        }
    }

    private static func jsonObject(_ value: Any?) -> [String: JSONValue]? {
        guard let dict = value as? [String: Any] else { return nil }
        let mapped = dict.compactMapValues(jsonValue)
        return mapped.isEmpty ? nil : mapped
    }

    private static func contextResourceId(blockType: String, payload: [String: Any]) -> String? {
        switch blockType {
        case "table_selection":
            return stringValue(payload["table_id"]) ?? stringValue(payload["resource_id"])
        case "doc_selection":
            return stringValue(payload["doc_id"]) ?? stringValue(payload["resource_id"])
        default:
            return stringValue(payload["resource_id"])
                ?? stringValue(payload["table_id"])
                ?? stringValue(payload["doc_id"])
        }
    }

    private static func contextLocationHint(payload: [String: Any]) -> String? {
        if let explicit = stringValue(payload["location_hint"] ?? payload["locationHint"]) {
            return explicit
        }
        var parts: [String] = []
        if let page = intValue(payload["page"]) {
            parts.append("第 \(page) 页")
        }
        switch (intValue(payload["start_line"] ?? payload["startLine"]), intValue(payload["end_line"] ?? payload["endLine"])) {
        case let (.some(start), .some(end)) where end > start:
            parts.append("行 \(start)-\(end)")
        case let (.some(start), _):
            parts.append("行 \(start)")
        default:
            break
        }
        if let rowIds = stringArray(payload["row_ids"] ?? payload["rowIds"]), !rowIds.isEmpty {
            parts.append(rowIds.count == 1 ? "记录 \(rowIds[0])" : "\(rowIds.count) 条记录")
        }
        if let fieldIds = stringArray(payload["field_ids"] ?? payload["fieldIds"]), !fieldIds.isEmpty {
            parts.append(fieldIds.count == 1 ? "字段 \(fieldIds[0])" : "\(fieldIds.count) 个字段")
        }
        if let chunkId = stringValue(payload["chunk_id"] ?? payload["chunkId"]) {
            parts.append("Chunk \(chunkId)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func sourceRefContextBlock(payload: [String: Any], messageId: String, index: Int) -> ContextRefBlock? {
        guard let snapshot = payload["snapshot"] as? [String: Any],
              let kind = stringValue(snapshot["kind"] ?? payload["ref_kind"]) else { return nil }
        switch kind {
        case "web":
            let url = stringValue(snapshot["url"])
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "web",
                resourceId: nil,
                url: url,
                tableId: nil,
                docId: nil,
                rowIds: [],
                fieldIds: [],
                label: firstNonEmpty(stringValue(snapshot["title"]), url) ?? "网页来源",
                preview: firstNonEmpty(stringValue(snapshot["selected_text"]), stringValue(snapshot["preview"])),
                spaceId: nil,
                spaceName: nil,
                locationHint: nil
            )
        case "doc":
            let docId = stringValue(snapshot["doc_id"] ?? snapshot["docId"])
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "doc_selection",
                resourceId: docId,
                url: nil,
                tableId: nil,
                docId: docId,
                rowIds: [],
                fieldIds: [],
                label: "文档引用",
                preview: stringValue(snapshot["preview"]),
                spaceId: nil,
                spaceName: nil,
                locationHint: sourceRefLocationHint(page: intValue(snapshot["page"]), bbox: doubleArray(snapshot["bbox"]))
            )
        case "table":
            let tableId = stringValue(snapshot["table_id"] ?? snapshot["tableId"])
            let rowIds = stringArray(snapshot["row_ids"] ?? snapshot["rowIds"]) ?? []
            let fieldIds = stringArray(snapshot["field_ids"] ?? snapshot["fieldIds"]) ?? []
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "table_selection",
                resourceId: tableId,
                url: nil,
                tableId: tableId,
                docId: nil,
                rowIds: rowIds,
                fieldIds: fieldIds,
                label: "表格引用",
                preview: stringValue(snapshot["csv_preview"] ?? snapshot["csvPreview"]),
                spaceId: nil,
                spaceName: nil,
                locationHint: sourceRefLocationHint(
                    rowIds: rowIds,
                    fieldIds: fieldIds
                )
            )
        case "code":
            let filePath = stringValue(snapshot["file_path"] ?? snapshot["filePath"])
            let startLine = intValue(snapshot["start_line"] ?? snapshot["startLine"])
            let endLine = intValue(snapshot["end_line"] ?? snapshot["endLine"])
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "code_file",
                resourceId: filePath,
                url: nil,
                tableId: nil,
                docId: nil,
                rowIds: [],
                fieldIds: [],
                label: filePath ?? "代码引用",
                preview: stringValue(snapshot["code_excerpt"] ?? snapshot["codeExcerpt"]),
                spaceId: nil,
                spaceName: nil,
                locationHint: sourceRefLocationHint(startLine: startLine, endLine: endLine)
            )
        case "memo":
            let memoId = stringValue(snapshot["memo_id"] ?? snapshot["memoId"])
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "memo",
                resourceId: memoId,
                url: nil,
                tableId: nil,
                docId: nil,
                rowIds: [],
                fieldIds: [],
                label: "笔记引用",
                preview: stringValue(snapshot["preview"]),
                spaceId: nil,
                spaceName: nil,
                locationHint: nil
            )
        default:
            return nil
        }
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            let cleaned = value?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let cleaned, !cleaned.isEmpty {
                return cleaned
            }
        }
        return nil
    }

    private static func sourceRefLocationHint(page: Int? = nil, bbox: [Double]? = nil, rowIds: [String]? = nil, fieldIds: [String]? = nil, startLine: Int? = nil, endLine: Int? = nil) -> String? {
        var parts: [String] = []
        if let page {
            parts.append("第 \(page) 页")
        }
        if let bbox, !bbox.isEmpty {
            parts.append("区域 \(bbox.map { String(format: "%.2f", $0) }.joined(separator: ","))")
        }
        if let rowIds, !rowIds.isEmpty {
            parts.append(rowIds.count == 1 ? "记录 \(rowIds[0])" : "\(rowIds.count) 条记录")
        }
        if let fieldIds, !fieldIds.isEmpty {
            parts.append(fieldIds.count == 1 ? "字段 \(fieldIds[0])" : "\(fieldIds.count) 个字段")
        }
        switch (startLine, endLine) {
        case let (.some(start), .some(end)) where end > start:
            parts.append("行 \(start)-\(end)")
        case let (.some(start), _):
            parts.append("行 \(start)")
        default:
            break
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func jsonValue(_ value: Any?) -> JSONValue? {
        switch value {
        case nil, is NSNull:
            return .null
        case let bool as Bool:
            return .bool(bool)
        case let int as Int:
            return .int(int)
        case let int64 as Int64:
            return .int(Int(int64))
        case let double as Double:
            return .double(double)
        case let string as String:
            return .string(string)
        case let array as [Any]:
            return .array(array.compactMap(jsonValue))
        case let dict as [String: Any]:
            return .object(dict.compactMapValues(jsonValue))
        default:
            guard let value else { return .null }
            return .string(String(describing: value))
        }
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let int64 = value as? Int64 { return Int(int64) }
        if let double = value as? Double { return Int(double) }
        if let string = value as? String { return Int(string) }
        return nil
    }

    private static func parseTableRows(_ payload: [String: Any]?) -> [[String]] {
        guard let payload else { return [] }
        if let rows = payload["rows"] as? [[String: Any]], !rows.isEmpty {
            let columns = parseColumnKeys(payload["columns"], fallbackRows: rows)
            var table: [[String]] = [columns.map(\.label)]
            table.append(contentsOf: rows.prefix(10).map { row in
                columns.map { cellText(row[$0.key]) }
            })
            return table
        }
        if let rows = payload["rows"] as? [[Any]], !rows.isEmpty {
            return rows.prefix(10).map { row in
                row.prefix(5).map { cellText($0) }
            }
        }
        if let rows = payload["data"] as? [[Any]], !rows.isEmpty {
            return rows.prefix(10).map { row in
                row.prefix(5).map { cellText($0) }
            }
        }
        if let rows = payload["records"] as? [[String: Any]], !rows.isEmpty {
            let keys = Array(rows.flatMap(\.keys)).reduce(into: [String]()) { acc, key in
                if !acc.contains(key) { acc.append(key) }
            }.prefix(5)
            var table: [[String]] = [Array(keys)]
            table.append(contentsOf: rows.prefix(10).map { row in
                keys.map { cellText(row[$0]) }
            })
            return table
        }
        return []
    }

    private static func parseColumnKeys(_ value: Any?, fallbackRows: [[String: Any]]) -> [(key: String, label: String)] {
        if let columns = value as? [[String: Any]], !columns.isEmpty {
            return columns.prefix(6).compactMap { column in
                let key = (column["key"] as? String)
                    ?? (column["id"] as? String)
                    ?? (column["name"] as? String)
                guard let key, !key.isEmpty else { return nil }
                let label = (column["label"] as? String)
                    ?? (column["title"] as? String)
                    ?? (column["name"] as? String)
                    ?? key
                return (key, label)
            }
        }
        let keys = Array(fallbackRows.flatMap(\.keys)).reduce(into: [String]()) { acc, key in
            if !acc.contains(key) { acc.append(key) }
        }.prefix(6)
        return keys.map { ($0, $0) }
    }

    private static func cellText(_ value: Any?) -> String {
        switch value {
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        case let dict as [String: Any]:
            return (dict["text"] as? String) ?? (dict["value"] as? String) ?? String(describing: dict)
        case .some(let value): return String(describing: value)
        case .none: return ""
        }
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

    private static func stringArray(_ value: Any?) -> [String]? {
        if let strings = value as? [String] {
            return strings.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
        if let values = value as? [Any] {
            return values.compactMap(stringValue)
        }
        return nil
    }

    private static func doubleArray(_ value: Any?) -> [Double]? {
        if let doubles = value as? [Double] {
            return doubles
        }
        if let numbers = value as? [NSNumber] {
            return numbers.map(\.doubleValue)
        }
        if let values = value as? [Any] {
            let parsed = values.compactMap { item -> Double? in
                if let double = item as? Double { return double }
                if let number = item as? NSNumber { return number.doubleValue }
                if let string = item as? String { return Double(string) }
                return nil
            }
            return parsed.isEmpty ? nil : parsed
        }
        return nil
    }

    private nonisolated(unsafe) static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private nonisolated(unsafe) static let isoFallback: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func parseDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        return iso.date(from: raw) ?? isoFallback.date(from: raw)
    }
}
