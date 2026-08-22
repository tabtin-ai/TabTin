import SwiftUI

/// 任务首页会话行：左侧 Agent 头像（状态画在头像上）+ 标题 / 第二行 + 行尾时间与图钉。
///
/// 版式参考 OpenMinis 会话列表：44pt 圆头像、16pt 标题、行尾右对齐时间。
/// 头像换成会话所属 Agent 的头像——列表回答的第一个问题是「谁在替我干这件事」。
struct TaskHomeSessionRow: View {
    let session: RecentSession
    var isPinned = false
    var isMutating = false
    var statusOverride: TaskHomeSessionStatusOverride?
    var resolvedRunStatus: SessionRunStatus?

    private var hasPendingInteraction: Bool {
        PendingInteractionStore.shared.hasPendingForSession(session.id)
    }

    private var runState: AgentRunPresentationState {
        TaskHomeSessionStatusPolicy.presentation(
            for: session,
            resolvedRunStatus: resolvedRunStatus,
            statusOverride: statusOverride,
            hasPendingInteraction: hasPendingInteraction
        )
    }

    /// 服务端还没生成标题时给的是占位文案，不是用户写的内容——弱化它。
    private var hasRealTitle: Bool {
        (session.title?.trimmingCharacters(in: .whitespacesAndNewlines)).map { !$0.isEmpty } ?? false
    }

    private var secondLine: TaskRowContentPolicy.SecondLine {
        TaskRowContentPolicy.secondLine(session: session, state: runState)
    }

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.md) {
            TaskHomeSessionAvatar(session: session, state: runState)

            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                Text(session.displayTitle)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(hasRealTitle ? .tt.textPrimary : .tt.textTertiary)
                    .lineLimit(TaskRowContentPolicy.titleLineLimit(secondLine: secondLine))

                if secondLine.isOccupied {
                    secondLineView
                }

                if let match = normalized(session.searchMatchContext) {
                    Label(match, systemImage: "magnifyingglass")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // 时间与图钉右对齐成一列：扫列表时目光只在一条竖线上走，不被标题长短带偏。
            VStack(alignment: .trailing, spacing: TTSpacing.xs) {
                if let time = session.displayTime {
                    Text(time)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }

                if isPinned {
                    Image(systemName: "pin.fill")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textTertiary)
                        .accessibilityLabel(L10n.Home.segmentPinned)
                }
            }
            .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.md)
        .contentShape(Rectangle())
        .opacity(isMutating ? 0.58 : 1)
    }

    /// 第二行全是弱文本，靠 `·` 串起来——不用灰底 chip，色块在列表里太吵。
    @ViewBuilder
    private var secondLineView: some View {
        HStack(spacing: TTSpacing.xs) {
            if secondLine.isArchived {
                metaText(L10n.Home.statusArchived, color: .tt.textTertiary)
                    .layoutPriority(1)
                if secondLine.text != nil { separator }
            }
            if let text = secondLine.text {
                metaText(text, color: secondLineColor)
                    .layoutPriority(0)
            }
        }
    }

    private func metaText(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.tt.meta)
            .foregroundStyle(color)
            .lineLimit(1)
    }

    private var separator: some View {
        Text(verbatim: "·")
            .font(.tt.meta)
            .foregroundStyle(.tt.textTertiary.opacity(0.6))
    }

    /// 状态用语义色喊人；预览和归属是背景信息，一律弱色，别跟状态抢注意力。
    private var secondLineColor: Color {
        switch secondLine.kind {
        case .status:
            switch secondLine.badge {
            case .attention: return .tt.textWarning
            case .failed: return .tt.textCritical
            case .running: return .tt.textRunning
            case .done, .none: return .tt.textSecondary
            }
        case .preview, .location, .empty:
            return .tt.textTertiary
        }
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum TaskHomeSessionStatusOverride: Equatable {
    case completedUnread
    case completedRead
    case failed
    case interrupted

    var summaryFlags: (isActive: Bool, isUnread: Bool, isFailed: Bool) {
        switch self {
        case .completedUnread:
            return (false, true, false)
        case .failed:
            return (false, false, true)
        case .completedRead, .interrupted:
            return (false, false, false)
        }
    }
}

enum TaskHomeSessionStatusPolicy {
    private static let terminalTypes = Set([
        "agent.task.completed",
        "agent.task.error",
        "agent.task.interrupted",
    ])

    static func override(
        for session: RecentSession,
        notifications: [MobileNotification]
    ) -> TaskHomeSessionStatusOverride? {
        guard let notification = notifications.first(where: {
            terminalTypes.contains($0.type)
                && $0.metadata["session_id"]?.stringValue == session.id
        }) else { return nil }

        // 旧轮次终态不能覆盖其后新发起的一轮。服务端时间均为 ISO-8601；
        // 解析失败时宁可不覆盖，也不把正在运行误投影成已完成。
        if let lastMessageAt = session.lastMessageAt,
           !isAtOrAfter(notification.createdAt, lastMessageAt) {
            return nil
        }

        switch notification.type {
        case "agent.task.error":
            return .failed
        case "agent.task.interrupted":
            return .interrupted
        default:
            return notification.isRead ? .completedRead : .completedUnread
        }
    }

    static func presentation(
        for session: RecentSession,
        resolvedRunStatus: SessionRunStatus?,
        statusOverride: TaskHomeSessionStatusOverride?,
        hasPendingInteraction: Bool
    ) -> AgentRunPresentationState {
        if let resolvedRunStatus {
            return AgentRunPresentationState.sessionSummary(
                runStatus: resolvedRunStatus,
                hasUnreadReply: resolvedRunStatus == .completed
                    && statusOverride == .completedUnread
            )
        }
        let resolved = statusOverride?.summaryFlags ?? (
            isActive: session.hasActiveTask,
            isUnread: session.hasUnreadReply,
            isFailed: session.lastRunFailed
        )
        return AgentRunPresentationState.sessionSummary(
            hasActiveTask: resolved.isActive,
            hasUnreadReply: resolved.isUnread,
            hasPendingInteraction: hasPendingInteraction,
            hasFailedTask: resolved.isFailed
        )
    }

    private static func isAtOrAfter(_ candidate: String, _ reference: String) -> Bool {
        guard let candidateDate = parseISO(candidate),
              let referenceDate = parseISO(reference) else { return false }
        return candidateDate >= referenceDate
    }

    private static func parseISO(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        return ISO8601DateFormatter().date(from: raw)
    }
}
