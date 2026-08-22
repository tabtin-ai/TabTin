import SwiftUI

private struct IMReadReceiptActionKey: EnvironmentKey {
    nonisolated(unsafe) static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var imReadReceiptAction: (() -> Void)? {
        get { self[IMReadReceiptActionKey.self] }
        set { self[IMReadReceiptActionKey.self] = newValue }
    }
}

/// Phase E 会话内交互的展示组件 + 常量：表情回应条、撤回占位、typing 指示、已读态。
/// 交互动作（toggle/编辑/撤回）由 `IMConversationScreen` 通过 `IMMessageStore` 执行。

/// 撤回时限：与后端 `RECALL_TIMEOUT_SECONDS=120` / Electron `MESSAGE_RECALL_WINDOW_MS` 对齐。
let imRecallWindowSeconds: TimeInterval = 120

/// 手机端一行最多放 5 个回应，避免表情条横跨整块消息区。
let imReactionMaxItemsPerRow = 5

/// 撤回失败必须转成用户可见反馈；成功时不打扰用户。
func imRecallFeedbackMessage(success: Bool) -> String? {
    success ? nil : "消息撤回失败，请稍后重试"
}

/// 消息发送时间（ISO8601）解析；解析失败返回 nil。
func imParseTimestamp(_ raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = withFraction.date(from: raw) { return d }
    return ISO8601DateFormatter().date(from: raw)
}

/// 是否仍在撤回时限内（仅本人文本/附件消息可撤回）。
func imWithinRecallWindow(_ message: IMMessage, now: Date = Date()) -> Bool {
    guard let created = imParseTimestamp(message.createdAt) else { return false }
    return now.timeIntervalSince(created) <= imRecallWindowSeconds
}

/// IM 文本气泡色 / 形，对齐 Electron `IMMessageBubble`：
/// 己方 `foreground/[0.06]`、对方 `accent/10`、`rounded-2xl` + 尾角（`TTBubbleShape`）。
enum IMTextBubbleChrome {
    static func fill(isMine: Bool) -> Color {
        isMine
            ? Color.tt.textPrimary.opacity(0.06)
            : Color.tt.bgAccent.opacity(0.10)
    }

    static func shape(isMine: Bool) -> UnevenRoundedRectangle {
        isMine ? TTBubbleShape.outgoing : TTBubbleShape.incoming
    }
}

/// IM 消息时间线分组，对齐 Electron `IMMessageBubble`（Discord 单列口径）。
enum IMMessageTimeline {
    /// 连续消息超过该间隔视为新一组（Electron `shouldShowTimestamp`）。
    static let gapBreakInterval: TimeInterval = 5 * 60

    static func isSameCalendarDay(_ a: String?, _ b: String?) -> Bool {
        guard let da = imParseTimestamp(a), let db = imParseTimestamp(b) else { return false }
        return Calendar.current.isDate(da, inSameDayAs: db)
    }

    static func shouldShowDateDivider(for message: IMMessage, previous: IMMessage?) -> Bool {
        guard let previous else { return true }
        return !isSameCalendarDay(previous.createdAt, message.createdAt)
    }

    static func shouldShowTimestampGap(current: IMMessage, previous: IMMessage?) -> Bool {
        guard let previous else { return true }
        guard let curr = imParseTimestamp(current.createdAt),
              let prev = imParseTimestamp(previous.createdAt) else { return true }
        return curr.timeIntervalSince(prev) > gapBreakInterval
    }

    static func senderChanged(current: IMMessage, previous: IMMessage?) -> Bool {
        guard let previous else { return true }
        return previous.senderId != current.senderId
            || previous.senderType != current.senderType
    }

    /// 组首：跨天 / 超 5 分钟 / 发送者变化。
    static func isGroupStart(current: IMMessage, previous: IMMessage?) -> Bool {
        previous?.isDeleted == true
            || shouldShowDateDivider(for: current, previous: previous)
            || shouldShowTimestampGap(current: current, previous: previous)
            || senderChanged(current: current, previous: previous)
    }

