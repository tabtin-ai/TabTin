import SwiftUI
import UIKit

/// 阻断类 HITL 面板宿主：根据 `coordinator.pending` 渲染对应面板，悬浮在 Composer 之上。
/// 无 pending 时不渲染。plan / mode_switch 不走这里（inline 卡）。
struct HITLPanelHost: View {
    @Bindable var coordinator: HITLCoordinator

    var body: some View {
        if let pending = coordinator.pending {
            if coordinator.canResolvePending, let approval = ApprovalHost.context(for: pending) {
                // Dock 自带圆角容器与外边距，这里不再叠 host 的整块底色与顶部分隔线。
                VStack(spacing: 0) {
                    errorBanner
                    ApprovalDock(
                        request: approval.request,
                        coordinator: coordinator,
                        actionApprovalId: approval.actionApprovalId
                    )
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                VStack(spacing: 0) {
                    errorBanner
                    if coordinator.canResolvePending {
                        content(for: pending)
                    } else {
                        TeamSpaceReadonlyHITLPanel(
                            ownerName: coordinator.pendingExecutionOwnerDisplayName
                        )
                    }
                }
                .background(.tt.bgCanvasDefault)
                .overlay(alignment: .top) { Divider().overlay(.tt.borderLight) }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = coordinator.submitError {
            HStack(spacing: TTSpacing.sm) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textCritical)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    coordinator.dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.tt.iconCaptionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭")
            }
            .padding(.horizontal, TTSpacing.lg)
            .padding(.vertical, TTSpacing.xs)
        }
    }

    @ViewBuilder
    private func content(for pending: HITLPrompt) -> some View {
        switch pending {
        case .approvalBatch, .actionApproval:
            // 审批走 Dock 分支（见 body），这里不重复渲染。
            EmptyView()
        case let .askUser(p):
            AskUserPanel(request: p, coordinator: coordinator)
        case let .askForm(p):
            AskFormPanel(request: p, coordinator: coordinator)
        case let .requestApproval(p):
            RequestApprovalPanel(request: p, coordinator: coordinator)
        case .planProposal, .modeSwitch:
            EmptyView()
        }
    }
}

/// Project 里的 HITL 只能由本轮执行负责人处理。其他成员不展示问题、表单、工具参数或
/// 操作按钮，只保留明确的等待状态；处理结果会通过同一会话实时同步。
private struct TeamSpaceReadonlyHITLPanel: View {
    let ownerName: String?

    private var ownerLabel: String {
        let trimmed = ownerName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "执行负责人" : trimmed
    }

    var body: some View {
        HITLContainer(title: "等待执行负责人处理", subtitle: nil) {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                Image(systemName: "hourglass")
                    .font(.tt.iconBodyMedium)
                    .foregroundStyle(.tt.iconAccent)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text("仅\(ownerLabel)可处理这项请求，你可以等待结果。")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                    Text("处理完成后，Agent 会继续执行，结果将同步到当前会话。")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(TTSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        } actions: {
            EmptyView()
        }
    }
}

// MARK: - 审批：Dock（收起态）+ Sheet（展开态）

/// 审批提案的取值口。新版 batch 与旧版 action 审批复用同一套 UI，差异只在提交通道，
/// 这里把它收敛成一个可选的 `actionApprovalId`，让视图层不必再分辨事件来源。
private enum ApprovalHost {
    static func context(
        for prompt: HITLPrompt
    ) -> (request: ApprovalRequested, actionApprovalId: String?)? {
        switch prompt {
        case let .approvalBatch(request):
            return (request, nil)
        case let .actionApproval(request):
            return (request.displayRequest, request.approvalId)
        case .askUser, .askForm, .requestApproval, .planProposal, .modeSwitch:
            return nil
        }
    }
}

/// 整批审批的严重度：决定行首图标与风险色。
/// 低风险不使用成功色——风险分级低不等于我们担保它安全。
private enum ApprovalSeverity {
    case critical
    case warning
    case neutral

    static func resolve(_ actions: [ApprovalRequestedPayloadActionRequestsItem]) -> ApprovalSeverity {
        var resolved = ApprovalSeverity.neutral
        for action in actions {
            let zone = ApprovalPresentation.workspaceZone(for: action.decisionReason)
            if action.riskLevel == .high || zone == "sensitive" { return .critical }
            if action.riskLevel == .medium || zone == "outside" { resolved = .warning }
        }
        return resolved
    }

    var iconColor: Color {
        switch self {
        case .critical: return Color.tt.textCritical
        case .warning: return Color.tt.textWarning
        case .neutral: return Color.tt.iconAccent
        }
    }

    /// 中性态用不带对勾的盾牌：这里要表达的是「需要你授权」，
    /// 而不是「我们已经检查过它是安全的」。
    var symbol: String {
        switch self {
        case .critical: return "exclamationmark.triangle.fill"
        case .warning: return "exclamationmark.shield.fill"
        case .neutral: return "shield"
        }
    }
}

/// Dock 副行要说的那一件事。
private enum ApprovalDockSubline {
    case command(String)
    case text(String)
    case empty
}

/// 审批的共享上下文：批内交集能力、过期判断、文案与提交入口。
/// Dock（收起态）与 Sheet（展开态）共用同一份，避免两处各算一遍导致口径漂移。
@MainActor
private struct ApprovalContext {
    let request: ApprovalRequested
    let coordinator: HITLCoordinator
    let actionApprovalId: String?

    var actions: [ApprovalRequestedPayloadActionRequestsItem] { request.actionRequests }

    /// Team Space 脱敏：不显示命令 / 路径 / 参数，也不给决策按钮。
    var isRedacted: Bool { request.hasRedactedTeamApprovalDetails }

    var severity: ApprovalSeverity { .resolve(actions) }

    // MARK: 批内交集

