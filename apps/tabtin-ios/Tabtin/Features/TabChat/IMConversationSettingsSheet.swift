import SwiftUI
import PhotosUI
import UIKit

/// 群成员管理只依赖 Django 会话角色，不借用组织角色或 Provider 身份。
enum IMConversationMemberManagementPolicy {
    private static let adminRole = 2
    private static let ownerRole = 3

    static func canRemove(
        from detail: IMConversationDetail,
        currentUserId: String?,
        member: IMMember,
        binding: IMConversationAgentBinding?
    ) -> Bool {
        guard detail.conversationType == .group,
              !detail.isTeamSpaceChannel,
              let currentUserId,
              !currentUserId.isEmpty,
              let currentRole = detail.members.first(where: {
                  $0.typedMemberType == .user && $0.userId == currentUserId
              })?.role else {
            return false
        }
        if member.typedMemberType == .agent {
            return binding?.canRebind == true || currentRole >= adminRole
        }
        guard let userId = member.userId,
              !userId.isEmpty,
              userId != currentUserId else {
            return false
        }
        return currentRole >= adminRole && member.role < ownerRole
    }
}

/// 会话设置：对齐 Electron `ConversationDetailPanel`——英雄区大头像 + 免打扰/置顶磁贴 + 清空记录卡。
/// 成员、邀请和资产继续沿同一 NavigationStack push。
struct IMConversationSettingsScreen: View {
    let detail: IMConversationDetail
    let currentUserId: String?
    /// 私聊对方 userId，用于英雄区头像色种子；群聊可传 nil。
    var peerUserId: String? = nil
    let isMuted: Bool
    let isPinned: Bool
    let catalogIsExternal: Bool?
    /// data 为处理后的 JPEG；nil 表示移除。成功返回保存后的 URL（移除成功返回空串）。
    let onUpdateAvatar: (Data?) async -> String?
    let onRename: (String) async -> Bool
    let onToggleMute: () async -> Bool
    let onTogglePin: () async -> Bool
    let onInvite: ([String]) async -> Bool
    let onInviteExternal: ([String]) async -> Bool
    let onRemoveMember: (String) async -> Bool
    let onRemoveAgent: (String, Bool) async -> Bool
    let onAgentAdded: () async -> Void
    let onClearHistory: () async -> Bool
    let onLeave: () async -> Bool
    let onLoadAssets: () async -> [IMMessage]

    @State private var workspace = WorkspaceStore.shared
    @State private var externalContactStore = ExternalContactDirectoryStore.shared
    @State private var nameDraft = ""
    @State private var showRename = false
    @State private var showLeaveConfirmation = false
    @State private var showClearConfirmation = false
    @State private var localMuted: Bool?
    @State private var localPinned: Bool?
    @State private var isMutating = false
    @State private var selectedAvatarItem: PhotosPickerItem?
    @State private var showAvatarPicker = false
    @State private var localAvatarUrl: String?
    @State private var isUpdatingAvatar = false
    @State private var avatarErrorMessage: String?
    @State private var showAgentPicker = false
    @State private var agentBindings: [IMConversationAgentBinding] = []
    @State private var rebindingAgentId: String?
    @State private var memberPendingRemoval: IMMember?
    @State private var memberActionError: String?
    private let conversationService: IMConversationServing = IMConversationService()
    @Environment(\.dismiss) private var dismiss

    private var isGroup: Bool { detail.conversationType == .group }
    private var displayedMuted: Bool { localMuted ?? isMuted }
    private var displayedPinned: Bool { localPinned ?? isPinned }
    private var existingMemberIds: Set<String> { Set(detail.members.compactMap(\.userId)) }
    private var existingAgentIds: Set<String> {
        Set(detail.members.compactMap { member in
            member.typedMemberType == .agent ? member.agentId : nil
        })
    }
    private var canAddAgent: Bool {
        IMGroupAgentMembershipPolicy.canAddAgent(
            to: detail,
            currentUserId: currentUserId,
            catalogIsExternal: catalogIsExternal
        )
    }
    private var canEditAvatar: Bool {
        IMConversationAvatarPolicy.canEditGroupAvatar(detail, currentUserId: currentUserId)
    }
    private var displayedAvatarUrl: String { localAvatarUrl ?? detail.avatarUrl }