    /// 对方消息仅在消息组首展示头像；组内连续消息保留头像槽对齐。
    static func showsIncomingAvatar(
        for message: IMMessage,
        previous: IMMessage?,
        currentUserId: String?
    ) -> Bool {
        guard message.senderId != currentUserId else { return false }
        return isGroupStart(current: message, previous: previous)
    }

    /// 对齐 Electron：仅群聊中的真人对方头像可进入私聊；本人、Agent、系统消息和私聊内头像均不可点。
    static func canOpenSenderDirectMessage(
        for message: IMMessage,
        isDirectMessage: Bool,
        currentUserId: String?
    ) -> Bool {
        guard !isDirectMessage,
              message.senderId != currentUserId,
              !message.isFromAgent,
              message.messageType != IMMessageType.system.rawValue,
              message.senderId != "system" else {
            return false
        }
        return !message.senderId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// 日期分割线文案：今天 / 昨天 / 月日（同年省略年）。
    static func formatDateDivider(_ raw: String?, now: Date = Date()) -> String {
        guard let date = imParseTimestamp(raw) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return L10n.Common.today }
        if calendar.isDateInYesterday(date) { return L10n.Common.yesterday }
        let formatter = DateFormatter()
        formatter.locale = LanguageManager.shared.effectiveLocale
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "Md" : "yMd")
        return formatter.string(from: date)
    }

    /// 组首时分（"14:30"），对齐 Electron `formatMessageClock`。
    /// 桌面靠 hover 显隐；手机无 hover，仅在组首常显。
    static func formatMessageClock(_ raw: String?) -> String {
        guard let date = imParseTimestamp(raw) else { return "" }
        let formatter = DateFormatter()
        formatter.locale = LanguageManager.shared.effectiveLocale
        formatter.setLocalizedDateFormatFromTemplate("Hm")
        return formatter.string(from: date)
    }
}

enum IMConversationAvatarPolicy {
    private static let adminRole = 2

    static func canEditGroupAvatar(
        _ detail: IMConversationDetail,
        currentUserId: String?
    ) -> Bool {
        guard detail.conversationType == .group,
              let currentUserId,
              !currentUserId.isEmpty else {
            return false
        }
        return detail.members.contains { member in
            member.typedMemberType == .user
                && member.userId == currentUserId
                && member.role >= adminRole
        }
    }
}

/// 跨天日期分割线（居中 caption，对齐 Electron date divider）。
struct IMMessageDateDivider: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.tt.captionMedium)
            .foregroundStyle(.tt.textTertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.md)
            .accessibilityAddTraits(.isHeader)
    }
}

/// 表情回应条：展示每个 emoji + 计数，本人点过的高亮描边；点击切换。
struct IMReactionBar: View {
    let reactions: [String: [String]]
    let reactionOrder: [String]
    let currentUserId: String?
    let isMine: Bool
    let onToggle: (String) -> Void

    private var items: [(emoji: String, users: [String])] {
        orderedIMReactionItems(reactions, order: reactionOrder)
    }