    var commonAllowedScopes: [String] {
        guard let first = request.actionRequests.first else { return ["once"] }
        var common = Set(first.allowedScopes.map(\.rawValue))
        for item in request.actionRequests.dropFirst() {
            common.formIntersection(Set(item.allowedScopes.map(\.rawValue)))
        }
        let ordered = ["once", "thread", "always"].filter { common.contains($0) }
        return ordered.isEmpty ? ["once"] : ordered
    }

    private var commonAllowedOutcomes: Set<String> {
        guard let first = request.actionRequests.first else { return ["allow", "deny"] }
        var common = Set(first.allowedOutcomes.map(\.rawValue))
        for item in request.actionRequests.dropFirst() {
            common.formIntersection(Set(item.allowedOutcomes.map(\.rawValue)))
        }
        return common.isEmpty ? ["allow", "deny"] : common
    }

    var canAllow: Bool { !isRedacted && commonAllowedOutcomes.contains("allow") }
    var canDeny: Bool { !isRedacted && commonAllowedOutcomes.contains("deny") }

    /// 收起态能否一键放行。高风险 / 敏感 / 工作区外 / 批量一律要求展开确认。
    var allowsDirectApproval: Bool {
        canAllow && ApprovalDockPolicy.allowsDirectApproval(actions)
    }

    var defaultScope: String {
        let suggested = request.actionRequests.first?.askHint?.suggestedScope.rawValue
        if let suggested, commonAllowedScopes.contains(suggested) { return suggested }
        return commonAllowedScopes.first ?? "once"
    }

    // MARK: 过期

    private var expiresAtDate: Date {
        let raw = request.expiresAt
        let seconds = raw > 1_000_000_000_000 ? raw / 1000 : raw
        return Date(timeIntervalSince1970: seconds)
    }

    func remainingSeconds(at now: Date) -> Int {
        guard request.expiresAt > 0 else { return Int.max }
        return max(0, Int(expiresAtDate.timeIntervalSince(now).rounded(.down)))
    }

    func isExpired(at now: Date) -> Bool {
        guard request.expiresAt > 0 else { return false }
        return remainingSeconds(at: now) <= 0
    }

    /// 紧迫感文案。位置与字号变了，口径与旧面板保持一致。
    func expiresHint(at now: Date) -> String? {
        guard request.expiresAt > 0 else { return nil }
        let remaining = remainingSeconds(at: now)
        if remaining <= 0 { return "请求已过期，请让 Agent 重新发起。" }
        if remaining < 60 { return "还剩 \(remaining) 秒，请尽快确认。" }
        if remaining < 30 * 60 { return "约 \((remaining + 30) / 60) 分钟后过期。" }
        return nil
    }

    /// 行首倒计时（mm:ss）。超过一小时只给粗粒度，避免抢注意力。
    func countdown(at now: Date) -> String? {
        guard request.expiresAt > 0 else { return nil }
        let remaining = remainingSeconds(at: now)
        guard remaining > 0 else { return nil }
        if remaining >= 3600 { return "\(remaining / 3600) 小时" }
        return String(format: "%d:%02d", remaining / 60, remaining % 60)
    }

    // MARK: 文案

    func dockTitle(at now: Date) -> String {
        if isExpired(at: now) { return "审批已过期" }
        if coordinator.isSubmitting { return "正在提交…" }
        if isRedacted { return RedactedApprovalDisplay.title }
        if actions.count == 1, let action = actions.first {
            return ToolPresentation.of(action.toolName).verb
        }
        return "需要确认"
    }

    /// 收起态只回答「做什么」：有命令就让命令自己说话，不再叠一行摘要。
    var dockSubline: ApprovalDockSubline {
        guard !isRedacted else { return .empty }
        guard actions.count == 1, let action = actions.first else {
            return .text("\(actions.count) 个操作待确认")
        }
        let layout = ApprovalPresentation.layout(from: action.toolInput)
        if let command = layout.command { return .command(command.value) }
        if let primary = layout.primaryRows.first { return .text(primary.value) }
        if let summary = action.askHint?.summary,
           !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .text(summary)
        }
        return .empty
    }

    var sheetTitle: String {
        isRedacted ? RedactedApprovalDisplay.title : "需要你的批准"
    }

    var sheetSubtitle: String {
        isRedacted ? "正在等待 Owner 处理" : "\(actions.count) 个操作"
    }

    // MARK: 提交

    /// wire 契约不变：batch 走 `submitApprovalBatch`，旧 action 审批走 `submitActionApproval`。
    func submit(outcome: String, scope: String, rejectReason: String) {
        // 只确认「按下了」，不预告结果——提交是异步的，成功与否要等 coordinator 回来。
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let promptId = actionApprovalId.map { "action_approval:\($0)" }
            ?? "approval:\(request.batchId)"
        Task {
            await coordinator.submitApprovalDecision(
                promptId: promptId,
                outcome: outcome,
                scope: outcome == "allow" ? scope : nil,
                rejectionMessage: outcome == "deny"
                    ? rejectReason.trimmingCharacters(in: .whitespacesAndNewlines)
                    : nil
            )
        }
    }
}

/// 收起态授权栏：贴在 Composer 上方，一眼给「做什么 / 什么命令 / 还剩多久」。
/// 只有单条、非高风险、工作区内的请求才允许在这里直接批准。
@MainActor
private struct ApprovalDock: View {
    let request: ApprovalRequested
    let coordinator: HITLCoordinator
    let actionApprovalId: String?

    @State private var now = Date()
    @State private var scope = "once"
    @State private var isSheetPresented = false
    @State private var sheetOpensRejectReason = false

    private var context: ApprovalContext {
        ApprovalContext(
            request: request,
            coordinator: coordinator,
            actionApprovalId: actionApprovalId
        )
    }

