import Foundation

/// 任务行第二行放什么，以及标题因此能占几行。
///
/// 第二行回答「这条任务讲到哪了」——默认给**最后一条消息的预览**（Agent 说的
/// 或你说的都算）。这是列表里信息量最大的一行：扫一眼就知道该不该点进去。
///
/// 唯一压过预览的是**要你动手**的状态（等你确认 / 运行失败）：那不是进展播报，
/// 是行动号召，必须先喊住人。「运行中 / 已暂停」不抢——头像上的光环已经说清楚了，
/// 再用文字重复一遍就是把最有用的那行让给了废话。
///
/// 归属名（Workspace / Project）降为兜底：它是筛选维度，顶部范围选择器已经常驻
/// 显示，没必要每行再抄一遍；只有连预览都没有（空会话）时才用它填坑。
///
/// 核心约束仍是「标题和第二行共用两行文本预算」：第二行有内容时标题一行，
/// 第二行空着时标题放开到两行。这样长标题不被截断，列表行高也始终一致。
enum TaskRowContentPolicy {
    enum Kind: Equatable {
        /// 等你确认 / 失败——有话要说，且要你动手
        case status
        /// 最后一条消息的预览
        case preview
        /// 只剩归属信息
        case location
        /// 什么都没有
        case empty
    }

    struct SecondLine: Equatable {
        var kind: Kind
        /// 第二行主文本，按 `kind` 决定语义与配色。
        var text: String?
        var badge: TaskRowStatusPresentation.Badge
        var isArchived: Bool

        var isOccupied: Bool {
            kind != .empty || isArchived
        }
    }

    static func secondLine(
        session: RecentSession,
        state: AgentRunPresentationState
    ) -> SecondLine {
        let badge = TaskRowStatusPresentation.resolve(from: state)
        let isArchived = normalized(session.status)?.lowercased() == "archived"

        func line(_ kind: Kind, _ text: String?) -> SecondLine {
            SecondLine(kind: kind, text: text, badge: badge, isArchived: isArchived)
        }

        if let blocking = blockingStatusText(for: state) {
            return line(.status, blocking)
        }
        if let preview = messagePreview(session: session) {
            return line(.preview, preview)
        }
        if let running = runningStatusText(for: state) {
            return line(.status, running)
        }
        if let locationName = locationName(session: session) {
            return line(.location, locationName)
        }
        return line(.empty, nil)
    }

    /// 归属只报一个名字：在 Project 里干活时用户认的是 Project，其余场景认 Workspace。
    static func locationName(session: RecentSession) -> String? {
        if normalized(session.projectId) != nil, let projectName = normalized(session.projectName) {
            return projectName
        }
        return normalized(session.spaceName)
    }

    /// 消息预览是多行原文，直接塞进单行会把换行渲染成断头文本——先把所有空白折成单空格。
    static func messagePreview(session: RecentSession) -> String? {
        guard let raw = normalized(session.lastMessagePreview) else { return nil }
        let collapsed = raw
            .split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .joined(separator: " ")
        return collapsed.isEmpty ? nil : collapsed
    }

    static func titleLineLimit(secondLine: SecondLine) -> Int {
        secondLine.isOccupied ? 1 : 2
    }

    /// 要人动手的状态。压过预览，因为用户点进去是为了「做事」而不是「读上一句」。
    private static func blockingStatusText(for state: AgentRunPresentationState) -> String? {
        switch state.phase {
        case .waitingForUser:
            return L10n.Home.rowStatusWaitingForUser
        case .failed:
            return L10n.Home.rowStatusFailed
        default:
            return nil
        }
    }

    /// 不需要人动手的进行态。仅在没有预览可显示时兜底，避免和头像光环重复。
    private static func runningStatusText(for state: AgentRunPresentationState) -> String? {
        switch state.phase {
        case .paused:
            return L10n.RunStatus.paused
        case .preparing, .planning, .executing, .responding, .recoveringConnection:
            return state.currentAction ?? L10n.Home.sessionStatusRunning
        case .idle, .completed, .waitingForUser, .failed:
            return nil
        }
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
