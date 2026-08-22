import SwiftUI

struct WorkspaceMembersScreen: View {
    let organization: Organization

    @State private var workspace = WorkspaceStore.shared
    @State private var invitations = InvitationService.shared
    @State private var memberToRemove: OrganizationMember?
    @State private var errorMessage: String?

    private var currentUserId: String? { AuthService.shared.currentUser?.id }
    private let assignableRoles: [OrganizationRole] = [.viewer, .editor, .admin]

    private var displayedMembers: [OrganizationMember] {
        OrganizationMemberPresentation.ownerFirst(workspace.members)
    }

    var body: some View {
        List {
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.tt.textCritical)
                }
            }

            Section("成员") {
                if workspace.isLoadingMembers && workspace.members.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else if workspace.members.isEmpty {
                    Text("暂无成员")
                        .foregroundStyle(.tt.textTertiary)
                } else {
                    ForEach(displayedMembers) { member in
                        memberRow(member)
                    }
                }
            }

            if workspace.canManage && !organization.isPersonal {
                Section("邀请") {
                    NavigationLink {
                        WorkspaceInvitationsScreen(organization: organization)
                    } label: {
                        Label("邀请成员", systemImage: "person.badge.plus")
                    }
                    if invitations.invitations.isEmpty {
                        Text("暂无待处理邀请")
                            .foregroundStyle(.tt.textTertiary)
                    } else {
                        ForEach(invitations.invitations) { invitation in
                            pendingInvitationRow(invitation)
                        }
                    }
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle("成员")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .ttTabBarHidden(true)
        .ttLoading(workspace.isMutating || invitations.isMutating)
        .refreshable { await reload() }
        .task { await reload() }
        .alert("移除成员", isPresented: Binding(
            get: { memberToRemove != nil },
            set: { if !$0 { memberToRemove = nil } }
        )) {
            Button("移除", role: .destructive) {
                if let memberToRemove {
                    Task { await remove(memberToRemove) }
                }
            }
            Button(L10n.Common.cancel, role: .cancel) { memberToRemove = nil }
        } message: {
            Text("该成员将无法继续访问这个组织。")
        }
    }

    private func memberRow(_ member: OrganizationMember) -> some View {
        HStack(spacing: TTSpacing.md) {
            WorkspaceMemberAvatar(name: member.displayName, imageURL: member.avatar.flatMap(URL.init(string:)))
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(member.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if member.userId == currentUserId {
                        Text("我")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textAccent)
                            .padding(.horizontal, TTSpacing.xs)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(.tt.bgAccent.opacity(0.12)))
                    }
                }
                if let subtitle = member.subtitle {
                    Text(subtitle)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer()
            WorkspaceRoleBadge(role: member.role)
            memberActions(for: member)
        }
        .padding(.vertical, TTSpacing.xs)
    }

    @ViewBuilder
    private func memberActions(for member: OrganizationMember) -> some View {
        let canEditMember = OrganizationMemberActions.canManage(
            operatorRole: workspace.currentUserRole,
            targetRole: member.role,
            isCurrentUser: member.userId == currentUserId,
            isPersonalOrganization: organization.isPersonal
        )

        if canEditMember {
            Menu {
                ForEach(assignableRoles.filter {
                    OrganizationMemberActions.canAssign(operatorRole: workspace.currentUserRole, role: $0)
                }) { role in
                    Button {
                        Task { await update(member, role: role) }
                    } label: {
                        Label(role.title, systemImage: role == member.role ? "checkmark" : "person")
                    }
                }
                Divider()
                Button(role: .destructive) {
                    memberToRemove = member
                } label: {
                    Label("移除成员", systemImage: "person.badge.minus")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.tt.body)
                    .foregroundStyle(.tt.iconSecondary)
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("成员操作")
        }
    }

    private func pendingInvitationRow(_ invitation: OrganizationInvitation) -> some View {
        HStack(spacing: TTSpacing.md) {
            Image(systemName: invitation.inviteType == "email" ? "envelope" : "link")
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(invitation.email ?? invitation.token.map { InvitationLink.url(token: $0) } ?? invitation.id)
                    .font(.tt.body)
                Text(invitation.role.title)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer()
            Button(role: .destructive) {
                Task { await cancelInvitation(invitation) }
            } label: {
                Image(systemName: "xmark.circle")
            }
        }
    }

    private func reload() async {
        await workspace.loadMembers(organizationId: organization.id)
        if workspace.canManage {
            await invitations.loadInvitations(organizationId: organization.id)
        }
    }

    private func update(_ member: OrganizationMember, role: OrganizationRole) async {
        errorMessage = nil
        let success = await workspace.updateMemberRole(organizationId: organization.id, userId: member.userId, role: role)
        if !success {
            errorMessage = workspace.errorMessage ?? "更新成员角色失败"
        }
    }

    private func remove(_ member: OrganizationMember) async {
        errorMessage = nil
        memberToRemove = nil
        let success = await workspace.removeMember(organizationId: organization.id, userId: member.userId)
        if !success {
            errorMessage = workspace.errorMessage ?? "移除成员失败"
        }
    }

    private func cancelInvitation(_ invitation: OrganizationInvitation) async {
        errorMessage = nil
        do {
            try await invitations.cancelInvitation(organizationId: organization.id, invitationId: invitation.id)
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }
}

struct WorkspaceWalletScreen: View {
    let organizationId: String

    @State private var wallet: WalletInfo?
    @State private var transactions: [WalletTransaction] = []
    @State private var isLoading = true
    @State private var isLoadingMore = false
    @State private var errorMessage: String?
    @State private var offset = 0
    @State private var hasMore = true

    private let pageSize = 20

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                balanceCard
                transactionList
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle("钱包")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .ttTabBarHidden(true)
        .refreshable { await reload() }
        .task { await reload() }
        .ttLoading(isLoading && wallet == nil && transactions.isEmpty)
    }

    private var balanceCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text("余额")
                .font(.tt.metaSemibold)
                .foregroundStyle(.tt.textSecondary)
            Text(WorkspaceNumberFormat.formatCredits(wallet?.creditsPrecise, fallback: wallet?.credits))
                .font(.tt.iconEmptySemibold)
                .foregroundStyle(.tt.textPrimary)
            HStack(spacing: TTSpacing.xl) {
                balanceMetric("可用", WorkspaceNumberFormat.formatCredits(wallet?.availableCreditsPrecise, fallback: wallet?.availableCredits))
                balanceMetric("冻结", WorkspaceNumberFormat.formatCredits(wallet?.creditsFrozenPrecise, fallback: wallet?.creditsFrozen))
            }
            if let errorMessage, wallet == nil {
                Text(errorMessage)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textCritical)
            }
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous).fill(.tt.bgSubtle))
    }

    private func balanceMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Text(title)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
            Text(value)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
        }
    }

    @ViewBuilder
    private var transactionList: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text("交易记录")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            if transactions.isEmpty && !isLoading {
                Text("暂无交易记录")
                    .font(.tt.body)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, TTSpacing.xxxl)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(transactions) { tx in
                        transactionRow(tx)
                        Divider().opacity(0.35)
                    }
                    if hasMore && !transactions.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, TTSpacing.lg)
                            .onAppear { Task { await loadMore() } }
                    }
                }
            }
        }
    }

    private func transactionRow(_ tx: WalletTransaction) -> some View {
        let value = tx.amountPrecise.flatMap(Double.init) ?? Double(tx.amount)
        return HStack(alignment: .top, spacing: TTSpacing.md) {
            Image(systemName: walletIcon(for: tx.transactionType))
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(tx.description.isEmpty ? tx.transactionType : tx.description)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                Text(RelativeTime.format(tx.createdAt) ?? tx.createdAt)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer()
            Text(amountText(tx))
                .font(.tt.bodySemibold)
                .foregroundStyle(value > 0 ? .tt.textSuccess : (value < 0 ? .tt.textCritical : .tt.textSecondary))
        }
        .padding(.vertical, TTSpacing.md)
    }

    private func reload() async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        offset = 0
        hasMore = true
        do {
            async let walletResult: WalletInfo = APIClient.shared.get(path: Endpoints.Wallet.organizationWallet(organizationId))
            let page: TransactionsResponse = try await APIClient.shared.get(
                path: Endpoints.Wallet.organizationTransactions(organizationId),
                query: ["limit": "\(pageSize)", "offset": "0", "order_by": "-created_at"]
            )
            wallet = try await walletResult
            transactions = page.transactions
            offset = page.transactions.count
            hasMore = page.transactions.count >= pageSize && offset < page.total
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard !isLoadingMore, hasMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page: TransactionsResponse = try await APIClient.shared.get(
                path: Endpoints.Wallet.organizationTransactions(organizationId),
                query: ["limit": "\(pageSize)", "offset": "\(offset)", "order_by": "-created_at"]
            )
            transactions.append(contentsOf: page.transactions)
            offset += page.transactions.count
            hasMore = page.transactions.count >= pageSize && offset < page.total
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func amountText(_ tx: WalletTransaction) -> String {
        let formatted = WorkspaceNumberFormat.formatCredits(tx.amountPrecise, fallback: tx.amount)
        let value = tx.amountPrecise.flatMap(Double.init) ?? Double(tx.amount)
        return value > 0 ? "+\(formatted)" : formatted
    }

    private func walletIcon(for type: String) -> String {
        switch type {
        case "recharge": return "arrow.down.circle.fill"
        case "consume": return "arrow.up.circle.fill"
        case "refund": return "arrow.uturn.backward.circle.fill"
        case "grant": return "gift.fill"
        case "freeze", "unfreeze": return "lock.fill"
        case "expire": return "clock.fill"
        default: return "circle.fill"
        }
    }

}