    var body: some View {
        let context = self.context
        let expired = context.isExpired(at: now)

        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            header(context: context, expired: expired)
            subline(context: context, expired: expired)
            actionRow(context: context, expired: expired)
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgCanvasDefault, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay {
            RoundedRectangle(cornerRadius: TTRadius.md)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.xs)
        .contentShape(Rectangle())
        .onTapGesture {
            // 脱敏态没有决策按钮，整块可点开详情看等待说明。
            if context.isRedacted { isSheetPresented = true }
        }
        .onAppear { scope = context.defaultScope }
        .task {
            guard request.expiresAt > 0 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                now = Date()
            }
        }
        .sheet(isPresented: $isSheetPresented) {
            ApprovalDetailSheet(
                context: context,
                scope: $scope,
                startsWithRejectReason: sheetOpensRejectReason,
                onClose: { isSheetPresented = false }
            )
        }
    }

    private func header(context: ApprovalContext, expired: Bool) -> some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: expired ? "hourglass" : context.severity.symbol)
                .font(.tt.iconSubtitleMedium)
                .foregroundStyle(expired ? Color.tt.textTertiary : context.severity.iconColor)
            Text(context.dockTitle(at: now))
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
            Spacer(minLength: TTSpacing.sm)
            if !expired, let countdown = context.countdown(at: now) {
                Text(countdown)
                    .font(.tt.meta)
                    .monospacedDigit()
                    .foregroundStyle(
                        context.remainingSeconds(at: now) < 30
                            ? Color.tt.textCritical
                            : Color.tt.textTertiary
                    )
            }
        }
    }

    @ViewBuilder
    private func subline(context: ApprovalContext, expired: Bool) -> some View {
        if expired {
            Text("请求已过期，让 Agent 重新发起即可。")
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
        } else if context.isRedacted {
            Text(RedactedApprovalDisplay.waitingMessage)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(2)
        } else {
            switch context.dockSubline {
            case let .command(command):
                ApprovalInlineCommand(command: command)
            case let .text(text):
                Text(text)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)
            case .empty:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func actionRow(context: ApprovalContext, expired: Bool) -> some View {
        let isSubmitting = coordinator.isSubmitting
        if context.isRedacted {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "hourglass")
                    .font(.tt.iconBodyMedium)
                    .foregroundStyle(.tt.iconAccent)
                Text("等待 Owner 审批")
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }
        } else if expired {
            ApprovalDecisionButton(title: "关闭", kind: .secondary, fillsWidth: true) {
                coordinator.dismiss()
            }
        } else if context.allowsDirectApproval {
            HStack(spacing: TTSpacing.sm) {
                ApprovalDecisionButton(title: "查看详情", kind: .secondary, isDisabled: isSubmitting) {
                    sheetOpensRejectReason = false
                    isSheetPresented = true
                }
                ApprovalDecisionButton(
                    title: isSubmitting ? "提交中…" : "批准",
                    kind: .primary,
                    isLoading: isSubmitting,
                    fillsWidth: true
                ) {
                    context.submit(outcome: "allow", scope: scope, rejectReason: "")
                }
            }
        } else {
            HStack(spacing: TTSpacing.sm) {
                if context.canDeny {
                    ApprovalDecisionButton(title: "拒绝", kind: .destructive, isDisabled: isSubmitting) {
                        // 两步拒绝：先展开理由输入，再在 Sheet 里「确认拒绝」。
                        sheetOpensRejectReason = true
                        isSheetPresented = true
                    }
                }
                ApprovalDecisionButton(
                    title: isSubmitting ? "提交中…" : "查看并确认",
                    kind: .primary,
                    isLoading: isSubmitting,
                    fillsWidth: true
                ) {
                    sheetOpensRejectReason = false
                    isSheetPresented = true
                }
            }
        }
    }
}

/// 展开态详情面板：每条操作一张卡，底部固定授权范围与决策按钮。
@MainActor
private struct ApprovalDetailSheet: View {
    let context: ApprovalContext
    @Binding var scope: String
    let onClose: () -> Void

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var now = Date()
    @State private var showRejectReason: Bool
    @State private var rejectReason = ""

    init(
        context: ApprovalContext,
        scope: Binding<String>,
        startsWithRejectReason: Bool,
        onClose: @escaping () -> Void
    ) {
        self.context = context
        self._scope = scope
        self.onClose = onClose
        self._showRejectReason = State(initialValue: startsWithRejectReason)
    }

    var body: some View {
        let expired = context.isExpired(at: now)

        VStack(spacing: 0) {
            header(expired: expired)
            Divider().overlay(.tt.borderLight)
            scrollBody(expired: expired)
            footer(expired: expired)
        }
        // iPad / 横屏：限宽居中，行长回到可读区间，而不是单行跨满屏。
        .frame(maxWidth: horizontalSizeClass == .regular ? 560 : .infinity)
        .frame(maxWidth: .infinity)
        .background(.tt.bgCanvasDefault)
        // iPad 上 form sheet 已经是限宽浮层，再给 medium 档会显得空；对齐 ConversationMenuActions 的做法。
        .presentationDetents(horizontalSizeClass == .regular ? [.large] : [.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            guard context.request.expiresAt > 0 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                now = Date()
            }
        }
    }

