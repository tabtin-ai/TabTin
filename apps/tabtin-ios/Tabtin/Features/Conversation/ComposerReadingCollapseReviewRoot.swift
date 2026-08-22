#if DEBUG
import SwiftUI

/// 「阅读时 Composer 收敛」的确定性视觉夹具。用
/// `--composer-reading-collapse-review` 启动，不依赖登录、后端或执行设备，
/// 便于逐轮验证：滑动消息 → 输入区收成悬浮胶囊；回到最新 → 自然展开；
/// 点胶囊 → 展开并聚焦。
struct ComposerReadingCollapseReviewRoot: View {
    @State private var text = ""
    @State private var collapsedForReading = false

    private static let agent = ComposerTaskAgentOption(
        id: "review-agent",
        name: "小豆子",
        avatar: "豆"
    )

    private static let messages: [ChatMessage] = (1...14).flatMap { round -> [ChatMessage] in
        [
            ChatMessage(
                id: "u-\(round)",
                role: .user,
                text: "第 \(round) 轮：帮我看看这块的实现思路。"
            ),
            ChatMessage(
                id: "a-\(round)",
                role: .assistant,
                text: """
                第 \(round) 轮回复：先把链路拆成「输入 → 变换 → 渲染」三段，再定位分叉点。
                这里多写几行是为了把列表撑高，好让夹具能真的滚起来，验证输入区在阅读时
                的收敛与回到底部后的展开。
                """
            ),
        ]
    }

    var body: some View {
        MessageListView(
            messages: Self.messages,
            agentOptions: [Self.agent],
            onScrollStateChange: { state in
                let collapse = ComposerReadingCollapsePolicy.scrollWantsCollapse(state)
                guard collapse != collapsedForReading else { return }
                collapsedForReading = collapse
            }
        ) {
            ComposerView(
                text: $text,
                collapsedForReading: collapsedForReading,
                currentMode: "agent",
                currentAgentName: Self.agent.name,
                agentOptions: [Self.agent],
                selectedAgentId: Self.agent.id,
                agentIsMutable: true,
                currentApprovalMode: "always_ask",
                executionWorkspaceName: "2026-06-07-17-33-35",
                selectedModelName: "Kimi K2.5",
                onSend: { _ in },
                onCancel: {},
                onPause: {},
                onResume: {}
            )
            .ttComposerTopScrim()
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }
}
#endif
