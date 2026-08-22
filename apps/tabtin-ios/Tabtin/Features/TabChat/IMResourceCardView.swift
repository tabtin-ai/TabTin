import SwiftUI

private enum IMCardLayout {
    static let structuredWidth: CGFloat = 300
    static let resourceHeight: CGFloat = 196
    static let resourceBodyHeight: CGFloat = 136
    static let resourcePreviewHeight: CGFloat = 56
    static let promptHeight: CGFloat = 190
    static let promptBodyHeight: CGFloat = 108
    static let promptFooterHeight: CGFloat = 57
    /// 名片紧凑方案 B：自适应气泡列宽，上限贴近手机可读宽度。
    static let contactMaxWidth: CGFloat = 248
    static let contactMinHeight: CGFloat = 68
    static let contactAvatarSize: CGFloat = 44
    static let contactCornerRadius: CGFloat = 14
    static let sessionShareHeight: CGFloat = 208
    static let sessionShareBodyHeight: CGFloat = 126
    static let sessionShareFooterHeight: CGFloat = 57
}

/// 资源卡消息气泡：文档 / 表格 / 名片 / 指令。快照嵌在消息 metadata，直接渲染，
/// 无需额外请求。卡片是完整的消息主体，不重复展示兼容用的文本回退内容。
struct IMResourceCardBubble: View {
    let message: IMMessage
    let card: IMResourceCard
    let isMine: Bool
    let isAgent: Bool
    let showsSenderName: Bool
    var clock: String? = nil
    let onOpen: (IMResourceCardPreview?) -> Void
    /// 指令卡不打开资源，而是把正文带入既有「新任务」流程。
    var onUsePrompt: ((IMPromptCard) -> Void)? = nil
    var loadPreview: ((IMResourceCard) async -> IMResourceCardPreviewResult)? = nil
    var onRequestAccess: (() async -> Bool)? = nil
    var readProgress: IMReadReceipt? = nil
    var organizationMembers: [OrganizationMember] = []

    var body: some View {
        let snapshotDisplayName = card.displayName(messageContent: message.content)
        let displayName = card.typedType == .contact
            ? IMMemberDisplayPolicy.resolvedDisplayName(
                userId: card.userId,
                snapshotName: snapshotDisplayName,
                organizationMembers: organizationMembers
            ).nilIfBlank ?? snapshotDisplayName
            : snapshotDisplayName
        let contactAvatarURL = IMMemberDisplayPolicy.resolvedAvatar(
            userId: card.userId,
            snapshotAvatar: card.avatar,
            organizationMembers: organizationMembers
        )
        HStack(alignment: .bottom, spacing: 6) {
            if isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                if showsSenderName && !message.senderName.isEmpty {
                    IMMessageSenderLabel(senderName: message.senderName, isAgent: isAgent, clock: clock)
                }
                IMResourceCardView(
                    card: card,
                    displayName: displayName,
                    contactAvatarURL: contactAvatarURL,
                    onOpen: onOpen,
                    onUsePrompt: onUsePrompt,
                    loadPreview: loadPreview,
                    onRequestAccess: onRequestAccess
                )
            }
            if !isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
        }
    }
}

/// 资源卡主体：按类型分派文档 / 表格 / 名片。
struct IMResourceCardView: View {
    let card: IMResourceCard
    var displayName: String? = nil
    var contactAvatarURL: String? = nil
    let onOpen: (IMResourceCardPreview?) -> Void
    var onUsePrompt: ((IMPromptCard) -> Void)? = nil
    var loadPreview: ((IMResourceCard) async -> IMResourceCardPreviewResult)? = nil
    var onRequestAccess: (() async -> Bool)? = nil
    @State private var lastOpenAt = Date.distantPast
    @State private var previewResult: IMResourceCardPreviewResult?
    @State private var freshOpenPreview: IMResourceCardPreview?
    @State private var accessRequested = false
    @State private var requestingAccess = false
    @State private var openingResource = false
    @State private var previewRefreshToken = 0

    init(
        card: IMResourceCard,
        displayName: String? = nil,
        contactAvatarURL: String? = nil,
        onOpen: @escaping (IMResourceCardPreview?) -> Void,
        onUsePrompt: ((IMPromptCard) -> Void)? = nil,
        loadPreview: ((IMResourceCard) async -> IMResourceCardPreviewResult)? = nil,
        onRequestAccess: (() async -> Bool)? = nil
    ) {
        self.card = card
        self.displayName = displayName
        self.contactAvatarURL = contactAvatarURL
        self.onOpen = onOpen
        self.onUsePrompt = onUsePrompt
        self.loadPreview = loadPreview
        self.onRequestAccess = onRequestAccess
        _previewResult = State(initialValue: IMCardStatusMemoryCache.resourcePreview(for: card))
        _freshOpenPreview = State(initialValue: nil)
        _accessRequested = State(initialValue: IMCardStatusMemoryCache.hasRequestedResourceAccess(for: card))
    }

    @ViewBuilder
    var body: some View {
        if let prompt = card.promptCard {
            compactCardChrome(
                IMPromptCardView(prompt: prompt, onUse: onUsePrompt.map { action in { action(prompt) } })
            )
        } else {
            Group {
                switch card.typedType {
                case .contact:
                    contactCardChrome(contactCard)
                case .table:
                    resourceCard(icon: "tablecells", tablePreview: card.previewTable)
                case .space, .agentSpace:
                    contactCardChrome(workspaceCard)
                case .document, .sessionShare, .none:
                    resourceCard(icon: "doc.text", tablePreview: nil)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: openOnce)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAction { openOnce() }
            .task(id: "\(card.type):\(card.resourceId ?? ""):\(previewRefreshToken)") {
                let requestRefreshToken = previewRefreshToken
                freshOpenPreview = nil
                guard card.typedType == .document || card.typedType == .table else { return }
                guard let loadPreview else { return }
                guard card.resourceId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return }
                let loaded = await loadPreview(card)
                await MainActor.run {
                    guard requestRefreshToken == previewRefreshToken else { return }
                    if loaded.status == .error, previewResult != nil {
                        return
                    }
                    IMCardStatusMemoryCache.putResourcePreview(loaded, for: card)
                    if previewResult != loaded { previewResult = loaded }
                    freshOpenPreview = authoritativePreview(from: loaded)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .imResourceCardStatusDidChange)) { notification in
                guard let changedKey = notification.userInfo?["resourceKey"] as? String,
                      changedKey == IMCardStatusMemoryCache.resourceKey(for: card) else {
                    return
                }
                previewResult = IMCardStatusMemoryCache.resourcePreview(for: card)
                accessRequested = IMCardStatusMemoryCache.hasRequestedResourceAccess(for: card)
                if notification.userInfo?["shouldRefresh"] as? Bool == true {
                    freshOpenPreview = nil
                    previewRefreshToken += 1
                }
            }
        }
    }

