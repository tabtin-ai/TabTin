import SwiftUI

/// TabChat 会话详情导航目标（与 Agent 的 `ConversationTarget` 分属两套系统，不复用）。
struct IMConversationTarget: Hashable, Sendable {
    let conversationId: String
    let title: String
}

/// TabChat 会话在 IM 收件箱中的行：头像 + 名称 + 群/私信标签 + 预览 + 时间 + 未读角标。
struct IMInboxRow: View {
    let conversation: IMConversation
    var previewOverride: String? = nil
    @State private var workspace = WorkspaceStore.shared
    @State private var externalContactStore = ExternalContactDirectoryStore.shared

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            avatar
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    if conversation.pinned {
                        Image(systemName: "pin.fill")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.iconAccent)
                            .accessibilityHidden(true)
                    }
                    Text(displayTitle)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let time = displayTime {
                        Text(time)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                HStack(spacing: TTSpacing.xs) {
                    Text(kindLabel)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textAccent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.tt.bgAccent.opacity(0.12), in: Capsule())
                        .overlay(
                            Capsule()
                                .strokeBorder(Color.tt.bgAccent.opacity(0.32), lineWidth: 1)
                        )
                    ForEach(Array(conversation.labels.prefix(2))) { label in
                        Text(label.name)
                            .font(.tt.captionMedium)
                            .foregroundStyle(Color(hex: label.color))
                            .lineLimit(1)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(hex: label.color).opacity(0.12), in: Capsule())
                    }
                    if !displayPreview.isEmpty {
                        Text(displayPreview)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if conversation.unreadCount > 0 {
                        unreadBadge
                    }
                    if conversation.isMuted {
                        Image(systemName: "bell.slash.fill")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.iconSecondary)
                            .accessibilityLabel(L10n.Messages.muted)
                    }
                }
            }
        }
        .padding(.vertical, TTSpacing.sm)
        .contentShape(Rectangle())
    }

    private var displayPreview: String {
        previewOverride ?? conversation.lastMessagePreview
    }

    private var kindLabel: String {
        if conversation.isTeamSpaceChannel {
            let space = conversation.spaceName.trimmingCharacters(in: .whitespaces)
            return space.isEmpty ? L10n.Messages.channel : "\(L10n.Messages.channel) · \(space)"
        }
        if conversation.isExternal {
            return conversation.type == IMConversationType.group.rawValue ? "外部群" : "外部联系人"
        }
        return conversation.type == IMConversationType.group.rawValue
            ? L10n.Messages.groupChat
            : L10n.Messages.directMessage
    }

    private var displayTitle: String {
        let peerDisplayName = conversation.dmPeerUserId.flatMap { id in
            workspace.members.first { $0.userId == id }?.displayName
                ?? externalContactStore.contact(peerUserId: id)?.displayName
        }
        return IMConversationTitlePolicy.resolve(
            conversationName: conversation.name,
            isDirectMessage: conversation.conversationType == .dm,
            peerDisplayName: peerDisplayName,
            directMessageFallback: L10n.Messages.directMessage,
            conversationFallback: L10n.Messages.unnamedConversation
        )
    }

    private var displayTime: String? {
        guard let raw = conversation.lastMessageAt else { return nil }
        return RelativeTime.format(raw)
    }

    private var avatar: some View {
        let isChannel = conversation.isTeamSpaceChannel
        let isGroup = conversation.type == IMConversationType.group.rawValue && !isChannel
        let isDM = conversation.type == IMConversationType.dm.rawValue
        let seed: String = {
            if isDM {
                return conversation.dmPeerUserId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? conversation.id
            }
            let name = conversation.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? conversation.id : name
        }()
        let displayName = isDM
            ? displayTitle
            : conversation.name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                ?? (isChannel ? L10n.Messages.channel : L10n.Messages.groupChat)
        let externalAvatar = conversation.isExternal
            ? externalContactStore.contact(peerUserId: conversation.dmPeerUserId)?.avatarURL.nilIfEmpty
            : nil
        let imageURL = isDM
            ? externalAvatar ?? IMMemberDisplayPolicy.resolvedAvatar(
                userId: conversation.dmPeerUserId,
                snapshotAvatar: conversation.avatarUrl,
                organizationMembers: workspace.members
            ).nilIfEmpty
            : conversation.avatarUrl.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        return IdentityColorAvatar(
            name: displayName,
            seed: seed,
            imageUrl: imageURL,
            size: 40,
            group: isGroup,
            channel: isChannel
        )
    }

    private var unreadBadge: some View {
        Text(conversation.unreadCount > 99 ? "99+" : "\(conversation.unreadCount)")
            .font(.tt.captionMedium)
            .foregroundStyle(.tt.textOnAccent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.red))
    }
}

private extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
