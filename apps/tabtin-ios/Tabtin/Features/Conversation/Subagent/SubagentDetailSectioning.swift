import Foundation

/// 子代理详情「结果」块：终态结论 + 流式 assistant 正文，与中间步骤分离。
struct SubagentDetailResultSection: Equatable {
    /// transcript 中 `kind == .assistant` 且 text 非空的条目，按原序提取正文。
    let assistantTexts: [String]
    /// 复用 `SubagentPresentationPolicy` 的终态结论（完成摘要 / 失败错误等）。
    let terminalConclusion: String?
    /// 复用 policy 的失败引导；非失败态为 nil。
    let failureGuidance: String?
    /// 未终态且尚无 assistant 正文、也无终态结论 → UI「尚未给出结果」。
    let isPendingResult: Bool
}

/// 子代理详情三块投影：指令 / 中间步骤 / 结果。
struct SubagentDetailSections: Equatable {
    /// `task` 非空优先，否则 `label`，再否则 nil（UI 空态）。
    let instruction: String?
    /// transcript 中过程类条目（不含 assistant），按原序。
    let steps: [SubagentTranscriptItem]
    let result: SubagentDetailResultSection
}

/// 从 `SubagentRun` 投影详情三块。纯函数，不改 run、不暴露独立 toolHistory 列表。
///
/// 步骤默认以 transcript 为准；不把 toolHistory 并入 steps（避免与流式条目重复或乱序）。
enum SubagentDetailSectioning {
    private static let stepKinds: Set<SubagentTranscriptItem.Kind> = [
        .thinking, .tool, .richContent, .contextRef, .system, .error,
    ]

    static func sections(for run: SubagentRun) -> SubagentDetailSections {
        let presentation = SubagentPresentationPolicy.presentation(for: run)
        let assistantTexts = run.transcript.compactMap { item -> String? in
            guard item.kind == .assistant else { return nil }
            return nonEmpty(item.text)
        }
        // 已有 assistant 正文时，completed 的 summary 再挂一层「结果摘要」是冗余；
        // 失败 / 取消仍保留终态结论（错误原因）。
        let terminalConclusion: String? = {
            if run.status == .completed, !assistantTexts.isEmpty {
                return nil
            }
            return presentation.terminalConclusion
        }()
        let isPendingResult = !run.status.isTerminal
            && assistantTexts.isEmpty
            && nonEmpty(terminalConclusion) == nil

        return SubagentDetailSections(
            instruction: nonEmpty(run.task) ?? nonEmpty(run.label),
            steps: run.transcript.filter { stepKinds.contains($0.kind) && !isThinkingIterationNoise($0) },
            result: SubagentDetailResultSection(
                assistantTexts: assistantTexts,
                terminalConclusion: terminalConclusion,
                failureGuidance: presentation.failureGuidance,
                isPendingResult: isPendingResult
            )
        )
    }

    /// 旧协议 `agent.stream.step` 的 thinking 迭代占位（如 "Thinking..." /
    /// "Thinking... (iteration 2)"）。真正思考由 content_block thinking 承载，
    /// 主对话时间线也丢弃这类 step——详情中间步骤同步丢弃。
    static func isThinkingIterationNoise(_ item: SubagentTranscriptItem) -> Bool {
        guard item.kind == .system else { return false }
        let title = (item.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return false }
        return title.lowercased().hasPrefix("thinking")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
