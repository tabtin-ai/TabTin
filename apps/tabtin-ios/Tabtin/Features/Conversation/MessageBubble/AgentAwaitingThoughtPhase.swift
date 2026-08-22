import Foundation

/// 对齐 Electron `agentAwaitingThoughtPhase.ts`：回合尾部同一时刻只允许一个活动行。
enum AgentAwaitingThoughtPhase: Equatable, Sendable {
    case hidden
    case pending
    case planningNext
}

enum AgentTurnTailActivity: Equatable, Sendable {
    case none
    case thinking
    case text
    case settledTool
    case unsettledTool
    case other
}

enum AgentAwaitingThoughtPresentation {
    /// 流式空 thinking 不构成可见活动行（交给 planningNext / pending 等待壳）。
    static func hasVisibleThinkingBody(_ segment: ThinkingSegment) -> Bool {
        !segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func isEmptyStreamingThinking(_ block: MessageBlock) -> Bool {
        guard case let .thinking(segment) = block else { return false }
        return !segment.completed && !hasVisibleThinkingBody(segment)
    }

    /// 无可视正文的 text（无引用）不打断连续执行段，也不计入步骤。
    ///
    /// 必须先剥 `<turn_identity>`：模型常把内部身份标签原样回吐，展示层会剥掉变成空白，
    /// 但若仍按 raw 文本判 inert，会在两个「执行详情」之间插入看不见的打断点。
    static func isInertWhitespaceText(_ block: MessageBlock) -> Bool {
        guard case let .text(textBlock) = block else { return false }
        guard textBlock.citations.isEmpty else { return false }
        let visible = AgentTurnIdentityMarkup.stripped(textBlock.text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return visible.isEmpty
    }

    /// 当前 run 末尾的用户可见活动归属。
    ///
    /// 空 streaming thinking 跳过，保留工具后的 planning 空窗；已完成 thinking 必须阻断 planningNext。
    static func resolveTailActivity(blocks: [MessageBlock]) -> AgentTurnTailActivity {
        for block in blocks.reversed() {
            switch block {
            case let .thinking(segment):
                if !segment.completed && !hasVisibleThinkingBody(segment) {
                    continue
                }
                return .thinking
            case let .text(textBlock):
                if isInertWhitespaceText(.text(textBlock)) {
                    continue
                }
                return .text
            case let .tool(tool):
                if tool.isExecutionRunning {
                    return .unsettledTool
                }
                if tool.resolvedExecutionPhase.isTerminal || tool.hasResult || tool.finalized {
                    return .settledTool
                }
                return .unsettledTool
            case .attachment, .richContent, .contextRef:
                return .other
            }
        }
        return .none
    }

    /// `sessionPulseVisible` ≈ 消息仍在流式且无错误（iOS 无独立 HITL tail 门闩时由调用方收敛）。
    static func resolvePhase(
        sessionPulseVisible: Bool,
        isLastAssistantMessage: Bool,
        tailActivity: AgentTurnTailActivity
    ) -> AgentAwaitingThoughtPhase {
        guard sessionPulseVisible, isLastAssistantMessage else { return .hidden }
        switch tailActivity {
        case .settledTool:
            return .planningNext
        case .none:
            return .pending
        case .thinking, .text, .unsettledTool, .other:
            return .hidden
        }
    }

    static func resolvePhase(
        sessionPulseVisible: Bool,
        isLastAssistantMessage: Bool,
        blocks: [MessageBlock]
    ) -> AgentAwaitingThoughtPhase {
        resolvePhase(
            sessionPulseVisible: sessionPulseVisible,
            isLastAssistantMessage: isLastAssistantMessage,
            tailActivity: resolveTailActivity(blocks: blocks)
        )
    }
}