struct WorkspaceUsageScreen: View {
    let organizationId: String

    @State private var dashboard: UsageDashboardData?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var refreshVersion = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                if let errorMessage, dashboard == nil {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                }
                if let dashboard {
                    overviewCard(dashboard)
                    meterSection(dashboard)
                    modelSection(dashboard)
                } else if !isLoading {
                    ContentUnavailableView(L10n.Workspace.usageEmpty, systemImage: "chart.pie")
                }
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle(L10n.Workspace.usageTitle)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .ttTabBarHidden(true)
        .refreshable { await load() }
        .task(id: refreshVersion) { await load() }
        .onReceive(NotificationCenter.default.publisher(for: BillingEventHandler.refreshNotification)) { _ in
            refreshVersion &+= 1
        }
        .ttLoading(isLoading && dashboard == nil)
    }

    private func overviewCard(_ data: UsageDashboardData) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text(L10n.Workspace.usageCurrentMonth)
                .font(.tt.metaSemibold)
                .foregroundStyle(.tt.textSecondary)
            Text(formatCreditsWithUnit(data.currentMonthTotalCredits))
                .font(.tt.iconEmptySemibold)
                .foregroundStyle(.tt.textPrimary)
            Text("\(L10n.Workspace.usageLastMonth) \(formatCreditsWithUnit(data.lastMonthTotalCredits))")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
            if let pct = data.monthOverMonthPct {
                Label("\(L10n.Workspace.usageMonthOverMonth) \(String(format: "%.1f%%", abs(pct)))", systemImage: pct >= 0 ? "arrow.up.right" : "arrow.down.right")
                    .font(.tt.meta)
                    .foregroundStyle(pct > 0 ? .tt.textCritical : (pct < 0 ? .tt.textSuccess : .tt.textSecondary))
            }
            if let today = data.todayTotalCredits {
                Divider().opacity(0.35)
                Text("今日 \(formatCreditsWithUnit(today))")
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
            }
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous).fill(.tt.bgSubtle))
    }

    private func meterSection(_ data: UsageDashboardData) -> some View {
        let total = data.byMeter.reduce(0) { $0 + parseCredits($1.totalCredits) }
        return VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text(L10n.Workspace.usageMeterDistribution)
                .font(.tt.bodySemibold)
            if data.byMeter.isEmpty {
                Text(L10n.Workspace.usageEmpty)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            } else {
                ForEach(data.byMeter, id: \.meterKey) { row in
                    usageBar(title: displayMeter(row.meterKey), value: row.totalCredits, total: total)
                }
            }
        }
    }

    private func modelSection(_ data: UsageDashboardData) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            Text(L10n.Workspace.usageModelTop)
                .font(.tt.bodySemibold)
            if data.byModel.isEmpty {
                Text(L10n.Workspace.usageModelEmpty)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            } else {
                ForEach(Array(data.byModel.prefix(UsageDashboardPresentation.modelRankLimit).enumerated()), id: \.offset) { _, row in
                    HStack(spacing: TTSpacing.md) {
                        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                            Text(row.modelName)
                                .font(.tt.body)
                                .foregroundStyle(.tt.textPrimary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let callCount = row.callCount {
                                Text(L10n.Workspace.usageCallCount(callCount))
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Spacer()
                        Text(formatCreditsWithUnit(row.totalCredits))
                            .font(.tt.metaSemibold)
                            .foregroundStyle(.tt.textSecondary)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .padding(.vertical, TTSpacing.xs)
                }
            }
        }
    }

    private func usageBar(title: String, value: String, total: Double) -> some View {
        let number = parseCredits(value)
        let pct = total > 0 ? min(1, number / total) : 0
        return VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack {
                Text(title)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                Spacer()
                Text(formatCreditsWithUnit(value))
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textSecondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.tt.bgSubtle)
                    Capsule()
                        .fill(.tt.bgAccent.opacity(0.45))
                        .frame(width: max(4, geo.size.width * pct))
                }
            }
            .frame(height: 6)
        }
        .padding(.vertical, TTSpacing.sm)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            dashboard = try await APIClient.shared.get(
                path: Endpoints.Billing.usageDashboard(organizationId: organizationId),
                query: ["days": "30"]
            )
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func parseCredits(_ raw: String) -> Double {
        Double(raw) ?? 0
    }

    private func formatCredits(_ raw: String) -> String {
        WorkspaceNumberFormat.formatUsageCredits(raw)
    }

    private func formatCreditsWithUnit(_ raw: String) -> String {
        L10n.Workspace.usageCredits(formatCredits(raw))
    }

    private func displayMeter(_ key: String) -> String {
        switch key {
        case "llm.tokens": return "LLM"
        case "storage.gb_day", "storage.bytes": return "存储"
        default:
            return key.replacingOccurrences(of: "_", with: " ")
        }
    }
}

struct WorkspaceTransferOwnershipSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var workspace = WorkspaceStore.shared
    @State private var selectedUserId: String?
    @State private var showConfirm = false
    @State private var errorMessage: String?

    let organizationId: String

    /// 可选新所有者：除自己（owner）外的成员（对齐 Android TransferOwnershipDialog 成员单选）。
    private var candidates: [OrganizationMember] {
        workspace.members.filter { $0.role != .owner }
    }

    private var selectedMember: OrganizationMember? {
        candidates.first { $0.userId == selectedUserId }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("选择新所有者") {
                    if workspace.isLoadingMembers && candidates.isEmpty {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(L10n.Common.loading)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                        }
                    } else if candidates.isEmpty {
                        Text("暂无可转让的成员")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    } else {
                        ForEach(candidates) { member in
                            Button {
                                selectedUserId = member.userId
                            } label: {
                                HStack(spacing: TTSpacing.md) {
                                    Image(systemName: selectedUserId == member.userId ? "largecircle.fill.circle" : "circle")
                                        .foregroundStyle(selectedUserId == member.userId ? .tt.iconAccent : .tt.textTertiary)
                                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                        Text(member.displayName)
                                            .font(.tt.body)
                                            .foregroundStyle(.tt.textPrimary)
                                        Text(member.subtitle ?? member.role.title)
                                            .font(.tt.meta)
                                            .foregroundStyle(.tt.textTertiary)
                                    }
                                    Spacer()
                                }
                            }
                        }
                    }
                }
                Section {
                    Text("转让后，你将不再是该组织所有者。这个操作风险较高，请确认目标成员无误。")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.tt.textCritical)
                    }
                }
            }
            .ttSettingsDetailFormStyle()
            .navigationTitle(L10n.Workspace.transferOwnership)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("转让") { showConfirm = true }
                        .disabled(selectedUserId == nil || workspace.isMutating)
                }
            }
            .task {
                if workspace.members.isEmpty {
                    await workspace.loadMembers(organizationId: organizationId)
                }
            }
            .alert("确认转让所有权？", isPresented: $showConfirm) {
                Button("转让", role: .destructive) {
                    Task { await transfer() }
                }
                Button(L10n.Common.cancel, role: .cancel) {}
            } message: {
                Text("组织所有权会立即移交给「\(selectedMember?.displayName ?? "")」。")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func transfer() async {
        errorMessage = nil
        guard let userId = selectedUserId else { return }
        if await workspace.transferOwnership(organizationId: organizationId, newOwnerUserId: userId) {
            dismiss()
        } else {
            errorMessage = workspace.errorMessage ?? "转让失败"
        }
    }
}

