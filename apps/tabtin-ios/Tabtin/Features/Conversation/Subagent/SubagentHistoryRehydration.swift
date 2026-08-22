import Foundation

/// 从 HTTP 历史 chat_message 重建 `SubagentRun`（对齐 Electron
/// `deriveSubagentRunsFromMessages` + 子消息 API transcript 兜底）。
///
/// 冷启动时 WS 内存态已丢；父消息 tool_use/tool_result 可恢复 metadata，
/// 同页 `subagent_run_id` 子消息可恢复 transcript。纯函数，便于单测。
enum SubagentHistoryRehydration {
    private static let subagentIdRegex = try! NSRegularExpression(
        pattern: #"\[子 Agent ID:\s*([^\]\s]+)\s*\]"#
    )

    /// 合并历史派生 runs 到现有内存态。
    /// - live 已有非空 transcript 时保留（不覆盖实时流）；
    /// - archive 终态可覆盖 stale 的 pending/queued/running；
    /// - 其余字段仅在 prev 缺值时回填。
    static func reconcile(
        existing: [SubagentRun],
        messages: [ChatMessage],
        historyDTOs: [SessionMessageDTO]
    ) -> [SubagentRun] {
        let snapshots = deriveRuns(from: messages) + deriveNestedRuns(from: historyDTOs)
        let transcripts = transcriptsByRunId(from: historyDTOs)
        guard !snapshots.isEmpty || !transcripts.isEmpty else { return existing }

        var byId: [String: SubagentRun] = [:]
        for run in existing {
            byId[run.runId] = run
        }

        // 先灌 / 合并 metadata snapshots
        var orderedIds: [String] = existing.map(\.runId)
        for snapshot in snapshots {
            if let prev = byId[snapshot.runId] {
                byId[snapshot.runId] = merge(previous: prev, archive: snapshot)
            } else {
                byId[snapshot.runId] = snapshot
                orderedIds.append(snapshot.runId)
            }
        }

        // 再挂 transcript（仅当现有为空）
        for (runId, items) in transcripts {
            guard !items.isEmpty else { continue }
            if var run = byId[runId] {
                if run.transcript.isEmpty {
                    run.transcript = items
                    byId[runId] = run
                }
            } else {
                // 只有子消息、父 tool_result 尚未进当前页时，至少挂上 transcript 壳
                var shell = SubagentRun.pending(runId: runId)
                shell.status = .completed
                shell.transcript = items
                byId[runId] = shell
                orderedIds.append(runId)
            }
        }

        return orderedIds.compactMap { byId[$0] }
    }

    // MARK: - Derive runs from parent timeline messages

    static func deriveRuns(from messages: [ChatMessage]) -> [SubagentRun] {
        var runs: [SubagentRun] = []
        var seen = Set<String>()
        for message in messages {
            for block in message.blocks {
                guard case let .tool(tool) = block else { continue }
                guard let run = runFromDispatchTool(tool, parentMessage: message) else { continue }
                guard !seen.contains(run.runId) else { continue }
                seen.insert(run.runId)
                runs.append(run)
            }
        }
        return runs
    }

    /// 子消息内嵌套的 agent/task 派发 → 孙 Agent（扫未进主时间线的 DTO）。
    static func deriveNestedRuns(from dtos: [SessionMessageDTO]) -> [SubagentRun] {
        let childMessages = dtos.compactMap { dto -> ChatMessage? in
            guard firstNonBlank(dto.subagentRunId) != nil else { return nil }
            return MessageHistoryMapper.mapOne(dto)
        }
        return deriveRuns(from: childMessages)
    }

    // MARK: - Transcripts from child messages

    static func transcriptsByRunId(from dtos: [SessionMessageDTO]) -> [String: [SubagentTranscriptItem]] {
        var grouped: [String: [(date: Date, items: [SubagentTranscriptItem])]] = [:]
        for dto in dtos {
            guard let runId = firstNonBlank(dto.subagentRunId) else { continue }
            guard let message = MessageHistoryMapper.mapOne(dto) else { continue }
            let items = transcriptItems(from: message)
            guard !items.isEmpty else { continue }
            grouped[runId, default: []].append((message.createdAt, items))
        }
        var result: [String: [SubagentTranscriptItem]] = [:]
        for (runId, chunks) in grouped {
            let sorted = chunks.sorted { $0.date < $1.date }
            var flat: [SubagentTranscriptItem] = []
            var seenIds = Set<String>()
            for chunk in sorted {
                for item in chunk.items {
                    guard !seenIds.contains(item.id) else { continue }
                    seenIds.insert(item.id)
                    flat.append(item)
                }
            }
            result[runId] = flat
        }
        return result
    }