    private var rows: [[(emoji: String, users: [String])]] {
        chunkedIMReactionItems(items, maxItemsPerRow: imReactionMaxItemsPerRow)
    }

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 4) {
                        ForEach(row, id: \.emoji) { item in
                            chip(emoji: item.emoji, count: item.users.count,
                                 reactedByMe: currentUserId.map(item.users.contains) ?? false)
                        }
                    }
                }
            }
        }
    }

    private func chip(emoji: String, count: Int, reactedByMe: Bool) -> some View {
        Button {
            onToggle(emoji)
        } label: {
            HStack(spacing: 3) {
                Text(emoji).font(.tt.iconCaption)
                Text("\(count)").font(.tt.captionMedium)
                    .foregroundStyle(reactedByMe ? Color.tt.textAccent : Color.tt.textSecondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(reactedByMe ? Color.tt.bgAccent.opacity(0.16) : Color.tt.bgSubtleSecondary, in: Capsule())
            .overlay(
                Capsule().stroke(reactedByMe ? Color.tt.bgAccent.opacity(0.7) : Color.tt.borderLight, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }
}

/// 与 Electron 的 `Object.entries(reactions)` 保持一致：沿用 reaction 数据顺序，
/// 已有表情不换位，新表情追加；不要按 emoji 字符串重新排序。
func orderedIMReactionItems(
    _ reactions: [String: [String]],
    order: [String]
) -> [(emoji: String, users: [String])] {
    var seen = Set<String>()
    let emojis = order + reactions.keys.filter { !order.contains($0) }
    return emojis.compactMap { emoji in
        guard seen.insert(emoji).inserted,
              let users = reactions[emoji], !users.isEmpty else { return nil }
        return (emoji, users)
    }
}

func chunkedIMReactionItems<T>(_ items: [T], maxItemsPerRow: Int) -> [[T]] {
    guard maxItemsPerRow > 0 else { return items.isEmpty ? [] : [items] }
    return stride(from: 0, to: items.count, by: maxItemsPerRow).map { start in
        Array(items[start ..< min(start + maxItemsPerRow, items.count)])
    }
}

/// 已读比例：用一个紧凑圆形扇区表达群聊阅读覆盖率；DM 已读即 100%。
struct IMReadProgressIndicator: View {
    let readCount: Int
    let recipientCount: Int
    @Environment(\.imReadReceiptAction) private var openReadReceipts

    private var clampedReadCount: Int {
        min(max(readCount, 0), max(recipientCount, 0))
    }

    private var safeRecipientCount: Int {
        max(recipientCount, 1)
    }

    private var ratio: Double {
        Double(clampedReadCount) / Double(safeRecipientCount)
    }

    var body: some View {
        if let openReadReceipts {
            Button(action: openReadReceipts) {
                indicator
                    .padding(8)
            }
            .buttonStyle(.plain)
            .padding(-8)
            .accessibilityHint("查看已读和未读成员")
        } else {
            indicator
        }
    }

    private var indicator: some View {
        ZStack {
            if ratio >= 0.999 {
                Circle()
                    .stroke(Color.tt.textSuccess, lineWidth: 1.25)
                GeometryReader { proxy in
                    Path { path in
                        path.move(
                            to: CGPoint(
                                x: proxy.size.width * 0.29,
                                y: proxy.size.height * 0.52
                            )
                        )
                        path.addLine(
                            to: CGPoint(
                                x: proxy.size.width * 0.45,
                                y: proxy.size.height * 0.67
                            )
                        )
                        path.addLine(
                            to: CGPoint(
                                x: proxy.size.width * 0.72,
                                y: proxy.size.height * 0.38
                            )
                        )
                    }
                    .stroke(
                        Color.tt.textSuccess,
                        style: StrokeStyle(
                            lineWidth: 1.25,
                            lineCap: .round,
                            lineJoin: .round
                        )
                    )
                }
            } else if ratio > 0 {
                GeometryReader { proxy in
                    let side = min(proxy.size.width, proxy.size.height)
                    let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
                    let radius = side / 2
                    Path { path in
                        path.move(to: center)
                        path.addArc(
                            center: center,
                            radius: radius,
                            startAngle: .degrees(-90),
                            endAngle: .degrees(-90 + ratio * 360),
                            clockwise: false
                        )
                        path.closeSubpath()
                    }
                    .fill(Color.tt.bgAccent.opacity(0.72))
                }
                Circle()
                    .stroke(Color.tt.textTertiary.opacity(0.36), lineWidth: 1)
            } else {
                Circle()
                    .stroke(Color.tt.textTertiary.opacity(0.36), lineWidth: 1)
            }
        }
        .frame(width: 12, height: 12)
        .accessibilityLabel("已读 \(clampedReadCount)/\(safeRecipientCount)")
    }
}

/// 撤回占位：居中灰字，替代原气泡。
struct IMRecalledBubble: View {
    let isMine: Bool
    var canRecompose = false
    var onRecompose: () -> Void = {}

    var body: some View {
        HStack {
            Spacer(minLength: 0)
            HStack(spacing: TTSpacing.xs) {
                Text(isMine ? "你撤回了一条消息" : "对方撤回了一条消息")
                    .foregroundStyle(.tt.textTertiary)
                if canRecompose {
                    Button("重新编辑", action: onRecompose)
                        .buttonStyle(.plain)
                        .foregroundStyle(.tt.textAccent)
                        .accessibilityHint("将撤回前的内容放回输入框")
                }
            }
            .font(.tt.captionMedium)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.tt.bgSubtle, in: Capsule())
            Spacer(minLength: 0)
        }
    }
}

/// 会话系统提示：成员加入/退出等事件不是任何成员发言，统一居中显示。
struct IMSystemMessageBubble: View {
    let content: String

    var body: some View {
        HStack {
            Spacer(minLength: 0)
            Text(content)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(.tt.bgSubtle.opacity(0.72), in: Capsule())
            Spacer(minLength: 0)
        }
        .accessibilityLabel("系统提示：\(content)")
    }
}

extension IMReplyPreview {
    /// 空内容不是「附件」的同义词：撤回/失权会被服务端显式标记为不可用。
    var displayText: String {
        if isUnavailable { return "消息内容不可用" }
        if !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return content }
        if messageType == IMMessageType.image.rawValue { return "图片" }
        if messageType == IMMessageType.file.rawValue || hasAttachment {
            return fileName.isEmpty ? "文件" : "文件：\(fileName)"
        }
        return "消息内容不可用"
    }
}

/// 供 `.sheet(item:)` 使用的回复详情请求；保留当前分页内的相关消息快照。
struct IMReplyThreadRequest: Identifiable {
    let id = UUID()
    let root: IMMessage
    let replies: [IMMessage]
}

/// 手机端的回复详情以 present 形式呈现，替代桌面端右侧 ReplyThreadPanel。
struct IMReplyThreadSheet: View {
    let root: IMMessage
    let replies: [IMMessage]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("原消息") {
                    IMReplyThreadMessage(message: root)
                }
                Section("回复（\(replies.count)）") {
                    if replies.isEmpty {
                        Text("暂无已加载的回复")
                            .foregroundStyle(.tt.textSecondary)
                    } else {
                        ForEach(replies) { IMReplyThreadMessage(message: $0) }
                    }
                }
            }
            .navigationTitle("回复详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct IMReplyThreadMessage: View {
    let message: IMMessage

    private var displayText: String {
        if message.isDeleted { return "消息内容不可用" }
        if !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return message.content }
        if message.messageType == IMMessageType.image.rawValue { return "图片" }
        if message.messageType == IMMessageType.file.rawValue || message.hasAttachment {
            return message.attachmentFileName.isEmpty ? "文件" : "文件：\(message.attachmentFileName)"
        }
        return "消息内容不可用"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(message.senderName.isEmpty ? message.senderId : message.senderName)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textSecondary)
            Text(displayText)
                .font(.tt.body)
                .foregroundStyle(message.isDeleted ? .tt.textTertiary : .tt.textPrimary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }
}

/// 「对方正在输入…」指示（跳动三点）。
struct IMTypingIndicator: View {
    @State private var phase = 0
    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color.tt.textTertiary)
                        .frame(width: 5, height: 5)
                        .opacity(phase == i ? 1 : 0.3)
                }
            }
            Text("正在输入…").font(.tt.captionMedium).foregroundStyle(.tt.textTertiary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
    }
}
