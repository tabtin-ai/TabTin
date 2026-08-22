import Foundation

/// 任务首页的运行范围（活跃 / 等我确认 / 进行中 / 已归档）。
/// UI 入口已下线，列表固定用 `.all`；枚举仍承载服务端 wire 参数与单测。
enum TaskHomeScope: String, CaseIterable, Identifiable, Hashable {
    case all
    case needsYou
    case running
    case archived

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return L10n.Home.scopeAll
        case .needsYou: return L10n.Home.scopeNeedsYou
        case .running: return L10n.Home.scopeRunning
        case .archived: return L10n.Home.scopeArchived
        }
    }

    /// 下推到服务端的参数。nil 表示该维度不过滤。
    var wireStatus: String? {
        switch self {
        case .archived: return "archived"
        case .all, .needsYou, .running: return "active"
        }
    }

    var wireRunStatus: String? {
        switch self {
        case .needsYou: return "waiting_user"
        case .running: return "running"
        case .all, .archived: return nil
        }
    }

    func matches(state: AgentRunPresentationState, session: RecentSession) -> Bool {
        let isArchived = (session.status?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()) == "archived"
        switch self {
        case .all:
            return !isArchived
        case .archived:
            return isArchived
        case .needsYou:
            return !isArchived && TaskRowStatusPresentation.needsUserAction(state)
        case .running:
            return !isArchived && state.isActive
        }
    }
}