    private func compactCardChrome<Content: View>(_ content: Content) -> some View {
        content
            .frame(width: IMCardLayout.structuredWidth, height: IMCardLayout.promptHeight, alignment: .leading)
            .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16).stroke(Color.tt.bgAccent.opacity(0.38), lineWidth: 1)
            )
    }

    private func contactCardChrome<Content: View>(_ content: Content) -> some View {
        content
            .frame(width: IMCardLayout.contactMaxWidth, alignment: .leading)
            .frame(minHeight: IMCardLayout.contactMinHeight, alignment: .leading)
            .background(
                .tt.bgBubbleIncoming,
                in: RoundedRectangle(cornerRadius: IMCardLayout.contactCornerRadius)
            )
            .overlay(
                RoundedRectangle(cornerRadius: IMCardLayout.contactCornerRadius)
                    .stroke(.tt.borderLight, lineWidth: 1)
            )
    }

    private func openOnce() {
        let now = Date()
        guard now.timeIntervalSince(lastOpenAt) >= 0.7 else { return }
        lastOpenAt = now
        guard card.typedType == .document || card.typedType == .table,
              let loadPreview else {
            onOpen(nil)
            return
        }
        if let freshOpenPreview {
            onOpen(freshOpenPreview)
            return
        }
        guard !openingResource else { return }
        openingResource = true
        Task {
            let loaded = await loadPreview(card)
            await MainActor.run {
                if loaded.status != .error || previewResult == nil {
                    IMCardStatusMemoryCache.putResourcePreview(loaded, for: card)
                    if previewResult != loaded { previewResult = loaded }
                }
                let preview = authoritativePreview(from: loaded)
                freshOpenPreview = preview
                openingResource = false
                onOpen(preview)
            }
        }
    }

    private func authoritativePreview(
        from result: IMResourceCardPreviewResult
    ) -> IMResourceCardPreview? {
        guard result.status == .ok,
              let preview = result.data,
              preview.organizationId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            return nil
        }
        return preview
    }

    private var accessibilityLabel: String {
        switch card.typedType {
        case .contact:
            return isSelfContact ? "这是我的名片" : "打开与 \(resolvedDisplayName) 的私信"
        case .table: return "打开表格 \(resolvedDisplayName)"
        case .document: return "打开文档 \(resolvedDisplayName)"
        case .space, .agentSpace: return "打开工作空间 \(resolvedDisplayName)"
        case .sessionShare, .none: return resolvedDisplayName
        }
    }

    private var resolvedDisplayName: String {
        displayName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? displayName! : card.displayName
    }

    private var isSelfContact: Bool {
        guard let userId = card.userId?.trimmingCharacters(in: .whitespacesAndNewlines), !userId.isEmpty,
              let me = AuthService.shared.currentUser?.id else { return false }
        return userId == me
    }

    private var contactSubtitle: String {
        if let username = card.username?.trimmingCharacters(in: .whitespacesAndNewlines), !username.isEmpty {
            return "@\(username)"
        }
        return "个人名片"
    }

    private var workspaceCard: some View {
        let rawIcon = card.icon?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let iconText = !rawIcon.isEmpty && !rawIcon.lowercased().hasPrefix("http")
            ? rawIcon
            : String(resolvedDisplayName.first ?? "W")
        return HStack(spacing: 10) {
            Text(iconText)
                .font(.tt.titleMedium.weight(.semibold))
                .foregroundStyle(.tt.textAccent)
                .lineLimit(1)
                .frame(width: IMCardLayout.contactAvatarSize, height: IMCardLayout.contactAvatarSize)
                .background(Color.tt.bgAccent.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text(resolvedDisplayName)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Text("工作空间")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textSecondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    // MARK: - 文档 / 表格

    private func resourceCard(icon: String, tablePreview: IMCardTablePreview?) -> some View {
        let isTable = card.typedType == .table
        let accent = isTable ? Color(red: 0.08, green: 0.78, blue: 0.52) : Color(red: 0.22, green: 0.55, blue: 1.0)
        let data = previewResult?.data
        let status = previewResult?.status
        let title = nonEmpty(data?.name) ?? resolvedDisplayName
        let description = nonEmpty(data?.description) ?? card.description
        let table = data?.previewTable ?? tablePreview
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                    Text(isTable ? "多维表格" : "云文档")
                        .font(.tt.captionMedium.weight(.semibold))
                }
                .foregroundStyle(accent)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.tt.bgBubbleIncoming.opacity(0.8), in: Capsule())

                Text(title)
                    .font(.tt.titleMedium.weight(.semibold))
                    .foregroundStyle(accent)
                    .lineLimit(1)

                previewBody(status: status, table: table, description: description, accent: accent)
                    .frame(height: IMCardLayout.resourcePreviewHeight, alignment: .topLeading)
                    .clipped()
            }
            .frame(height: IMCardLayout.resourceBodyHeight, alignment: .topLeading)
            .padding(12)

            Divider().overlay(accent.opacity(0.22))
            HStack {
                Text(permissionText(status: status, role: data?.currentUserRole))
                    .font(.tt.captionMedium.weight(.semibold))
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
                Spacer()
                if status == .forbidden {
                    if accessRequested {
                        Text("等待确认")
                            .font(.tt.captionMedium.weight(.semibold))
                            .foregroundStyle(.tt.textSecondary)
                    } else {
                        Button(requestingAccess ? "申请中…" : "申请访问") {
                            guard let onRequestAccess, !requestingAccess else { return }
                            requestingAccess = true
                            Task {
                                let submitted = await onRequestAccess()
                                await MainActor.run {
                                    if submitted {
                                        IMCardStatusMemoryCache.markResourceAccessRequested(for: card)
                                        accessRequested = true
                                    }
                                    requestingAccess = false
                                }
                            }
                        }
                        .font(.tt.captionMedium.weight(.semibold))
                        .foregroundStyle(accent)
                        .disabled(onRequestAccess == nil || requestingAccess)
                    }
                } else {
                    Button("在工作台打开") { openOnce() }
                        .font(.tt.captionMedium.weight(.semibold))
                        .foregroundStyle(accent)
                }
            }
            .frame(height: IMCardLayout.resourceHeight - IMCardLayout.resourceBodyHeight - 25, alignment: .center)
            .padding(.horizontal, 12)
        }
        .frame(width: IMCardLayout.structuredWidth, height: IMCardLayout.resourceHeight, alignment: .leading)
        .background(accent.opacity(isTable ? 0.12 : 0.10), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(accent.opacity(0.42), lineWidth: 1))
    }

    private func permissionText(status: IMResourceCardPreviewStatus?, role: String?) -> String {
        if status == .forbidden { return accessRequested ? "已申请访问" : "暂无访问权限" }
        if ["owner", "admin", "editor"].contains(role ?? "") { return "你可编辑" }
        if role == "viewer" { return "你可阅读" }
        return "权限校验中"
    }

    @ViewBuilder
    private func previewBody(
        status: IMResourceCardPreviewStatus?,
        table: IMCardTablePreview?,
        description: String?,
        accent: Color
    ) -> some View {
        if status == .forbidden {
            HStack(spacing: 6) {
                Image(systemName: "eye")
                Text("暂无访问权限").lineLimit(1)
            }
            .font(.tt.bodyMedium)
            .foregroundStyle(.tt.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.tt.bgBubbleIncoming.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
        } else if status == .deleted {
            Text("资源已删除或不可用")
                .font(.tt.bodyMedium)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if let preview = table, !preview.columns.isEmpty {
            tableGrid(preview)
        } else if let description, !description.isEmpty {
            Text(description)
                .font(.tt.bodyMedium)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            VStack(alignment: .leading, spacing: 7) {
                Capsule().fill(accent.opacity(0.14)).frame(width: 180, height: 8)
                Capsule().fill(accent.opacity(0.12)).frame(width: 160, height: 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.tt.bgBubbleIncoming.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// 表格采样：表头 + 最多 3 行；列超 3 只取前 3（避免手机上过宽）。
    private func tableGrid(_ preview: IMCardTablePreview) -> some View {
        let columns = Array(preview.columns.prefix(3))
        let rows = Array(preview.rows.prefix(3))
        return VStack(alignment: .leading, spacing: 4) {
            Divider()
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    ForEach(columns) { column in
                        Text(row[column.key] ?? "")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            if preview.totalRows > rows.count {
                Text("共 \(preview.totalRows) 行")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
    }

    // MARK: - 名片（紧凑方案 B：44 头像 + 半粗昵称 + 右侧发消息胶囊）

    private var contactCard: some View {
        HStack(spacing: 10) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                Text(resolvedDisplayName)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Text(contactSubtitle)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if !isSelfContact {
                contactSendPill
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var contactSendPill: some View {
        HStack(spacing: 4) {
            Image(systemName: "bubble.left")
                .font(.tt.iconCaption)
            Text("发消息")
                .font(.tt.captionMedium)
        }
        .foregroundStyle(.tt.textAccent)
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(Color.tt.bgAccent.opacity(0.08), in: Capsule())
        .overlay(Capsule().stroke(Color.tt.bgAccent.opacity(0.35), lineWidth: 1))
        .accessibilityHidden(true)
    }

    private var avatar: some View {
        ProfileAvatarView(
            name: resolvedDisplayName,
            imageURL: ProviderIconURLResolver.resolve(contactAvatarURL ?? card.avatar),
            size: IMCardLayout.contactAvatarSize
        )
    }
}

/// 指令卡：正文最多展示两行；「使用此指令」只预填到新任务，仍由用户在任务 composer 选择 AI 分身与 Workspace。
private struct IMPromptCardView: View {
    let prompt: IMPromptCard
    let onUse: (() -> Void)?

    var body: some View {
        let accent = Color.tt.bgAccent
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Label("指令", systemImage: "terminal")
                        .font(.tt.bodyMedium.weight(.semibold))
                        .foregroundStyle(accent)
                    Spacer()
                    Text("可复用")
                        .font(.tt.captionMedium.weight(.semibold))
                        .foregroundStyle(.tt.textSecondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(.tt.bgBubbleIncoming.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
                }
                Text(prompt.displayTitle)
                    .font(.tt.titleMedium.weight(.bold))
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Text(prompt.promptText)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .padding(8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(.tt.bgBubbleIncoming.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
            }
            .frame(height: IMCardLayout.promptBodyHeight, alignment: .topLeading)
            .padding(12)
            Divider().overlay(.tt.borderLight)
            HStack {
                Button(action: { onUse?() }) {
                    Text("使用此指令")
                        .font(.tt.bodyMedium.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 42)
                        .background(onUse == nil ? accent.opacity(0.35) : accent, in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(onUse == nil)
            }
            .frame(height: IMCardLayout.promptFooterHeight)
            .padding(.horizontal, 10)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("指令卡：\(prompt.displayTitle)")
    }
}

/// 从一条现有消息整理接力包。手机端保持 Electron 的同一决策顺序：先确认接收者，
/// 再补一句交接目标；原消息以及其中的文档/表格会作为受控材料一并引用。
struct IMHandoffComposerSheet: View {
    let conversationId: String
    let sourceMessage: IMMessage
    let members: [IMMember]
    let currentUserId: String?
    let onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedRecipientIds: Set<String> = []
    @State private var goal = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private let service = IMHandoffService()

    private var recipients: [IMMember] {
        members
            .filter { $0.typedMemberType == .user && $0.userId != nil && $0.userId != currentUserId }
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }

    private var sourceSummary: String {
        if let displayName = sourceMessage.resourceCardDisplayName { return displayName }
        let text = sourceMessage.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        if sourceMessage.isImageAttachment { return "图片" }
        if sourceMessage.hasAttachment { return sourceMessage.attachmentFileName.isEmpty ? "文件" : sourceMessage.attachmentFileName }
        return "会话消息"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("交接内容") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(sourceMessage.senderName.isEmpty ? "原消息" : sourceMessage.senderName)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                        Text(sourceSummary)
                            .font(.tt.body)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(4)
                    }
                    .padding(.vertical, 3)
                }

                Section("交给谁") {
                    if recipients.isEmpty {
                        Text("当前会话没有其他可接收的成员")
                            .foregroundStyle(.tt.textSecondary)
                    } else {
                        ForEach(recipients) { member in
                            if let userId = member.userId {
                                Button {
                                    if selectedRecipientIds.contains(userId) { selectedRecipientIds.remove(userId) }
                                    else { selectedRecipientIds.insert(userId) }
                                } label: {
                                    HStack {
                                        Text(member.displayName.isEmpty ? member.username : member.displayName)
                                            .foregroundStyle(.tt.textPrimary)
                                        Spacer()
                                        Image(systemName: selectedRecipientIds.contains(userId) ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selectedRecipientIds.contains(userId) ? .tt.textAccent : .tt.textTertiary)
                                    }
                                }
                            }
                        }
                    }
                }

                Section {
                    TextEditor(text: $goal)
                        .frame(minHeight: 88)
                        .onChange(of: goal) { _, value in
                            if value.count > 500 { goal = String(value.prefix(500)) }
                        }
                    Text("\(goal.count)/500")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } header: {
                    Text("补充信息（可选）")
                } footer: {
                    Text("接收者会看到原消息和这里的目标；资源权限仍按查看者实时校验。")
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.tt.textCritical) }
                }
            }
            .navigationTitle("整理为交接")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if isSubmitting { ProgressView().controlSize(.small) }
                        else { Text("发送") }
                    }
                    .disabled(selectedRecipientIds.isEmpty || isSubmitting)
                }
            }
        }
        .onAppear {
            if recipients.count == 1, let id = recipients[0].userId { selectedRecipientIds = [id] }
        }
        .presentationDetents([.large])
    }

    private var references: [(type: String, resourceId: String)] {
        var result: [(String, String)] = [("im_message", String(sourceMessage.id))]
        if let card = sourceMessage.resourceCard,
           let resourceId = card.resourceId,
           card.typedType == .document || card.typedType == .table {
            result.append((card.typedType == .table ? "table" : "document", resourceId))
        }
        return result
    }

    private func submit() async {
        guard !isSubmitting else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let note = goal.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await service.create(
                conversationId: conversationId,
                goal: note.isEmpty ? "上下文交接" : note,
                recipientIds: Array(selectedRecipientIds).sorted(),
                references: references
            )
            onFinished()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// 对话接力卡。卡面快照只负责首帧，挂载后始终拉独立交接包；实时版本变化会再次拉取，
/// 因而撤销、接手和接收者状态能跨端同步。
struct IMHandoffCardBubble: View {
    let message: IMMessage
    let card: IMResourceCard
    let isMine: Bool
    let isAgent: Bool
    let showsSenderName: Bool
    var clock: String? = nil
    let refreshVersion: Int
    let members: [IMMember]
    let onOpenReference: (IMHandoffReference) -> Void
    var readProgress: IMReadReceipt? = nil

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                if showsSenderName && !message.senderName.isEmpty {
                    IMMessageSenderLabel(senderName: message.senderName, isAgent: isAgent, clock: clock)
                }
                IMHandoffCardView(
                    handoffId: card.handoffId ?? "",
                    goalSnapshot: card.goalSnapshot ?? message.content,
                    initiatorTypeSnapshot: card.initiatorType,
                    refreshVersion: refreshVersion,
                    members: members,
                    onOpenReference: onOpenReference
                )
            }
            if !isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
        }
    }
}

private struct IMHandoffCardView: View {
    let handoffId: String
    let goalSnapshot: String
    let initiatorTypeSnapshot: String?
    let refreshVersion: Int
    let members: [IMMember]
    let onOpenReference: (IMHandoffReference) -> Void

    @State private var detail: IMHandoffPackage?
    @State private var loadFailed = false
    @State private var acting = false
    @State private var actionError: String?
    @State private var showTakeOver = false
    @State private var transcript: IMHandoffFrozenTranscript?

    private let service = IMHandoffService()
    private var currentUserId: String? { AuthService.shared.currentUser?.id }
    private var revoked: Bool { detail?.status == "revoked" }
    private var isInitiator: Bool { detail?.initiatorUserId == currentUserId }
    private var myRecipient: IMHandoffRecipient? { detail?.recipients.first { $0.userId == currentUserId } }
    private var isViewOnly: Bool { detail?.scope == "view_only" }
    private var canTakeOver: Bool {
        guard detail != nil, !revoked, !isInitiator, !isViewOnly else { return false }
        guard let state = myRecipient?.state else { return true }
        return ["sent", "viewed", "acknowledged", "taking_over"].contains(state)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Label("上下文交接", systemImage: "arrow.left.arrow.right")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textAccent)
                if (detail?.initiatorType ?? initiatorTypeSnapshot) == "agent" {
                    Text("Agent 发起").font(.tt.caption).foregroundStyle(.tt.textSecondary)
                }
                if isViewOnly {
                    Text("仅供查看").font(.tt.caption).foregroundStyle(.tt.textSecondary)
                }
                Spacer(minLength: 0)
                if revoked { Text("已撤销").font(.tt.captionMedium).foregroundStyle(.tt.textTertiary) }
            }
            .padding(.horizontal, 13)
            .padding(.top, 12)

            Text(detail?.goal ?? cleanedGoalSnapshot)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .opacity(revoked ? 0.55 : 1)

            if loadFailed {
                Button("交接详情加载失败，点此重试") { Task { await load() } }
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textCritical)
                    .padding(.horizontal, 13)
                    .padding(.bottom, 10)
            }

            if let detail, !revoked {
                Divider()
                VStack(alignment: .leading, spacing: 12) {
                    checklist("当前进展", items: detail.progress, kind: .progress)
                    checklist("下一步", items: detail.nextSteps, kind: .next)
                    checklist("待确认 / 风险", items: detail.risks, kind: .risk)
                    if !detail.references.isEmpty { references(detail.references) }
                    if !detail.recipients.isEmpty { recipients(detail.recipients) }
                }
                .padding(13)
            }

            if let detail, !revoked, (canTakeOver || isInitiator) {
                Divider()
                HStack {
                    if canTakeOver {
                        Button {
                            Task { await beginTakeOver() }
                        } label: {
                            if acting { ProgressView().controlSize(.small) }
                            else { Label("由我继续", systemImage: "person.badge.clock") }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.tt.bgAccent)
                        .disabled(acting)
                    }
                    Spacer(minLength: 8)
                    if isInitiator && detail.status == "sent" {
                        Button("撤销", role: .destructive) { Task { await revoke() } }
                            .disabled(acting)
                    }
                }
                .font(.tt.captionMedium)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
            }
        }
        .frame(width: IMCardLayout.structuredWidth, alignment: .leading)
        .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.tt.borderLight, lineWidth: 1))
        .task(id: "\(handoffId):\(refreshVersion)") { await load() }
        .sheet(isPresented: $showTakeOver) {
            IMHandoffTakeOverSheet(handoffId: handoffId, service: service)
        }
        .sheet(item: Binding(
            get: { transcript.map { IdentifiedTranscript(value: $0) } },
            set: { if $0 == nil { transcript = nil } }
        )) { item in
            IMHandoffTranscriptView(transcript: item.value)
        }
        .alert("操作失败", isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) { Button("知道了", role: .cancel) { actionError = nil } }
        message: { Text(actionError ?? "") }
    }

    private var cleanedGoalSnapshot: String {
        goalSnapshot.replacingOccurrences(of: "[交接] ", with: "")
    }

    private enum ChecklistKind { case progress, next, risk }

    @ViewBuilder
    private func checklist(_ title: String, items: [IMHandoffChecklistItem], kind: ChecklistKind) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.tt.captionMedium).foregroundStyle(.tt.textSecondary)
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 7) {
                        Image(systemName: kind == .next
                              ? (item.checked == true ? "checkmark.circle.fill" : "circle")
                              : (kind == .risk && item.highRisk == true ? "exclamationmark.triangle.fill" : "circle.fill"))
                            .font(.tt.iconCaption)
                            .foregroundStyle(kind == .risk && item.highRisk == true ? .tt.textCritical : .tt.textTertiary)
                        Text(item.text).font(.tt.meta).foregroundStyle(.tt.textPrimary)
                    }
                }
            }
        }
    }

    private func references(_ items: [IMHandoffReference]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("相关材料").font(.tt.captionMedium).foregroundStyle(.tt.textSecondary)
            ForEach(items) { reference in
                Button {
                    guard reference.accessible else { return }
                    if let snapshot = reference.frozenSnapshot { transcript = snapshot }
                    else { onOpenReference(reference) }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: reference.accessible ? referenceIcon(reference.refType) : "nosign")
                        VStack(alignment: .leading, spacing: 1) {
                            Text(reference.title.isEmpty ? fallbackReferenceTitle(reference) : reference.title)
                                .lineLimit(1)
                            if !reference.accessible {
                                Text(deniedText(reference.deniedReason)).font(.tt.caption).foregroundStyle(.tt.textTertiary)
                            }
                        }
                        Spacer(minLength: 0)
                        if reference.accessible { Image(systemName: "chevron.right").font(.tt.iconCaption) }
                    }
                    .font(.tt.meta)
                    .foregroundStyle(reference.accessible ? .tt.textPrimary : .tt.textTertiary)
                    .padding(8)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(!reference.accessible)
            }
        }
    }

    private func recipients(_ items: [IMHandoffRecipient]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("接收者").font(.tt.captionMedium).foregroundStyle(.tt.textSecondary)
            ForEach(items) { recipient in
                HStack(spacing: 6) {
                    Image(systemName: recipientStateIcon(recipient.state))
                        .foregroundStyle(recipient.state == "rejected" ? .tt.textCritical : .tt.textAccent)
                    Text(memberName(recipient.userId) ?? recipient.agentId ?? "成员").lineLimit(1)
                    Spacer(minLength: 0)
                    Text(recipientStateLabel(recipient.state)).foregroundStyle(.tt.textTertiary)
                }
                .font(.tt.meta)
            }
        }
    }

    private func load() async {
        guard !handoffId.isEmpty else { loadFailed = true; return }
        do { detail = try await service.fetch(id: handoffId); loadFailed = false }
        catch { loadFailed = true }
    }

    private func beginTakeOver() async {
        guard !acting else { return }
        if myRecipient?.state != "taking_over" {
            acting = true
            defer { acting = false }
            do { detail = try await service.act(id: handoffId, action: .takeOver) }
            catch { actionError = error.localizedDescription; return }
        }
        showTakeOver = true
    }

    private func revoke() async {
        guard !acting else { return }
        acting = true
        defer { acting = false }
        do { detail = try await service.revoke(id: handoffId) }
        catch { actionError = error.localizedDescription }
    }

    private func memberName(_ userId: String?) -> String? {
        guard let userId else { return nil }
        return members.first { $0.userId == userId }?.displayName.nilIfBlank
    }

    private func referenceIcon(_ type: String) -> String {
        switch type { case "document": return "doc.text"; case "table": return "tablecells"; case "chat_session": return "bubble.left.and.bubble.right"; default: return "quote.bubble" }
    }
    private func fallbackReferenceTitle(_ ref: IMHandoffReference) -> String { ref.summary.isEmpty ? (ref.refType == "chat_session" ? "Agent 会话记录" : "会话消息") : ref.summary }
    private func deniedText(_ reason: String?) -> String { switch reason { case "deleted": return "内容已删除"; case "revoked": return "交接已撤销"; case "access_denied": return "无权访问"; default: return "暂时无法访问" } }
    private func recipientStateIcon(_ state: String) -> String { switch state { case "taking_over", "delegated_to_agent": return "person.crop.circle.badge.checkmark"; case "acknowledged": return "checkmark.circle.fill"; case "rejected": return "xmark.circle.fill"; default: return "circle" } }
    private func recipientStateLabel(_ state: String) -> String { switch state { case "viewed": return "已查看"; case "acknowledged": return "已了解"; case "taking_over": return "由 TA 继续"; case "delegated_to_agent": return "已交给 Agent"; case "rejected": return "已拒绝"; default: return "未查看" } }
}

