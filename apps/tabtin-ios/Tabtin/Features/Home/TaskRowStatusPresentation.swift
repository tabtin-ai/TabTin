import SwiftUI

/// 任务行状态角标：把 9 种运行态收敛成 4 种「要不要现在管」的视觉信号。
///
/// 收敛原则是紧迫度而非技术状态——用户不关心 queued 和 running 的区别，
/// 只关心「在跑 / 等我 / 崩了 / 完事了」。
enum TaskRowStatusPresentation {
    enum Badge: Equatable {
        /// 正在跑，不需要你动手
        case running
        /// 卡着等你，或被暂停
        case attention
        /// 这一轮失败了
        case failed
        /// 已完成
        case done
        /// 静默，不渲染角标
        case none
    }

    static func resolve(from state: AgentRunPresentationState) -> Badge {
        switch state.phase {
        case .preparing, .planning, .executing, .responding, .recoveringConnection:
            return .running
        case .waitingForUser, .paused:
            return .attention
        case .failed:
            return .failed
        case .completed:
            return .done
        case .idle:
            return .none
        }
    }

    /// 是否进「需要你」置顶区。只认 waitingForUser——paused 是 Agent 自己停下，
    /// 不是在等人，把它捞进来会让这个区失去「点进去就有事做」的确定性。
    static func needsUserAction(_ state: AgentRunPresentationState) -> Bool {
        if case .waitingForUser = state.phase { return true }
        return false
    }
}

extension TaskRowStatusPresentation.Badge {
    var symbolName: String? {
        switch self {
        case .running: return "play.fill"
        case .attention: return "exclamationmark"
        case .failed: return "xmark"
        case .done: return "checkmark"
        case .none: return nil
        }
    }

    var tint: Color {
        switch self {
        case .running: return .tt.bgRunning
        case .attention: return .tt.bgWarning
        case .failed: return .tt.bgCritical
        case .done: return .tt.bgSuccess
        case .none: return .clear
        }
    }
}
