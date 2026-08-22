import SwiftUI

/// TabChat IM 会话列表（Phase A 最小骨架）。
///
/// 产品入口 IA（放「最近」tab / 新开 tab / 嵌 Space）留 Phase B 决策；当前仅提供
/// 可独立渲染的列表视图，用于打通「REST 拉会话列表 → 渲染」这条链路。
/// 单会话详情、实时消息在 Phase B 接入。
struct TabChatRoot: View {
    let organizationId: String

    @State private var store = IMConversationStore.shared

    var body: some View {
        Group {
            if store.isLoading && store.conversations.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.loadError, store.conversations.isEmpty {
                ContentUnavailableView {
                    Label("加载失败", systemImage: "exclamationmark.bubble")
                } description: {
                    Text(error)
                } actions: {
                    Button("重试") {
                        store.loadConversations(organizationId: organizationId)
                    }
                }
            } else if store.conversations.isEmpty {
                ContentUnavailableView("暂无会话", systemImage: "bubble.left.and.bubble.right")
            } else {
                List(store.conversations) { conversation in
                    IMConversationRow(conversation: conversation)
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("消息")
        .task { store.loadConversations(organizationId: organizationId) }
        .refreshable { await store.reload(organizationId: organizationId) }
    }
}

/// 会话列表单行：头像占位 + 名称 + 最近预览 + 未读角标。
private struct IMConversationRow: View {
    let conversation: IMConversation

    var body: some View {
        HStack(spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.name.isEmpty ? "未命名会话" : conversation.name)
                    .font(.tt.body)
                    .lineLimit(1)
                if !conversation.lastMessagePreview.isEmpty {
                    Text(conversation.lastMessagePreview)
                        .font(.tt.body)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if conversation.unreadCount > 0 {
                unreadBadge
            }
        }
        .padding(.vertical, 4)
    }

    private var avatar: some View {
        Circle()
            .fill(Color.secondary.opacity(0.15))
            .frame(width: 44, height: 44)
            .overlay {
                Image(systemName: conversation.type == IMConversationType.group.rawValue
                      ? "person.2.fill" : "person.fill")
                    .foregroundStyle(.secondary)
            }
    }

    private var unreadBadge: some View {
        Text(conversation.unreadCount > 99 ? "99+" : "\(conversation.unreadCount)")
            .font(.tt.iconCaption)
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.red))
    }
}