    private var displayName: String {
        if isGroup {
            let name = detail.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? "群聊" : name
        }
        return IMMemberDisplayPolicy.directMessageDisplayName(
            members: detail.members,
            currentUserId: currentUserId,
            peerUserId: peerUserId,
            organizationMembers: workspace.members
        )
    }

    private var subtitle: String {
        if isGroup {
            return detail.memberCount > 0 ? "\(detail.memberCount) 位成员" : "群聊"
        }
        return "私聊"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                heroSection
                    .padding(.horizontal, 16)
                    .padding(.top, 20)
                    .padding(.bottom, 16)

                Divider().opacity(0.35)

                actionTiles
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 12)

                clearHistoryCard
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)

                labelCard
                    .padding(.horizontal, 12)
                    .padding(.bottom, 16)

                if isGroup {
                    groupActions
                        .padding(.horizontal, 12)
                        .padding(.bottom, 24)
                }
            }
        }
        .background(Color.tt.bgCanvasDefault.ignoresSafeArea())
        .navigationTitle(isGroup ? "群聊信息" : "聊天信息")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: detail.directoryOrganizationId) {
            let directoryOrganizationId = detail.directoryOrganizationId
            guard !directoryOrganizationId.isEmpty else { return }
            async let membersLoad: Void = workspace.loadMembers(organizationId: directoryOrganizationId)
            async let bindingsLoad: Void = loadAgentBindings()
            if detail.isExternal {
                async let externalLoad: Void = externalContactStore.reload(organizationId: directoryOrganizationId)
                _ = await (membersLoad, bindingsLoad, externalLoad)
            } else {
                _ = await (membersLoad, bindingsLoad)
            }
        }
        .alert("修改群聊名称", isPresented: $showRename) {
            TextField("群聊名称", text: $nameDraft)
            Button("保存") {
                Task { _ = await onRename(nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
            Button("取消", role: .cancel) {}
        }
        .alert("清空聊天记录？", isPresented: $showClearConfirmation) {
            Button("清空", role: .destructive) { Task { _ = await onClearHistory() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("将清除你在此会话中的本地聊天记录。")
        }
        .alert("退出群聊？", isPresented: $showLeaveConfirmation) {
            Button("退出", role: .destructive) { Task { if await onLeave() { dismiss() } } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("退出后将不再接收该群消息。")
        }
        .alert("群头像更新失败", isPresented: Binding(
            get: { avatarErrorMessage != nil },
            set: { if !$0 { avatarErrorMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { avatarErrorMessage = nil }
        } message: {
            Text(avatarErrorMessage ?? "请稍后重试。")
        }
        .alert("移出群聊？", isPresented: Binding(
            get: { memberPendingRemoval != nil },
            set: { if !$0 && !isMutating { memberPendingRemoval = nil } }
        )) {
            Button("移除", role: .destructive) { Task { await removePendingMember() } }
                .disabled(isMutating)
            Button("取消", role: .cancel) { memberPendingRemoval = nil }
                .disabled(isMutating)
        } message: {
            Text(memberPendingRemoval.map {
                "确定将 \(IMMemberDisplayPolicy.displayName(for: $0)) 移出当前群聊吗？"
            } ?? "")
        }
        .alert("成员操作失败", isPresented: Binding(
            get: { memberActionError != nil },
            set: { if !$0 { memberActionError = nil } }
        )) {
            Button("知道了", role: .cancel) { memberActionError = nil }
        } message: {
            Text(memberActionError ?? "请稍后重试。")
        }
        .onChange(of: selectedAvatarItem) { _, item in
            guard let item else { return }
            Task { await updateGroupAvatar(from: item) }
        }
        .photosPicker(
            isPresented: $showAvatarPicker,
            selection: $selectedAvatarItem,
            matching: .images
        )
        .sheet(isPresented: $showAgentPicker) {
            AgentMentionPickerView(
                conversationId: detail.id,
                organizationId: detail.organizationId,
                existingAgentIds: existingAgentIds,
                mode: .addOnly
            ) { _ in
                await onAgentAdded()
                await loadAgentBindings()
            }
        }
        .sheet(isPresented: Binding(
            get: { rebindingAgentId != nil },
            set: { if !$0 { rebindingAgentId = nil } }
        )) {
            if let agentId = rebindingAgentId,
               let binding = agentBindings.first(where: { $0.agentId == agentId }) {
                IMAgentWorkspaceRebindingSheet(
                    conversationId: detail.id,
                    organizationId: detail.organizationId,
                    agentId: agentId,
                    agentName: detail.members.first(where: { $0.agentId == agentId })
                        .map { IMMemberDisplayPolicy.displayName(for: $0) } ?? "Agent",
                    currentBinding: binding,
                    service: conversationService
                ) { updated in
                    if let index = agentBindings.firstIndex(where: { $0.agentId == updated.agentId }) {
                        agentBindings[index] = updated
                    }
                    rebindingAgentId = nil
                }
            }
        }
    }

    // MARK: - Hero

    private var heroSection: some View {
        VStack(spacing: 10) {
            avatarControl
            Text(displayName)
                .font(.tt.titleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
            Text(subtitle)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var avatarControl: some View {
        let avatarName = displayName
        let avatarIsGroup = isGroup
        let avatarSeed = avatarIsGroup ? detail.id : (peerUserId ?? detail.id)
        let avatarUrl = displayedAvatarUrl.isEmpty ? nil : displayedAvatarUrl
        if canEditAvatar {
            Button {
                showAvatarPicker = true
            } label: {
                ZStack(alignment: .bottomTrailing) {
                    IdentityColorAvatar(
                        name: avatarName,
                        seed: avatarSeed,
                        imageUrl: avatarUrl,
                        size: 80,
                        group: avatarIsGroup
                    )
                    Circle()
                        .fill(Color.tt.bgCanvasDefault)
                        .frame(width: 26, height: 26)
                        .overlay {
                            Image(systemName: "camera.fill")
                                .font(.tt.iconCaptionMedium)
                                .foregroundStyle(.tt.textAccent)
                        }
                        .overlay(Circle().strokeBorder(Color.tt.borderLight, lineWidth: 1))
                }
            }
            .buttonStyle(.plain)
            .disabled(isUpdatingAvatar)
            .overlay {
                if isUpdatingAvatar {
                    Circle()
                        .fill(.black.opacity(0.28))
                        .frame(width: 80, height: 80)
                        .overlay { ProgressView().tint(.white) }
                }
            }
            if !displayedAvatarUrl.isEmpty {
                Button("移除群头像", role: .destructive) {
                    Task { await removeGroupAvatar() }
                }
                .font(.tt.captionMedium)
                .disabled(isUpdatingAvatar)
            }
        } else {
            IdentityColorAvatar(
                name: avatarName,
                seed: avatarSeed,
                imageUrl: avatarUrl,
                size: 80,
                group: avatarIsGroup
            )
        }
    }

    // MARK: - Tiles

    private var actionTiles: some View {
        HStack(spacing: 8) {
            settingsTile(
                title: "免打扰",
                systemImage: displayedMuted ? "bell.slash.fill" : "bell.fill",
                active: displayedMuted,
                disabled: isMutating
            ) {
                await toggleMute()
            }
            settingsTile(
                title: "置顶",
                systemImage: "pin.fill",
                active: displayedPinned,
                disabled: isMutating
            ) {
                await togglePin()
            }
        }
    }

    private func settingsTile(
        title: String,
        systemImage: String,
        active: Bool,
        disabled: Bool,
        action: @escaping () async -> Void
    ) -> some View {
        Button {
            Task { await action() }
        } label: {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 20, weight: .medium))
                Text(title)
                    .font(.tt.captionMedium)
            }
            .foregroundStyle(active ? Color.tt.textAccent : Color.tt.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(active ? Color.tt.bgAccent.opacity(0.10) : Color.tt.bgSubtle.opacity(0.85))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(active ? Color.tt.bgAccent.opacity(0.30) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    // MARK: - Clear / Group

    private var clearHistoryCard: some View {
        Button {
            showClearConfirmation = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "trash")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.tt.textSecondary)
                Text("清空聊天记录")
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.tt.bgSubtle.opacity(0.55))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.tt.borderLight.opacity(0.55), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var labelCard: some View {
        NavigationLink {
            IMConversationLabelSettingsView(
                conversationId: detail.id,
                organizationId: detail.organizationId,
                initialLabels: detail.labels
            )
        } label: {
            groupRowLabel(title: "会话标签", systemImage: "tag")
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.tt.bgSubtle.opacity(0.55))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.tt.borderLight.opacity(0.55), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private var groupActions: some View {
        VStack(spacing: 0) {
            groupRow(title: "当前成员", systemImage: "person.2") {
                memberList
            }
            groupRow(title: "邀请新成员", systemImage: "person.badge.plus") {
                inviteList
            }
            if canAddAgent {
                Button {
                    showAgentPicker = true
                } label: {
                    groupRowLabel(title: "添加 AI Agent", systemImage: "sparkles")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("添加 AI Agent 到群聊")
            }
            Button {
                nameDraft = detail.name
                showRename = true
            } label: {
                groupRowLabel(title: "修改群聊名称", systemImage: "pencil")
            }
            .buttonStyle(.plain)
            groupRow(title: "会话资产", systemImage: "folder") {
                assetList
            }
            Button {
                showLeaveConfirmation = true
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .font(.system(size: 16, weight: .medium))
                    Text("退出群聊")
                        .font(.tt.body)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.tt.textCritical)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.tt.bgSubtle.opacity(0.55))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.tt.borderLight.opacity(0.55), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func groupRow<Destination: View>(
        title: String,
        systemImage: String,
        @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            groupRowLabel(title: title, systemImage: systemImage)
        }
    }

    private func groupRowLabel(title: String, systemImage: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.tt.textSecondary)
                .frame(width: 22)
            Text(title)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tt.textTertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    // MARK: - Actions

    private func toggleMute() async {
        guard !isMutating else { return }
        isMutating = true
        defer { isMutating = false }
        let muted = await onToggleMute()
        localMuted = muted
    }

    private func togglePin() async {
        guard !isMutating else { return }
        isMutating = true
        defer { isMutating = false }
        let pinned = await onTogglePin()
        localPinned = pinned
    }

    private func updateGroupAvatar(from item: PhotosPickerItem) async {
        guard canEditAvatar, !isUpdatingAvatar else { return }
        isUpdatingAvatar = true
        defer {
            isUpdatingAvatar = false
            selectedAvatarItem = nil
        }
        do {
            guard let sourceData = try await item.loadTransferable(type: Data.self),
                  let jpegData = processedGroupAvatarJPEG(sourceData) else {
                throw IMGroupAvatarEditError.invalidImage
            }
            guard let savedUrl = await onUpdateAvatar(jpegData) else { return }
            localAvatarUrl = savedUrl
        } catch {
            avatarErrorMessage = error.localizedDescription
        }
    }

    private func removeGroupAvatar() async {
        guard canEditAvatar, !isUpdatingAvatar else { return }
        isUpdatingAvatar = true
        defer { isUpdatingAvatar = false }
        guard let savedUrl = await onUpdateAvatar(nil) else { return }
        localAvatarUrl = savedUrl
    }

    // MARK: - Nested pages

    private var memberList: some View {
        List(detail.members) { member in
            let displayName = IMMemberDisplayPolicy.displayName(for: member)
            let binding = member.agentId.flatMap { agentId in
                agentBindings.first(where: { $0.agentId == agentId })
            }
            HStack(spacing: 12) {
                IdentityColorAvatar(
                    name: displayName,
                    seed: member.userId ?? member.agentId,
                    size: 36,
                    group: false
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                    Text(member.typedMemberType == .agent ? agentBindingLabel(binding) : "成员")
                        .font(.tt.captionMedium)
                        .foregroundStyle(
                            member.typedMemberType == .agent && binding?.isExecutable != true
                                ? Color.tt.textCritical
                                : Color.tt.textTertiary
                        )
                }
                Spacer()
                if member.typedMemberType == .agent, binding?.canRebind == true {
                    Button("更换") { rebindingAgentId = member.agentId }
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textAccent)
                }
                if IMConversationMemberManagementPolicy.canRemove(
                    from: detail,
                    currentUserId: currentUserId,
                    member: member,
                    binding: binding
                ) {
                    Button("移除", role: .destructive) { memberPendingRemoval = member }
                        .font(.tt.captionMedium)
                        .disabled(isMutating)
                }
            }
        }
        .navigationTitle("成员（\(detail.memberCount)）")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func agentBindingLabel(_ binding: IMConversationAgentBinding?) -> String {
        guard let binding else { return "未绑定执行现场" }
        let workspaceName = binding.workspaceName.isEmpty ? "执行现场" : binding.workspaceName
        return binding.isExecutable ? workspaceName : "\(workspaceName) · 已失效"
    }

    private func loadAgentBindings() async {
        guard isGroup, !detail.isExternal, !detail.isTeamSpaceChannel else {
            agentBindings = []
            return
        }
        agentBindings = (try? await conversationService.listAgentBindings(conversationId: detail.id)) ?? []
    }

    private var inviteList: some View {
        let candidates = workspace.members.filter { !existingMemberIds.contains($0.userId) && $0.userId != currentUserId }
        let externalCandidates = externalContactStore.contacts.filter { !existingMemberIds.contains($0.peerUserId) }
        return Group {
            if (workspace.isLoadingMembers && workspace.members.isEmpty)
                || (detail.isExternal && externalContactStore.isLoading && externalContactStore.contacts.isEmpty) {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if candidates.isEmpty && externalCandidates.isEmpty {
                ContentUnavailableView("暂无可邀请成员", systemImage: "person.badge.plus")
            } else {
                List {
                    if !candidates.isEmpty {
                        Section("组织成员") {
                            ForEach(candidates) { member in
                                Button {
                                    Task { _ = await onInvite([member.userId]) }
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(member.displayName).foregroundStyle(.tt.textPrimary)
                                            if let subtitle = member.subtitle {
                                                Text(subtitle).font(.tt.captionMedium).foregroundStyle(.tt.textTertiary)
                                            }
                                        }
                                        Spacer()
                                        Text("邀请").foregroundStyle(.tt.textAccent)
                                    }
                                }
                                .disabled(isMutating)
                            }
                        }
                    }
                    if detail.isExternal, !externalCandidates.isEmpty {
                        Section("外部联系人") {
                            ForEach(externalCandidates) { contact in
                                Button {
                                    Task { _ = await onInviteExternal([contact.contactId]) }
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(contact.displayName.isEmpty ? "外部联系人" : contact.displayName)
                                                .foregroundStyle(.tt.textPrimary)
                                            if !contact.peerOrganizationName.isEmpty {
                                                Text(contact.peerOrganizationName)
                                                    .font(.tt.captionMedium)
                                                    .foregroundStyle(.tt.textTertiary)
                                            }
                                        }
                                        Spacer()
                                        Text("邀请").foregroundStyle(.tt.textAccent)
                                    }
                                }
                                .disabled(isMutating)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("邀请成员")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func removePendingMember() async {
        guard let member = memberPendingRemoval, !isMutating else { return }
        isMutating = true
        defer { isMutating = false }
        let succeeded: Bool
        if member.typedMemberType == .agent, let agentId = member.agentId {
            let canDeleteBinding = agentBindings.first(where: { $0.agentId == agentId })?.canRebind == true
            succeeded = await onRemoveAgent(agentId, canDeleteBinding)
        } else if let userId = member.userId {
            succeeded = await onRemoveMember(userId)
        } else {
            memberActionError = "成员身份不完整。"
            return
        }
        if succeeded {
            memberPendingRemoval = nil
            await loadAgentBindings()
        } else {
            memberActionError = "未能移除该成员，请确认权限后重试。"
        }
    }

    private var assetList: some View {
        IMConversationAssetList(onLoadAssets: onLoadAssets)
            .navigationTitle("会话资产")
            .navigationBarTitleDisplayMode(.inline)
    }
}

private struct IMAgentWorkspaceRebindingSheet: View {
    let conversationId: String
    let organizationId: String
    let agentId: String
    let agentName: String
    let currentBinding: IMConversationAgentBinding
    let service: IMConversationServing
    let onBound: (IMConversationAgentBinding) -> Void

    @State private var workspace = WorkspaceStore.shared
    @State private var isSaving = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    private var selectableWorkspaces: [Space] {
        workspace.spaces.filter {
            $0.organizationId == organizationId
                && $0.isExecutionSpace
                && $0.isArchived != true
                && $0.executionDeviceId != nil
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if workspace.isLoadingSpaces && selectableWorkspaces.isEmpty {
                    ProgressView("正在加载执行现场…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if selectableWorkspaces.isEmpty {
                    ContentUnavailableView(
                        "没有可用执行现场",
                        systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                        description: Text(workspace.spacesLoadError ?? "请先创建并信任一个绑定执行设备的 Workspace。")
                    )
                } else {
                    List(selectableWorkspaces) { item in
                        Button {
                            Task { await updateBinding(workspaceId: item.id) }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.tt.textAccent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.name).foregroundStyle(.tt.textPrimary)
                                    Text(item.id == currentBinding.workspaceId ? "当前执行现场" : "用于 \(agentName) 执行群聊任务")
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textSecondary)
                                }
                                Spacer()
                                if isSaving { ProgressView().controlSize(.small) }
                            }
                        }
                        .disabled(isSaving || item.id == currentBinding.workspaceId)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("更换执行现场")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .task { await workspace.loadSpaces() }
            .alert("更换失败", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("好", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private func updateBinding(workspaceId: String) async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await service.updateAgentBinding(
                conversationId: conversationId,
                agentId: agentId,
                workspaceId: workspaceId
            )
            onBound(updated)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private let imConversationLabelPalette = [
    "#6b7280", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6",
]

private struct IMConversationLabelSettingsView: View {
    let conversationId: String
    let organizationId: String
    let initialLabels: [IMConversationLabel]

    @State private var labelStore = IMConversationLabelStore.shared
    @State private var assignedLabels: [IMConversationLabel] = []
    @State private var hasSeededAssignedLabels = false
    @State private var draftName = ""
    @State private var draftColor = imConversationLabelPalette[0]
    @State private var busyLabelId: String?
    @State private var isCreating = false
    @State private var editingLabel: IMConversationLabel?
    @State private var deletingLabel: IMConversationLabel?
    @State private var errorMessage: String?

    private var customLabels: [IMConversationLabel] {
        labelStore.labels.filter { !$0.isSystem }
    }

    private var assignedLabelIds: Set<String> { Set(assignedLabels.map(\.id)) }

    var body: some View {
        Form {
            Section("新建并添加到当前会话") {
                TextField("标签名称", text: $draftName)
                    .textInputAutocapitalization(.never)
                    .onChange(of: draftName) { _, value in
                        if value.count > 32 { draftName = String(value.prefix(32)) }
                    }
                labelColorPicker(selected: $draftColor)
                Button {
                    Task { await createAndAssign() }
                } label: {
                    if isCreating {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("创建标签", systemImage: "plus")
                            .frame(maxWidth: .infinity)
                    }
                }
                .disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreating)
            }

            Section("已有标签") {
                if customLabels.isEmpty {
                    Text("还没有自定义标签")
                        .foregroundStyle(.tt.textSecondary)
                } else {
                    ForEach(customLabels) { label in
                        HStack(spacing: 10) {
                            Button {
                                Task { await toggle(label) }
                            } label: {
                                Image(systemName: assignedLabelIds.contains(label.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(Color(hex: label.color))
                            }
                            .buttonStyle(.plain)
                            .disabled(busyLabelId != nil)

                            Circle()
                                .fill(Color(hex: label.color))
                                .frame(width: 9, height: 9)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label.name).lineLimit(1)
                                if label.conversationCount > 0 {
                                    Text("\(label.conversationCount) 个会话")
                                        .font(.tt.caption)
                                        .foregroundStyle(.tt.textSecondary)
                                }
                            }
                            Spacer(minLength: 8)
                            Button { editingLabel = label } label: {
                                Image(systemName: "pencil")
                            }
                            .buttonStyle(.plain)
                            .disabled(busyLabelId != nil)
                            Button(role: .destructive) { deletingLabel = label } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.plain)
                            .disabled(busyLabelId != nil)
                        }
                    }
                }
            }
        }
        .navigationTitle("会话标签")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !hasSeededAssignedLabels {
                assignedLabels = IMConversationStore.shared.conversations
                    .first(where: { $0.id == conversationId })?.labels ?? initialLabels
                hasSeededAssignedLabels = true
            }
            await labelStore.load(organizationId: organizationId)
        }
        .sheet(item: $editingLabel) { label in
            IMConversationLabelEditorSheet(label: label) { name, color in
                await update(label, name: name, color: color)
            }
        }
        .alert("删除标签？", isPresented: Binding(
            get: { deletingLabel != nil },
            set: { if !$0 && busyLabelId == nil { deletingLabel = nil } }
        )) {
            Button("删除", role: .destructive) { Task { await deletePendingLabel() } }
                .disabled(busyLabelId != nil)
            Button("取消", role: .cancel) { deletingLabel = nil }
                .disabled(busyLabelId != nil)
        } message: {
            Text(deletingLabel.map { "“\($0.name)”将从所有会话移除。" } ?? "")
        }
        .alert("标签操作失败", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "请稍后重试。")
        }
    }

    private func createAndAssign() async {
        guard !isCreating else { return }
        isCreating = true
        defer { isCreating = false }
        do {
            let created = try await labelStore.create(name: draftName, color: draftColor)
            assignedLabels = try await labelStore.setAssigned(
                conversationId: conversationId,
                labelId: created.id,
                assigned: true
            )
            draftName = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggle(_ label: IMConversationLabel) async {
        guard busyLabelId == nil else { return }
        busyLabelId = label.id
        defer { busyLabelId = nil }
        do {
            assignedLabels = try await labelStore.setAssigned(
                conversationId: conversationId,
                labelId: label.id,
                assigned: !assignedLabelIds.contains(label.id)
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func update(_ label: IMConversationLabel, name: String, color: String) async -> Bool {
        guard busyLabelId == nil else { return false }
        busyLabelId = label.id
        defer { busyLabelId = nil }
        do {
            try await labelStore.update(labelId: label.id, name: name, color: color)
            assignedLabels = assignedLabels.map {
                $0.id == label.id
                    ? IMConversationLabel(id: label.id, name: name, color: color)
                    : $0
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func deletePendingLabel() async {
        guard let label = deletingLabel, busyLabelId == nil else { return }
        busyLabelId = label.id
        defer { busyLabelId = nil }
        do {
            try await labelStore.delete(labelId: label.id)
            assignedLabels.removeAll { $0.id == label.id }
            deletingLabel = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct IMConversationLabelEditorSheet: View {
    let label: IMConversationLabel
    let onSave: (String, String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var color: String
    @State private var isSaving = false

    init(label: IMConversationLabel, onSave: @escaping (String, String) async -> Bool) {
        self.label = label
        self.onSave = onSave
        _name = State(initialValue: label.name)
        _color = State(initialValue: label.color)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("标签名称", text: $name)
                    .onChange(of: name) { _, value in
                        if value.count > 32 { name = String(value.prefix(32)) }
                    }
                labelColorPicker(selected: $color)
            }
            .navigationTitle("编辑标签")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        Task {
                            isSaving = true
                            if await onSave(name.trimmingCharacters(in: .whitespacesAndNewlines), color) {
                                dismiss()
                            }
                            isSaving = false
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                }
            }
        }
    }
}

private func labelColorPicker(selected: Binding<String>) -> some View {
    HStack(spacing: 12) {
        ForEach(imConversationLabelPalette, id: \.self) { color in
            Button {
                selected.wrappedValue = color
            } label: {
                Circle()
                    .fill(Color(hex: color))
                    .frame(width: 28, height: 28)
                    .overlay {
                        if selected.wrappedValue == color {
                            Circle().strokeBorder(Color.primary, lineWidth: 3)
                        }
                    }
            }
            .buttonStyle(.plain)
        }
    }
    .padding(.vertical, 4)
}

private enum IMGroupAvatarEditError: LocalizedError {
    case invalidImage

    var errorDescription: String? { "无法读取这张图片，请重新选择。" }
}

/// 中心裁成正方形并限制到 512px，降低移动网络上传成本，也与桌面头像裁切后的展示一致。
private func processedGroupAvatarJPEG(_ data: Data) -> Data? {
    guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { return nil }
    let targetSide = min(CGFloat(512), min(image.size.width, image.size.height))
    let drawScale = max(targetSide / image.size.width, targetSide / image.size.height)
    let drawSize = CGSize(width: image.size.width * drawScale, height: image.size.height * drawScale)
    let drawRect = CGRect(
        x: (targetSide - drawSize.width) / 2,
        y: (targetSide - drawSize.height) / 2,
        width: drawSize.width,
        height: drawSize.height
    )
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: targetSide, height: targetSide))
    let rendered = renderer.image { _ in
        image.draw(in: drawRect)
    }
    return rendered.jpegData(compressionQuality: 0.8)
}

private struct IMConversationAssetList: View {
    let onLoadAssets: () async -> [IMMessage]
    @State private var assets: [IMMessage] = []
    @State private var isLoading = true

    var body: some View {
        Group {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if assets.isEmpty {
                ContentUnavailableView("当前会话暂无共享资产", systemImage: "folder")
            } else {
                List(assets) { message in
                    Text(assetTitle(for: message)).lineLimit(1)
                }
            }
        }
        .task {
            assets = await onLoadAssets()
            isLoading = false
        }
    }

    private func assetTitle(for message: IMMessage) -> String {
        if !message.attachmentFileName.isEmpty { return message.attachmentFileName }
        if let displayName = message.resourceCardDisplayName, !displayName.isEmpty { return displayName }
        if !message.content.isEmpty { return message.content }
        if message.messageType == IMMessageType.image.rawValue { return "图片" }
        return "共享资源"
    }
}