    static func transcriptItems(from message: ChatMessage) -> [SubagentTranscriptItem] {
        message.blocks.compactMap { block -> SubagentTranscriptItem? in
            switch block {
            case let .text(text):
                let body = text.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !body.isEmpty else { return nil }
                return SubagentTranscriptItem(
                    id: "\(message.id)-\(text.index)-text",
                    messageId: message.id,
                    index: text.index,
                    kind: .assistant,
                    title: nil,
                    text: body,
                    inputText: nil,
                    outputText: nil,
                    isFinal: true,
                    isError: false,
                    toolCallId: nil,
                    richContent: nil,
                    contextRef: nil
                )
            case let .thinking(segment):
                let body = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !body.isEmpty else { return nil }
                return SubagentTranscriptItem(
                    id: "\(message.id)-\(segment.index)-thinking",
                    messageId: message.id,
                    index: segment.index,
                    kind: .thinking,
                    title: "思考",
                    text: body,
                    inputText: nil,
                    outputText: nil,
                    isFinal: true,
                    isError: false,
                    toolCallId: nil,
                    richContent: nil,
                    contextRef: nil
                )
            case let .tool(tool):
                return SubagentTranscriptItem(
                    id: "tool-\(tool.toolCallId)",
                    messageId: message.id,
                    index: tool.index,
                    kind: .tool,
                    title: tool.name,
                    text: nil,
                    inputText: tool.inputJson.isEmpty ? nil : tool.inputJson,
                    outputText: tool.resultText,
                    isFinal: true,
                    isError: tool.isError,
                    toolCallId: tool.toolCallId,
                    richContent: nil,
                    contextRef: nil
                )
            case let .richContent(rich):
                return SubagentTranscriptItem(
                    id: "\(message.id)-\(rich.index)-rich",
                    messageId: message.id,
                    index: rich.index,
                    kind: .richContent,
                    title: rich.title,
                    text: rich.summary,
                    inputText: nil,
                    outputText: nil,
                    isFinal: true,
                    isError: false,
                    toolCallId: nil,
                    richContent: rich,
                    contextRef: nil
                )
            case let .contextRef(ref):
                return SubagentTranscriptItem(
                    id: "\(message.id)-\(ref.index)-context",
                    messageId: message.id,
                    index: ref.index,
                    kind: .contextRef,
                    title: ref.label,
                    text: ref.preview,
                    inputText: nil,
                    outputText: nil,
                    isFinal: true,
                    isError: false,
                    toolCallId: nil,
                    richContent: nil,
                    contextRef: ref
                )
            case .attachment:
                return nil
            }
        }
    }

    // MARK: - Marker helpers

    static func extractSubagentRunId(from resultText: String?) -> String? {
        guard let resultText else { return nil }
        let range = NSRange(resultText.startIndex..<resultText.endIndex, in: resultText)
        guard let match = subagentIdRegex.firstMatch(in: resultText, range: range),
              match.numberOfRanges >= 2,
              let idRange = Range(match.range(at: 1), in: resultText) else {
            return nil
        }
        let id = String(resultText[idRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }

    static func stripSubagentIdMarker(from resultText: String?) -> String? {
        guard let resultText else { return nil }
        let range = NSRange(resultText.startIndex..<resultText.endIndex, in: resultText)
        let stripped = subagentIdRegex.stringByReplacingMatches(
            in: resultText,
            range: range,
            withTemplate: ""
        )
        let trimmed = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Private

    private static func runFromDispatchTool(_ tool: ToolCall, parentMessage: ChatMessage) -> SubagentRun? {
        guard subagentDispatchToolNames.contains(tool.name) else { return nil }
        let input = parseToolInput(tool.inputJson)
        guard isHistoryDispatchInput(input) else { return nil }
        guard let runId = extractSubagentRunId(from: tool.resultText) else { return nil }

        let summary = stripSubagentIdMarker(from: tool.resultText)
        let status: SubagentStatus = tool.isError ? .failed : .completed
        let startedAt: Double? = parentMessage.createdAt.timeIntervalSince1970

        var run = SubagentRun.pending(runId: runId)
        run.parentToolCallId = tool.toolCallId
        run.parentMessageId = parentMessage.serverId ?? parentMessage.id
        run.label = stringField("description", in: input)
        run.task = stringField("prompt", in: input) ?? stringField("task", in: input)
        run.status = status
        run.summary = summary
        run.startedAt = startedAt
        if status == .failed {
            run.error = summary
            run.errorKind = "failed"
        }
        return run
    }

    /// 历史路径：必须明确是 spawn/resume；check/wait 不建卡。input 缺失时不猜测。
    private static func isHistoryDispatchInput(_ input: [String: Any]?) -> Bool {
        guard let input else { return true }
        if let waits = input["wait_agent_ids"] as? [Any], !waits.isEmpty { return false }
        if let checkId = input["check_agent_id"] as? String, !checkId.isEmpty { return false }
        if let resume = input["resume_agent_id"] as? String, !resume.isEmpty { return true }
        if let prompt = input["prompt"] as? String, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        // 老归档可能缺 prompt 字段但仍有 marker——放行，由 marker 决定是否成 run。
        return true
    }

    private static func merge(previous: SubagentRun, archive: SubagentRun) -> SubagentRun {
        var filled = previous
        if archive.status.isTerminal && !previous.status.isTerminal {
            filled.status = archive.status
        }
        if isBlank(filled.task) { filled.task = archive.task }
        if isBlank(filled.label) { filled.label = archive.label }
        if isBlank(filled.parentToolCallId) { filled.parentToolCallId = archive.parentToolCallId }
        if isBlank(filled.parentMessageId) { filled.parentMessageId = archive.parentMessageId }
        if filled.startedAt == nil { filled.startedAt = archive.startedAt }
        if filled.endedAt == nil { filled.endedAt = archive.endedAt }
        if isBlank(filled.summary) { filled.summary = archive.summary }
        if isBlank(filled.error) { filled.error = archive.error }
        if isBlank(filled.errorKind) { filled.errorKind = archive.errorKind }
        if filled.transcript.isEmpty, !archive.transcript.isEmpty {
            filled.transcript = archive.transcript
        }
        return filled
    }

    private static func parseToolInput(_ raw: String) -> [String: Any]? {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any]
        else { return nil }
        if let kwargs = object["kwargs"] as? [String: Any] {
            return object.merging(kwargs) { current, _ in current }
        }
        return object
    }

    private static func stringField(_ key: String, in input: [String: Any]?) -> String? {
        guard let raw = input?[key] as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isBlank(_ value: String?) -> Bool {
        guard let value else { return true }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func firstNonBlank(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