    private func header(expired: Bool) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: expired ? "hourglass" : context.severity.symbol)
                .font(.tt.iconSubtitleMedium)
                .foregroundStyle(expired ? Color.tt.textTertiary : context.severity.iconColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(expired ? "审批已过期" : context.sheetTitle)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text(context.sheetSubtitle)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer(minLength: 0)
            if !expired, let countdown = context.countdown(at: now) {
                Text(countdown)
                    .font(.tt.meta)
                    .monospacedDigit()
                    .foregroundStyle(
                        context.remainingSeconds(at: now) < 30
                            ? Color.tt.textCritical
                            : Color.tt.textTertiary
                    )
            }
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.top, TTSpacing.sm)
        .padding(.bottom, TTSpacing.md)
    }

    private func scrollBody(expired: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                if let hint = context.expiresHint(at: now) {
                    Text(hint)
                        .font(.tt.meta)
                        .foregroundStyle(expired ? Color.tt.textCritical : Color.tt.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(context.actions.enumerated()), id: \.element.requestId) { index, item in
                    ApprovalActionCard(item: item, index: index, total: context.actions.count)
                }
            }
            .padding(.horizontal, TTSpacing.lg)
            .padding(.vertical, TTSpacing.md)
        }
    }

    @ViewBuilder
    private func footer(expired: Bool) -> some View {
        let isSubmitting = context.coordinator.isSubmitting
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            if !expired, context.canAllow, context.commonAllowedScopes.count > 1 {
                VStack(spacing: TTSpacing.xs) {
                    ForEach(context.commonAllowedScopes, id: \.self) { value in
                        ApprovalScopeOption(scope: value, isSelected: scope == value) {
                            withAnimation(.easeInOut(duration: 0.15)) { scope = value }
                        }
                    }
                }
            }

            if showRejectReason, !expired, context.canDeny {
                TextField("拒绝理由（可选，会回传给 Agent）", text: $rejectReason, axis: .vertical)
                    .font(.tt.body)
                    .lineLimit(1...3)
                    .padding(TTSpacing.sm)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
            }

            if context.isRedacted {
                HStack(spacing: TTSpacing.xs) {
                    Image(systemName: "hourglass")
                        .font(.tt.iconBodyMedium)
                        .foregroundStyle(.tt.iconAccent)
                    Text("等待 Owner 审批")
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                    Spacer(minLength: 0)
                }
                .frame(height: 48)
            } else if expired {
                ApprovalDecisionButton(title: "关闭", kind: .secondary, fillsWidth: true) {
                    onClose()
                    context.coordinator.dismiss()
                }
            } else {
                HStack(spacing: TTSpacing.sm) {
                    if context.canDeny {
                        ApprovalDecisionButton(
                            title: showRejectReason ? "确认拒绝" : "拒绝",
                            kind: .destructive,
                            isDisabled: isSubmitting
                        ) {
                            if showRejectReason {
                                submit(outcome: "deny")
                            } else {
                                withAnimation(.easeInOut(duration: 0.15)) { showRejectReason = true }
                            }
                        }
                    }
                    if context.canAllow {
                        ApprovalDecisionButton(
                            title: isSubmitting ? "提交中…" : "批准",
                            kind: .primary,
                            isLoading: isSubmitting,
                            fillsWidth: true
                        ) {
                            submit(outcome: "allow")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.top, TTSpacing.sm)
        .padding(.bottom, TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgCanvasDefault)
        .overlay(alignment: .top) { Divider().overlay(.tt.borderLight) }
    }

    private func submit(outcome: String) {
        context.submit(outcome: outcome, scope: scope, rejectReason: rejectReason)
        onClose()
    }
}

/// 单条操作卡：标题 + 命令块 + 最多两个关键字段 + 最多一行风险提示，其余进折叠。
private struct ApprovalActionCard: View {
    let item: ApprovalRequestedPayloadActionRequestsItem
    let index: Int
    let total: Int

    @State private var isExpanded = false

    private var workspaceZone: String? {
        ApprovalPresentation.workspaceZone(for: item.decisionReason)
    }

    private var severity: ApprovalSeverity { .resolve([item]) }

    /// 摘要只留一句：`ask_hint.summary` 优先，缺失才退回 `explanation`，避免两段重复小字。
    private var summary: String? {
        if let summary = item.askHint?.summary,
           !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return summary
        }
        return ApprovalPresentation.explanation(from: item.toolInput)
    }

    private var fullToolName: String {
        guard let namespace = item.toolNamespace, !namespace.isEmpty else { return item.toolName }
        return "\(namespace).\(item.toolName)"
    }

    var body: some View {
        let layout = item.isRedactedTeamApproval
            ? ApprovalActionLayout.empty
            : ApprovalPresentation.layout(from: item.toolInput)
        let riskHint = item.isRedactedTeamApproval
            ? nil
            : ApprovalPresentation.riskHint(level: item.riskLevel, workspaceZone: workspaceZone)

        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            head

            if item.isRedactedTeamApproval {
                Text(RedactedApprovalDisplay.waitingMessage)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if let command = layout.command {
                    ApprovalCommandBlock(command: command.value)
                }
                if !layout.primaryRows.isEmpty {
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        ForEach(layout.primaryRows) { ApprovalFieldRow(row: $0) }
                    }
                }
                if let riskHint {
                    ApprovalRiskRow(hint: riskHint)
                }
                disclosure(layout: layout)
            }
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private var head: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            if item.isRedactedTeamApproval {
                Image(systemName: "hourglass")
                    .font(.tt.iconSubtitleMedium)
                    .foregroundStyle(.tt.iconAccent)
                    .frame(width: 20, height: 20)
            } else {
                ElectronChatIcon(
                    name: ToolPresentation.of(item.toolName).icon,
                    size: 16,
                    color: severity == .critical ? Color.tt.textCritical : Color.tt.iconAccent
                )
                .frame(width: 20, height: 20)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(item.isRedactedTeamApproval
                    ? RedactedApprovalDisplay.title
                    : ToolPresentation.of(item.toolName).verb)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                if !item.isRedactedTeamApproval, let summary {
                    Text(summary)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: TTSpacing.xs)

            if total > 1 {
                Text("\(index + 1)/\(total)")
                    .font(.tt.meta)
                    .monospacedDigit()
                    .foregroundStyle(.tt.textTertiary)
            }
            // 低风险不再显示胶囊：风险分级低不等于我们担保它安全。
            if !item.isRedactedTeamApproval, let level = item.riskLevel, level != .low {
                RiskBadge(level: level.rawValue)
            }
        }
    }

    @ViewBuilder
    private func disclosure(layout: ApprovalActionLayout) -> some View {
        let reason = ApprovalReasonCopy.text(for: item.decisionReason)
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: TTSpacing.xxs) {
                    Text(isExpanded ? "收起" : "完整参数")
                        .font(.tt.meta)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.tt.iconCaptionMedium)
                }
                .foregroundStyle(.tt.textAccent)
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    if let reason {
                        ApprovalFieldRow(row: ApprovalParameterRow(
                            key: "__reason", label: "原因", value: reason, style: .text
                        ))
                    }
                    ApprovalFieldRow(row: ApprovalParameterRow(
                        key: "__tool", label: "工具", value: fullToolName, style: .code
                    ))
                    ForEach(layout.collapsedRows) { ApprovalFieldRow(row: $0) }
                }
            }
        }
    }
}

