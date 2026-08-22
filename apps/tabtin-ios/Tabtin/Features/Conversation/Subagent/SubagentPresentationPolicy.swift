import Foundation

/// 子 Agent 只有 stream 回流的运行快照，没有独立 retry endpoint。
/// 此 policy 只把真实快照投影成用户可理解的过程、结论与证据，不产生任何控制能力，
/// 供会话内联卡片与独立详情页共同使用。
struct SubagentRunPresentation: Equatable {
    let statusLabel: String
    let subtitle: String
    let latestProgress: String?
    let terminalConclusion: String?
    let failureGuidance: String?
    let evidenceSummary: String
    let canRequestCancel: Bool
    let cancelLabel: String?
}

enum SubagentPresentationPolicy {
    static func presentation(
        for run: SubagentRun,
        cancellationRequested: Bool = false
    ) -> SubagentRunPresentation {
        let evidenceSummary = evidenceSummary(for: run)
        switch run.status {
        case .pending:
            return .init(
                statusLabel: "启动中",
                subtitle: cancellationRequested ? "正在尝试停止，等待运行状态回流" : "等待调度启动",
                latestProgress: nil,
                terminalConclusion: nil,
                failureGuidance: nil,
                evidenceSummary: evidenceSummary,
                canRequestCancel: !cancellationRequested,
                cancelLabel: cancellationRequested ? "尝试停止中" : "请求停止"
            )
        case .queued:
            return .init(
                statusLabel: "排队中",
                subtitle: cancellationRequested ? "正在尝试停止，等待运行状态回流" : "等待空闲执行槽",
                latestProgress: nil,
                terminalConclusion: nil,
                failureGuidance: nil,
                evidenceSummary: evidenceSummary,
                canRequestCancel: !cancellationRequested,
                cancelLabel: cancellationRequested ? "尝试停止中" : "请求停止"
            )
        case .running:
            let latest = latestProgress(for: run)
            return .init(
                statusLabel: "进行中",
                subtitle: cancellationRequested ? "正在尝试停止，等待运行状态回流" : latest ?? "正在执行",
                latestProgress: latest,
                terminalConclusion: nil,
                failureGuidance: nil,
                evidenceSummary: evidenceSummary,
                canRequestCancel: !cancellationRequested,
                cancelLabel: cancellationRequested ? "尝试停止中" : "请求停止"
            )
        case .completed:
            let conclusion = nonEmpty(run.summary) ?? "子 Agent 已完成，但未提供结果摘要。"
            return .init(
                statusLabel: "已完成",
                subtitle: conclusion,
                latestProgress: terminalProgress(for: run),
                terminalConclusion: conclusion,
                failureGuidance: nil,
                evidenceSummary: evidenceSummary,
                canRequestCancel: false,
                cancelLabel: nil
            )
        case .failed:
            let conclusion = nonEmpty(run.error) ?? "子 Agent 执行失败，未返回具体错误。"
            return .init(
                statusLabel: "失败",
                subtitle: conclusion,
                latestProgress: terminalProgress(for: run),
                terminalConclusion: conclusion,
                failureGuidance: "当前没有独立重试通道；可让父 Agent 根据此结论重新委派。",
                evidenceSummary: evidenceSummary,
                canRequestCancel: false,
                cancelLabel: nil
            )
        case .cancelled:
            let conclusion = nonEmpty(run.error) ?? "已收到子 Agent 取消终态。"
            return .init(
                statusLabel: "已取消",
                subtitle: conclusion,
                latestProgress: nil,
                terminalConclusion: conclusion,
                failureGuidance: nil,
                evidenceSummary: evidenceSummary,
                canRequestCancel: false,
                cancelLabel: nil
            )
        }
    }

    private static func latestProgress(for run: SubagentRun) -> String? {
        guard let tool = nonEmpty(run.latestTool) else {
            if let stepCount = run.stepCount, stepCount > 0 { return "正在执行第 \(stepCount) 步" }
            return nil
        }
        let prefix: String
        switch run.latestToolStatus {
        case .pending:
            prefix = "准备使用"
        case .running:
            prefix = "正在使用"
        case .completed:
            prefix = "刚完成"
        case .failed:
            prefix = "工具失败"
        case nil:
            prefix = run.latestSuccess == false ? "工具失败" : "正在使用"
        }
        if let stepCount = run.stepCount, stepCount > 0 {
            return "第 \(stepCount) 步 · \(prefix) \(tool)"
        }
        return "\(prefix) \(tool)"
    }

    /// 终态不能沿用“正在使用工具”这类过程文案：stream 的最后一个工具状态可能尚未
    /// 刷新，但 run 的 completed / failed 已经是更高优先级的终态事实。
    private static func terminalProgress(for run: SubagentRun) -> String? {
        if let tool = nonEmpty(run.latestTool) {
            if run.latestToolStatus == .failed || run.latestSuccess == false {
                return "最后一个工具失败：\(tool)"
            }
            return "最后一个工具：\(tool)"
        }
        if let stepCount = run.stepCount, stepCount > 0 {
            return "共执行 \(stepCount) 步"
        }
        return nil
    }

    private static func evidenceSummary(for run: SubagentRun) -> String {
        let toolCount = run.transcript.filter { $0.kind == .tool }.count
        let transcriptCount = run.transcript.count
        if toolCount == 0, transcriptCount == 0 {
            return "暂无可展开的执行证据"
        }
        var parts: [String] = []
        if toolCount > 0 { parts.append("\(toolCount) 个工具步骤") }
        if transcriptCount > 0 { parts.append("\(transcriptCount) 条执行流") }
        return "执行证据：" + parts.joined(separator: "，")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
