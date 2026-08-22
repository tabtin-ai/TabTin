import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import Observation

func imGroupCreatedNotice(
    createdAt: String?,
    isGroup: Bool,
    hasCompletedInitialHistoryLoad: Bool,
    hasMoreHistory: Bool,
    locale: Locale = .current,
    timeZone: TimeZone = .current
) -> String? {
    guard isGroup,
          hasCompletedInitialHistoryLoad,
          !hasMoreHistory,
          let raw = createdAt?.trimmingCharacters(in: .whitespacesAndNewlines),
          !raw.isEmpty,
          let date = IMWireDate.parse(raw)
    else { return nil }
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = timeZone
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    let formattedCreatedAt = formatter.string(from: date)
    return "群组创建于 \(formattedCreatedAt)"
}

/// 消息 Tab 被程序化激活时会并发刷新会话目录。刷新会短暂清空列表，进入页必须保留
/// 刷新前已经确认的组织归属，否则同一次导航会被误判为“无法确认会话所属组织”。
func resolveIMConversationActivationOrganizationId(
    initialOrganizationId: String?,
    currentOrganizationId: String?
) -> String? {
    [currentOrganizationId, initialOrganizationId]
        .compactMap { value -> String? in
            let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return normalized.isEmpty ? nil : normalized
        }
        .first
}

/// TabChat 单会话详情：Django REST 负责读写，Centrifugo 承载完整实时事件。
/// 视觉为 Phase B 最小可用版（系统气泡 + TT token）；富文本/附件/已读回执后续增强。
struct IMConversationScreen: View {
    let conversationId: String
    let title: String
    let onOpenConversation: (IMConversationTarget) -> Void
    var onOpenChatSession: (ConversationTarget) -> Void = { MainRouter.shared.openConversation($0) }

    @State private var store: IMMessageStore
    @State private var cardDetailRequests = IMConversationCardDetailRequestCoordinator()
    @State private var workspace = WorkspaceStore.shared
    @State private var conversationStore = IMConversationStore.shared
    @State private var draft: String = ""
    @State private var detail: IMConversationDetail?
    /// 本次输入中已选的群成员。正文直接保留 @名称，发送时再拆成用户 / Agent 的 mention metadata。
    @State private var pendingMentions: [IMDraftMention] = []
    @State private var showGroupMentionPicker = false
    @State private var showAgentMentionPicker = false
    @State private var agentTaskMessage: IMMessage?
    @State private var handoffSourceMessage: IMMessage?
    @State private var showMembersSheet = false
    /// 长按消息后的二级动作：表情选择、回复和转发在这里显式建模，避免把具体 emoji 堆在菜单中。
    @State private var reactionMessage: IMMessage?
    @State private var readReceiptMessage: IMMessage?
    @State private var readReceiptDetails: [Int: IMMessageReadReceipts] = [:]
    @State private var replyMessage: IMMessage?
    /// 点击引用栏或「N 条回复」后展示的只读上下文，不打断当前会话滚动位置。
    @State private var replyThreadRequest: IMReplyThreadRequest?
    @State private var forwardRequest: IMForwardRequest?
    @State private var isPinnedBannerExpanded = false
    /// 正在编辑的消息（非空时输入框进入编辑态）。
    @State private var editingMessage: IMMessage?
    /// 上次发出 typing 信号的时间（3s 节流，对齐 Electron）。
    @State private var lastTypingSent = Date.distantPast
    @State private var resourceTarget: IMResourceTarget?
    @State private var sharedSessionTarget: IMSessionShareCard?
    @State private var cloudResourceContext: CloudResourceOpenContext?
    @State private var actionMessage: String?
    @State private var attachmentManager = ChatAttachmentManager()
    @State private var showPhotoPicker = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    /// 输入框“+”使用锚定菜单；云文档和多维表格统一从“云文件”入口选择。
    @State private var showResourcePicker = false
    @State private var showContactCardPicker = false
    @State private var showPromptComposer = false
    @State private var showSessionSharePicker = false
    @State private var pendingCard: IMOutgoingCard?
    @State private var taskComposerDraft = ""
    @State private var showTaskComposer = false
    @State private var hasLoadedInitial = false
    @State private var isOpeningNestedConversation = false
    @State private var openingDirectMessageUserId: String?
    @State private var isOpeningResourceDetail = false
    /// 强制贴底令牌：发送后自增，UIKit 滚动层无视当前是否翻历史直接滚到底。
    @State private var scrollToBottomToken = 0
    @State private var scrollToMessageToken = 0
    @State private var scrollToMessageRequest: IMMessageScrollRequest?
    @FocusState private var composerFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    private let conversationService: IMConversationServing = IMConversationService()
    private var centrifugo: CentrifugoClient { .shared }
    private var currentUserId: String? { AuthService.shared.currentUser?.id }