/// Dock 的单行命令：不换行、可横滑，右侧渐隐提示还有内容。
private struct ApprovalInlineCommand: View {
    let command: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(command)
                .font(.tt.codeSM)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.sm)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .overlay(alignment: .trailing) {
            LinearGradient(
                colors: [Color.tt.bgSubtle.opacity(0), Color.tt.bgSubtle],
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(width: 24)
            .allowsHitTesting(false)
        }
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm))
    }
}

/// Sheet 里的命令块：独立底色 + 右上角拷贝，超高时内部滚动。
private struct ApprovalCommandBlock: View {
    let command: String

    @State private var didCopy = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.vertical, showsIndicators: false) {
                Text(command)
                    .font(.tt.codeSM)
                    .foregroundStyle(.tt.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, 28)
            }
            .frame(maxHeight: 120)
            .padding(TTSpacing.sm)

            Button {
                UIPasteboard.general.string = command
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                withAnimation(.easeInOut(duration: 0.15)) { didCopy = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    withAnimation(.easeInOut(duration: 0.15)) { didCopy = false }
                }
            } label: {
                Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(didCopy ? Color.tt.textSuccess : Color.tt.textSecondary)
                    .frame(width: 28, height: 28)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.xs))
            }
            .buttonStyle(.plain)
            .padding(TTSpacing.xs)
            .accessibilityLabel("拷贝命令")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgCanvasDefault, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }
}

private struct ApprovalFieldRow: View {
    let row: ApprovalParameterRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: TTSpacing.sm) {
            Text(row.label)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
                .frame(minWidth: 44, alignment: .leading)
            Text(row.value)
                .font(row.style == .text ? .tt.body : .tt.codeSM)
                .foregroundStyle(.tt.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}

private struct ApprovalRiskRow: View {
    let hint: ApprovalRiskHint

    private var color: Color {
        hint.emphasis == .critical ? Color.tt.textCritical : Color.tt.textWarning
    }

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: hint.emphasis == .critical
                ? "exclamationmark.triangle.fill"
                : "exclamationmark.circle")
                .font(.tt.iconBodyMedium)
                .foregroundStyle(color)
            Text(hint.text)
                .font(.tt.body)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }
}

/// 授权范围选项：纵向可点行，只有选中项展开一句后果说明。
private struct ApprovalScopeOption: View {
    let scope: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .font(.tt.iconBodyMedium)
                    .foregroundStyle(isSelected ? Color.tt.iconAccent : Color.tt.textTertiary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ApprovalScopePresentation.label(scope))
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                    if isSelected {
                        Text(ApprovalScopePresentation.consequence(scope))
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(TTSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .fill(isSelected ? Color.tt.bgReasoning : Color.clear)
            )
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .strokeBorder(isSelected ? Color.tt.borderFocused : Color.tt.borderLight, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// 决策按钮：48pt 触达，正文同档字号——最不该抢注意力的控件不再用系统 17pt。
private struct ApprovalDecisionButton: View {
    enum Kind {
        case primary
        case secondary
        case destructive
    }

    let title: String
    var kind: Kind = .secondary
    var isLoading = false
    var isDisabled = false
    var fillsWidth = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: TTSpacing.xs) {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(foregroundColor)
                }
                Text(title)
                    .font(.tt.bodySemibold)
                    .lineLimit(1)
            }
            .foregroundStyle(foregroundColor)
            .padding(.horizontal, TTSpacing.lg)
            .frame(maxWidth: fillsWidth ? .infinity : nil)
            .frame(height: 48)
            .background(backgroundColor, in: RoundedRectangle(cornerRadius: TTRadius.md))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || isLoading)
        .opacity(isDisabled || isLoading ? 0.5 : 1)
    }

    private var foregroundColor: Color {
        switch kind {
        case .primary: return Color.tt.textOnAccent
        case .secondary: return Color.tt.textSecondary
        case .destructive: return Color.tt.textCritical
        }
    }

    private var backgroundColor: Color {
        switch kind {
        case .primary: return Color.tt.bgAccent
        case .secondary: return Color.tt.bgSubtle
        case .destructive: return Color.tt.bgCritical.opacity(0.12)
        }
    }
}

