import SwiftUI

/// 会话列表行的「待处理」pill——该会话存在打断会话流程、等用户处理的事项
/// （工具审批 / 选择题 / 表单 / 权限请求）时显示。
///
/// 数据源：`PendingInteractionStore.shared`（HTTP 全量 + WS 用户级事件增量）。
/// 在行 View 的 body 里读 `PendingInteractionStore.shared.hasPendingForSession(id)`
/// 即可随 @Observable 自动刷新。
struct PendingInteractionPill: View {
    var body: some View {
        Text(L10n.Agent.sessionPendingPill)
            .font(.tt.captionSemibold)
            .foregroundStyle(.tt.textAccent)
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, 2)
            .background(Capsule().fill(.tt.textAccent.opacity(0.12)))
            .lineLimit(1)
            .fixedSize()
    }
}