private struct IdentifiedTranscript: Identifiable {
    let value: IMHandoffFrozenTranscript
    var id: String { value.title + String(value.messageCount) }
}

private struct IMHandoffTranscriptView: View {
    let transcript: IMHandoffFrozenTranscript
    @State private var previewAttachment: AttachmentBlock?
    @State private var attachmentError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    Text("交接时的只读快照，不含思考过程与工具参数")
                        .font(.tt.caption).foregroundStyle(.tt.textTertiary)
                    ForEach(transcript.turns) { turn in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(turn.role == "user" ? "发起人" : "AI")
                                .font(.tt.captionMedium).foregroundStyle(.tt.textSecondary)
                            if !turn.text.isEmpty { Text(turn.text).font(.tt.body).textSelection(.enabled) }
                            ForEach(Array(turn.attachments.enumerated()), id: \.element.id) { index, attachment in
                                Button {
                                    Task { await openAttachment(attachment, index: index) }
                                } label: {
                                    HStack {
                                        Label(attachment.filename, systemImage: "paperclip")
                                        Spacer(minLength: 8)
                                        Image(systemName: "chevron.right").font(.tt.iconCaption)
                                    }
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textSecondary)
                                }
                                .buttonStyle(.plain)
                                .disabled(attachment.fileId.isEmpty)
                            }
                        }
                        .padding(12)
                        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 10))
                    }
                    if transcript.truncated { Text("会话较长，仅展示前一部分").font(.tt.caption).foregroundStyle(.tt.textTertiary) }
                }
                .padding()
            }
            .navigationTitle(transcript.title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(item: $previewAttachment) { attachment in
            ChatAttachmentPreviewSheet(attachment: attachment)
        }
        .alert("附件无法打开", isPresented: Binding(
            get: { attachmentError != nil },
            set: { if !$0 { attachmentError = nil } }
        )) { Button("知道了", role: .cancel) { attachmentError = nil } }
        message: { Text(attachmentError ?? "") }
    }

    private func openAttachment(_ frozen: IMHandoffFrozenAttachment, index: Int) async {
        guard !frozen.fileId.isEmpty else { return }
        do {
            let access = try await OSSUploadService.shared.resolveFile(fileId: frozen.fileId)
            guard !access.resolvedUrl.isEmpty else { throw APIError.apiError("附件访问地址为空") }
            previewAttachment = AttachmentBlock(
                index: index,
                kind: access.mimeType.hasPrefix("image/") ? .image : .file,
                filename: access.fileName.isEmpty ? frozen.filename : access.fileName,
                mimeType: access.mimeType.isEmpty ? frozen.mimeType : access.mimeType,
                size: access.fileSize > 0 ? access.fileSize : Int64(frozen.size),
                url: access.resolvedUrl,
                fileId: access.fileId
            )
        } catch {
            attachmentError = error.localizedDescription
        }
    }
}