/// 判决理由文案。只出现在「完整参数」折叠里——它解释「为什么问你」，不参与决策视线。
private enum ApprovalReasonCopy {
    static func text(
        for reason: ApprovalRequestedPayloadActionRequestsItemDecisionReason
    ) -> String? {
        switch reason {
        case .hardlineBlock:
            return "命中高危规则，默认阻止。"
        case .hardlineConfirm:
            return "命中高危规则，需要你确认后才能继续。"
        case .skillNotApproved:
            return "Skill 尚未授权，需要确认权限。"
        case .skillTrustDowngrade:
            return "Skill 信任级别变化，需要重新确认。"
        case .denyReadPath(let payload):
            return "读取路径受限：\(payload.path)"
        case .denyWritePath(let payload):
            return "写入路径受限：\(payload.path)"
        case .sandboxReadonly:
            return "当前环境是只读模式。"
        case .bashTooComplex:
            return "命令较复杂，无法安全自动判断。"
        case .bashParseUnavailable:
            return "命令解析不可用，需要人工确认。"
        case .memoizedAlways:
            return "命中已记住的始终授权规则。"
        case .memoizedThread:
            return "命中本会话内已记住的授权规则。"
        case .classifierLowConfidence:
            return "风险判断置信度较低，需要人工确认。"
        case .classifierDecided:
            return "风险分类器建议人工确认。"
        case .userInteractive:
            return "Agent 主动请求你的确认。"
        case .unknownTool:
            return "未知工具调用，需要确认。"
        case .ruleHighRiskAllowlistMiss:
            return "高风险动作未命中允许规则。"
        case .hardlineCommand(let payload):
            return "命中高危命令规则：\(payload.pattern)"
        case .hardlinePath(let payload):
            return "命中高危路径规则：\(payload.pattern)"
        case .sensitiveOutDeny(let payload):
            return "敏感路径默认拒绝：\(payload.path)"
        case .sensitiveInAsk(let payload):
            return "访问敏感路径：\(payload.path)"
        case .memoAllow(let payload):
            return payload.scopeDescription ?? "命中已允许的记忆规则。"
        case .memoDeny(let payload):
            return payload.scopeDescription ?? "命中已拒绝的记忆规则。"
        case .yoloAllow:
            return "超级权限模式下自动允许。"
        case .autoAllow:
            return "当前审批策略允许自动执行。"
        case .fullAccessAllow:
            return "完全访问模式下自动允许。"
        case .policyRiskAsk:
            return "命中风险策略，需要你确认后才能继续。"
        case .workspaceIn(let payload):
            return "工作区内路径：\(payload.path)"
        case .workspaceOut(let payload):
            return "工作区外路径：\(payload.path)"
        case .platformArtifactAllow:
            return "平台受管产物允许读取。"
        case .platformGateDeferred:
            return "操作已交由平台权限门禁确认。"
        case .destructiveInWorkspaceAsk:
            return "工作区内的破坏性操作需要确认。"
        case .objectDefaultAllow:
            return "对象读取类操作默认允许。"
        case .objectWriteAsk:
            return "对象写入类操作需要确认。"
        case .mcpDefaultAsk:
            return "MCP 工具调用需要确认。"
        case .deviceDefaultAsk:
            return "设备控制动作需要确认。"
        case .deviceObserveAllow:
            return "设备观察动作默认允许。"
        case .planBlocked:
            return "当前计划状态阻止自动执行。"
        case .fallbackAsk, .fallbackPreset, .operationSwitch, .planGuard:
            return "需要你确认后继续。"
        }
    }
}

// MARK: - AskUser

private struct AskUserPanel: View {
    let request: AskUserRequest
    let coordinator: HITLCoordinator
    @State private var selections: [String: Set<String>] = [:]
    @State private var freeText: [String: String] = [:]

    var body: some View {
        HITLContainer(title: request.title ?? "请选择", subtitle: nil) {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                ForEach(request.questions, id: \.id) { q in
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        if !q.header.isEmpty {
                            Text(q.header).font(.tt.bodySemibold).foregroundStyle(.tt.textPrimary)
                        }
                        if !q.prompt.isEmpty {
                            Text(q.prompt).font(.tt.meta).foregroundStyle(.tt.textSecondary)
                        }
                        FlowChips(
                            options: q.options,
                            selected: selections[q.id] ?? [],
                            onTap: { optionId in toggle(question: q, optionId: optionId) }
                        )
                        if AskUserAnswerDraft.isOtherSelected(selections[q.id] ?? []) {
                            TextField("输入自定义回答…", text: bindingFreeText(q.id), axis: .vertical)
                                .font(.tt.meta)
                                .lineLimit(1...3)
                                .padding(TTSpacing.sm)
                                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
                                .overlay(
                                    RoundedRectangle(cornerRadius: TTRadius.sm)
                                        .strokeBorder(.tt.borderLight, lineWidth: 1)
                                )
                        }
                    }
                }
            }
        } actions: {
            HStack(spacing: TTSpacing.sm) {
                Button("跳过") { Task { await coordinator.skipAskUser(requestId: request.requestId) } }
                    .buttonStyle(.bordered).tint(.tt.textSecondary)
                Button { submit() } label: { Text("提交").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(.tt.bgAccent)
                    .disabled(!canSubmit)
            }
            .disabled(coordinator.isSubmitting)
        }
    }

    private var canSubmit: Bool {
        request.questions.allSatisfy { q in
            AskUserAnswerDraft.canSubmit(
                question: q,
                selected: selections[q.id] ?? [],
                freeText: freeText[q.id] ?? ""
            )
        }
    }

    private func toggle(question q: AskUserRequestQuestionsItem, optionId: String) {
        var set = selections[q.id] ?? []
        if q.allowMultiple == true {
            if set.contains(optionId) { set.remove(optionId) } else { set.insert(optionId) }
        } else {
            set = set.contains(optionId) ? [] : [optionId]
        }
        selections[q.id] = set
        if !AskUserAnswerDraft.isOtherSelected(set) {
            freeText[q.id] = nil
        }
    }

    private func bindingFreeText(_ id: String) -> Binding<String> {
        Binding(get: { freeText[id] ?? "" }, set: { freeText[id] = $0 })
    }

    private func submit() {
        let answers = request.questions.map { q in
            AskUserAnswerDraft.answer(
                question: q,
                selected: selections[q.id] ?? [],
                freeText: freeText[q.id] ?? ""
            )
        }
        Task { await coordinator.submitAskUser(answers, requestId: request.requestId) }
    }
}

