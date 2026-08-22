import SwiftUI

struct AgentRunStatusSymbol: View {
    let state: AgentRunPresentationState

    var body: some View {
        Image(systemName: copy.symbolName)
            .font(.tt.iconCaption)
            .foregroundStyle(copy.tint)
            .accessibilityHidden(true)
    }

    private var copy: AgentRunPresentationCopy {
        AgentRunPresentationCopy(state: state)
    }
}

/// 任务首页行内状态：图标与文案双重表达，不依赖颜色区分运行、待确认和未读。
struct AgentRunRowStatus: View {
    let state: AgentRunPresentationState

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            AgentRunStatusSymbol(state: state)

            Text(copy.rowText)
                .font(.tt.captionSemibold)
                .foregroundStyle(copy.tint)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(copy.accessibilityText)
    }

    private var copy: AgentRunPresentationCopy {
        AgentRunPresentationCopy(state: state)
    }
}

private struct AgentRunPresentationCopy {
    let state: AgentRunPresentationState

    var title: String {
        switch state.phase {
        case .idle:
            return L10n.RunStatus.idle
        case .preparing, .planning:
            // preparing 不再单独露出「正在准备…」文案。
            return L10n.RunStatus.planning
        case .executing:
            return L10n.RunStatus.executing
        case .responding:
            return L10n.RunStatus.responding
        case .waitingForUser(let count):
            return L10n.RunStatus.waitingForUser(count)
        case .paused:
            return L10n.RunStatus.paused
        case .recoveringConnection:
            return L10n.RunStatus.recoveringConnection
        case .completed(let hasUnreadReply):
            return hasUnreadReply ? L10n.Home.sessionStatusUnread : L10n.RunStatus.completed
        case .failed:
            return L10n.RunStatus.failed
        }
    }

    var detail: String? {
        if case .failed = state.phase {
            return state.failureReason
        }
        guard let action = state.currentAction else { return nil }
        return L10n.RunStatus.currentAction(action)
    }

    var rowText: String {
        switch state.phase {
        case .executing where state.currentAction == nil:
            return L10n.Home.sessionStatusRunning
        case .waitingForUser:
            return title
        case .completed(hasUnreadReply: true):
            return L10n.Home.sessionStatusUnread
        default:
            return detail ?? title
        }
    }

    var recoveryText: String? {
        switch state.recovery {
        case .retry:
            return L10n.RunStatus.canRetry
        case .checkBilling:
            return L10n.RunStatus.checkBilling
        case .relogin:
            return L10n.RunStatus.relogin
        case .newConversation:
            return L10n.RunStatus.newConversation
        case nil:
            return nil
        }
    }

    var recoverySymbolName: String {
        switch state.recovery {
        case .checkBilling:
            return "creditcard"
        case .relogin:
            return "person.crop.circle.badge.exclamationmark"
        case .newConversation:
            return "plus.bubble"
        case .retry, nil:
            return "arrow.clockwise"
        }
    }

    var accessibilityText: String {
        [title, detail, recoveryText]
            .compactMap { $0 }
            .joined(separator: "，")
    }

    var symbolName: String {
        switch state.phase {
        case .idle:
            return "circle"
        case .preparing, .responding:
            return "sparkles"
        case .planning:
            return "brain"
        case .executing:
            return state.currentAction == nil ? "bolt.fill" : "wrench.and.screwdriver.fill"
        case .waitingForUser:
            return "person.crop.circle.badge.questionmark"
        case .paused:
            return "pause.circle.fill"
        case .recoveringConnection:
            return "wifi.exclamationmark"
        case .completed:
            return "checkmark.circle.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }

    var tint: Color {
        switch state.phase {
        case .failed:
            return .tt.textCritical
        case .waitingForUser, .paused, .recoveringConnection:
            return .tt.textWarning
        case .completed:
            return .tt.textSuccess
        case .idle:
            return .tt.textTertiary
        case .preparing, .planning, .executing, .responding:
            return .tt.textAccent
        }
    }
}