private struct IMHandoffTakeOverSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var workspaceStore = WorkspaceStore.shared
    @State private var agentStore = MyAgentsStore.shared
    @State private var selectedWorkspaceId: String?
    @State private var selectedAgentId: String?
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    let handoffId: String
    let service: IMHandoffService

    private var workspaces: [Space] { workspaceStore.spaces.filter(\.isExecutionSpace) }
    private var agents: [OrganizationAgent] { agentStore.agents.filter { $0.isActive != false } }

    var body: some View {
        NavigationStack {
            Form {
                Section("Workspace") {
                    ForEach(workspaces) { workspace in
                        Button { selectedWorkspaceId = workspace.id } label: {
                            Label(workspace.name, systemImage: selectedWorkspaceId == workspace.id ? "checkmark.circle.fill" : "circle")
                        }
                    }
                }
                Section("AI 分身") {
                    ForEach(agents) { agent in
                        Button { selectedAgentId = agent.id } label: {
                            Label(agent.displayName, systemImage: selectedAgentId == agent.id ? "checkmark.circle.fill" : "circle")
                        }
                    }
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.tt.textCritical) } }
            }
            .navigationTitle("接手交接任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("进入任务") { Task { await submit() } }
                        .disabled(selectedWorkspaceId == nil || selectedAgentId == nil || isSubmitting)
                }
            }
        }
        .task {
            if workspaceStore.spaces.isEmpty { await workspaceStore.loadSpaces() }
            let organizationId = workspaceStore.selectedOrganizationId
            await agentStore.ensureLoaded(organizationId: organizationId)
            selectedWorkspaceId = workspaces.first(where: { $0.isDefault == true })?.id ?? workspaces.first?.id
            selectedAgentId = selectedWorkspaceId.flatMap { id in workspaces.first { $0.id == id }?.primaryAgentId }
                ?? agents.first(where: { $0.isDefault == true })?.id ?? agents.first?.id
        }
    }

    private func submit() async {
        guard let workspace = workspaces.first(where: { $0.id == selectedWorkspaceId }),
              let agentId = selectedAgentId else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let session = try await service.takeOver(id: handoffId, agentId: agentId, workspaceId: workspace.id)
            dismiss()
            MainRouter.shared.openConversation(ConversationTarget(
                title: session.title ?? workspace.name,
                workspaceId: session.workspaceId ?? workspace.id,
                organizationId: session.organizationId ?? workspace.organizationId,
                agentId: session.agentId ?? agentId,
                projectId: session.projectId,
                sessionId: session.id
            ))
        } catch { errorMessage = error.localizedDescription }
    }
}

private extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

/// 对未知、尚未落地或结构异常的 metadata.card 的保守降级。
///
/// 关键是维持“它是一张结构化卡片”的视觉和交互边界：不套成可编辑的普通文本气泡。
/// 卡面固定两行，第二行保留服务端给出的兼容描述（例如「[共享任务](新任务)」）。
struct IMUnsupportedCardBubble: View {
    let message: IMMessage
    let isMine: Bool
    let isAgent: Bool
    var showsSenderName: Bool = false
    var clock: String? = nil
    var readProgress: IMReadReceipt? = nil

    private var description: String {
        let text = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "未提供消息描述" : text
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            VStack(alignment: .leading, spacing: 5) {
                if showsSenderName && !message.senderName.isEmpty {
                    IMMessageSenderLabel(senderName: message.senderName, isAgent: isAgent, clock: clock)
                }
                Text("不支持的消息类型")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                Text(description)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
            }
            .padding(12)
            .frame(width: IMCardLayout.structuredWidth, alignment: .leading)
            .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.tt.borderLight, lineWidth: 1))
            if !isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("不支持的消息类型，\(description)")
    }
}

/// `session_share_v2` 协作卡。消息只携带快照，打开和确认加入依赖详情接口。
struct IMSessionShareV2CardBubble: View {
    let message: IMMessage
    let snapshot: IMSessionShareV2Card
    let isMine: Bool
    let isAgent: Bool
    let showsSenderName: Bool
    var clock: String? = nil
    let currentUserId: String?
    var organizationMembers: [OrganizationMember] = []
    let loadDetail: (IMSessionShareV2Card) async -> IMSessionShareV2Detail?
    let onAccept: (IMSessionShareV2Card) async -> IMSessionShareV2Detail?
    let onRetryDelivery: (IMSessionShareV2Card) async -> IMSessionShareV2Detail?
    let onOpen: (IMSessionShareV2Detail) -> Void
    var readProgress: IMReadReceipt? = nil
    @State private var detail: IMSessionShareV2Detail?
    @State private var loading = false
    @State private var joining = false
    @State private var loadFailed = false

    private var relation: String {
        let senderName = IMMemberDisplayPolicy.resolvedDisplayName(
            userId: snapshot.senderId,
            snapshotName: message.senderName,
            organizationMembers: organizationMembers
        )
        let recipientName = IMMemberDisplayPolicy.resolvedDisplayName(
            userId: snapshot.recipientId,
            snapshotName: nil,
            organizationMembers: organizationMembers
        )
        if currentUserId == snapshot.senderId {
            return recipientName.isEmpty ? "你发起了协作邀请" : "你邀请 \(recipientName) 参与"
        }
        if currentUserId == snapshot.recipientId {
            return senderName.isEmpty ? "对方邀请你参与" : "\(senderName) 邀请你参与"
        }
        return "任务协作邀请"
    }