// MARK: - ask_form

private struct AskFormPanel: View {
    let request: HITLAskFormRequest
    let coordinator: HITLCoordinator
    @State private var textValues: [String: String] = [:]
    @State private var toggleValues: [String: Bool] = [:]
    @State private var singleSelect: [String: String] = [:]
    @State private var multiSelect: [String: Set<String>] = [:]

    var body: some View {
        HITLContainer(title: request.title, subtitle: nil) {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                ForEach(request.fields) { field in
                    fieldView(field)
                }
            }
        } actions: {
            HStack(spacing: TTSpacing.sm) {
                Button("跳过") {
                    Task { await coordinator.skipAskForm(requestId: request.requestId) }
                }
                .buttonStyle(.bordered)
                .tint(.tt.textSecondary)

                Button { submit() } label: {
                    Text(request.submitLabel ?? "提交").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)
                .disabled(!canSubmit || coordinator.isSubmitting)
            }
            .disabled(coordinator.isSubmitting)
        }
    }

    @ViewBuilder
    private func fieldView(_ field: HITLAskFormRequest.Field) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack(spacing: 2) {
                Text(field.label)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                if field.required {
                    Text("*")
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textCritical)
                }
            }
            if let desc = field.description, !desc.isEmpty {
                Text(desc).font(.tt.caption).foregroundStyle(.tt.textTertiary)
            }

            switch normalizedType(field.type) {
            case "toggle", "boolean", "bool", "checkbox":
                Toggle(isOn: toggleBinding(field.key)) {
                    Text(field.placeholder ?? "")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                }
                .tint(.tt.bgAccent)
            case "select", "radio":
                if field.options.isEmpty {
                    textInput(field, multiline: false)
                } else {
                    optionList(field, multiple: false)
                }
            case "multiselect", "multi_select", "checkboxes":
                if field.options.isEmpty {
                    textInput(field, multiline: false, placeholderSuffix: "，用逗号分隔")
                } else {
                    optionList(field, multiple: true)
                }
            case "tags":
                if field.options.isEmpty {
                    textInput(field, multiline: false, placeholderSuffix: "，用逗号分隔")
                } else {
                    optionList(field, multiple: true)
                }
            case "textarea", "long_text":
                textInput(field, multiline: true)
            case "number", "integer", "float":
                textInput(field, multiline: false)
                    .keyboardType(.decimalPad)
            default:
                textInput(field, multiline: false)
            }
        }
    }

    private func textInput(
        _ field: HITLAskFormRequest.Field,
        multiline: Bool,
        placeholderSuffix: String = ""
    ) -> some View {
        let placeholder = (field.placeholder ?? "") + placeholderSuffix
        return TextField(placeholder, text: textBinding(field.key), axis: multiline ? .vertical : .horizontal)
            .font(.tt.meta)
            .lineLimit(multiline ? 3...8 : 1...1)
            .padding(TTSpacing.sm)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .strokeBorder(.tt.borderLight, lineWidth: 1)
            )
    }

    private func optionList(_ field: HITLAskFormRequest.Field, multiple: Bool) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            ForEach(field.options) { option in
                let selected = multiple
                    ? (multiSelect[field.key]?.contains(option.id) == true)
                    : (singleSelect[field.key] == option.id)
                Button {
                    toggleOption(field.key, optionId: option.id, multiple: multiple)
                } label: {
                    HStack(spacing: TTSpacing.xs) {
                        Image(systemName: selected ? selectedIcon(multiple: multiple) : emptyIcon(multiple: multiple))
                            .foregroundStyle(selected ? .tt.iconAccent : .tt.textTertiary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.label).font(.tt.meta).foregroundStyle(.tt.textPrimary)
                            if let desc = option.description, !desc.isEmpty {
                                Text(desc).font(.tt.caption).foregroundStyle(.tt.textTertiary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(TTSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: TTRadius.sm)
                            .fill(selected ? .tt.bgReasoning : .tt.bgSubtle)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: TTRadius.sm)
                            .strokeBorder(selected ? .tt.borderFocused : .tt.borderLight, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private func selectedIcon(multiple: Bool) -> String {
        multiple ? "checkmark.square.fill" : "largecircle.fill.circle"
    }

    private func emptyIcon(multiple: Bool) -> String {
        multiple ? "square" : "circle"
    }

    private func toggleOption(_ key: String, optionId: String, multiple: Bool) {
        if multiple {
            var set = multiSelect[key] ?? []
            if set.contains(optionId) {
                set.remove(optionId)
            } else {
                set.insert(optionId)
            }
            multiSelect[key] = set
        } else {
            singleSelect[key] = singleSelect[key] == optionId ? "" : optionId
        }
    }

    private func textBinding(_ key: String) -> Binding<String> {
        Binding(get: { textValues[key] ?? "" }, set: { textValues[key] = $0 })
    }

    private func toggleBinding(_ key: String) -> Binding<Bool> {
        Binding(get: { toggleValues[key] ?? false }, set: { toggleValues[key] = $0 })
    }

    private var canSubmit: Bool {
        request.fields.allSatisfy { field in
            !field.required || isFilled(field)
        }
    }

    private func isFilled(_ field: HITLAskFormRequest.Field) -> Bool {
        switch normalizedType(field.type) {
        case "toggle", "boolean", "bool", "checkbox":
            return true
        case "select", "radio":
            if field.options.isEmpty { return hasText(field.key) }
            return !(singleSelect[field.key] ?? "").isEmpty
        case "multiselect", "multi_select", "checkboxes", "tags":
            if field.options.isEmpty { return hasText(field.key) }
            return !(multiSelect[field.key]?.isEmpty ?? true)
        default:
            return hasText(field.key)
        }
    }

    private func hasText(_ key: String) -> Bool {
        !(textValues[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        let fieldValues = buildFieldValues()
        Task { await coordinator.submitAskForm(fieldValues, requestId: request.requestId) }
    }

    private func buildFieldValues() -> [String: Any] {
        var out: [String: Any] = [:]
        for field in request.fields {
            switch normalizedType(field.type) {
            case "toggle", "boolean", "bool", "checkbox":
                out[field.key] = toggleValues[field.key] ?? false
            case "select", "radio":
                if field.options.isEmpty {
                    addTextValue(field, to: &out)
                } else if let value = singleSelect[field.key], !value.isEmpty {
                    out[field.key] = value
                }
            case "multiselect", "multi_select", "checkboxes":
                if field.options.isEmpty {
                    addDelimitedListValue(field, to: &out)
                } else {
                    let values = Array(multiSelect[field.key] ?? []).sorted()
                    if !values.isEmpty { out[field.key] = values }
                }
            case "tags":
                if field.options.isEmpty {
                    addDelimitedListValue(field, to: &out)
                } else {
                    let values = Array(multiSelect[field.key] ?? []).sorted()
                    if !values.isEmpty { out[field.key] = values }
                }
            case "number", "integer", "float":
                addNumberValue(field, to: &out)
            default:
                addTextValue(field, to: &out)
            }
        }
        return out
    }

    private func addTextValue(_ field: HITLAskFormRequest.Field, to out: inout [String: Any]) {
        let value = (textValues[field.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { out[field.key] = value }
    }

    private func addDelimitedListValue(_ field: HITLAskFormRequest.Field, to out: inout [String: Any]) {
        let values = (textValues[field.key] ?? "")
            .split { $0 == "," || $0 == "，" || $0 == "\n" }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if !values.isEmpty { out[field.key] = values }
    }

    private func addNumberValue(_ field: HITLAskFormRequest.Field, to out: inout [String: Any]) {
        let value = (textValues[field.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        if let number = Double(value) {
            out[field.key] = number.rounded() == number ? Int(number) : number
        } else {
            out[field.key] = value
        }
    }

    private func normalizedType(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "_")
            .lowercased()
    }
}

// MARK: - request_approval（单请求批准）

private struct RequestApprovalPanel: View {
    let request: RequestApprovalRequest
    let coordinator: HITLCoordinator

    var body: some View {
        HITLContainer(title: request.title, subtitle: nil) {
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                RiskBadge(level: request.riskLevel.rawValue)
                if !request.rationale.isEmpty {
                    Text(request.rationale).font(.tt.meta).foregroundStyle(.tt.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } actions: {
            HStack(spacing: TTSpacing.sm) {
                Button(request.declineLabel ?? "拒绝") {
                    Task { await coordinator.submitRequestApproval(false, requestId: request.requestId) }
                }
                .buttonStyle(.bordered).tint(.tt.bgCritical)
                Button {
                    Task { await coordinator.submitRequestApproval(true, requestId: request.requestId) }
                } label: {
                    Text(request.submitLabel ?? "批准").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).tint(.tt.bgAccent)
            }
            .disabled(coordinator.isSubmitting)
        }
    }
}

// MARK: - 复用件

/// 面板统一外壳：标题 + 可滚动内容 + 底部动作区。
private struct HITLContainer<Content: View, Actions: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.tt.bodySemibold).foregroundStyle(.tt.textPrimary)
                if let subtitle { Text(subtitle).font(.tt.caption).foregroundStyle(.tt.textSecondary) }
            }
            ScrollView { content().frame(maxWidth: .infinity, alignment: .leading) }
                .frame(maxHeight: 240)
            actions()
        }
        .padding(TTSpacing.lg)
    }
}

private struct RiskBadge: View {
    let level: String
    var body: some View {
        Text(label)
            .font(.tt.captionMedium)
            .foregroundStyle(.tt.textOnAccent)
            .padding(.horizontal, TTSpacing.xs + 2)
            .padding(.vertical, 1)
            .background(color, in: Capsule())
    }
    private var label: String {
        switch level {
        case "high": return "高风险"
        case "medium", "review": return "需留意"
        default: return "安全"
        }
    }
    private var color: Color {
        switch level {
        case "high": return .tt.bgCritical
        case "medium", "review": return .tt.bgWarning
        default: return .tt.bgSuccess
        }
    }
}

/// 选项 chip 流式布局（简化版：自适应换行）。
private struct FlowChips: View {
    let options: [AskUserRequestQuestionsItemOptionsItem]
    let selected: Set<String>
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            ForEach(options, id: \.id) { opt in
                Button { onTap(opt.id) } label: {
                    HStack(spacing: TTSpacing.xs) {
                        Image(systemName: selected.contains(opt.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selected.contains(opt.id) ? .tt.iconAccent : .tt.textTertiary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(optionLabel(opt))
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textPrimary)
                            if !optionDescription(opt).isEmpty {
                                Text(optionDescription(opt))
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                            if let preview = opt.preview,
                               !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text(preview)
                                    .font(.tt.codeXS)
                                    .foregroundStyle(.tt.textSecondary)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(TTSpacing.xs)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(
                                        .tt.bgCanvasDefault,
                                        in: RoundedRectangle(cornerRadius: TTRadius.xs)
                                    )
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(TTSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: TTRadius.sm)
                            .fill(selected.contains(opt.id) ? .tt.bgReasoning : .tt.bgSubtle)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func optionLabel(_ option: AskUserRequestQuestionsItemOptionsItem) -> String {
        option.id == AskUserAnswerDraft.otherOptionId ? "其他" : option.label
    }

    private func optionDescription(_ option: AskUserRequestQuestionsItemOptionsItem) -> String {
        option.id == AskUserAnswerDraft.otherOptionId
            ? "填写上述选项之外的自定义回答"
            : option.description
    }
}
