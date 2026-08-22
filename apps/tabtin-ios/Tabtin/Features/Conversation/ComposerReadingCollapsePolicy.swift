import Foundation

/// 消息列表滚动态快照：驱动「阅读时 Composer 收敛」。
struct MessageListScrollState: Equatable, Sendable {
    /// 手指正在拖动，或松手后的惯性滚动还没停。
    var isUserScrolling: Bool = false
    /// 视口停在（或已回到）最新消息处。
    var isAtBottom: Bool = true

    /// 初始态：没在滚，停在最新消息处。
    static let settledAtBottom = MessageListScrollState()
}

/// Composer 的「阅读态收敛」决策。
///
/// 产品意图：开始翻消息 = 用户在读、不在写。此时输入区让出屏幕高度，收成一行悬浮
/// 胶囊；回到最新消息处再自然展开。收敛只折叠输入井的视觉体积，不改变任何可发送
/// 状态——运行控制（停止 / 继续）在收敛态照样在位。
enum ComposerReadingCollapsePolicy {
    /// 滚动层判据：滚动中一律收敛；停下后只有「停在底部」才展开——停在历史中间说明
    /// 用户还在读。
    ///
    /// 滚动过程中刻意不看 `isAtBottom`，是为了避开这条自激回路：收敛让输入区变矮 →
    /// 列表底部 inset 变小 → 距底距离随之变小 → 判成贴底 → 展开 → inset 变大 → 又
    /// 不贴底 → 再收敛。判据只在滚动停下后取一次，回路就断了。
    static func scrollWantsCollapse(_ state: MessageListScrollState) -> Bool {
        if state.isUserScrolling { return true }
        return !state.isAtBottom
    }

    /// 内容层判据：输入区里只要有用户自己的东西（草稿 / 附件 / 引用 / 正在输入），或有
    /// 必须让他看见的东西（硬门闩禁发原因），就一律不收——收敛绝不能藏掉写了一半的
    /// 内容或发不出去的原因。
    static func shouldCollapse(
        scrollWantsCollapse: Bool,
        isFocused: Bool,
        hasDraftText: Bool,
        hasAttachments: Bool,
        hasContextRefs: Bool,
        hasBlockingReason: Bool
    ) -> Bool {
        guard scrollWantsCollapse else { return false }
        if isFocused || hasDraftText || hasAttachments || hasContextRefs { return false }
        if hasBlockingReason { return false }
        return true
    }
}

/// Composer 右侧主按钮：发送、发送中、停止，三者不得共用同一手势槽。
enum ComposerPrimaryAction: Equatable {
    case send
    case sending
    case stop
    case none
}

enum ComposerPrimaryActionPolicy {
    /// 刚变成可停止后的短暂窗口：同一位置上的发送手势不得立刻变成停止。
    static let stopArmDelay: Duration = .milliseconds(450)

    static func action(
        canSubmitCurrentDraft: Bool,
        canCancel: Bool,
        sendInFlight: Bool,
        cancelControlPending: Bool = false,
        isPaused: Bool = false,
        pauseControlPending: Bool = false,
        stopArmed: Bool = false
    ) -> ComposerPrimaryAction {
        if cancelControlPending || isPaused || pauseControlPending {
            return .stop
        }
        if sendInFlight {
            return .sending
        }
        if canCancel, !canSubmitCurrentDraft {
            return stopArmed ? .stop : .sending
        }
        if canSubmitCurrentDraft {
            return .send
        }
        return .none
    }
}