    private var permissionText: String {
        switch detail?.accessMode {
        case "collaborate": return "可参与对话"
        case "fork": return "查看并创建副本"
        case "view": return "实时查看"
        default: return "任务协作"
        }
    }

    private var actionTitle: String {
        if joining { return "确认中..." }
        if loadFailed { return "重新加载" }
        if detail?.phase == "deliveryUnconfirmed", detail?.role == "owner" { return "重试发送" }
        if detail?.actions?.canJoin == true { return "确认加入任务" }
        if detail?.actions?.canOpen == true { return detail?.role == "owner" ? "打开我的任务" : "查看任务" }
        if loading { return "加载中..." }
        if detail?.phase == "stopped" || detail?.status == "revoked" { return "共享已停止" }
        if detail?.phase == "ineligible" { return "资格已失效" }
        return "详情暂不可用"
    }

    private var actionEnabled: Bool {
        if joining { return false }
        if loadFailed { return true }
        if detail?.phase == "deliveryUnconfirmed", detail?.role == "owner" { return true }
        if detail?.actions?.canJoin == true { return true }
        if detail?.actions?.canOpen == true,
           (detail?.sessionId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return true
        }
        return false
    }

    init(
        message: IMMessage,
        snapshot: IMSessionShareV2Card,
        isMine: Bool,
        isAgent: Bool,
        showsSenderName: Bool,
        clock: String? = nil,
        currentUserId: String?,
        organizationMembers: [OrganizationMember] = [],
        loadDetail: @escaping (IMSessionShareV2Card) async -> IMSessionShareV2Detail?,
        onAccept: @escaping (IMSessionShareV2Card) async -> IMSessionShareV2Detail?,
        onRetryDelivery: @escaping (IMSessionShareV2Card) async -> IMSessionShareV2Detail?,
        onOpen: @escaping (IMSessionShareV2Detail) -> Void,
        readProgress: IMReadReceipt? = nil
    ) {
        self.message = message
        self.snapshot = snapshot
        self.isMine = isMine
        self.isAgent = isAgent
        self.showsSenderName = showsSenderName
        self.clock = clock
        self.currentUserId = currentUserId
        self.organizationMembers = organizationMembers
        self.loadDetail = loadDetail
        self.onAccept = onAccept
        self.onRetryDelivery = onRetryDelivery
        self.onOpen = onOpen
        self.readProgress = readProgress
        _detail = State(initialValue: IMCardStatusMemoryCache.sessionShareV2Detail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ))
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                if showsSenderName && !message.senderName.isEmpty {
                    IMMessageSenderLabel(senderName: message.senderName, isAgent: isAgent, clock: clock)
                }
                card
            }
            if !isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("协作邀请，\(snapshot.title)，\(relation)")
        .task(id: "\(snapshot.objectId)-\(snapshot.version)") {
            await refreshDetail()
        }
    }

    private var card: some View {
        let accent = Color.tt.textAccent
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "person.2.fill")
                    Text("协作邀请")
                    Spacer(minLength: 8)
                    Text("版本 \(snapshot.version)")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                }
                .font(.tt.bodyMedium.weight(.semibold))
                .foregroundStyle(accent)
                Text(snapshot.title)
                    .font(.tt.titleMedium.weight(.bold))
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                Text(relation)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
                Label(permissionText, systemImage: "person.2")
                    .font(.tt.captionMedium.weight(.semibold))
                    .foregroundStyle(.tt.textSecondary)
            }
            .padding(12)
            Divider().overlay(.tt.borderLight)
            Button {
                Task { await handleAction() }
            } label: {
                HStack(spacing: 6) {
                    if loading || joining {
                        ProgressView().controlSize(.mini)
                    }
                    Text(actionTitle)
                        .font(.tt.captionMedium.weight(.semibold))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .center)
                .padding(.horizontal, 10)
            }
            .buttonStyle(.plain)
            .foregroundStyle(actionEnabled ? accent : .tt.textSecondary)
            .disabled(!actionEnabled)
        }
        .frame(width: IMCardLayout.structuredWidth, alignment: .leading)
        .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(accent.opacity(0.38), lineWidth: 1))
    }

    private func refreshDetail() async {
        if let cached = IMCardStatusMemoryCache.sessionShareV2Detail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ) {
            detail = cached
            loading = false
            loadFailed = false
            return
        }
        loading = true
        loadFailed = false
        if let loaded = await loadDetail(snapshot) {
            detail = loaded
            IMCardStatusMemoryCache.putSessionShareV2Detail(loaded)
        } else {
            loadFailed = true
        }
        loading = false
    }

    private func handleAction() async {
        if loadFailed {
            await refreshDetail()
            return
        }
        if detail?.phase == "deliveryUnconfirmed", detail?.role == "owner" {
            loading = true
            if let retried = await onRetryDelivery(snapshot) {
                detail = retried
            }
            loading = false
            return
        }
        if detail?.actions?.canJoin == true {
            joining = true
            if let accepted = await onAccept(snapshot) {
                detail = accepted
            }
            joining = false
            return
        }
        if detail?.actions?.canOpen == true, let detail {
            onOpen(detail)
        }
    }
}

/// 冻结任务上下文的续接卡。卡片消息只负责定位；状态、材料与新任务 id 都来自权威详情。
struct IMSessionContinuationCardBubble: View {
    let message: IMMessage
    let snapshot: IMSessionContinuationCard
    let isMine: Bool
    let isAgent: Bool
    let showsSenderName: Bool
    var clock: String? = nil
    let currentUserId: String?
    var organizationMembers: [OrganizationMember] = []
    let loadDetail: (IMSessionContinuationCard) async -> IMSessionContinuationDetail?
    let createTask: (
        IMSessionContinuationCard,
        String,
        String,
        String
    ) async -> IMSessionContinuationDetail?
    let onOpen: (IMSessionContinuationDetail) -> Void
    var readProgress: IMReadReceipt? = nil

    @State private var detail: IMSessionContinuationDetail?
    @State private var loading = false
    @State private var loadFailed = false
    @State private var showTargetPicker = false
    @State private var materializeRequestId = UUID().uuidString