/// 团队设置 → AI 能力：模型列表（点选设默认）+ 工具开关（对齐 Android AICapabilitiesTab）。
struct WorkspaceCapabilitiesScreen: View {
    @State private var workspace = WorkspaceStore.shared
    let organization: Organization

    @State private var models: [ChatModel] = []
    @State private var defaultModelId: String?
    @State private var enableTools: Bool
    @State private var isLoading = false
    @State private var isMutating = false
    @State private var errorMessage: String?

    init(organization: Organization) {
        self.organization = organization
        _enableTools = State(initialValue: organization.settings?.enableTools ?? true)
    }

    private var canManage: Bool { workspace.canManage }

    var body: some View {
        List {
            Section("工具能力") {
                Toggle("允许 Agent 使用工具", isOn: $enableTools)
                    .disabled(!canManage || isMutating)
                    .onChange(of: enableTools) { _, newValue in
                        Task { await saveEnableTools(newValue) }
                    }
                Text("关闭后，该组织的 Agent 将不能调用工具（终端、文件、浏览器等）。")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }

            Section("默认模型") {
                if isLoading && models.isEmpty {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(L10n.Common.loading)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                } else if models.isEmpty {
                    Text("暂无可用模型")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                } else {
                    ForEach(models) { model in
                        Button {
                            guard canManage, model.id != defaultModelId else { return }
                            Task { await setDefaultModel(model) }
                        } label: {
                            HStack(spacing: TTSpacing.md) {
                                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                    Text(model.displayName)
                                        .font(.tt.body)
                                        .foregroundStyle(.tt.textPrimary)
                                    if !model.provider.isEmpty {
                                        Text(model.provider)
                                            .font(.tt.meta)
                                            .foregroundStyle(.tt.textTertiary)
                                    }
                                }
                                Spacer()
                                if model.id == defaultModelId {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tt.iconAccent)
                                }
                            }
                        }
                        .disabled(!canManage || isMutating)
                    }
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.tt.textCritical) }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Workspace.capabilitiesTitle)
        .navigationBarTitleDisplayMode(.inline)
        .ttLoading(isMutating)
        .task { await loadModels() }
        .refreshable { await loadModels() }
    }

    private func loadModels() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let resp: ChatModelListResponse = try await APIClient.shared.get(
                path: Endpoints.LLM.organizationModels(organization.id)
            )
            models = resp.models
            defaultModelId = resp.defaultModelId ?? resp.models.first(where: { $0.isDefault })?.id
        } catch {
            guard !error.isCancellation else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func setDefaultModel(_ model: ChatModel) async {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let _: ApiEnvelope<String?> = try await APIClient.shared.put(
                path: Endpoints.LLM.organizationDefaultModel(organization.id),
                body: ["model_id": model.id]
            )
            defaultModelId = model.id
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveEnableTools(_ newValue: Bool) async {
        guard newValue != (organization.settings?.enableTools ?? true) || errorMessage != nil else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            _ = try await workspace.updateOrganizationSettings(id: organization.id, enableTools: newValue)
        } catch {
            errorMessage = error.localizedDescription
            enableTools = !newValue
        }
    }
}

private struct WorkspaceMemberAvatar: View {
    let name: String
    let imageURL: URL?

    var body: some View {
        Group {
            if let imageURL {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        placeholder
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
            Circle().fill(.tt.bgAccent.opacity(0.14))
            Text(IdentityAvatar.initials(name))
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textAccent)
        }
    }
}

private struct WorkspaceRoleBadge: View {
    let role: OrganizationRole

    var body: some View {
        Text(role.title)
            .font(.tt.metaSemibold)
            .foregroundStyle(color)
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xxs)
            .background(Capsule().fill(color.opacity(0.12)))
    }

    private var color: Color {
        switch role {
        case .owner: return .tt.textAccent
        case .admin: return .tt.textWarning
        case .editor: return .tt.textSecondary
        case .viewer: return .tt.textTertiary
        case .unknown: return .tt.textDisabled
        }
    }
}
