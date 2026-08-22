import Foundation

/// 会话恢复的用户可见事实链。
///
/// 传输重新连上只说明 WebSocket 可用，不能代表消息时间线已经与服务端核对；只有
/// `.synced` 才表示一次 `refreshHistorySucceeded` 返回成功。初次正常进入保持 `.idle`，
/// 避免把例行历史加载误提示为“恢复”。
enum ConversationRecoveryState: Equatable, Sendable {
    case idle
    case transportInterrupted
    case reconciling
    case reconciliationDeferredWhileStreaming
    case synced
    case reconciliationFailed
}

enum ConversationRecoveryEvent: Equatable, Sendable {
    case transportInterrupted
    case reconciliationStarted
    case reconciliationDeferredWhileStreaming
    case reconciliationSucceeded
    case reconciliationFailed
    case syncedDismissed
}

enum ConversationRecoveryPolicy {
    enum ReconcileTick: Equatable, Sendable {
        case apply
        case skipWait
        case abort
    }

    static func shouldResetSeqCursor(connectedAfterDrop: Bool) -> Bool {
        connectedAfterDrop
    }

    static func shouldWaitForSubscribeBeforeResume(
        wasReconnect: Bool,
        hasDesiredTopics: Bool
    ) -> Bool {
        wasReconnect && hasDesiredTopics
    }

    static func reconcileTick(
        streamingActive: Bool,
        allowWhileStreaming: Bool
    ) -> ReconcileTick {
        if streamingActive && !allowWhileStreaming { return .skipWait }
        return .apply
    }

    static func reduce(
        _ state: ConversationRecoveryState,
        event: ConversationRecoveryEvent
    ) -> ConversationRecoveryState {
        switch event {
        case .transportInterrupted:
            return .transportInterrupted
        case .reconciliationStarted:
            return .reconciling
        case .reconciliationDeferredWhileStreaming:
            return .reconciliationDeferredWhileStreaming
        case .reconciliationSucceeded:
            return .synced
        case .reconciliationFailed:
            return .reconciliationFailed
        case .syncedDismissed:
            return state == .synced ? .idle : state
        }
    }
}

/// 不依赖 SwiftUI 的 Banner 描述，便于测试「传输已连接」和「数据已同步」不会被混淆。
struct ConversationRecoveryBanner: Equatable, Sendable {
    enum Style: Equatable, Sendable {
        case warning
        case critical
        case accent
    }

    let style: Style
    let icon: String
    let text: String
    let showsProgress: Bool
    let offersRetry: Bool
    let dataReconciled: Bool
}

enum ConversationRecoveryPresentation {
    static func banner(for state: ConversationRecoveryState) -> ConversationRecoveryBanner? {
        switch state {
        case .idle:
            return nil
        case .transportInterrupted:
            return ConversationRecoveryBanner(
                style: .warning,
                icon: "wifi.exclamationmark",
                text: "传输连接已断开，正在重连…",
                showsProgress: true,
                offersRetry: false,
                dataReconciled: false
            )
        case .reconciling:
            return ConversationRecoveryBanner(
                style: .accent,
                icon: "arrow.triangle.2.circlepath",
                text: "已连接，正在与服务器核对消息…",
                showsProgress: true,
                offersRetry: false,
                dataReconciled: false
            )
        case .reconciliationDeferredWhileStreaming:
            return ConversationRecoveryBanner(
                style: .warning,
                icon: "clock.arrow.circlepath",
                text: "已连接；当前任务仍在进行，结束后将与服务器核对消息。",
                showsProgress: true,
                offersRetry: false,
                dataReconciled: false
            )
        case .synced:
            return ConversationRecoveryBanner(
                style: .accent,
                icon: "checkmark.circle.fill",
                text: "已与服务器同步",
                showsProgress: false,
                offersRetry: false,
                dataReconciled: true
            )
        case .reconciliationFailed:
            return ConversationRecoveryBanner(
                style: .critical,
                icon: "exclamationmark.triangle.fill",
                text: "已连接，但未能与服务器核对消息，需重试。",
                showsProgress: false,
                offersRetry: true,
                dataReconciled: false
            )
        }
    }
}

/// 远程执行现场的环境态（由设备/绑定轮询驱动，不是单次发送 ACK）。
///
/// 所有权边界（避免叠层）：
/// - 非 `.ready` → Composer **硬门闩**（井内 `disabledReason`，禁发；对齐 Electron
///   `useRemoteExecutionGate.isBlocked`）。不再外挂「可先发送」横幅。
/// - `actionError` → 仅「这次用户操作失败」（且 `delivery=persisted` 的 NAK 不得写入）
/// - `OutgoingQueueStrip` → 未送达 / 持久化后执行未启动等队列异常（`awaitingDevice` 静默）
enum RemoteExecutionState: Equatable, Sendable {
    case ready
    case workspaceNeedsDevice
    case deviceUnavailable

    /// 绑定执行设备不可达或未绑定 → 禁止发送，避免提交到离线 runtime。
    var blocksComposer: Bool { self != .ready }
}

/// 远程执行阻断提示。文案进 Composer 井内，不单独挂屏幕横幅。
struct RemoteExecutionNotice: Equatable, Sendable {
    let icon: String
    let text: String
}

/// 会话标题圆点：仅 WS 已连接且绑定执行设备就绪时为绿，其余一律灰。
enum SessionReadyIndicatorPolicy {
    static func showsReady(
        gatewayConnected: Bool,
        remoteExecutionState: RemoteExecutionState
    ) -> Bool {
        gatewayConnected && remoteExecutionState == .ready
    }
}

enum RemoteExecutionNoticePresentation {
    static func notice(for state: RemoteExecutionState) -> RemoteExecutionNotice? {
        switch state {
        case .ready:
            return nil
        case .workspaceNeedsDevice:
            return RemoteExecutionNotice(
                icon: "desktopcomputer.trianglebadge.exclamationmark",
                text: "尚未关联执行设备。请先在设置里绑定电脑，再发送任务。"
            )
        case .deviceUnavailable:
            return RemoteExecutionNotice(
                icon: "",
                text: "该设备离线（请在电脑打开 TabTin 恢复连接）"
            )
        }
    }

    /// Composer 硬门闩文案；`.ready` 时为 nil。
    static func composerDisabledReason(for state: RemoteExecutionState) -> String? {
        notice(for: state)?.text
    }
}