    init(
        message: IMMessage,
        snapshot: IMSessionContinuationCard,
        isMine: Bool,
        isAgent: Bool,
        showsSenderName: Bool,
        clock: String? = nil,
        currentUserId: String?,
        organizationMembers: [OrganizationMember] = [],
        loadDetail: @escaping (IMSessionContinuationCard) async -> IMSessionContinuationDetail?,
        createTask: @escaping (
            IMSessionContinuationCard,
            String,
            String,
            String
        ) async -> IMSessionContinuationDetail?,
        onOpen: @escaping (IMSessionContinuationDetail) -> Void,
        readProgress: IMReadReceipt? = nil
    ) {
        self.message = message
        self.snapshot = snapshot
        self.isMine = isMine
        self.isAgent = isAgent
        self.showsSenderName = showsSenderName
        self.clock = clock
        self.currentUserId = currentUserId
        self.organizationMembers = organizationMembers
        self.loadDetail = loadDetail
        self.createTask = createTask
        self.onOpen = onOpen
        self.readProgress = readProgress
        _detail = State(initialValue: IMCardStatusMemoryCache.sessionContinuationDetail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ))
    }

    private var relation: String {
        let senderName = IMMemberDisplayPolicy.resolvedDisplayName(
            userId: snapshot.senderId,
            snapshotName: message.senderName,
            organizationMembers: organizationMembers
        )
        let recipientName = IMMemberDisplayPolicy.resolvedDisplayName(
            userId: snapshot.recipientId,
            snapshotName: nil,
            organizationMembers: organizationMembers
        )
        if currentUserId == snapshot.senderId {
            return recipientName.isEmpty ? "你发送的冻结任务上下文" : "你把任务交给 \(recipientName) 续接"
        }
        if currentUserId == snapshot.recipientId {
            return senderName.isEmpty ? "对方交给你继续的任务" : "\(senderName) 交给你继续的任务"
        }
        return "任务续接"
    }

    private var statusTitle: String {
        guard let detail else { return loadFailed ? "详情不可用" : "加载中..." }
        if detail.role == "recipient", !detail.eligibility.canCreate { return "资格已失效" }
        if detail.creationStatus == "created" { return "已创建" }
        if detail.creationStatus == "failed" { return "创建失败" }
        if detail.deliveryStatus != "confirmed" { return "发送中" }
        if detail.contextStatus == "empty" { return "没有可续接内容" }
        if detail.contextStatus == "truncated" { return "上下文已截断" }
        if detail.resourceStatus == "partial" || detail.resourceStatus == "unavailable" {
            return "部分资源不可用"
        }
        return "可续接"
    }

    private var actionTitle: String {
        if loading { return "加载中..." }
        if loadFailed { return "重新加载" }
        guard let detail else { return "详情暂不可用" }
        if detail.role != "recipient" {
            return detail.creationStatus == "created" ? "对方已创建新任务" : "等待对方创建"
        }
        if !detail.eligibility.canCreate { return "资格已失效" }
        if detail.creationStatus == "created" { return "打开新任务" }
        if detail.creationStatus == "failed" { return "重试创建" }
        if detail.deliveryStatus != "confirmed" { return "等待送达" }
        if detail.contextStatus == "empty" { return "没有可续接内容" }
        return "创建我的任务"
    }

    private var actionEnabled: Bool {
        if loadFailed { return true }
        guard !loading, let detail, detail.role == "recipient", detail.eligibility.canCreate else {
            return false
        }
        if detail.creationStatus == "created" {
            return detail.linkedSessionId?.isEmpty == false && detail.targetWorkspaceId?.isEmpty == false
        }
        return detail.deliveryStatus == "confirmed" && detail.contextStatus != "empty"
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                if showsSenderName && !message.senderName.isEmpty {
                    IMMessageSenderLabel(senderName: message.senderName, isAgent: isAgent, clock: clock)
                }
                card
            }
            if !isMine, let readProgress {
                IMReadProgressIndicator(
                    readCount: readProgress.readCount,
                    recipientCount: readProgress.recipientCount
                )
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("任务续接，\(snapshot.title)，\(relation)，\(statusTitle)")
        .task(id: "\(snapshot.objectId)-\(snapshot.version)") { await refreshDetail() }
        .sheet(isPresented: $showTargetPicker) {
            if let detail {
                IMSessionContinuationTargetSheet(
                    organizationId: detail.organizationId,
                    clientRequestId: materializeRequestId,
                    createTask: { agentId, workspaceId, clientRequestId in
                        await createTask(snapshot, agentId, workspaceId, clientRequestId)
                    },
                    onCreated: { created in
                        self.detail = created
                        showTargetPicker = false
                        onOpen(created)
                    }
                )
            }
        }
    }

    private var card: some View {
        let accent = Color.tt.textAccent
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch")
                    Text("任务续接")
                    Spacer(minLength: 8)
                    Text(statusTitle)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                }
                .font(.tt.bodyMedium.weight(.semibold))
                .foregroundStyle(accent)
                Text(detail?.titleSnapshot.nilIfBlank ?? snapshot.title)
                    .font(.tt.titleMedium.weight(.bold))
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                Text(relation)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)
                if let detail {
                    Label(
                        "冻结 \(detail.snapshotTurnCount) 轮上下文，之后不跟随原任务变化",
                        systemImage: "camera"
                    )
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                    if detail.resources.contains(where: \.unavailable) {
                        Label("部分关联资源需要重新获取权限", systemImage: "exclamationmark.triangle")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textWarning)
                    }
                }
            }
            .padding(12)
            Divider().overlay(.tt.borderLight)
            Button { handleAction() } label: {
                HStack(spacing: 6) {
                    if loading { ProgressView().controlSize(.mini) }
                    Text(actionTitle)
                        .font(.tt.captionMedium.weight(.semibold))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .center)
                .padding(.horizontal, 10)
            }
            .buttonStyle(.plain)
            .foregroundStyle(actionEnabled ? accent : .tt.textSecondary)
            .disabled(!actionEnabled)
        }
        .frame(width: IMCardLayout.structuredWidth, alignment: .leading)
        .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(accent.opacity(0.38), lineWidth: 1))
    }

    private func refreshDetail() async {
        if let cached = IMCardStatusMemoryCache.sessionContinuationDetail(
            id: snapshot.objectId,
            minimumVersion: snapshot.version
        ) {
            detail = cached
            loading = false
            loadFailed = false
            return
        }
        loading = true
        loadFailed = false
        if let loaded = await loadDetail(snapshot) {
            detail = loaded
            IMCardStatusMemoryCache.putSessionContinuationDetail(loaded)
        } else {
            loadFailed = true
        }
        loading = false
    }

    private func handleAction() {
        if loadFailed {
            Task { await refreshDetail() }
            return
        }
        guard let detail, detail.role == "recipient" else { return }
        if detail.creationStatus == "created" {
            onOpen(detail)
        } else {
            showTargetPicker = true
        }
    }
}

private struct IMSessionContinuationTargetSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var workspaceStore = WorkspaceStore.shared
    @State private var agentStore = MyAgentsStore.shared
    @State private var selectedWorkspaceId: String?
    @State private var selectedAgentId: String?
    @State private var isLoading = true
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    let organizationId: String
    let clientRequestId: String
    let createTask: (String, String, String) async -> IMSessionContinuationDetail?
    let onCreated: (IMSessionContinuationDetail) -> Void

    private var workspaces: [Space] {
        SharedSessionExecutionTargetPolicy.workspaces(
            from: workspaceStore.spaces,
            organizationId: organizationId
        )
    }
    private var agents: [OrganizationAgent] {
        SharedSessionExecutionTargetPolicy.agents(
            from: agentStore.agents,
            organizationId: organizationId
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                if isLoading {
                    Section { ProgressView("正在加载可用执行目标…") }
                } else {
                    Section("AI 分身") {
                        if agents.isEmpty { Text("当前组织没有可用的 AI 分身") }
                        ForEach(agents) { agent in
                            Button { selectedAgentId = agent.id } label: {
                                Label(
                                    agent.displayName,
                                    systemImage: selectedAgentId == agent.id ? "checkmark.circle.fill" : "circle"
                                )
                            }
                        }
                    }
                    Section("Workspace") {
                        if workspaces.isEmpty { Text("当前组织没有可用的执行 Workspace") }
                        ForEach(workspaces) { workspace in
                            Button { selectedWorkspaceId = workspace.id } label: {
                                Label(
                                    workspace.name,
                                    systemImage: selectedWorkspaceId == workspace.id ? "checkmark.circle.fill" : "circle"
                                )
                            }
                        }
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.tt.textCritical) }
                }
            }
            .navigationTitle("创建续接任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "创建中…" : "创建") {
                        Task { await submit() }
                    }
                    .disabled(selectedWorkspaceId == nil || selectedAgentId == nil || isSubmitting)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSubmitting)
        .task { await loadTargets() }
    }

    @MainActor
    private func loadTargets() async {
        isLoading = true
        if workspaceStore.spacesLoadedOrganizationId != organizationId {
            await workspaceStore.loadSpaces()
        }
        await agentStore.ensureLoaded(organizationId: organizationId)
        selectedWorkspaceId = SharedSessionExecutionTargetPolicy.defaultWorkspace(in: workspaces)?.id
        selectedAgentId = SharedSessionExecutionTargetPolicy.defaultAgent(in: agents)?.id
        isLoading = false
    }

    @MainActor
    private func submit() async {
        guard let selectedAgentId, let selectedWorkspaceId else { return }
        isSubmitting = true
        errorMessage = nil
        if let created = await createTask(selectedAgentId, selectedWorkspaceId, clientRequestId) {
            onCreated(created)
        } else {
            errorMessage = "创建续接任务失败，请重试。"
        }
        isSubmitting = false
    }
}