    private var resolvedTitle: String {
        let snapshot = IMConversationStore.shared.conversations.first { $0.id == conversationId }
        let isDirectMessage = detail?.conversationType == .dm || snapshot?.conversationType == .dm
        let latestConversationName = [
            detail?.name,
            snapshot?.name,
            title
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? title
        let preferredPeerUserId = snapshot?.dmPeerUserId
        let detailPeer = detail.flatMap {
            IMMemberDisplayPolicy.directMessagePeerDisplayName(
                in: $0,
                currentUserId: currentUserId,
                preferredPeerUserId: preferredPeerUserId
            )
        }
        let peerDisplayName = detailPeer
            ?? preferredPeerUserId.flatMap { id in
                workspace.members.first { $0.userId == id }?.displayName
            }
        return IMConversationTitlePolicy.resolve(
            conversationName: latestConversationName,
            isDirectMessage: isDirectMessage,
            peerDisplayName: peerDisplayName,
            directMessageFallback: L10n.Messages.directMessage,
            conversationFallback: "会话"
        )
    }

    /// 资源/名片 picker 必须以会话组织为边界。详情尚未回到时，回退会话列表快照，避免误用全局当前组织。
    private var conversationOrganizationId: String? {
        let detailOrganizationId = detail?.organizationId.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !detailOrganizationId.isEmpty { return detailOrganizationId }
        let listOrganizationId = IMConversationStore.shared.conversations
            .first(where: { $0.id == conversationId })?
            .organizationId
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return listOrganizationId.isEmpty ? nil : listOrganizationId
    }

    /// 会话目录刷新与实时数据面激活使用参与者目录，而不是外部会话的托管组织。
    private var conversationDirectoryOrganizationId: String? {
        let detailScope = detail?.directoryOrganizationId
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !detailScope.isEmpty { return detailScope }
        let listScope = IMConversationStore.shared.conversations
            .first(where: { $0.id == conversationId })?
            .directoryOrganizationId
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return listScope.isEmpty ? nil : listScope
    }

    /// 仅群聊可 @ 当前成员，私信不展示也不触发成员选择。
    private var canMentionMembers: Bool { detail?.conversationType == .group }

    private var canAddAgentToGroup: Bool {
        guard let detail else { return false }
        let catalogIsExternal = conversationStore.conversations
            .first(where: { $0.id == conversationId })?
            .isExternal
        return IMGroupAgentMembershipPolicy.canAddAgent(
            to: detail,
            currentUserId: currentUserId,
            catalogIsExternal: catalogIsExternal
        )
    }

    /// DM 会话：本人消息始终展示已读圆（空心=未读、绿色勾=已读）；群聊展示已读比例扇形。
    private var isDM: Bool {
        if let conversationType = detail?.conversationType { return conversationType == .dm }
        return IMConversationStore.shared.conversations
            .first(where: { $0.id == conversationId })?
            .conversationType == .dm
    }

    private var peerUserId: String? {
        if let preferredPeerUserId = IMConversationStore.shared.conversations
            .first(where: { $0.id == conversationId })?
            .dmPeerUserId?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !preferredPeerUserId.isEmpty {
            return preferredPeerUserId
        }
        guard let currentUserId = currentUserId?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !currentUserId.isEmpty else { return nil }
        return detail?.members.first {
            $0.typedMemberType == .user && $0.userId != currentUserId
        }?.userId
    }

    private var peerDisplayName: String {
        if let name = detail.flatMap({
            IMMemberDisplayPolicy.directMessagePeerDisplayName(
                in: $0,
                currentUserId: currentUserId,
                preferredPeerUserId: peerUserId
            )
        }) {
            return name
        }
        if let peerUserId,
           let member = workspace.members.first(where: { $0.userId == peerUserId }),
           !member.displayName.isEmpty {
            return member.displayName
        }
        return "对方"
    }

    private var isReadOnlyConversation: Bool {
        isIMConversationReadOnly(
            snapshot: IMConversationStore.shared.conversations.first { $0.id == conversationId },
            detail: detail
        )
    }

    private var isExternalConversation: Bool {
        detail?.isExternal == true
            || conversationStore.conversations.first(where: { $0.id == conversationId })?.isExternal == true
    }

    private var externalConversationMessage: String { "外部会话仅支持发送文字消息。" }

    private var readOnlyMessage: String {
        if detail?.canSend == false
            || conversationStore.conversations.first(where: { $0.id == conversationId })?.canSend == false {
            return "你已不在当前会话，历史仍可查看，但不能发送消息。"
        }
        return "对方已不在组织，当前会话只读。"
    }

    private var groupCreatedNotice: String? {
        let raw = [
            detail?.createdAt,
            conversationStore.conversations.first(where: { $0.id == conversationId })?.createdAt,
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return imGroupCreatedNotice(
            createdAt: raw,
            isGroup: detail?.conversationType == .group
                || conversationStore.conversations.first(where: { $0.id == conversationId })?.conversationType == .group,
            hasCompletedInitialHistoryLoad: store.hasCompletedInitialHistoryLoad,
            hasMoreHistory: store.hasMoreHistory
        )
    }

    private var pinnedMessages: [IMMessage] {
        return store.pinnedMessages
    }

    private var conversationLastMessageSeq: Int {
        conversationStore.conversations.first { $0.id == conversationId }?.lastMessageSeq ?? 0
    }

    private var visibleLastMessageSeq: Int {
        store.messages.map(\.seq).max() ?? 0
    }

    /// IM 附件始终以会话详情中的组织归属签名，不能读取当前全局选中组织。
    private var attachmentUploadScope: UploadScope? {
        guard let organizationId = detail?.organizationId, !organizationId.isEmpty else { return nil }
        return UploadScope(
            module: "tabchat",
            contextType: "im_message",
            contextId: conversationId,
            organizationId: organizationId,
            isPublic: true
        )
    }

    init(
        conversationId: String,
        title: String,
        onOpenConversation: @escaping (IMConversationTarget) -> Void = { _ in },
        onOpenChatSession: @escaping (ConversationTarget) -> Void = { MainRouter.shared.openConversation($0) }
    ) {
        self.conversationId = conversationId
        self.title = title
        self.onOpenConversation = onOpenConversation
        self.onOpenChatSession = onOpenChatSession
        let cacheScopeId = AuthService.shared.currentUser?.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedCacheScopeId = cacheScopeId?.isEmpty == false ? cacheScopeId! : "anonymous"
        // Store 按 request id 管理附件 upload-stage usage；无论实时回声、清空或 HTTP 回包的
        // 先后顺序如何，都会只触发一次 deactivate，避免把所有权绑在展示用 pending 上。
        _store = State(initialValue: IMMessageStore(
            conversationId: conversationId,
            snapshotCache: IMMessageCompositeCache([
                IMMessageMemoryCache.shared,
                IMMessageDatabaseCache.shared,
            ]),
            initialSnapshotCache: IMMessageMemoryCache.shared,
            pinnedSnapshotCache: IMPinnedMessageCompositeCache([
                IMPinnedMessageMemoryCache.shared,
                IMMessageDatabaseCache.shared,
            ]),
            initialPinnedSnapshotCache: IMPinnedMessageMemoryCache.shared,
            readStateCache: IMMessageDatabaseCache.shared,
            pendingCache: IMPendingMessageUserDefaultsCache.shared,
            cacheScopeId: resolvedCacheScopeId,
            onMessageEnqueued: { preview in
                let listedSeq = IMConversationStore.shared.conversations
                    .first(where: { $0.id == conversationId })?
                    .lastMessageSeq ?? 0
                IMConversationStore.shared.applyLatestPreviewUpdate(
                    conversationId: conversationId,
                    messageSeq: listedSeq,
                    preview: preview
                )
            },
            onMessageConfirmed: { message in
                IMConversationStore.shared.applyLatestPreviewUpdate(
                    conversationId: message.conversationId,
                    messageSeq: message.seq,
                    preview: message.previewTextForConversationList
                )
            },
            onReleaseAbandonedAttachment: { attachment in
                Task {
                    await OSSUploadService.shared.deactivateUsage(
                        fileId: attachment.fileId,
                        module: "tabchat",
                        contextType: "im_message",
                        contextId: conversationId
                    )
                }
            }
        ))
    }

    var body: some View {
        AnyView(conversationInteractionChrome)
    }

    private var conversationBaseChrome: some View {
        AnyView(
        // 滚动层用 UIKit（IMMessageListView），不用 SwiftUI ScrollView——后者贴底/键盘一直不稳，
        // Agent 对话同理走 ChatScrollController。输入区经 footer → safeAreaInset(.bottom)。
        ZStack(alignment: .top) {
            IMMessageListView(
                contentKey: IMMessageListContentKey(
                    conversationId: conversationId,
                    // 冷进入时实时层可能先推一条 latest、随后才返回完整历史。首批历史未完成前
                    // 不把这条隐藏消息放进 UIKit 的内容键，避免列表被无意义重挂一次。
                    messages: store.isInitialHistoryRenderable ? store.messages : [],
                    pending: store.pending,
                    typingActive: !store.typingUserIds.isEmpty,
                    peerReadWaterline: store.peerReadWaterline,
                    initialHistoryReady: store.isInitialHistoryRenderable
                ),
                renderVersion: messageListRenderVersion,
                scrollToBottomToken: scrollToBottomToken,
                scrollToMessageRequest: scrollToMessageRequest,
                earlierPrependToken: store.earlierPrependToken,
                leadingSystemNotice: groupCreatedNotice,
                isLoadingEarlier: store.isLoadingHistory && !store.messages.isEmpty,
                earlierLoadError: IMEarlierHistoryRetryPolicy.errorMessage(
                    historyError: store.historyError,
                    messageCount: store.messages.count,
                    hasMoreHistory: store.hasMoreHistory,
                    isLoadingHistory: store.isLoadingHistory
                ),
                onLoadEarlier: {
                    if store.hasMoreHistory { store.loadMore() }
                },
                onRetryEarlier: {
                    if store.hasMoreHistory { store.loadMore() }
                },
                rowContent: { message, previousMessage in
                    AnyView(messageCell(message, previousMessage: previousMessage))
                },
                pendingContent: { pendingMessage in
                    AnyView(
                        IMPendingMessageBubble(
                            pending: pendingMessage,
                            onRetry: pendingMessage.status == .failed ? {
                                retryPending(pendingMessage)
                            } : nil
                        )
                    )
                },
                typingContent: {
                    AnyView(
                        IMTypingIndicator()
                            .padding(.horizontal, 4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    )
                },
                footer: {
                    VStack(spacing: 0) {
                        Divider()
                        composer
                    }
                    .background(.tt.bgCanvasDefault)
                }
            )
            .padding(
                .top,
                !pinnedMessages.isEmpty
                    ? IMPinnedMessageBanner.collapsedHeight
                    : 0
            )

            if !pinnedMessages.isEmpty, isPinnedBannerExpanded {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isPinnedBannerExpanded = false
                        }
                    }
                    .accessibilityHidden(true)
                    .zIndex(0.5)
            }

            if !pinnedMessages.isEmpty {
                IMPinnedMessageBanner(
                    messages: pinnedMessages,
                    isExpanded: $isPinnedBannerExpanded,
                    onOpen: scrollToMessage,
                    onUnpin: toggleMessagePin
                )
                .zIndex(1)
            }
        }
        .background(.tt.bgCanvasDefault)
        .overlay { emptyOrError }
        .navigationTitle(resolvedTitle)
        .navigationBarTitleDisplayMode(.inline)
        // iPhone 详情页让出垂直空间；iPad 保留自适应一级导航，避免分屏切换后失去全局入口。
        .ttTabBarHidden(true)
        )
    }

    private var conversationLifecycleChrome: some View {
        AnyView(
        conversationBaseChrome
        .task(id: readReceiptPrefetchMessageIds) {
            await prefetchHumanReadReceiptDetails()
        }
        .onChange(of: store.messages.count) {
            // 仅前台推进已读：后台 chat 订阅仍在、count 仍会变，但应保留未读。
            if scenePhase == .active {
                store.markReadUpToLatest()
            }
        }
        .onChange(of: conversationLastMessageSeq) { _, latestSeq in
            guard hasLoadedInitial, latestSeq > visibleLastMessageSeq else { return }
            store.refreshLatest()
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let detail {
                    NavigationLink {
                        conversationSettingsScreen(detail)
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("会话设置")
                } else {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(.tt.textTertiary)
                        .accessibilityLabel("会话设置加载中")
                }
            }
        }
        .task {
            await hydratePersistentSnapshotAfterFirstFrame()
            await activate()
        }
        .onDisappear {
            if isOpeningNestedConversation {
                IMConversationStore.shared.leaveConversation(conversationId)
            } else if isOpeningResourceDetail {
                // Push 云文档 / 多维表只是子页面覆盖，父会话仍在导航栈里。
                // 不要撤 Centrifugo listener，也不要释放 store；否则返回时会半重新进会话，
                // 资源卡 preview 与消息布局重算会扰动滚动位置。
            } else {
                deactivate()
            }
        }
        .onAppear {
            isOpeningNestedConversation = false
            isOpeningResourceDetail = false
        }
        .onChange(of: scenePhase) { _, newPhase in
            // 页面留在导航栈时按 Home/锁屏不会触发 onDisappear：改随 scenePhase 处理活动会话，
            // 对齐 Android lifecycle——非前台注销（后台来消息保留未读、不推进已读），回前台再登记并 mark-read。
            switch newPhase {
            case .active:
                IMConversationStore.shared.enterConversation(conversationId)
                store.markReadUpToLatest()
            case .inactive, .background:
                IMConversationStore.shared.leaveConversation(conversationId)
            @unknown default:
                break
            }
        }
        .onChange(of: store.conversationRevision) { _, _ in
            Task {
                await loadDetail()
                await IMConversationStore.shared.reload(
                    organizationId: conversationDirectoryOrganizationId ?? ""
                )
            }
        }
        .onChange(of: conversationStore.profileRevision) { _, _ in
            Task { await loadDetail() }
        }
        .navigationDestination(item: $cloudResourceContext) { context in
            SpaceAppRouteScreen(
                route: context.route,
                organizationId: context.organizationId,
                spaceId: context.spaceId,
                locationHint: context.spaceName
            )
            .ttTabBarHidden(true)
        }
        )
    }

    private var conversationPresentedChrome: some View {
        AnyView(
        conversationLifecycleChrome
        .sheet(isPresented: $showGroupMentionPicker) {
            if let detail {
                IMGroupMemberMentionSheet(
                    members: detail.members,
                    currentUserId: currentUserId,
                    onPick: insertMention,
                    onPickAll: insertMentionAll,
                    canAddAgent: canAddAgentToGroup,
                    onAddAgent: {
                        showGroupMentionPicker = false
                        showAgentMentionPicker = true
                    }
                )
            }
        }
        .sheet(isPresented: $showAgentMentionPicker) {
            if let detail, !detail.organizationId.isEmpty, canAddAgentToGroup {
                AgentMentionPickerView(
                    conversationId: conversationId,
                    organizationId: detail.organizationId,
                    existingAgentIds: Set(detail.members.compactMap { member in
                        member.typedMemberType == .agent ? member.agentId : nil
                    }),
                    service: conversationService
                ) { agent in
                    insertMention(agent)
                    await loadDetail()
                }
            }
        }
        .sheet(item: $agentTaskMessage) { message in
            if let organizationId = conversationOrganizationId {
                IMAgentTaskComposerSheet(
                    organizationId: organizationId,
                    sourceMessage: message,
                    service: conversationService,
                    onCreated: openAgentTask
                )
            }
        }
        .sheet(item: $handoffSourceMessage) { message in
            IMHandoffComposerSheet(
                conversationId: conversationId,
                sourceMessage: message,
                members: detail?.members ?? [],
                currentUserId: currentUserId,
                onFinished: {
                    handoffSourceMessage = nil
                    actionMessage = "交接已发送。"
                }
            )
        }
        .sheet(isPresented: $showMembersSheet) {
            if let detail {
                IMConversationMembersSheet(
                    detail: detail,
                    currentUserId: currentUserId,
                    onOpenDirectMessage: { userId, displayName in
                        showMembersSheet = false
                        openDirectMessage(userId: userId, displayName: displayName)
                    },
                    onAgentTap: {
                        actionMessage = "当前 IM 后端暂不支持与 Agent 建立一对一私信。"
                    }
                )
            }
        }
        .sheet(item: $resourceTarget) { target in
            WorkbenchSheet(
                organizationId: target.organizationId,
                spaceId: target.spaceId,
                initialOpenRequest: target.request,
                onClose: { resourceTarget = nil }
            )
        }
        .sheet(item: $sharedSessionTarget) { card in
            NavigationStack {
                IMSharedSessionViewerScreen(
                    card: card,
                    organizationId: conversationOrganizationId ?? "",
                    onOpenFork: { target in
                        sharedSessionTarget = nil
                        onOpenChatSession(target)
                    }
                )
            }
        }
        .sheet(item: $reactionMessage) { message in
            IMReactionPicker(reactions: message.reactions) { emoji in
                store.toggleReaction(messageId: message.id, emoji: emoji)
                reactionMessage = nil
            }
        }
        .sheet(item: $readReceiptMessage) { message in
            IMReadReceiptDetailSheet(
                message: message,
                progress: store.readProgress(for: message),
                conversationMembers: detail?.members ?? [],
                currentUserId: currentUserId,
                organizationMembers: workspace.members,
                load: { try await store.fetchReadReceipts(for: message) },
                onLoaded: { readReceiptDetails[message.id] = $0 }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $replyThreadRequest) { request in
            IMReplyThreadSheet(root: request.root, replies: request.replies)
        }
        .sheet(item: $forwardRequest) { request in
            IMForwardConversationPicker(
                sourceConversationId: conversationId,
                conversations: IMConversationStore.shared.conversations,
                allowExternal: request.allowExternal
            ) { target in
                forwardRequest = nil
                Task { await forward(request.messages, to: target) }
            }
        }
        .sheet(isPresented: $showResourcePicker) {
            if let organizationId = conversationOrganizationId {
                IMResourceCardPickerSheet(
                    organizationId: organizationId,
                    onPick: { card in
                        showResourcePicker = false
                        pendingCard = card
                        composerFocused = true
                    }
                )
            }
        }
        .sheet(isPresented: $showContactCardPicker) {
            if let organizationId = conversationOrganizationId {
                IMContactCardPickerSheet(
                    organizationId: organizationId,
                    currentUserId: currentUserId,
                    onPick: { card in
                        showContactCardPicker = false
                        sendCardImmediately(card)
                    }
                )
            }
        }
        .sheet(isPresented: $showPromptComposer) {
            IMPromptComposeSheet { promptText, title in
                showPromptComposer = false
                sendCardImmediately(.prompt(promptText: promptText, title: title))
            }
        }
        .sheet(isPresented: $showSessionSharePicker) {
            if let organizationId = conversationOrganizationId, let peerUserId {
                IMSessionSharePickerSheet(
                    peerName: peerDisplayName,
                    peerUserId: peerUserId,
                    organizationId: organizationId,
                    loadSessions: { try await conversationService.listShareableSessions(organizationId: organizationId) },
                    onShare: { session, mode, clientRequestId in
                        try await shareSession(
                            session,
                            peerUserId: peerUserId,
                            mode: mode,
                            clientRequestId: clientRequestId
                        )
                    },
                    onDismiss: { showSessionSharePicker = false }
                )
            }
        }
        .sheet(isPresented: $showTaskComposer) {
            ComposeSheet(isPresented: $showTaskComposer, initialDraft: taskComposerDraft)
        }
        )
    }

    private var conversationInteractionChrome: some View {
        AnyView(
        conversationPresentedChrome
        .alert("提示", isPresented: Binding(
            get: { actionMessage != nil },
            set: { if !$0 { actionMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { actionMessage = nil }
        } message: {
            Text(actionMessage ?? "")
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $selectedPhotoItem,
            matching: .images
        )
        .onChange(of: selectedPhotoItem) { _, item in
            guard let item else { return }
            Task { await importPhoto(item) }
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in handlePickedFile(result) }
        )
    }

    // MARK: - 消息列表内容（由 UIKit UIScrollView 承载，非 Lazy）

    private func conversationSettingsScreen(_ detail: IMConversationDetail) -> some View {
        let conversation = IMConversationStore.shared.conversations.first(where: { $0.id == conversationId })
        return IMConversationSettingsScreen(
            detail: detail,
            currentUserId: currentUserId,
            peerUserId: conversation?.dmPeerUserId,
            isMuted: conversation?.isMuted ?? false,
            isPinned: conversation?.pinned ?? false,
            catalogIsExternal: conversation?.isExternal,
            onUpdateAvatar: { data in await updateConversationAvatar(data: data) },
            onRename: { name in await renameConversation(name) },
            onToggleMute: { await toggleConversationMute() },
            onTogglePin: { await toggleConversationPin() },
            onInvite: { memberIds in await inviteMembers(memberIds) },
            onInviteExternal: { contactIds in await inviteExternalMembers(contactIds) },
            onRemoveMember: { userId in await removeConversationMember(userId) },
            onRemoveAgent: { agentId, deleteBinding in
                await removeConversationAgent(agentId, deleteBinding: deleteBinding)
            },
            onAgentAdded: { await loadDetail() },
            onClearHistory: { await clearConversationHistory() },
            onLeave: { await leaveConversation() },
            onLoadAssets: { await loadConversationAssets() }
        )
    }

    private var messageListRenderVersion: String {
        (store.handoffVersions.map { "handoff:\($0.key)=\($0.value)" }
            + store.sessionShareVersions.map { "share:\($0.key)=\($0.value)" })
            .sorted()
            .joined(separator: ",")
    }

    /// 对齐 Electron `IMMessageBubble`：私聊不显示发送者名；群聊仅在组首显示。
    private func showsIncomingSenderName(for message: IMMessage, previousMessage: IMMessage?) -> Bool {
        guard !isDM else { return false }
        guard message.senderId != currentUserId else { return false }
        return IMMessageTimeline.isGroupStart(current: message, previous: previousMessage)
    }

    private func senderMember(for message: IMMessage) -> IMMember? {
        detail?.members.first { member in
            message.isFromAgent
                ? member.typedMemberType == .agent && member.agentId == message.senderId
                : member.typedMemberType == .user && member.userId == message.senderId
        }
    }

    private func senderDisplayName(for message: IMMessage) -> String {
        let member = senderMember(for: message)
        if message.isFromAgent {
            let memberName = member?.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !memberName.isEmpty { return memberName }
            let snapshotName = message.senderName.trimmingCharacters(in: .whitespacesAndNewlines)
            return snapshotName.isEmpty ? "Agent" : snapshotName
        }
        let snapshotName = member?.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolved = IMMemberDisplayPolicy.resolvedDisplayName(
            userId: message.senderId,
            snapshotName: snapshotName?.isEmpty == false ? snapshotName : message.senderName,
            organizationMembers: workspace.members
        )
        return resolved.isEmpty ? message.senderId : resolved
    }

    private func senderAvatarURL(for message: IMMessage) -> String? {
        let member = senderMember(for: message)
        let rawAvatar: String
        if message.isFromAgent {
            rawAvatar = member?.avatar ?? ""
        } else {
            rawAvatar = IMMemberDisplayPolicy.resolvedAvatar(
                userId: message.senderId,
                snapshotAvatar: member?.avatar,
                organizationMembers: workspace.members
            )
        }
        let trimmed = rawAvatar.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    @ViewBuilder
    private func incomingAvatarSlot(_ message: IMMessage, previousMessage: IMMessage?) -> some View {
        if IMMessageTimeline.showsIncomingAvatar(
            for: message,
            previous: previousMessage,
            currentUserId: currentUserId
        ) {
            let canOpenDirectMessage = IMMessageTimeline.canOpenSenderDirectMessage(
                for: message,
                isDirectMessage: isDM,
                currentUserId: currentUserId
            ) && senderMember(for: message)?.typedMemberType != .agent
            Group {
                if canOpenDirectMessage {
                    Button {
                        openDirectMessage(
                            userId: message.senderId,
                            displayName: senderDisplayName(for: message)
                        )
                    } label: {
                        senderAvatar(message)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("打开私聊")
                } else {
                    senderAvatar(message)
                }
            }
            .accessibilityLabel("发送者：\(senderDisplayName(for: message))")
        } else {
            Color.clear
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
        }
    }

    private func senderAvatar(_ message: IMMessage) -> some View {
        IdentityColorAvatar(
            name: senderDisplayName(for: message),
            seed: message.senderId,
            imageUrl: senderAvatarURL(for: message),
            size: 36
        )
    }

    /// 单条已确认消息：撤回态显示占位；否则气泡 + 表情回应条 + 页脚（已编辑/已读）。
    /// 消息操作只通过长按气泡唤起，避免常驻更多按钮挤占聊天内容。
    @ViewBuilder
    private func messageCell(_ message: IMMessage, previousMessage: IMMessage?) -> some View {
        let showDateDivider = IMMessageTimeline.shouldShowDateDivider(for: message, previous: previousMessage)
        let isGroupStart = IMMessageTimeline.isGroupStart(current: message, previous: previousMessage)

        VStack(spacing: 0) {
            if showDateDivider {
                IMMessageDateDivider(label: IMMessageTimeline.formatDateDivider(message.createdAt))
            }

            IMMessageAnchorView(messageId: message.id)
                .frame(width: 1, height: 0)
            messageCellBody(message, previousMessage: previousMessage)
                // Electron：组首 `mt-1.5`、组内 `mt-0.5`；跨天分割线自带上下留白。
                .padding(.top, showDateDivider ? 0 : (isGroupStart ? TTSpacing.sm : TTSpacing.xxs))
        }
    }

    @ViewBuilder
    private func messageCellBody(_ message: IMMessage, previousMessage: IMMessage?) -> some View {
        // 系统消息由后端以 `message_type=SYSTEM` + `sender_id=system` 写入；兼容历史数据
        // 只带其中一个字段的情况，始终走居中提示，不应露出为某个成员发送的聊天气泡。
        if message.messageType == IMMessageType.system.rawValue || message.senderId == "system" {
            IMSystemMessageBubble(content: message.content)
        } else {
        let isMine = message.senderId == currentUserId
        if message.isDeleted {
            IMRecalledBubble(
                isMine: isMine,
                canRecompose: isMine && !message.content.isEmpty,
                onRecompose: { recomposeRecalledMessage(message) }
            )
        } else {
            let readProgress = readStatusProgress(for: message, isMine: isMine)
            let readReceiptAction: (() -> Void)? = !isDM && isMine
                ? { readReceiptMessage = message }
                : nil
            VStack(alignment: isMine ? .trailing : .leading, spacing: 2) {
                let isGroupStart = IMMessageTimeline.isGroupStart(current: message, previous: previousMessage)
                let showsSenderName = showsIncomingSenderName(for: message, previousMessage: previousMessage)
                let clock = isGroupStart
                    ? IMMessageTimeline.formatMessageClock(message.createdAt)
                    : nil
                // 私信 / 自己发的消息没有发送者名，组首时分单独一行常显（桌面靠 hover）。
                if let clock, !clock.isEmpty, !showsSenderName {
                    IMMessageClockLabel(clock: clock, isMine: isMine)
                }
                HStack(alignment: .top, spacing: 10) {
                    if !isMine {
                        incomingAvatarSlot(message, previousMessage: previousMessage)
                    }
                    VStack(alignment: isMine ? .trailing : .leading, spacing: 2) {
                        let replyCount = store.messages.count { $0.replyToId == message.id }
                        if replyCount > 0 {
                            Button {
                                openReplyThread(from: message)
                            } label: {
                                Label("\(replyCount) 条回复", systemImage: "bubble.left")
                                    .font(.tt.captionMedium)
                                    .foregroundStyle(.tt.textAccent)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("查看 \(replyCount) 条回复")
                        }
                        bubbleContent(
                            message,
                            isMine: isMine,
                            showsSenderName: showsSenderName,
                            clock: clock,
                            readProgress: readProgress
                        )
                        IMReactionBar(
                            reactions: message.reactions,
                            reactionOrder: message.reactionOrder,
                            currentUserId: currentUserId,
                            isMine: isMine
                        ) { emoji in
                            store.toggleReaction(messageId: message.id, emoji: emoji)
                        }
                        messageFooter(message, isMine: isMine)
                    }
                }
            }
            .environment(\.imReadReceiptAction, readReceiptAction)
            .contextMenu {
                messageMenu(message, isMine: isMine)
            }
            .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
            .contentShape(Rectangle())
        }
        }
    }

    /// 气泡主体：图片/文件走附件气泡，资源卡走卡片气泡，其余走文本气泡。
    @ViewBuilder
    private func bubbleContent(
        _ message: IMMessage,
        isMine: Bool,
        showsSenderName: Bool,
        clock: String?,
        readProgress: IMReadReceipt?
    ) -> some View {
        let inlineReplyPreview = message.replyToPreview
        let usesInlineReplyPreview = inlineReplyPreview != nil
            && !message.isImageAttachment
            && !message.isFileAttachment
            && message.resourceCard == nil
            && message.sessionShareCard == nil
            && message.sessionShareV2Card == nil
            && message.sessionContinuationCard == nil
            && message.metadata?.card == nil
            && !message.hasStructuredCard
        let forwardedSourceText = IMForwardSourcePresentation.text(
            for: message.metadata?.forwardedFrom,
            currentUserId: currentUserId
        )
        VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
            if let forwardedSourceText {
                Label(forwardedSourceText, systemImage: "arrowshape.turn.up.right")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .padding(.horizontal, TTSpacing.xs)
                    .accessibilityLabel(forwardedSourceText)
            }
            if let preview = message.replyToPreview, !usesInlineReplyPreview {
                IMReplyPreviewBubble(preview: preview, isMine: isMine) {
                    openReplyThread(from: message)
                }
            }
            if message.isImageAttachment || message.isFileAttachment {
                IMAttachmentBubble(
                    message: message,
                    conversationId: conversationId,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    readProgress: readProgress
                )
            } else if let card = message.metadata?.card, card.isHandoff {
                IMHandoffCardBubble(
                    message: message,
                    card: card,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    refreshVersion: store.handoffVersions[card.handoffId ?? ""] ?? 0,
                    members: detail?.members ?? [],
                    onOpenReference: openHandoffReference,
                    readProgress: readProgress
                )
            } else if let card = message.resourceCard {
                IMResourceCardBubble(
                    message: message,
                    card: card,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    onOpen: { preview in
                        openCard(card, displayName: message.resourceCardDisplayName, preview: preview)
                    },
                    onUsePrompt: { prompt in usePromptInNewTask(prompt) },
                    loadPreview: { card in await conversationService.getResourceCardPreview(cardType: card.type, resourceId: card.resourceId ?? "") },
                    onRequestAccess: { await requestResourceAccess(message: message, card: card) },
                    readProgress: readProgress,
                    organizationMembers: workspace.members
                )
            } else if let card = message.sessionShareCard {
                IMSessionShareCardBubble(
                    message: message,
                    snapshot: card,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    currentUserId: currentUserId,
                    loadDetail: { snapshot in await loadSessionShareDetail(snapshot) },
                    onOpen: { openSessionShare($0) },
                    onRevoke: { await revokeSessionShare($0) },
                    onResume: { await resumeSessionShare($0) },
                    readProgress: readProgress
                )
            } else if let card = message.sessionShareV2Card {
                IMSessionShareV2CardBubble(
                    message: message,
                    snapshot: card,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    currentUserId: currentUserId,
                    organizationMembers: workspace.members,
                    loadDetail: { snapshot in await loadSessionShareV2Detail(snapshot) },
                    onAccept: { snapshot in await acceptSessionShareV2(snapshot) },
                    onRetryDelivery: { snapshot in await retrySessionShareV2Delivery(snapshot) },
                    onOpen: { openSessionShare($0.cardSnapshot) },
                    readProgress: readProgress
                )
            } else if let card = message.sessionContinuationCard {
                IMSessionContinuationCardBubble(
                    message: message,
                    snapshot: card,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    currentUserId: currentUserId,
                    organizationMembers: workspace.members,
                    loadDetail: { snapshot in await loadSessionContinuation(snapshot) },
                    createTask: { snapshot, agentId, workspaceId, clientRequestId in
                        await createTaskFromSessionContinuation(
                            snapshot,
                            agentId: agentId,
                            workspaceId: workspaceId,
                            clientRequestId: clientRequestId
                        )
                    },
                    onOpen: { openSessionContinuation($0) },
                    readProgress: readProgress
                )
            } else if let card = message.metadata?.card, card.promptCard != nil {
                IMResourceCardBubble(
                    message: message,
                    card: card,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    onOpen: { _ in },
                    onUsePrompt: { prompt in usePromptInNewTask(prompt) },
                    readProgress: readProgress,
                    organizationMembers: workspace.members
                )
            } else if message.hasStructuredCard {
                IMUnsupportedCardBubble(
                    message: message,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    readProgress: readProgress
                )
            } else if message.metadata?.kind == "tabtin_ref" && message.content.isEmpty {
                MessageBubble(
                    content: "消息内容暂不可用",
                    senderName: message.senderName,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    status: nil,
                    onRetry: nil,
                    replyPreview: inlineReplyPreview,
                    onOpenReplyPreview: { openReplyThread(from: message) },
                    readProgress: readProgress
                )
            } else {
                MessageBubble(
                    content: message.content,
                    senderName: message.senderName,
                    isMine: isMine,
                    isAgent: message.isFromAgent,
                    showsSenderName: showsSenderName,
                    clock: clock,
                    status: nil,
                    onRetry: nil,
                    replyPreview: inlineReplyPreview,
                    onOpenReplyPreview: { openReplyThread(from: message) },
                    readProgress: readProgress
                )
            }
        }
    }

    /// 与 Electron 的 ReplyThreadPanel 一致：引用消息进入其原消息 + 已加载回复的只读上下文。
    /// 原消息不在当前分页内时，用后端的安全预览构造占位，不为查看一条引用打断主列表分页。
    private func openReplyThread(from message: IMMessage) {
        let root: IMMessage
        if let replyToId = message.replyToId {
            if let loaded = store.messages.first(where: { $0.id == replyToId }) {
                root = loaded
            } else if let preview = message.replyToPreview {
                root = IMMessage(
                    id: replyToId,
                    seq: 0,
                    conversationId: conversationId,
                    senderId: preview.senderId,
                    content: preview.displayText,
                    messageType: IMMessageType.text.rawValue,
                    isDeleted: preview.isUnavailable
                )
            } else {
                root = message
            }
        } else {
            root = message
        }
        replyThreadRequest = IMReplyThreadRequest(
            root: root,
            replies: store.messages.filter { $0.replyToId == root.id }
        )
    }

    /// 消息页脚：仅保留已编辑标记；置顶状态统一在会话顶部管理。
    @ViewBuilder
    private func messageFooter(_ message: IMMessage, isMine: Bool) -> some View {
        let showEdited = message.isEdited
        if showEdited {
            HStack(spacing: 6) {
                if isMine { Spacer(minLength: 0) }
                Text("已编辑").font(.tt.captionMedium).foregroundStyle(.tt.textTertiary)
                if !isMine { Spacer(minLength: 0) }
            }
            .padding(.horizontal, 4)
        }
    }

    private func readStatusProgress(for message: IMMessage, isMine: Bool) -> IMReadReceipt? {
        guard isMine else { return nil }
        if isDM {
            return dmReadProgress(isMine: isMine, isReadByPeer: store.isReadByPeer(message))
        }
        return IMHumanReadReceiptPolicy.project(
            progress: store.readProgress(for: message),
            detail: readReceiptDetails[message.id],
            members: detail?.members ?? [],
            currentUserId: currentUserId,
            senderId: message.senderId
        ).progress
    }

    private var readReceiptPrefetchMessages: [IMMessage] {
        guard !isDM else { return [] }
        return store.messages.reversed().filter { message in
            message.senderId == currentUserId && (message.readReceipt?.recipientCount ?? 0) > 0
        }.prefix(12).map { $0 }
    }

    private var readReceiptPrefetchMessageIds: [Int] {
        readReceiptPrefetchMessages.map(\.id)
    }

    @MainActor
    private func prefetchHumanReadReceiptDetails() async {
        for message in readReceiptPrefetchMessages where readReceiptDetails[message.id] == nil {
            guard !Task.isCancelled else { return }
            if let detail = try? await store.fetchReadReceipts(for: message) {
                readReceiptDetails[message.id] = detail
            }
        }
        let retainedIds = Set(store.messages.suffix(64).map(\.id))
        readReceiptDetails = readReceiptDetails.filter { retainedIds.contains($0.key) }
    }

    /// 长按上下文菜单：首项只提供表情入口；其余能力与 Electron 的消息操作对齐。
    @ViewBuilder
    private func messageMenu(_ message: IMMessage, isMine: Bool) -> some View {
        Button {
            reactionMessage = message
        } label: {
            Label("添加表情", systemImage: "face.smiling")
        }

        Button {
            replyMessage = message
            composerFocused = true
        } label: {
            Label("回复", systemImage: "arrowshape.turn.up.left")
        }

        // 授权卡和无法安全重建的未知卡都不提供转发，避免只发出降级文本。
        if message.canForward {
            Button {
                forwardRequest = IMForwardRequest(messages: [message])
            } label: {
                Label("转发", systemImage: "arrowshape.turn.up.right")
            }
        }

        if detail?.isTeamSpaceChannel == true && !isExternalConversation {
            Button {
                agentTaskMessage = message
            } label: {
                Label("询问 Agent", systemImage: "sparkles")
            }
        }

        if !isExternalConversation,
           !isReadOnlyConversation,
           !message.isForwardRestrictedCard,
           detail?.members.contains(where: {
               $0.typedMemberType == .user && $0.userId != nil && $0.userId != currentUserId
           }) == true {
            Button {
                handoffSourceMessage = message
            } label: {
                Label("整理为交接", systemImage: "arrow.left.arrow.right")
            }
        }

        Button {
            toggleMessagePin(message)
        } label: {
            Label(message.isPinned ? "取消置顶" : "置顶", systemImage: message.isPinned ? "pin.slash" : "pin")
        }

        if message.isPlainText && !message.content.isEmpty {
            Button {
                UIPasteboard.general.string = message.content
            } label: {
                Label("复制", systemImage: "doc.on.doc")
            }
        }

        if isMine && message.isPlainText {
            Button {
                beginEdit(message)
            } label: {
                Label("编辑", systemImage: "pencil")
            }
        }

        if isMine && imWithinRecallWindow(message) {
            Button(role: .destructive) {
                recallMessage(message)
            } label: {
                Label("撤回", systemImage: "arrow.uturn.backward")
            }
        }
    }

    @MainActor
    private func openAgentTask(_ result: IMAgentTaskThreadResult) {
        guard let workspaceId = result.workspaceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !workspaceId.isEmpty else {
            actionMessage = "Agent 会话缺少执行 Workspace，请检查当前账号的设备绑定。"
            return
        }
        agentTaskMessage = nil
        onOpenChatSession(
            ConversationTarget(
                title: result.title.isEmpty ? "Agent 问询" : result.title,
                workspaceId: workspaceId,
                organizationId: result.organizationId,
                projectId: result.projectId,
                sessionId: result.sessionId,
                initialMessage: result.defaultPrompt
            )
        )
    }

    @ViewBuilder
    private var emptyOrError: some View {
        if let error = store.historyError,
           store.messages.isEmpty,
           store.hasCompletedInitialHistoryLoad {
            ContentUnavailableView {
                Label("加载失败", systemImage: "exclamationmark.bubble")
            } description: {
                Text(error)
            } actions: {
                Button("重试") { store.loadInitial() }
            }
        } else if groupCreatedNotice == nil, IMConversationInitialPresentation.shouldShowEmptyState(
            messageCount: store.messages.count,
            pendingCount: store.pending.count,
            hasCompletedInitialHistoryLoad: store.hasCompletedInitialHistoryLoad,
            isLoadingHistory: store.isLoadingHistory
        ) {
            ContentUnavailableView("还没有消息", systemImage: "bubble.left.and.bubble.right")
        } else if store.messages.isEmpty && store.pending.isEmpty {
            ProgressView()
                .controlSize(.regular)
        }
    }

    // MARK: - 输入框

    /// 保持移动端轻量输入栏：正文区域使用胶囊底色，附件与发送操作独立呈现。
    private var composer: some View {
        VStack(spacing: 6) {
            if isReadOnlyConversation {
                Label(readOnlyMessage, systemImage: "person.crop.circle.badge.xmark")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if editingMessage != nil {
                editBanner
            } else if let replyMessage {
                replyBanner(replyMessage)
            }
            if editingMessage == nil, let attachment = attachmentManager.attachments.first {
                IMDraftAttachmentRow(
                    attachment: attachment,
                    onRetry: {
                        guard let scope = attachmentUploadScope else {
                            actionMessage = "会话组织信息尚未就绪，请稍后重试。"
                            return
                        }
                        _ = attachmentManager.retryAttachment(
                            attachment.id,
                            scope: scope
                        )
                    },
                    onRemove: {
                        attachmentManager.removeAttachment(
                            attachment.id,
                            contextId: conversationId,
                            uploadScope: attachmentUploadScope
                        )
                    }
                )
            }
            if editingMessage == nil, let card = pendingCard {
                IMDraftCardRow(card: card) {
                    pendingCard = nil
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                if editingMessage == nil {
                    Menu {
                        // SwiftUI Menu 从底部锚点展开时会把源码后面的项放到视觉顶部。
                        // 这里按反向声明，让用户看到的顺序与 Android 一致：图片 / 文件优先。
                        Button("发送指令", systemImage: "terminal") { showPromptComposer = true }
                        if isDM, peerUserId != nil {
                            Button("共享任务", systemImage: "square.and.arrow.up") { showSessionSharePicker = true }
                        }
                        Divider()
                        Button("名片", systemImage: "person.crop.rectangle") { beginContactPicker() }
                        Button("云文件", systemImage: "folder") { beginResourcePicker() }
                        Divider()
                        Button("文件", systemImage: "paperclip") { beginFilePicker() }
                        Button("图片", systemImage: "photo") { beginPhotoPicker() }
                    } label: {
                        Image(systemName: "plus.circle")
                            .font(.tt.iconEmpty)
                            .foregroundStyle(.tt.textSecondary)
                    }
                    .accessibilityLabel("添加附件")
                    .disabled(isExternalConversation)
                }
                TextField(editingMessage == nil ? "发消息…" : "编辑消息…", text: $draft, axis: .vertical)
                    .font(ConversationTypography.composerFont)
                    .lineSpacing(ConversationTypography.composerLineSpacing)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 18))
                    .focused($composerFocused)
                    .onChange(of: draft) { oldDraft, newDraft in
                        //  defer：避免在 draft onChange 同步路径里改 @State / 触发 Centrifugo publish。
                        Task { @MainActor in sendTypingSignal() }
                        pendingMentions.removeAll { !hasMention(named: $0.displayName, in: newDraft) }
                        if isMentionTrigger(newDraft, previousDraft: oldDraft) {
                            showGroupMentionPicker = true
                        }
                    }

                Button(action: sendDraft) {
                    Image(systemName: editingMessage == nil ? "arrow.up.circle.fill" : "checkmark.circle.fill")
                        .font(.tt.iconEmpty)
                        .foregroundStyle(canSend ? Color.tt.bgAccent : Color.tt.textSecondary)
                }
                    .disabled(!canSend || isReadOnlyConversation)
                .accessibilityLabel(editingMessage == nil ? "发送" : "确认编辑")
            }
            if draftTextTooLong {
                Text(messageTooLongDetail)
                    .font(.tt.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, editingMessage == nil ? 44 : 0)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.tt.bgCanvasDefault)
    }

    private var editBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "pencil").font(.tt.iconCaption)
            Text("编辑消息").font(.tt.captionMedium)
            Spacer()
            Button("取消") { cancelEdit() }
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textAccent)
        }
        .foregroundStyle(.tt.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func replyBanner(_ message: IMMessage) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.left").font(.tt.iconCaption)
            VStack(alignment: .leading, spacing: 1) {
                Text("回复 \(message.senderName.isEmpty ? "消息" : message.senderName)").font(.tt.captionMedium)
                Text(message.content.isEmpty ? "附件消息" : message.content)
                    .font(.tt.captionMedium)
                    .lineLimit(1)
            }
            Spacer()
            Button { replyMessage = nil } label: {
                Image(systemName: "xmark.circle.fill").font(.tt.iconSubtitle)
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(.tt.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var canSend: Bool {
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasRichContent = attachmentManager.attachments.first?.status == .ready || pendingCard != nil
        return !isReadOnlyConversation && !draftTextTooLong && (hasText || (!isExternalConversation && hasRichContent))
    }

    private var draftTextLength: Int {
        getIMMessageContentLength(draft.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var draftTextTooLong: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isIMMessageContentWithinLimit(draft.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var messageTooLongDetail: String {
        "消息过长：当前 \(draftTextLength) 个字符，最多 \(imMessageContentMaxLength) 个字符"
    }

    // MARK: - 行为

    private func activate() async {
        // reaction 归属 / typing 过滤 / DM 已读判定都需要当前用户。
        store.currentUserId = currentUserId
        IMConversationStore.shared.enterConversation(conversationId)
        let initialOrganizationId = conversationOrganizationId
        if initialOrganizationId == nil { await loadDetail() }
        guard !Task.isCancelled else { return }

        let resolvedOrganizationId = resolveIMConversationActivationOrganizationId(
            initialOrganizationId: initialOrganizationId,
            currentOrganizationId: conversationOrganizationId
        )
        if resolvedOrganizationId == nil,
           let directoryOrganizationId = workspace.selectedOrganizationId {
            // 程序化切到消息 Tab 会并发切换会话目录；此时详情任务可能先于目录回填。
            // 当前组织只用于等待权威目录，不作为会话所属组织的兜底值。
            await conversationStore.reload(organizationId: directoryOrganizationId)
            guard !Task.isCancelled else { return }
        }
        // 会话成员身份才是消息历史与实时订阅的授权边界。组织归属只供资源分享、
        // 成员管理等二级操作使用；这些入口会继续各自要求权威 organizationId。
        // 因此目录仍暂空时不能阻断正文加载，否则一次正常的 Tab 切换竞态就会让
        // 用户永远进不去已经有权限的会话。
        let visibilityReady = await store.initializeHistoryVisibility()
        guard visibilityReady else {
            // REST 历史本身受服务端过滤，可安全展示；但实时共享通道必须等水位读取成功再订阅。
            if !hasLoadedInitial {
                hasLoadedInitial = true
                store.loadInitial()
            }
            await loadDetail()
            return
        }
        centrifugo.setChatPublicationListener(conversationId: conversationId) { data in
            store.applyRealtime(data)
        }
        centrifugo.setChatConnectionAvailableListener(conversationId: conversationId) {
            store.refreshLatest()
        }
        centrifugo.subscribeChat(conversationId: conversationId)
        centrifugo.connect()  // 幂等：已连/在连则忽略
        guard !hasLoadedInitial else {
            store.refreshLatest()
            store.markReadUpToLatest()
            return
        }
        hasLoadedInitial = true
        store.loadInitial()
        await loadDetail()
    }

    private func hydratePersistentSnapshotAfterFirstFrame() async {
        await Task.yield()
        let scopeId = currentUserId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedScopeId = scopeId?.isEmpty == false ? scopeId! : "anonymous"
        async let databaseMessages = IMMessageDatabaseCache.shared.messagesAsync(
            scopeId: resolvedScopeId,
            conversationId: conversationId
        )
        async let cachedWaterlines = IMMessageDatabaseCache.shared.readWaterlinesAsync(
            scopeId: resolvedScopeId,
            conversationId: conversationId
        )
        async let cachedPinnedMessages = IMMessageDatabaseCache.shared.pinnedMessagesAsync(
            scopeId: resolvedScopeId,
            conversationId: conversationId
        )
        var cachedMessages = await databaseMessages
        if cachedMessages.isEmpty {
            // 一次性兼容旧 JSON 快照；后续写入只走 SwiftData。
            cachedMessages = await IMMessageFileSnapshotCache.shared.messagesAsync(conversationId: conversationId)
            if !cachedMessages.isEmpty {
                IMMessageDatabaseCache.shared.store(
                    scopeId: resolvedScopeId,
                    conversationId: conversationId,
                    messages: cachedMessages
                )
            }
        }
        store.hydrateSnapshotIfNeeded(cachedMessages)
        store.hydratePinnedSnapshotIfNeeded(await cachedPinnedMessages)
        store.hydrateReadState(await cachedWaterlines)
    }

    private func beginEdit(_ message: IMMessage) {
        editingMessage = message
        pendingMentions = []
        draft = message.content
        composerFocused = true
    }

    private func recomposeRecalledMessage(_ message: IMMessage) {
        editingMessage = nil
        pendingMentions = []
        draft = message.content
        composerFocused = true
    }

    private func recallMessage(_ message: IMMessage) {
        let isLatest = store.messages.map(\.seq).max() == message.seq
        if isLatest {
            conversationStore.applyLatestPreviewUpdate(
                conversationId: conversationId,
                messageSeq: message.seq,
                preview: "消息已撤回"
            )
        }
        Task {
            let success = await store.recallMessage(messageId: message.id)
            if !success, isLatest {
                conversationStore.applyLatestPreviewUpdate(
                    conversationId: conversationId,
                    messageSeq: message.seq,
                    preview: message.previewTextForConversationList
                )
            }
            actionMessage = imRecallFeedbackMessage(success: success)
        }
    }

    private func cancelEdit() {
        editingMessage = nil
        draft = ""
    }

    private func toggleMessagePin(_ message: IMMessage) {
        Task {
            do {
                try await store.pinMessage(messageId: message.id, pinned: !message.isPinned)
            } catch {
                actionMessage = error.localizedDescription
            }
        }
    }

    private func scrollToMessage(_ message: IMMessage) {
        Task {
            while !store.messages.contains(where: { $0.id == message.id && !$0.isDeleted }),
                  store.hasMoreHistory {
                let previousCount = store.messages.count
                await store.loadHistory(reset: false)
                if store.messages.count == previousCount { break }
            }
            guard store.messages.contains(where: { $0.id == message.id && !$0.isDeleted }) else {
                actionMessage = "置顶消息已不可用"
                return
            }
            scrollToMessageToken += 1
            scrollToMessageRequest = IMMessageScrollRequest(messageId: message.id, token: scrollToMessageToken)
        }
    }

    private func forward(_ messages: [IMMessage], to target: IMConversation) async {
        var failed = 0
        for message in messages {
            do {
                try await store.forwardMessage(message, sourceConversationName: resolvedTitle, to: target.id)
            } catch {
                failed += 1
            }
        }
        actionMessage = failed == 0
            ? "已转发\(messages.count > 1 ? " \(messages.count) 条消息" : "")"
            : "\(messages.count - failed) 条已转发，\(failed) 条未成功。"
    }

    private func renameConversation(_ name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        do {
            try await conversationService.updateConversationName(conversationId: conversationId, name: trimmed)
            IMConversationStore.shared.updateConversationName(conversationId, name: trimmed)
            if let current = detail {
                detail = IMConversationDetail(
                    id: current.id,
                    organizationId: current.organizationId,
                    spaceId: current.spaceId,
                    spaceName: current.spaceName,
                    isTeamSpaceChannel: current.isTeamSpaceChannel,
                    type: current.type,
                    name: trimmed,
                    avatarUrl: current.avatarUrl,
                    memberCount: current.memberCount,
                    isArchived: current.isArchived,
                    lastMessageAt: current.lastMessageAt,
                    lastMessagePreview: current.lastMessagePreview,
                    createdBy: current.createdBy,
                    createdAt: current.createdAt,
                    members: current.members,
                    hasUnreadMention: current.hasUnreadMention,
                    isExternal: current.isExternal,
                    participantOrganizationId: current.participantOrganizationId,
                    directoryScopeId: current.directoryScopeId,
                    canSend: current.canSend,
                    labels: current.labels
                )
            }
            await loadDetail()
            return true
        } catch {
            actionMessage = error.localizedDescription
            return false
        }
    }

    /// 群头像沿用 Electron 的公开 conversation OSS scope；nil 表示移除头像。
    /// 返回非 nil 即保存成功，空字符串代表成功移除。
    private func updateConversationAvatar(data: Data?) async -> String? {
        guard let detail, detail.conversationType == .group else { return nil }
        do {
            let avatarUrl: String
            if let data {
                let upload = try await OSSUploadService.shared.directUpload(
                    data: data,
                    fileName: "group-avatar-\(conversationId).jpg",
                    contentType: "image/jpeg",
                    folder: "im/avatars",
                    scope: UploadScope(
                        module: "tabchat",
                        contextType: "conversation",
                        contextId: conversationId,
                        organizationId: detail.organizationId,
                        isPublic: true
                    )
                )
                avatarUrl = upload.accessUrl.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !avatarUrl.isEmpty else {
                    throw IMConversationActionError.emptyAvatarURL
                }
            } else {
                avatarUrl = ""
            }

            try await conversationService.updateConversationAvatar(
                conversationId: conversationId,
                avatarUrl: avatarUrl
            )
            IMConversationStore.shared.updateConversationAvatar(conversationId, avatarUrl: avatarUrl)
            self.detail = replacingAvatar(in: detail, avatarUrl: avatarUrl)
            return avatarUrl
        } catch {
            actionMessage = error.localizedDescription
            return nil
        }
    }

    private func replacingAvatar(in detail: IMConversationDetail, avatarUrl: String) -> IMConversationDetail {
        IMConversationDetail(
            id: detail.id,
            organizationId: detail.organizationId,
            spaceId: detail.spaceId,
            spaceName: detail.spaceName,
            isTeamSpaceChannel: detail.isTeamSpaceChannel,
            type: detail.type,
            name: detail.name,
            avatarUrl: avatarUrl,
            memberCount: detail.memberCount,
            isArchived: detail.isArchived,
            lastMessageAt: detail.lastMessageAt,
            lastMessagePreview: detail.lastMessagePreview,
            createdBy: detail.createdBy,
            createdAt: detail.createdAt,
            members: detail.members,
            hasUnreadMention: detail.hasUnreadMention,
            isExternal: detail.isExternal,
            participantOrganizationId: detail.participantOrganizationId,
            directoryScopeId: detail.directoryScopeId,
            canSend: detail.canSend,
            labels: detail.labels
        )
    }

    private func toggleConversationMute() async -> Bool {
        do {
            let muted = try await conversationService.toggleMute(conversationId: conversationId)
            IMConversationStore.shared.updateMuteState(conversationId, muted: muted)
            return muted
        } catch {
            actionMessage = error.localizedDescription
            return IMConversationStore.shared.conversations.first(where: { $0.id == conversationId })?.isMuted ?? false
        }
    }

    private func toggleConversationPin() async -> Bool {
        await IMConversationStore.shared.togglePin(conversationId: conversationId)
        if let error = IMConversationStore.shared.pinActionError {
            actionMessage = error
        }
        return IMConversationStore.shared.conversations.first(where: { $0.id == conversationId })?.pinned ?? false
    }

    private func inviteMembers(_ memberIds: [String]) async -> Bool {
        guard !memberIds.isEmpty else { return false }
        do {
            _ = try await conversationService.addMembers(conversationId: conversationId, memberIds: memberIds)
            await loadDetail()
            return true
        } catch {
            actionMessage = error.localizedDescription
            return false
        }
    }

    private func inviteExternalMembers(_ contactIds: [String]) async -> Bool {
        guard !contactIds.isEmpty else { return false }
        do {
            _ = try await conversationService.addExternalMembers(
                conversationId: conversationId,
                externalContactIds: contactIds
            )
            await refreshConversationMembership()
            return true
        } catch {
            actionMessage = error.localizedDescription
            return false
        }
    }

    private func removeConversationMember(_ userId: String) async -> Bool {
        guard !userId.isEmpty else { return false }
        do {
            try await conversationService.removeMember(conversationId: conversationId, userId: userId)
            await refreshConversationMembership()
            return true
        } catch {
            actionMessage = error.localizedDescription
            return false
        }
    }

    private func removeConversationAgent(_ agentId: String, deleteBinding: Bool) async -> Bool {
        guard !agentId.isEmpty else { return false }
        do {
            if deleteBinding {
                try await conversationService.deleteAgentBinding(conversationId: conversationId, agentId: agentId)
            } else {
                try await conversationService.removeAgent(conversationId: conversationId, agentId: agentId)
            }
            await refreshConversationMembership()
            return true
        } catch {
            actionMessage = error.localizedDescription
            return false
        }
    }

    private func refreshConversationMembership() async {
        let directoryOrganizationId = detail?.directoryOrganizationId
        await loadDetail()
        if let directoryOrganizationId, !directoryOrganizationId.isEmpty {
            await IMConversationStore.shared.reload(organizationId: directoryOrganizationId)
        }
    }

    private func clearConversationHistory() async -> Bool {
        do {
            try await store.clearHistory()
            return true
        } catch {
            actionMessage = error.localizedDescription
            return false
        }
    }

    private func leaveConversation() async -> Bool {
        do {
            try await store.leaveConversation()
            try await conversationService.leaveConversation(conversationId: conversationId)
            IMConversationStore.shared.removeConversation(conversationId)
            deactivate()
            dismiss()
            return true
        } catch {
            actionMessage = error.localizedDescription
            return false
        }
    }

    private func loadConversationAssets() async -> [IMMessage] {
        let messages = (try? await DjangoIMAdapter.shared.fetchMessages(
            conversationId: conversationId,
            before: nil,
            limit: 100
        )) ?? []
        return messages.filter { message in
            message.messageType == IMMessageType.file.rawValue
                || message.messageType == IMMessageType.image.rawValue
                || ["document", "table"].contains(message.metadata?.cardType)
        }
            .sorted { $0.id > $1.id }
    }

    /// 输入时向 `chat:{conv}` publish typing（3s 节流；编辑态/未登录不发）。
    private func sendTypingSignal() {
        guard editingMessage == nil, let userId = currentUserId,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let now = Date()
        guard now.timeIntervalSince(lastTypingSent) > 3 else { return }
        lastTypingSent = now
        centrifugo.publishToChat(
            conversationId: conversationId,
            payload: ["type": "im.typing", "user_id": userId]
        )
    }

    /// 拉会话详情：用于判定是否群聊（可 @ Agent）及已在会话的 Agent 成员。
    /// 失败不阻塞收发消息，仅关闭 @ 入口。
    private func loadDetail() async {
        guard let fetched = try? await conversationService.fetchDetail(conversationId: conversationId) else { return }
        detail = fetched
        store.updateConversationDetail(fetched)
        guard !fetched.organizationId.isEmpty else { return }
        await workspace.loadMembers(organizationId: fetched.organizationId)
        let enriched = IMMemberDisplayPolicy.enrichedDetail(fetched, organizationMembers: workspace.members)
        detail = enriched
        store.updateConversationDetail(enriched)
        await prewarmAvatarImages(detail: enriched)
    }

    /// 列表单元复用前先把会话成员图片解码进共享内存缓存，后续滚回屏幕可同步命中，
    /// 不再经历“文字头像 → 图片头像”的视觉切换。
    private func prewarmAvatarImages(detail: IMConversationDetail) async {
        let urls = Set(
            detail.members.map(\.avatar)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .compactMap(URL.init(string:))
        )
        await withTaskGroup(of: Void.self) { group in
            for url in urls {
                group.addTask {
                    _ = await AvatarImageMemoryCache.shared.image(for: url)
                }
            }
        }
    }

    private func isMentionTrigger(_ text: String, previousDraft: String) -> Bool {
        guard
            editingMessage == nil,
            canMentionMembers,
            !showGroupMentionPicker,
            !showAgentMentionPicker,
            text.count > previousDraft.count,
            text.last == "@"
        else {
            return false
        }
        guard text.count > 1 else { return true }
        return text.dropLast().last?.isWhitespace == true
    }

    /// 与桌面端同样要求 @所有人 后是分隔符或文末，避免 `@所有人事` 这类普通文本误触发全员提醒。
    private func hasMentionAll(_ text: String) -> Bool {
        text.range(
            of: #"@所有人(?=[\s,;.!?，。！？、；：]|$)"#,
            options: .regularExpression
        ) != nil
    }

    /// 保持与桌面端相同的尾部边界，昵称是另一个昵称前缀时不能误带 metadata。
    private func hasMention(named displayName: String, in text: String) -> Bool {
        let escapedName = NSRegularExpression.escapedPattern(for: displayName)
        return text.range(
            of: "@\(escapedName)(?=[\\s,;.!?，。！？、；：]|$)",
            options: .regularExpression
        ) != nil
    }

    private func insertMention(_ member: IMMember) {
        guard let mention = IMDraftMention(member: member), draft.last == "@" else { return }
        if !pendingMentions.contains(where: { $0.id == mention.id }) {
            pendingMentions.append(mention)
        }
        draft.removeLast()
        draft += "@\(mention.displayName) "
    }

    private func insertMention(_ agent: IMAgentSummary) {
        guard draft.last == "@" else { return }
        let mention = IMDraftMention(agent: agent)
        if !pendingMentions.contains(where: { $0.id == mention.id }) {
            pendingMentions.append(mention)
        }
        draft.removeLast()
        draft += "@\(mention.displayName) "
    }

    private func insertMentionAll() {
        guard draft.last == "@" else { return }
        draft.removeLast()
        draft += "@所有人 "
    }

    private func openDirectMessage(userId: String, displayName: String) {
        guard !userId.isEmpty else {
            actionMessage = "成员信息不完整，暂时无法发起私信。"
            return
        }
        guard userId != currentUserId else {
            actionMessage = "不能给自己创建私信。"
            return
        }
        guard let organizationId = conversationOrganizationId else {
            actionMessage = "会话组织信息尚未就绪，请稍后重试。"
            return
        }
        guard openingDirectMessageUserId == nil else { return }
        openingDirectMessageUserId = userId
        Task {
            defer {
                openingDirectMessageUserId = nil
            }
            do {
                let id = try await resolveDirectMessageConversationId(
                    conversations: conversationStore.conversations,
                    organizationId: organizationId,
                    otherUserId: userId
                ) {
                    try await conversationService.createOrGetDM(
                        organizationId: organizationId,
                        otherUserId: userId
                    )
                }
                guard !id.isEmpty else { throw IMConversationActionError.emptyConversationId }
                guard id != conversationId else {
                    actionMessage = "当前已经在这段私信中。"
                    return
                }
                conversationStore.rememberDirectMessage(
                    conversationId: id,
                    organizationId: organizationId,
                    otherUserId: userId,
                    displayName: displayName
                )
                isOpeningNestedConversation = true
                onOpenConversation(IMConversationTarget(
                    conversationId: id,
                    title: displayName.isEmpty ? "私信" : displayName
                ))
            } catch {
                actionMessage = error.localizedDescription
            }
        }
    }

    private func openCard(
        _ card: IMResourceCard,
        displayName: String? = nil,
        preview: IMResourceCardPreview? = nil
    ) {
        let trimmedDisplayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedDisplayName = trimmedDisplayName?.isEmpty == false ? trimmedDisplayName! : card.displayName
        switch card.typedType {
        case .contact:
            guard let userId = card.userId, !userId.isEmpty else {
                actionMessage = "这张名片缺少用户信息，只能查看。"
                return
            }
            openDirectMessage(userId: userId, displayName: resolvedDisplayName)
        case .document, .table:
            guard let target = card.resolveOpenTarget(
                conversationOrganizationId: conversationOrganizationId ?? "",
                preview: preview
            ) else {
                actionMessage = "资源卡缺少打开所需的信息，暂时无法打开。"
                return
            }
            let request = SpaceResourceOpenRequest(
                resourceType: target.resourceType,
                resourceId: target.resourceId,
                title: resolvedDisplayName,
                locationHint: nil
            )
            guard let route = request.fallbackRoute else {
                actionMessage = request.unsupportedOpenNotice
                return
            }
            isOpeningResourceDetail = true
            cloudResourceContext = CloudResourceOpenContext(
                id: target.resourceId,
                organizationId: target.organizationId,
                spaceId: target.spaceId,
                spaceName: nil,
                route: route
            )
        case .space, .agentSpace:
            guard let spaceId = card.spaceCard?.spaceId else {
                actionMessage = "工作空间卡缺少打开所需的信息。"
                return
            }
            MainRouter.shared.openWorkspace(spaceId)
        case .sessionShare, .none:
            actionMessage = "这条卡片缺少可执行信息，只能查看。"
        }
    }

    private func requestResourceAccess(message: IMMessage, card: IMResourceCard) async -> Bool {
        do {
            let info = try await conversationService.createResourceAccessRequest(
                conversationId: conversationId,
                message: message,
                card: card
            )
            actionMessage = info.status == "pending" ? "已提交访问申请，等待确认" : "已发送访问申请"
            if info.status == "pending" {
                IMCardStatusMemoryCache.markResourceAccessRequested(for: card)
            }
            return info.status == "pending"
        } catch {
            actionMessage = error.imUserMessage
            return false
        }
    }

    private func loadSessionShareDetail(_ snapshot: IMSessionShareCard) async -> IMSessionShareCard {
        if let cached = IMCardStatusMemoryCache.authoritativeSessionShare(id: snapshot.shareId) {
            return cached
        }
        let result = await cardDetailRequests.legacySessionShares.load(key: snapshot.shareId) {
            let card = try await conversationService.getSessionShare(id: snapshot.shareId)
            IMCardStatusMemoryCache.putAuthoritativeSessionShare(card)
            return card
        }
        return (try? result.get())
            ?? IMCardStatusMemoryCache.authoritativeSessionShare(id: snapshot.shareId)
            ?? IMCardStatusMemoryCache.sessionShare(id: snapshot.shareId)
            ?? snapshot
    }

    private func loadSessionShareV2Detail(_ snapshot: IMSessionShareV2Card) async -> IMSessionShareV2Detail? {
        if let cached = IMCardStatusMemoryCache.sessionShareV2Detail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ) {
            return cached
        }
        let result = await cardDetailRequests.sessionShareV2.load(
            key: "\(snapshot.objectId):\(snapshot.version)"
        ) {
            let detail = try await conversationService.getSessionShareV2(id: snapshot.objectId)
            IMCardStatusMemoryCache.putSessionShareV2Detail(detail)
            return detail
        }
        guard let loaded = try? result.get() else { return nil }
        return IMCardStatusMemoryCache.sessionShareV2Detail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ) ?? loaded
    }

    private func acceptSessionShareV2(_ snapshot: IMSessionShareV2Card) async -> IMSessionShareV2Detail? {
        do {
            let detail = try await conversationService.acceptSessionShareV2(id: snapshot.objectId)
            IMCardStatusMemoryCache.putSessionShareV2Detail(detail)
            return IMCardStatusMemoryCache.sessionShareV2Detail(
                id: snapshot.objectId,
                minimumVersion: snapshot.version
            ) ?? detail
        } catch {
            actionMessage = error.imUserMessage
            return nil
        }
    }

    private func retrySessionShareV2Delivery(
        _ snapshot: IMSessionShareV2Card
    ) async -> IMSessionShareV2Detail? {
        do {
            let detail = try await conversationService.retrySessionShareV2Delivery(id: snapshot.objectId)
            IMCardStatusMemoryCache.putSessionShareV2Detail(detail)
            return IMCardStatusMemoryCache.sessionShareV2Detail(
                id: snapshot.objectId,
                minimumVersion: snapshot.version
            ) ?? detail
        } catch {
            actionMessage = error.imUserMessage
            return nil
        }
    }

    private func loadSessionContinuation(
        _ snapshot: IMSessionContinuationCard
    ) async -> IMSessionContinuationDetail? {
        if let cached = IMCardStatusMemoryCache.sessionContinuationDetail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ) {
            return cached
        }
        let result = await cardDetailRequests.sessionContinuations.load(
            key: "\(snapshot.objectId):\(snapshot.version)"
        ) {
            let detail = try await conversationService.getSessionContinuation(id: snapshot.objectId)
            IMCardStatusMemoryCache.putSessionContinuationDetail(detail)
            return detail
        }
        let loaded: IMSessionContinuationDetail
        switch result {
        case .success(let detail):
            loaded = detail
        case .failure(let error):
            actionMessage = error.imUserMessage
            return nil
        }
        return IMCardStatusMemoryCache.sessionContinuationDetail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ) ?? loaded
    }

    private func createTaskFromSessionContinuation(
        _ snapshot: IMSessionContinuationCard,
        agentId: String,
        workspaceId: String,
        clientRequestId: String
    ) async -> IMSessionContinuationDetail? {
        do {
            let detail = try await conversationService.createTaskFromSessionContinuation(
                id: snapshot.objectId,
                agentId: agentId,
                workspaceId: workspaceId,
                clientRequestId: clientRequestId
            )
            IMCardStatusMemoryCache.putSessionContinuationDetail(detail)
            return detail
        } catch {
            actionMessage = error.imUserMessage
            return nil
        }
    }

    private func openSessionContinuation(_ detail: IMSessionContinuationDetail) {
        guard let sessionId = detail.linkedSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty,
              let workspaceId = detail.targetWorkspaceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !workspaceId.isEmpty else {
            actionMessage = "续接任务信息不完整"
            return
        }
        onOpenChatSession(
            ConversationTarget(
                title: detail.titleSnapshot,
                workspaceId: workspaceId,
                organizationId: detail.organizationId,
                sessionId: sessionId
            )
        )
    }

    private func openSessionShare(_ card: IMSessionShareCard) {
        guard card.normalizedStatus == "active" else {
            actionMessage = "共享已停止"
            return
        }
        guard let sessionId = card.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty else {
            actionMessage = "任务信息不完整"
            return
        }
        let currentUserId = AuthService.shared.currentUser?.id
        if isSessionShareOwner(currentUserId: currentUserId, ownerUserId: card.ownerUserId, isMine: false) {
            onOpenChatSession(
                ConversationTarget(
                    title: card.displayTitle,
                    workspaceId: "",
                    organizationId: conversationOrganizationId ?? "",
                    sessionId: sessionId
                )
            )
        } else {
            sharedSessionTarget = card
        }
    }

    private func revokeSessionShare(_ card: IMSessionShareCard) async -> IMSessionShareCard? {
        do {
            let updated = try await conversationService.revokeSessionShare(id: card.shareId)
            IMCardStatusMemoryCache.putAuthoritativeSessionShare(updated)
            return updated
        } catch {
            actionMessage = error.imUserMessage
            return nil
        }
    }

    private func resumeSessionShare(_ card: IMSessionShareCard) async -> IMSessionShareCard? {
        guard let sessionId = card.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty,
              let granteeUserId = card.granteeUserId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !granteeUserId.isEmpty else {
            actionMessage = "任务共享信息不完整"
            return nil
        }
        do {
            let updated = try await conversationService.createSessionShare(
                sessionId: sessionId,
                granteeUserId: granteeUserId,
                canFork: card.canFork,
                canChat: card.canChat,
                conversationId: conversationId,
                clientRequestId: nil,
                restoreShareId: card.shareId
            )
            IMCardStatusMemoryCache.putAuthoritativeSessionShare(updated)
            return updated
        } catch {
            actionMessage = error.imUserMessage
            return nil
        }
    }

    private func shareSession(
        _ session: RecentSession,
        peerUserId: String,
        mode: ConversationSessionShareMode,
        clientRequestId: String
    ) async throws {
        if mode.isContinuation {
            _ = try await conversationService.createSessionContinuation(
                sourceSessionId: session.id,
                recipientUserId: peerUserId,
                conversationId: conversationId,
                clientRequestId: clientRequestId
            )
        } else {
            _ = try await conversationService.createSessionShare(
                sessionId: session.id,
                granteeUserId: peerUserId,
                canFork: mode.canFork,
                canChat: mode.canChat,
                conversationId: conversationId,
                clientRequestId: clientRequestId,
                restoreShareId: nil
            )
        }
    }

    /// 交接材料仍遵守原资源权限：详情接口只会把当前查看者可访问的材料交给这里。
    private func openHandoffReference(_ reference: IMHandoffReference) {
        switch reference.refType {
        case "im_message":
            guard let messageId = reference.sourceLink.messageId,
                  let message = store.messages.first(where: { $0.id == messageId }) else {
                actionMessage = "这条原消息不在当前已加载的记录中。"
                return
            }
            replyThreadRequest = IMReplyThreadRequest(
                root: message,
                replies: store.messages.filter { $0.replyToId == message.id }
            )
        case "document", "table":
            let organizationId = reference.sourceLink.organizationId ?? conversationOrganizationId ?? ""
            guard !organizationId.isEmpty else {
                actionMessage = "材料缺少组织信息，暂时无法打开。"
                return
            }
            resourceTarget = IMResourceTarget(
                organizationId: organizationId,
                spaceId: reference.sourceLink.spaceId,
                request: SpaceResourceOpenRequest(
                    resourceType: reference.refType == "table" ? "tabdata" : "tabdoc",
                    resourceId: reference.resourceId,
                    title: reference.title,
                    locationHint: nil
                )
            )
        default:
            actionMessage = "这种材料暂不支持从消息页打开。"
        }
    }

    private func visibleMembers(_ detail: IMConversationDetail) -> [IMMember] {
        detail.members.filter { $0.userId != currentUserId }
    }

    private func deactivate() {
        centrifugo.unsubscribeChat(conversationId: conversationId)
        centrifugo.setChatPublicationListener(conversationId: conversationId, listener: nil)
        centrifugo.setChatConnectionAvailableListener(conversationId: conversationId, listener: nil)
        IMConversationStore.shared.leaveConversation(conversationId)
        // 失败消息属于可恢复的本地历史；离开会话只持久化，不能释放其附件重试所有权。
        attachmentManager.clear(
            contextId: conversationId,
            uploadScope: attachmentUploadScope
        )
    }

    private func sendDraft() {
        guard !isReadOnlyConversation else {
            actionMessage = readOnlyMessage
            return
        }
        if isExternalConversation && (!attachmentManager.attachments.isEmpty || pendingCard != nil) {
            actionMessage = externalConversationMessage
            return
        }
        guard !draftTextTooLong else {
            actionMessage = messageTooLongDetail
            return
        }
        if let editing = editingMessage {
            let newText = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !newText.isEmpty else { return }
            Task { await store.editMessage(messageId: editing.id, newContent: newText) }
            cancelEdit()
            return
        }
        Task { await sendDraftAsync() }
    }

    // MARK: - 富卡 composer

    /// 本期资源卡和本地附件各自是一条消息，避免把两个独立内容误合并为语义不清的复合消息。
    private func ensureNoPendingCardForAttachment() -> Bool {
        guard pendingCard == nil else {
            actionMessage = "请先发送或移除当前资源卡。"
            return false
        }
        return true
    }

    private func ensureNoPendingAttachmentForCard() -> Bool {
        guard attachmentManager.attachments.isEmpty else {
            actionMessage = "请先移除当前附件，再发送资源卡。"
            return false
        }
        return true
    }

    private func beginPhotoPicker() {
        guard !isExternalConversation else { actionMessage = externalConversationMessage; return }
        guard !isReadOnlyConversation else { actionMessage = readOnlyMessage; return }
        guard ensureNoPendingCardForAttachment() else { return }
        showPhotoPicker = true
    }

    private func beginFilePicker() {
        guard !isExternalConversation else { actionMessage = externalConversationMessage; return }
        guard !isReadOnlyConversation else { actionMessage = readOnlyMessage; return }
        guard ensureNoPendingCardForAttachment() else { return }
        showFileImporter = true
    }

    private func beginResourcePicker() {
        guard !isExternalConversation else { actionMessage = externalConversationMessage; return }
        guard !isReadOnlyConversation else { actionMessage = readOnlyMessage; return }
        guard ensureNoPendingAttachmentForCard() else { return }
        guard conversationOrganizationId != nil else {
            actionMessage = "会话信息尚未就绪，请稍后重试。"
            return
        }
        showResourcePicker = true
    }

    private func beginContactPicker() {
        guard !isExternalConversation else { actionMessage = externalConversationMessage; return }
        guard !isReadOnlyConversation else { actionMessage = readOnlyMessage; return }
        guard conversationOrganizationId != nil else {
            actionMessage = "会话信息尚未就绪，请稍后重试。"
            return
        }
        showContactCardPicker = true
    }

    /// 名片和指令是选择/提交后直接发出；失败时同样进入 pending，可从消息流就地重试。
    private func sendCardImmediately(_ card: IMOutgoingCard) {
        guard !isExternalConversation else { actionMessage = externalConversationMessage; return }
        guard !isReadOnlyConversation else { actionMessage = readOnlyMessage; return }
        let outcome = store.enqueueSend(
            content: card.fallbackContent,
            messageType: IMMessageType.text.rawValue,
            card: card
        )
        guard outcome.didEnqueue else {
            actionMessage = "消息无法发送。"
            return
        }
        replyMessage = nil
        scrollToBottomToken += 1
    }

    private func usePromptInNewTask(_ prompt: IMPromptCard) {
        taskComposerDraft = prompt.promptText
        showTaskComposer = true
    }

    private func sendDraftAsync() async {
        if isExternalConversation && (!attachmentManager.attachments.isEmpty || pendingCard != nil) {
            actionMessage = externalConversationMessage
            return
        }
        let attachment = attachmentManager.attachments.first
        let card = pendingCard
        if attachment?.status.isInFlight == true {
            actionMessage = "附件仍在上传中，请稍候再发送。"
            return
        }
        if attachment?.status == .error {
            actionMessage = "附件上传失败，请重试或移除后再发送。"
            return
        }

        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let mentions = pendingMentions.filter { hasMention(named: $0.displayName, in: text) }
        guard !text.isEmpty || attachment != nil || card != nil else { return }
        guard card == nil || attachment == nil else {
            actionMessage = "资源卡和附件请分开发送。"
            return
        }

        let outgoing = attachment.flatMap { item -> IMOutgoingAttachment? in
            guard let fileId = item.fileId else { return nil }
            return IMOutgoingAttachment(
                fileId: fileId,
                fileName: item.name,
                fileSize: Int(min(item.byteCount ?? 0, Int64(Int.max))),
                fileType: item.mimeType ?? "application/octet-stream",
                remoteURL: item.remoteURL
            )
        }
        let messageType: Int
        if let attachment {
            messageType = attachment.kind == .file
                ? IMMessageType.file.rawValue
                : IMMessageType.image.rawValue
        } else {
            messageType = IMMessageType.text.rawValue
        }

        // 卡片的 content 只是旧端/会话预览用的兼容文案。不能把用户额外输入的说明
        // 塞进去后又在卡片渲染时隐藏，否则用户看起来像是刚发送的文字消失了。
        // 有说明时紧接着单独发一条文本消息，卡片主体仍保持干净。
        let outcome = store.enqueueSend(
            content: card?.fallbackContent ?? text,
            messageType: messageType,
            replyToId: replyMessage?.id,
            mentionedUserIds: card == nil ? mentions.compactMap(\.userId) : [],
            mentionedAgentIds: card == nil ? mentions.compactMap(\.agentId) : [],
            mentionAll: card == nil && canMentionMembers && hasMentionAll(text),
            attachment: outgoing,
            card: card
        )
        // 同步入队成功即可清理 composer；传输结果只更新对应 pending。
        guard outcome.didEnqueue else {
            actionMessage = outcome == .rejectedTooLong ? messageTooLongDetail : "消息发送中，请稍候。"
            return
        }
        if card != nil, !text.isEmpty {
            // 与卡片分开发送后，说明能以普通消息正常展示；也让 @ 语义绑定在真正可见的文本上。
            let noteOutcome = store.enqueueSend(
                content: text,
                messageType: IMMessageType.text.rawValue,
                mentionedUserIds: mentions.compactMap(\.userId),
                mentionedAgentIds: mentions.compactMap(\.agentId),
                mentionAll: canMentionMembers && hasMentionAll(text)
            )
            guard noteOutcome.didEnqueue else {
                // 卡片已经入队，不能再次把它留在 composer；说明保留供用户稍后重发。
                pendingCard = nil
                actionMessage = noteOutcome == .rejectedTooLong ? messageTooLongDetail : "资源卡已发送，说明仍在输入框，请稍后发送。"
                return
            }
        }
        if attachment != nil {
            attachmentManager.clear(
                contextId: conversationId,
                deactivateUploaded: false,
                uploadScope: attachmentUploadScope
            )
        }
        draft = ""
        pendingMentions = []
        replyMessage = nil
        pendingCard = nil
        scrollToBottomToken += 1
    }

    private func retryPending(_ pending: IMPendingMessage) {
        guard !isReadOnlyConversation else {
            actionMessage = readOnlyMessage
            return
        }
        _ = store.enqueueSend(
            content: pending.content,
            messageType: pending.messageType,
            replyToId: pending.replyToId,
            mentionedUserIds: pending.mentionedUserIds,
            mentionedAgentIds: pending.mentionedAgentIds,
            mentionAll: pending.mentionAll,
            attachment: pending.attachment,
            card: pending.card,
            clientRequestId: pending.clientRequestId,
            isRetry: true
        )
    }

    private func importPhoto(_ item: PhotosPickerItem) async {
        defer { selectedPhotoItem = nil }
        guard pendingCard == nil else {
            actionMessage = "请先发送或移除当前资源卡。"
            return
        }
        guard attachmentManager.attachments.isEmpty else {
            actionMessage = "一条 IM 消息暂时只支持一个附件，请先移除当前附件。"
            return
        }
        guard let scope = attachmentUploadScope else {
            actionMessage = "会话组织信息尚未就绪，请稍后重试。"
            return
        }
        do {
            guard let data = try await item.loadTransferable(type: Data.self), !data.isEmpty else {
                actionMessage = "图片读取失败。"
                return
            }
            // 用相册项声明的 UTType 推导真实扩展名（PNG/HEIC/…），不再无条件命名 .jpg；
            // addPhoto 再按字节魔数归一化 MIME/扩展名并与转码产物对齐（PNG 保留、HEIC 转 JPEG）。
            let declaredExtension = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
            actionMessage = attachmentManager.addPhoto(
                data: data,
                filename: "image_\(Int(Date().timeIntervalSince1970)).\(declaredExtension)",
                scope: scope
            )
        } catch {
            actionMessage = error.localizedDescription
        }
    }

    private func addFile(_ url: URL) {
        guard pendingCard == nil else {
            actionMessage = "请先发送或移除当前资源卡。"
            return
        }
        guard attachmentManager.attachments.isEmpty else {
            actionMessage = "一条 IM 消息暂时只支持一个附件，请先移除当前附件。"
            return
        }
        guard let scope = attachmentUploadScope else {
            actionMessage = "会话组织信息尚未就绪，请稍后重试。"
            return
        }
        actionMessage = attachmentManager.addFile(
            url: url,
            scope: scope
        )
    }

    private func handlePickedFile(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            if let url = urls.first { addFile(url) }
        case .failure(let error):
            actionMessage = error.localizedDescription
        }
    }

}

func dmReadProgress(isMine: Bool, isReadByPeer: Bool) -> IMReadReceipt? {
    guard isMine else { return nil }
    return IMReadReceipt(readCount: isReadByPeer ? 1 : 0, recipientCount: 1)
}

func groupReadProgress(
    isMine: Bool,
    progress: IMReadReceipt?,
    fallbackRecipientCount: Int
) -> IMReadReceipt? {
    guard isMine else { return nil }
    let recipientCount = max(fallbackRecipientCount, 0)
    let readCount = min(max(progress?.readCount ?? 0, 0), max(recipientCount, 0))
    return IMReadReceipt(readCount: readCount, recipientCount: max(recipientCount, 0))
}

enum IMConversationInitialPresentation {
    static func shouldShowEmptyState(
        messageCount: Int,
        pendingCount: Int,
        hasCompletedInitialHistoryLoad: Bool,
        isLoadingHistory: Bool
    ) -> Bool {
        messageCount == 0
            && pendingCount == 0
            && hasCompletedInitialHistoryLoad
            && !isLoadingHistory
    }
}

private enum IMConversationActionError: LocalizedError {
    case emptyConversationId
    case emptyAvatarURL

    var errorDescription: String? {
        switch self {
        case .emptyConversationId:
            return "私信会话创建失败，请稍后重试。"
        case .emptyAvatarURL:
            return "群头像上传成功但未返回可用地址，请重新选择。"
        }
    }
}

private struct IMResourceTarget: Identifiable {
    let organizationId: String
    let spaceId: String?
    let request: SpaceResourceOpenRequest

    var id: String { "\(organizationId):\(spaceId ?? "organization"):\(request.normalizedType):\(request.resourceId)" }
}

/// 群消息阅读明细读取统一消息数据面：移动端只负责展示，不另建一套状态。
private struct IMReadReceiptDetailSheet: View {
    let message: IMMessage
    let progress: IMReadReceipt?
    let conversationMembers: [IMMember]
    let currentUserId: String?
    let organizationMembers: [OrganizationMember]
    let load: () async throws -> IMMessageReadReceipts
    let onLoaded: (IMMessageReadReceipts) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var receipts: IMMessageReadReceipts?
    @State private var errorMessage: String?
    @State private var reloadToken = 0

    var body: some View {
        NavigationStack {
            Group {
                if let receipts {
                    if receipts.readers.isEmpty && receipts.unreaders.isEmpty {
                        ContentUnavailableView(
                            "暂无阅读明细",
                            systemImage: "person.2",
                            description: Text("成员阅读状态尚未同步")
                        )
                    } else {
                        List {
                            memberSection(title: "已读", members: receipts.readers)
                            memberSection(title: "未读", members: receipts.unreaders)
                        }
                        .listStyle(.plain)
                    }
                } else if let errorMessage {
                    ContentUnavailableView {
                        Label("加载失败", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("重试") { reloadToken += 1 }
                    }
                } else {
                    ProgressView("正在加载阅读状态…")
                }
            }
            .navigationTitle("阅读状态")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
        .task(id: "\(message.id)-\(reloadToken)") {
            receipts = nil
            errorMessage = nil
            do {
                let loaded = try await load()
                onLoaded(loaded)
                let enriched = IMMemberDisplayPolicy.enrichedReadReceipts(
                    loaded,
                    organizationMembers: organizationMembers
                )
                let projection = IMHumanReadReceiptPolicy.project(
                    progress: progress,
                    detail: enriched,
                    members: conversationMembers,
                    currentUserId: currentUserId,
                    senderId: message.senderId
                )
                receipts = projection.detail
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    @ViewBuilder
    private func memberSection(title: String, members: [IMReadReceiptMember]) -> some View {
        Section {
            if members.isEmpty {
                Text("暂无成员")
                    .font(.tt.body)
                    .foregroundStyle(.tt.textTertiary)
            } else {
                ForEach(members) { member in
                    HStack(spacing: TTSpacing.md) {
                        IMReadReceiptAvatar(member: member)
                        Text(member.displayName)
                            .font(.tt.bodyMedium)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, TTSpacing.xxs)
                }
            }
        } header: {
            Text("\(title)（\(members.count)）")
        }
    }
}

private struct IMAgentTaskComposerSheet: View {
    let organizationId: String
    let sourceMessage: IMMessage
    let service: IMConversationServing
    let onCreated: @MainActor (IMAgentTaskThreadResult) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var agents: [IMAgentSummary] = []
    @State private var selectedAgentId: String?
    @State private var additionalContext = ""
    @State private var isLoading = true
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("所选消息及其回复会作为上下文，并在你的执行 Workspace 中创建一次 Agent 问询。")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                }
                Section("选择 Agent") {
                    if isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    } else if agents.isEmpty {
                        Text(errorMessage ?? "没有可用的 Agent")
                            .foregroundStyle(.tt.textSecondary)
                    } else {
                        ForEach(agents) { agent in
                            Button {
                                selectedAgentId = agent.id
                            } label: {
                                HStack {
                                    Label(agent.displayName, systemImage: "sparkles")
                                        .foregroundStyle(.tt.textPrimary)
                                    Spacer()
                                    if selectedAgentId == agent.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tt.textAccent)
                                    }
                                }
                            }
                            .disabled(isCreating)
                        }
                    }
                }
                Section("补充要求（可选）") {
                    TextField("例如：重点列出风险和负责人", text: $additionalContext, axis: .vertical)
                        .lineLimit(2...5)
                        .disabled(isCreating)
                }
                if let errorMessage, !agents.isEmpty {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("询问 Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(isCreating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        createTask()
                    } label: {
                        if isCreating { ProgressView() } else { Text("发送") }
                    }
                    .disabled(selectedAgentId == nil || isCreating)
                }
            }
            .task { await loadAgents() }
        }
    }

    @MainActor
    private func loadAgents() async {
        isLoading = true
        errorMessage = nil
        do {
            let loaded = try await service.searchAgents(organizationId: organizationId, query: "")
            agents = loaded
            selectedAgentId = loaded.first?.id
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func createTask() {
        guard let agentId = selectedAgentId else { return }
        isCreating = true
        errorMessage = nil
        Task {
            do {
                let result = try await service.createAgentTaskFromMessage(
                    conversationId: sourceMessage.conversationId,
                    messageId: sourceMessage.id,
                    agentId: agentId,
                    additionalContext: additionalContext
                )
                await MainActor.run { onCreated(result) }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isCreating = false
                }
            }
        }
    }
}

private struct IMReadReceiptAvatar: View {
    let member: IMReadReceiptMember

    var body: some View {
        Group {
            if let url = URL(string: member.avatar), !member.avatar.isEmpty {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    default: placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: 36, height: 36)
        .clipShape(Circle())
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(.tt.bgSubtle)
            if let initial = member.displayName.first {
                Text(String(initial))
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textPrimary)
            } else {
                Image(systemName: "person.fill")
                    .foregroundStyle(.tt.textSecondary)
            }
        }
    }
}

/// 会话成员通讯录：从顶栏入口 present，替代原先消息区上方的横向成员条。
private struct IMConversationMembersSheet: View {
    let detail: IMConversationDetail
    let currentUserId: String?
    let onOpenDirectMessage: (String, String) -> Void
    let onAgentTap: () -> Void

    @Environment(\.dismiss) private var dismiss

    private var canOpenDM: Bool {
        detail.conversationType == .group || detail.isTeamSpaceChannel
    }

    private var members: [IMMember] {
        detail.members.filter { $0.userId != currentUserId }
    }

    var body: some View {
        NavigationStack {
            List(members) { member in
                memberRow(member)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .navigationTitle("通讯录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func memberRow(_ member: IMMember) -> some View {
        let name = member.displayName.isEmpty
            ? (member.typedMemberType == .agent ? "Agent" : "未知成员")
            : member.displayName
        let subtitle = member.typedMemberType == .agent ? "Agent" : "成员"

        if canOpenDM {
            Button {
                if member.typedMemberType == .agent {
                    onAgentTap()
                } else if let userId = member.userId {
                    onOpenDirectMessage(userId, name)
                }
            } label: {
                IMConversationMemberRow(member: member, displayName: name, subtitle: subtitle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                member.typedMemberType == .agent
                    ? "\(name)，Agent，暂不支持私信"
                    : "\(name)，人类成员，点击进入私信"
            )
        } else {
            IMConversationMemberRow(member: member, displayName: name, subtitle: subtitle)
                .accessibilityLabel(
                    member.typedMemberType == .agent ? "\(name)，Agent" : "\(name)，人类成员"
                )
        }
    }
}

/// 群聊输入 `@` 后展示的当前成员选择页。只使用会话详情已返回的 members，绝不在此入口搜索或拉新成员入群。
private struct IMGroupMemberMentionSheet: View {
    let members: [IMMember]
    let currentUserId: String?
    let onPick: (IMMember) -> Void
    let onPickAll: () -> Void
    let canAddAgent: Bool
    let onAddAgent: () -> Void

    @Environment(\.dismiss) private var dismiss

    private var mentionableMembers: [IMMember] {
        members.filter { member in
            member.userId != currentUserId && IMDraftMention(member: member) != nil
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Button {
                    onPickAll()
                    dismiss()
                } label: {
                    HStack(spacing: TTSpacing.md) {
                        Image(systemName: "person.2.fill")
                            .foregroundStyle(.tt.bgAccent)
                            .frame(width: 32, height: 32)
                            .background(.tt.bgSubtle, in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text("@所有人")
                                .font(.tt.bodySemibold)
                                .foregroundStyle(.tt.textPrimary)
                            Text("通知群内所有成员")
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, TTSpacing.xxs)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)

                if canAddAgent {
                    Button {
                        onAddAgent()
                        dismiss()
                    } label: {
                        HStack(spacing: TTSpacing.md) {
                            Image(systemName: "sparkles")
                                .foregroundStyle(.tt.bgAccent)
                                .frame(width: 32, height: 32)
                                .background(.tt.bgSubtle, in: Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text("添加 Agent")
                                    .font(.tt.bodySemibold)
                                    .foregroundStyle(.tt.textPrimary)
                                Text("从组织中选择并加入群聊")
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, TTSpacing.xxs)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .accessibilityLabel("添加 Agent 到群聊")
                }

                ForEach(mentionableMembers) { member in
                    Button {
                        onPick(member)
                        dismiss()
                    } label: {
                        let name = member.displayName.isEmpty
                            ? (member.typedMemberType == .agent ? "Agent" : "未知成员")
                            : member.displayName
                        IMConversationMemberRow(
                            member: member,
                            displayName: name,
                            subtitle: member.typedMemberType == .agent ? "Agent" : "成员"
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .accessibilityLabel("@\(member.displayName)")
                }
            }
            .listStyle(.plain)
            .navigationTitle("选择成员")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }
}

/// 输入态 mention 的轻量快照：正文保留可编辑的 `@名称`，id 则用于发送后端可识别的元数据。
private struct IMDraftMention: Identifiable, Equatable {
    let id: String
    let displayName: String
    let userId: String?
    let agentId: String?

    init?(member: IMMember) {
        let displayName = member.displayName.isEmpty
            ? (member.typedMemberType == .agent ? "Agent" : "成员")
            : member.displayName
        switch member.typedMemberType {
        case .user:
            guard let userId = member.userId, !userId.isEmpty else { return nil }
            self.id = "user:\(userId)"
            self.userId = userId
            self.agentId = nil
        case .agent:
            guard let agentId = member.agentId, !agentId.isEmpty else { return nil }
            self.id = "agent:\(agentId)"
            self.userId = nil
            self.agentId = agentId
        case nil:
            return nil
        }
        self.displayName = displayName
    }

    init(agent: IMAgentSummary) {
        id = "agent:\(agent.id)"
        displayName = agent.displayName
        userId = nil
        agentId = agent.id
    }
}

private struct IMConversationMemberRow: View {
    let member: IMMember
    let displayName: String
    let subtitle: String

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            IMMemberAvatar(member: member, displayName: displayName)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, TTSpacing.xxs)
    }
}

private struct IMMemberAvatar: View {
    let member: IMMember
    let displayName: String

    var body: some View {
        Group {
            if let url = URL(string: member.avatar), !member.avatar.isEmpty {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    default: placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: 40, height: 40)
        .clipShape(Circle())
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(.tt.bgSubtle)
            if member.typedMemberType == .agent {
                Image(systemName: "sparkles").foregroundStyle(.tt.iconAccent)
            } else if let initial = displayName.first {
                Text(String(initial)).font(.tt.bodyMedium).foregroundStyle(.tt.textPrimary)
            } else {
                Image(systemName: "person.fill").foregroundStyle(.tt.textSecondary)
            }
        }
    }
}

private struct IMDraftAttachmentRow: View {
    let attachment: ComposerLocalAttachment
    let onRetry: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: attachment.kind == .file ? "paperclip" : "photo")
                .foregroundStyle(.tt.iconAccent)
            VStack(alignment: .leading, spacing: 3) {
                Text(attachment.name)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                switch attachment.status {
                case .pending, .uploading:
                    ProgressView(value: attachment.progress)
                case .ready:
                    Text("已准备发送").font(.tt.captionMedium).foregroundStyle(.tt.textSuccess)
                case .error:
                    Text(attachment.errorMessage ?? "上传失败")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if attachment.status == .error {
                Button(action: onRetry) {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("重试上传")
            }
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
            }
            .accessibilityLabel("移除附件")
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xs)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("待发送附件 \(attachment.name)，\(statusLabel)")
    }

    private var statusLabel: String {
        switch attachment.status {
        case .pending, .uploading: return "上传中"
        case .ready: return "已准备发送"
        case .error: return "上传失败"
        }
    }
}

/// 输入框上方的待发送资源卡。选择资源不是立即发送，用户仍可补一段说明再一起发送。
private struct IMDraftCardRow: View {
    let card: IMOutgoingCard
    let onRemove: () -> Void

    private var title: String {
        let name = card.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        if let title = card.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        return "未命名资源"
    }

    private var kindLabel: String {
        switch card.kind {
        case .space, .agentSpace: return "工作空间"
        case .document: return "云文档"
        case .table: return "多维表格"
        case .contact: return "名片"
        case .prompt: return "指令"
        case .codexSession: return "Codex 会话"
        }
    }

    private var icon: String {
        switch card.kind {
        case .space, .agentSpace: return "square.stack.3d.up"
        case .document: return "doc.text"
        case .table: return "tablecells"
        case .contact: return "person.crop.rectangle"
        case .prompt: return "terminal"
        case .codexSession: return "archivebox"
        }
    }

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: icon)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 24, height: 24)
                .background(.tt.bgAccent.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Text("待发送 · \(kindLabel)")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
            }
            Spacer(minLength: 0)
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("移除待发送\(kindLabel)")
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xs)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("待发送\(kindLabel)：\(title)")
    }
}

/// 对齐 Electron“云文件”：聚合会话所属组织的云文档与多维表格。
/// 选择后仍回到 composer 的待发送态，而不是直接发出。
private struct IMResourceCardPickerSheet: View {
    let organizationId: String
    let onPick: (IMOutgoingCard) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var resources: [SpaceResource] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var query = ""

    private var visibleResources: [SpaceResource] {
        let keyword = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let candidates = resources
            .filter {
                ["tabdoc", "tabdata"].contains($0.normalizedType)
                    && !($0.isArchived ?? false)
            }
            .sorted { $0.sortTimestamp > $1.sortTimestamp }
        guard !keyword.isEmpty else { return candidates }
        return candidates.filter {
            $0.displayTitle.lowercased().contains(keyword)
                || $0.typeLabel.lowercased().contains(keyword)
                || ($0.preview?.lowercased().contains(keyword) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && resources.isEmpty {
                    ProgressView("加载资源…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage, resources.isEmpty {
                    ContentUnavailableView {
                        Label("加载失败", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("重试") { Task { await loadResources() } }
                    }
                } else if visibleResources.isEmpty {
                    ContentUnavailableView(
                        "暂无可发送的云文件",
                        systemImage: "folder"
                    )
                } else {
                    List(visibleResources) { resource in
                        Button {
                            let kind: IMOutgoingCardKind = resource.normalizedType == "tabdata"
                                ? .table
                                : .document
                            let card = IMOutgoingCard.resource(
                                kind: kind,
                                resourceId: resource.resourceId,
                                name: resource.displayTitle,
                                spaceId: resource.spaceId,
                                organizationId: resource.organizationId ?? organizationId
                            )
                            onPick(card)
                            dismiss()
                        } label: {
                            HStack(spacing: TTSpacing.sm) {
                                CloudDocsAppIcon(itemType: resource.normalizedType)
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(resource.displayTitle)
                                        .font(.tt.body)
                                        .foregroundStyle(.tt.textPrimary)
                                        .lineLimit(1)
                                    Text(resource.spaceName?.isEmpty == false ? resource.spaceName! : resource.typeLabel)
                                        .font(.tt.captionMedium)
                                        .foregroundStyle(.tt.textSecondary)
                                        .lineLimit(1)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("选择云文件：\(resource.displayTitle)")
                        .accessibilityHint("添加到待发送消息")
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("选择云文件")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "搜索资源")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .task { await loadResources() }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func loadResources() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            var loaded: [SpaceResource] = []
            var page = 1
            while true {
                let response: SpaceResourceListResponse = try await APIClient.shared.get(
                    path: Endpoints.Context.organizationContextItems(organizationId: organizationId),
                    query: ["is_archived": "false", "page": String(page), "page_size": "100"]
                )
                loaded.append(contentsOf: response.items)
                let pageSize = response.pageSize.flatMap { $0 > 0 ? $0 : nil } ?? 100
                let hasNext = response.items.count >= pageSize
                    && (response.total.map { loaded.count < $0 } ?? true)
                if !hasNext { break }
                page += 1
            }
            resources = Array(Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { latest, _ in latest }).values)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

@MainActor
@Observable
final class IMSessionShareSubmissionController {
    struct Intent: Equatable {
        let sessionId: String
        let peerUserId: String
        let mode: ConversationSessionShareMode
    }

    private(set) var isSubmitting = false
    private(set) var errorMessage: String?
    private(set) var clientRequestId: String?
    private var intent: Intent?
    private let requestIdFactory: () -> String

    init(requestIdFactory: @escaping () -> String = { UUID().uuidString }) {
        self.requestIdFactory = requestIdFactory
    }

    func submit(
        intent: Intent,
        operation: @escaping @MainActor (String) async throws -> Void,
        onSuccess: @escaping @MainActor () -> Void
    ) {
        guard !isSubmitting else { return }
        if self.intent != intent || clientRequestId == nil {
            self.intent = intent
            clientRequestId = requestIdFactory()
        }
        guard let clientRequestId else { return }
        isSubmitting = true
        errorMessage = nil

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await operation(clientRequestId)
                reset()
                onSuccess()
            } catch is CancellationError {
                isSubmitting = false
            } catch {
                errorMessage = error.imUserMessage
                isSubmitting = false
            }
        }
    }

    func invalidateIntent() {
        guard !isSubmitting else { return }
        intent = nil
        clientRequestId = nil
        errorMessage = nil
    }

    func reset() {
        isSubmitting = false
        intent = nil
        clientRequestId = nil
        errorMessage = nil
    }
}

private struct IMSessionSharePickerSheet: View {
    let peerName: String
    let peerUserId: String
    let organizationId: String
    let loadSessions: () async throws -> [RecentSession]
    let onShare: (RecentSession, ConversationSessionShareMode, String) async throws -> Void
    let onDismiss: () -> Void

    @State private var sessions: [RecentSession] = []
    @State private var query = ""
    @State private var selectedSession: RecentSession?
    @State private var selectedMode: ConversationSessionShareMode = .viewOnly
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var submission = IMSessionShareSubmissionController()

    private var visibleSessions: [RecentSession] {
        let keyword = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !keyword.isEmpty else { return sessions }
        return sessions.filter {
            $0.displayTitle.localizedCaseInsensitiveContains(keyword)
                || ($0.agentName ?? "").localizedCaseInsensitiveContains(keyword)
                || ($0.spaceName ?? "").localizedCaseInsensitiveContains(keyword)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("选择一个任务共享给 \(peerName)，对方会在这段私信里收到任务共享卡。")
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textSecondary)
                TextField("搜索任务", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .disabled(submission.isSubmitting)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(ConversationSessionShareMode.allCases) { mode in
                            modeChip(mode.title, selected: selectedMode == mode) {
                                selectedMode = mode
                            }
                        }
                    }
                }
                .disabled(submission.isSubmitting)
                Group {
                    if isLoading && sessions.isEmpty {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 180)
                    } else if let errorMessage, sessions.isEmpty {
                        VStack(spacing: 8) {
                            Text(errorMessage).foregroundStyle(.red)
                            Button("重试") { Task { await reload() } }
                        }
                        .frame(maxWidth: .infinity, minHeight: 180)
                    } else if visibleSessions.isEmpty {
                        ContentUnavailableView("暂无可共享的任务", systemImage: "sparkles")
                            .frame(minHeight: 180)
                    } else {
                        List(visibleSessions) { session in
                            Button {
                                if selectedSession?.id != session.id {
                                    selectedSession = session
                                    submission.invalidateIntent()
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "sparkles")
                                        .foregroundStyle(selectedSession?.id == session.id ? .tt.textAccent : .tt.textSecondary)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(session.displayTitle.isEmpty ? "未命名任务" : session.displayTitle)
                                            .font(.tt.bodyMedium)
                                            .foregroundStyle(.tt.textPrimary)
                                            .lineLimit(1)
                                        Text([session.agentName, session.spaceName]
                                            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                                            .filter { !$0.isEmpty }
                                            .joined(separator: " · ")
                                        )
                                        .font(.tt.captionMedium)
                                        .foregroundStyle(.tt.textSecondary)
                                        .lineLimit(1)
                                    }
                                    Spacer()
                                    if selectedSession?.id == session.id {
                                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.tt.textAccent)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(submission.isSubmitting)
                        }
                        .listStyle(.plain)
                    }
                }
                if let submissionError = submission.errorMessage {
                    Text(submissionError)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textCritical)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Button {
                    guard let selectedSession else { return }
                    submission.submit(
                        intent: .init(
                            sessionId: selectedSession.id,
                            peerUserId: peerUserId,
                            mode: selectedMode
                        ),
                        operation: { clientRequestId in
                            try await onShare(selectedSession, selectedMode, clientRequestId)
                        },
                        onSuccess: { onDismiss() }
                    )
                } label: {
                    HStack(spacing: TTSpacing.sm) {
                        if submission.isSubmitting {
                            ProgressView().controlSize(.small)
                            Text("发送中…")
                        } else {
                            Text(selectedMode.isContinuation ? "发送任务续接" : "发送共享任务")
                        }
                    }
                    .font(.tt.bodyMedium)
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .disabled(selectedSession == nil || submission.isSubmitting)
            }
            .padding(TTSpacing.lg)
            .navigationTitle("共享任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { onDismiss() }
                        .disabled(submission.isSubmitting)
                }
            }
            .task(id: organizationId) { await reload() }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(submission.isSubmitting)
    }

    private func modeChip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button {
            guard selected == false else { return }
            action()
            submission.invalidateIntent()
        } label: {
            Text(title)
                .font(.tt.captionMedium.weight(.semibold))
                .foregroundStyle(selected ? .tt.textAccent : .tt.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(selected ? .tt.bgAccent.opacity(0.12) : .tt.bgSubtle, in: Capsule())
                .overlay(Capsule().stroke(selected ? .tt.borderFocused : .tt.borderLight, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    @MainActor
    private func reload() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        do {
            sessions = try await loadSessions()
        } catch {
            errorMessage = error.imUserMessage
        }
        isLoading = false
    }
}

/// 名片 picker 直接读取会话所属组织成员，不能误用全局当前组织；发送后后端仍会权威回填名片快照。
private struct IMContactCardPickerSheet: View {
    let organizationId: String
    let currentUserId: String?
    let onPick: (IMOutgoingCard) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var members: [OrganizationMember] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var query = ""

    private var visibleMembers: [OrganizationMember] {
        let keyword = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let candidates = members
            .filter { $0.userId != currentUserId }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        guard !keyword.isEmpty else { return candidates }
        return candidates.filter { member in
            [member.displayName, member.user?.username, member.user?.email]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(keyword) }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && members.isEmpty {
                    ProgressView("加载成员…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage, members.isEmpty {
                    ContentUnavailableView {
                        Label("加载失败", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("重试") { Task { await loadMembers() } }
                    }
                } else if visibleMembers.isEmpty {
                    ContentUnavailableView("暂无可发送的成员", systemImage: "person.2.slash")
                } else {
                    List(visibleMembers) { member in
                        Button {
                            onPick(.contact(
                                userId: member.userId,
                                name: member.displayName,
                                username: member.user?.username,
                                avatar: member.avatar
                            ))
                            dismiss()
                        } label: {
                            HStack(spacing: TTSpacing.sm) {
                                IMCardPickerAvatar(name: member.displayName, avatarURL: member.avatar)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.displayName)
                                        .font(.tt.body)
                                        .foregroundStyle(.tt.textPrimary)
                                        .lineLimit(1)
                                    if let subtitle = member.subtitle {
                                        Text(subtitle)
                                            .font(.tt.captionMedium)
                                            .foregroundStyle(.tt.textSecondary)
                                            .lineLimit(1)
                                    }
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("选择名片")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "搜索成员")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .task { await loadMembers() }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func loadMembers() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response: OrganizationMemberListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.organizationMembers(organizationId)
            )
            members = response.members
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// 一次性编写指令卡。第一行作为卡片标题，正文会在后端进行 1…8000 字符的最终校验和白名单重建。
private struct IMPromptComposeSheet: View {
    let onSend: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var promptText = ""
    @FocusState private var isFocused: Bool

    private var trimmedText: String { promptText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { !trimmedText.isEmpty && trimmedText.count <= 8_000 }
    private var title: String {
        let firstLine = trimmedText
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
        return firstLine.map { String($0.prefix(200)) } ?? ""
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                Text("写下希望对方 AI 分身执行的步骤与要求。第一行会作为卡片标题；对方使用时仍需自行确认 AI 分身和 Workspace。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                TextEditor(text: $promptText)
                    .font(.tt.body)
                    .scrollContentBackground(.hidden)
                    .padding(TTSpacing.sm)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 12))
                    .focused($isFocused)
                    .onChange(of: promptText) { _, newValue in
                        if newValue.count > 8_000 {
                            promptText = String(newValue.prefix(8_000))
                        }
                    }
                HStack {
                    Text("对方可一键预填到新任务")
                    Spacer()
                    Text("\(promptText.count) / 8000")
                }
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
            }
            .padding(TTSpacing.lg)
            .navigationTitle("发送指令")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送") {
                        onSend(trimmedText, title)
                        dismiss()
                    }
                    .disabled(!canSend)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            try? await Task.sleep(for: .milliseconds(200))
            isFocused = true
        }
    }
}

private struct IMCardPickerAvatar: View {
    let name: String
    let avatarURL: String?

    var body: some View {
        Group {
            if let avatarURL, let url = URL(string: avatarURL), !avatarURL.isEmpty {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    placeholder
                }
            } else {
                placeholder
            }
        }
        .frame(width: 36, height: 36)
        .clipShape(Circle())
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(.tt.bgSubtle)
            Text(String(name.prefix(1)).uppercased())
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textSecondary)
        }
    }
}

private struct IMPendingMessageBubble: View {
    let pending: IMPendingMessage
    let onRetry: (() -> Void)?

    var body: some View {
        HStack(alignment: .bottom, spacing: TTSpacing.sm) {
            Spacer(minLength: 40)
            switch pending.status {
            case .sending:
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("发送中")
            case .failed:
                Button(action: { onRetry?() }) {
                    Image(systemName: "arrow.clockwise.circle.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("重新发送")
                .accessibilityHint("使用原消息身份重新发送这条消息")
            }
            VStack(alignment: .trailing, spacing: 4) {
                if let card = pending.card {
                    IMResourceCardView(card: card.localCard, onOpen: { _ in })
                        .allowsHitTesting(false)
                }
                if let attachment = pending.attachment {
                    HStack(spacing: TTSpacing.sm) {
                        Image(systemName: pending.messageType == IMMessageType.image.rawValue ? "photo" : "paperclip")
                        Text(attachment.fileName).lineLimit(1).truncationMode(.middle)
                    }
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textPrimary)
                    .padding(TTSpacing.sm)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 12))
                }
                if !pending.content.isEmpty, pending.card == nil {
                    Text(pending.content)
                        .font(ConversationTypography.bodyFont)
                        .lineSpacing(ConversationTypography.bodyLineSpacing)
                        .foregroundStyle(.tt.textPrimary)
                        .padding(.horizontal, TTSpacing.md)
                        .padding(.vertical, TTSpacing.sm)
                        .background(IMTextBubbleChrome.fill(isMine: true), in: IMTextBubbleChrome.shape(isMine: true))
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("待发送消息\(pending.attachment.map { "，附件 \($0.fileName)" } ?? "")\(pending.card.map { "，\($0.fallbackContent)" } ?? "")")
        }
    }
}

/// 单条消息气泡：对齐 Electron 己方 foreground/6%、对方 accent/10%、尾角；乐观态显示发送中/失败。
private struct MessageBubble: View {
    let content: String
    let senderName: String
    let isMine: Bool
    /// Agent 消息：左侧、带 sparkles 身份标识（气泡色与普通对方一致，靠标签区分）。
    let isAgent: Bool
    let showsSenderName: Bool
    var clock: String? = nil
    let status: IMPendingMessage.Status?
    let onRetry: (() -> Void)?
    var replyPreview: IMReplyPreview? = nil
    var onOpenReplyPreview: (() -> Void)? = nil
    var readProgress: IMReadReceipt? = nil

    var body: some View {
        HStack(alignment: .bottom, spacing: TTSpacing.sm) {
            if isMine { Spacer(minLength: 40) }
            if isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: TTSpacing.xxs) {
                if showsSenderName && !senderName.isEmpty {
                    IMMessageSenderLabel(senderName: senderName, isAgent: isAgent, clock: clock)
                }
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    if let replyPreview {
                        inlineReplyPreview(replyPreview)
                    }
                    Text(attributedIMText(content))
                        .font(ConversationTypography.bodyFont)
                        .lineSpacing(ConversationTypography.bodyLineSpacing)
                        .foregroundStyle(.tt.textPrimary)
                }
                .padding(.horizontal, TTSpacing.md)
                .padding(.vertical, TTSpacing.sm)
                .background(IMTextBubbleChrome.fill(isMine: isMine), in: IMTextBubbleChrome.shape(isMine: isMine))
                statusFooter
            }
            if !isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            if !isMine { Spacer(minLength: 40) }
        }
    }

    private func inlineReplyPreview(_ preview: IMReplyPreview) -> some View {
        Button {
            onOpenReplyPreview?()
        } label: {
            HStack(alignment: .top, spacing: TTSpacing.xs) {
                Rectangle()
                    .fill(Color.tt.textSecondary.opacity(0.45))
                    .frame(width: 2, height: 34)
                    .clipShape(Capsule())
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text("回复")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                    Text(preview.displayText.isEmpty ? "消息内容不可用" : preview.displayText)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: 260, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("查看回复详情：\(preview.displayText)")
    }

    @ViewBuilder
    private var statusFooter: some View {
        switch status {
        case .sending:
            Text("发送中…").font(.tt.captionMedium).foregroundStyle(.tt.textSecondary)
        case .failed:
            Button {
                onRetry?()
            } label: {
                Label("发送失败，点击重试", systemImage: "exclamationmark.circle")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.red)
            }
        case nil:
            EmptyView()
        }
    }
}

/// 回复链路的轻量引用：服务端会随消息返回 `reply_to_preview`，移动端无需再额外拉原消息。
private struct IMReplyPreviewBubble: View {
    let preview: IMReplyPreview
    let isMine: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 6) {
                Rectangle()
                    .fill(Color.tt.textSecondary.opacity(0.45))
                    .frame(width: 2, height: 34)
                    .clipShape(Capsule())
                VStack(alignment: .leading, spacing: 2) {
                    Text("回复")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                    Text(preview.displayText.isEmpty ? "消息内容不可用" : preview.displayText)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 8))
            .frame(maxWidth: 260, alignment: isMine ? .trailing : .leading)
            .fixedSize(horizontal: true, vertical: false)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("查看回复详情：\(preview.displayText)")
    }
}

private struct IMPinnedMessageBanner: View {
    static let collapsedHeight: CGFloat = 48
    private static let maxVisibleMessageCount = 4
    private static let messageRowHeight: CGFloat = 44
    private static let expandedMaxHeight = messageRowHeight * CGFloat(maxVisibleMessageCount)

    let messages: [IMMessage]
    @Binding var isExpanded: Bool
    let onOpen: (IMMessage) -> Void
    let onUnpin: (IMMessage) -> Void

    private var latest: IMMessage { messages[0] }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    if messages.count > 1 {
                        withAnimation(.easeInOut(duration: 0.18)) { isExpanded.toggle() }
                    } else {
                        onOpen(latest)
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "pin.fill")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textAccent)
                        Text("置顶")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textAccent)
                        Text("\(latest.pinnedSenderText)：")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                        Text(latest.pinnedBannerText)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if messages.count > 1 {
                            Text("\(messages.count)")
                                .font(.tt.captionMedium)
                                .foregroundStyle(.tt.textTertiary)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.tt.textTertiary)
                                .rotationEffect(.degrees(isExpanded ? 180 : 0))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(messages.count > 1 ? "展开置顶消息列表" : "查看置顶消息：\(latest.pinnedBannerText)")

                if messages.count == 1 {
                    unpinButton(latest)
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .frame(height: Self.collapsedHeight)

            if isExpanded && messages.count > 1 {
                Divider().overlay(Color.tt.textAccent.opacity(0.12))
                if messages.count > Self.maxVisibleMessageCount {
                    ScrollView(.vertical) {
                        LazyVStack(spacing: 0) {
                            pinnedMessageRows
                        }
                    }
                    .frame(height: Self.expandedMaxHeight)
                } else {
                    VStack(spacing: 0) {
                        pinnedMessageRows
                    }
                }
            }
        }
        .background(Color.tt.bgAccent.opacity(0.08))
        .background(Color.tt.bgCanvasDefault)
        .onChange(of: messages.count) { _, count in
            if count <= 1 { isExpanded = false }
        }
    }

    @ViewBuilder
    private var pinnedMessageRows: some View {
        ForEach(messages, id: \.id) { message in
            HStack(spacing: 8) {
                Button {
                    isExpanded = false
                    onOpen(message)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.tt.textAccent.opacity(0.7))
                        Text(message.pinnedSenderText)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                        Text(message.pinnedBannerText)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("查看置顶消息：\(message.pinnedBannerText)")
                unpinButton(message)
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .frame(height: Self.messageRowHeight)
        }
    }

    private func unpinButton(_ message: IMMessage) -> some View {
        Button { onUnpin(message) } label: {
            Image(systemName: "xmark")
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textSecondary)
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("取消置顶")
    }
}

private extension IMMessage {
    var pinnedSenderText: String {
        let name = senderName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        return String(senderId.prefix(8))
    }

    var pinnedBannerText: String {
        if isDeleted { return "消息内容不可用" }
        if !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return content }
        if messageType == IMMessageType.image.rawValue { return "图片" }
        if messageType == IMMessageType.file.rawValue || hasAttachment {
            return attachmentFileName.isEmpty ? "文件" : "文件：\(attachmentFileName)"
        }
        if resourceCard != nil { return "资源消息" }
        return "消息内容不可用"
    }

    var previewTextForConversationList: String {
        if isDeleted { return "消息已撤回" }
        if sessionContinuationCard != nil { return "任务续接" }
        if sessionShareV2Card != nil { return "协作邀请" }
        if !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return content }
        if isImageAttachment { return "图片" }
        if isFileAttachment { return attachmentFileName.isEmpty ? "文件" : "文件：\(attachmentFileName)" }
        if sessionShareCard != nil { return "任务共享" }
        if resourceCard != nil { return "资源消息" }
        return "消息内容不可用"
    }
}

private extension Error {
    var imUserMessage: String {
        (self as? LocalizedError)?.errorDescription ?? localizedDescription
    }
}

/// 仅在点「添加表情」后展示完整常用集，避免长按菜单被具体 emoji 挤满。
private struct IMReactionPicker: View {
    let reactions: [String: [String]]
    let onPick: (String) -> Void
    private let emojis = ["👍", "❤️", "😂", "🎉", "😮", "🙏", "👏", "🔥", "🤔", "👀", "✅", "💯", "😢", "😡", "🚀", "💪", "👋", "🌹", "🎈", "💡", "🥳", "😱", "🤝", "☕️"]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 6)

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("添加表情").font(.tt.body)
                Text(activeReactionKindCount >= imReactionKindLimit
                     ? "已达到上限。取消一个已有表情后可继续添加"
                     : "每条消息最多添加 \(imReactionKindLimit) 种表情")
                    .font(.tt.captionMedium)
                    .foregroundStyle(activeReactionKindCount >= imReactionKindLimit
                                     ? Color.tt.textWarning : Color.tt.textSecondary)
            }
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(emojis, id: \.self) { emoji in
                    Button { onPick(emoji) } label: {
                        Text(emoji).font(.tt.iconEmpty)
                            .frame(maxWidth: .infinity, minHeight: 42)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("添加表情 \(emoji)")
                    .disabled(!canAddIMReaction(emoji, to: reactions))
                    .opacity(canAddIMReaction(emoji, to: reactions) ? 1 : 0.36)
                }
            }
        }
        .padding(20)
        .presentationDetents([.height(340)])
    }

    private var activeReactionKindCount: Int {
        reactions.values.filter { !$0.isEmpty }.count
    }
}

private struct IMForwardRequest: Identifiable {
    let id = UUID()
    let messages: [IMMessage]