struct IMSessionShareCardBubble: View {
    let message: IMMessage
    let snapshot: IMSessionShareCard
    let isMine: Bool
    let isAgent: Bool
    let showsSenderName: Bool
    var clock: String? = nil
    let currentUserId: String?
    let loadDetail: (IMSessionShareCard) async -> IMSessionShareCard
    let onOpen: (IMSessionShareCard) -> Void
    let onRevoke: (IMSessionShareCard) async -> IMSessionShareCard?
    let onResume: (IMSessionShareCard) async -> IMSessionShareCard?
    var readProgress: IMReadReceipt? = nil

    @State private var detail: IMSessionShareCard
    @State private var pendingAction: PendingAction?

    private enum PendingAction {
        case revoke
        case resume
    }

    init(
        message: IMMessage,
        snapshot: IMSessionShareCard,
        isMine: Bool,
        isAgent: Bool,
        showsSenderName: Bool,
        clock: String? = nil,
        currentUserId: String?,
        loadDetail: @escaping (IMSessionShareCard) async -> IMSessionShareCard,
        onOpen: @escaping (IMSessionShareCard) -> Void,
        onRevoke: @escaping (IMSessionShareCard) async -> IMSessionShareCard?,
        onResume: @escaping (IMSessionShareCard) async -> IMSessionShareCard?,
        readProgress: IMReadReceipt? = nil
    ) {
        self.message = message
        self.snapshot = snapshot
        self.isMine = isMine
        self.isAgent = isAgent
        self.showsSenderName = showsSenderName
        self.clock = clock
        self.currentUserId = currentUserId
        self.loadDetail = loadDetail
        self.onOpen = onOpen
        self.onRevoke = onRevoke
        self.onResume = onResume
        self.readProgress = readProgress
        _detail = State(initialValue:
            IMCardStatusMemoryCache.authoritativeSessionShare(id: snapshot.shareId)
                ?? IMCardStatusMemoryCache.sessionShare(id: snapshot.shareId)
                ?? snapshot
        )
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if isMine, let readProgress {
                IMReadProgressIndicator(readCount: readProgress.readCount, recipientCount: readProgress.recipientCount)
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                if showsSenderName && !message.senderName.isEmpty {
                    IMMessageSenderLabel(senderName: message.senderName, isAgent: isAgent, clock: clock)
                }
                card
            }
            if !isMine, let readProgress {
                IMReadProgressIndicator(readCount: readProgress.readCount, recipientCount: readProgress.recipientCount)
            }
        }
        .task(id: "\(snapshot.shareId):\(snapshot.status ?? "")") {
            let loaded = await loadDetail(snapshot)
            await MainActor.run {
                IMCardStatusMemoryCache.putAuthoritativeSessionShare(loaded)
                if detail != loaded { detail = loaded }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .imSessionShareStatusDidChange)) { note in
            guard note.userInfo?["share_id"] as? String == snapshot.shareId,
                  let updated = IMCardStatusMemoryCache.authoritativeSessionShare(id: snapshot.shareId)
                    ?? IMCardStatusMemoryCache.sessionShare(id: snapshot.shareId),
                  updated != detail else { return }
            detail = updated
        }
    }

    private var card: some View {
        let accent = Color(red: 0.95, green: 0.55, blue: 0.22)
        let active = detail.normalizedStatus == "active"
        let isOwner = isSessionShareOwner(
            currentUserId: currentUserId,
            ownerUserId: detail.ownerUserId,
            isMine: isMine
        )
        let isGrantee = currentUserId != nil && detail.granteeUserId == currentUserId
        let relation: String = {
            if isOwner, let name = detail.granteeDisplayName, !name.isEmpty { return "你共享给 \(name)" }
            if isGrantee, let name = detail.ownerDisplayName, !name.isEmpty { return "\(name) 共享给你" }
            return "任务共享"
        }()
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    HStack(spacing: 6) {
                        Image(systemName: "square.and.arrow.up")
                        Text("任务共享")
                    }
                    .font(.tt.bodyMedium.weight(.semibold))
                    .foregroundStyle(accent)
                    Spacer()
                    Text(active ? "共享中" : "已停止")
                        .font(.tt.captionMedium.weight(.semibold))
                        .foregroundStyle(.tt.textSecondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(.tt.bgBubbleIncoming.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
                }
                Text(detail.displayTitle)
                    .font(.tt.titleMedium.weight(.bold))
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Text(relation)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Image(systemName: "eye")
                    Text(detail.permissionLabel)
                }
                .font(.tt.captionMedium.weight(.semibold))
                .foregroundStyle(.tt.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.tt.bgBubbleIncoming.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
            }
            .frame(height: IMCardLayout.sessionShareBodyHeight, alignment: .topLeading)
            .padding(12)
            Divider().overlay(.tt.borderLight)
            HStack(spacing: 12) {
                if isOwner && !active {
                    Button {
                        perform(.resume)
                    } label: {
                        actionLabel("恢复共享", loading: pendingAction == .resume)
                            .background(accent, in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                    }
                    .buttonStyle(.plain)
                    .disabled(pendingAction != nil)
                } else if active {
                    Button {
                        onOpen(detail)
                    } label: {
                        Text("打开任务")
                            .font(.tt.bodyMedium.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .background(detail.sessionId?.isEmpty == false ? accent : accent.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                    }
                    .buttonStyle(.plain)
                    .disabled(detail.sessionId?.isEmpty != false || pendingAction != nil)
                    if isOwner {
                        Button {
                            perform(.revoke)
                        } label: {
                            HStack(spacing: 6) {
                                if pendingAction == .revoke {
                                    ProgressView().controlSize(.small)
                                }
                                Text("停止共享")
                            }
                        }
                        .font(.tt.bodyMedium.weight(.semibold))
                        .foregroundStyle(.tt.textSecondary)
                        .disabled(pendingAction != nil)
                    }
                } else {
                    Text("共享已停止")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .frame(height: IMCardLayout.sessionShareFooterHeight)
            .padding(.horizontal, 10)
        }
        .frame(width: IMCardLayout.structuredWidth, height: IMCardLayout.sessionShareHeight, alignment: .leading)
        .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(accent.opacity(0.38), lineWidth: 1))
    }

    private func actionLabel(_ title: String, loading: Bool) -> some View {
        HStack(spacing: 7) {
            if loading { ProgressView().tint(.white).controlSize(.small) }
            Text(title)
        }
        .font(.tt.bodyMedium.weight(.semibold))
        .frame(maxWidth: .infinity)
        .frame(height: 42)
    }

    private func perform(_ action: PendingAction) {
        guard pendingAction == nil else { return }
        pendingAction = action
        let current = detail
        Task {
            let updated: IMSessionShareCard?
            switch action {
            case .revoke:
                updated = await onRevoke(current)
            case .resume:
                updated = await onResume(current)
            }
            await MainActor.run {
                if let updated {
                    IMCardStatusMemoryCache.putAuthoritativeSessionShare(updated)
                    detail = updated
                }
                pendingAction = nil
            }
        }
    }
}

func isSessionShareOwner(
    currentUserId: String?,
    ownerUserId: String?,
    isMine: Bool
) -> Bool {
    if let ownerUserId = ownerUserId?.trimmingCharacters(in: .whitespacesAndNewlines),
       !ownerUserId.isEmpty {
        return currentUserId == ownerUserId
    }
    return isMine
}