    var allowExternal: Bool { messages.allSatisfy(\.isPlainText) }
}

/// 转发目标只展示当前组织已加载的会话；与桌面端一致，不允许把消息跨组织转发。
private struct IMForwardConversationPicker: View {
    let sourceConversationId: String
    let conversations: [IMConversation]
    let allowExternal: Bool
    let onSelect: (IMConversation) -> Void
    @State private var workspace = WorkspaceStore.shared

    var body: some View {
        NavigationStack {
            List(imForwardTargets(
                conversations,
                excluding: sourceConversationId,
                allowExternal: allowExternal
            )) { conversation in
                Button { onSelect(conversation) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayTitle(for: conversation))
                            .foregroundStyle(.tt.textPrimary)
                        if !conversation.lastMessagePreview.isEmpty {
                            Text(conversation.lastMessagePreview)
                                .font(.tt.captionMedium)
                                .foregroundStyle(.tt.textSecondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .navigationTitle("转发到")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func displayTitle(for conversation: IMConversation) -> String {
        let peerDisplayName = conversation.dmPeerUserId.flatMap { id in
            workspace.members.first { $0.userId == id }?.displayName
        }
        return IMConversationTitlePolicy.resolve(
            conversationName: conversation.name,
            isDirectMessage: conversation.conversationType == .dm,
            peerDisplayName: peerDisplayName,
            directMessageFallback: L10n.Messages.directMessage,
            conversationFallback: L10n.Messages.unnamedConversation
        )
    }
}
