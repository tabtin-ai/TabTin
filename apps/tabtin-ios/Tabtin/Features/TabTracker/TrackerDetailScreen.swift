import SwiftUI

/// 自动化详情始终先读取 `/events/{id}`，列表快照只承担首屏占位。
struct TrackerDetailScreen: View {
    let store: TabTrackerStore
    let trackerId: String
    let initialRunId: String?
    let onOpenConversation: (ConversationTarget) -> Void
    let onRequestEdit: (Tracker) -> Void
    let showsCloseButton: Bool
    let onClose: () -> Void
    let onDeleted: () -> Void

    @State private var actionError: String?
    @State private var showDeleteConfirm = false

    /// 详情页只消费 `/events/{id}` 的权威记录，不把列表快照升级为可操作详情。
    private var tracker: Tracker? { store.trackerDetailsById[trackerId] }
    private var runs: [TrackerRun] { store.runs(for: trackerId) }
    private var isActing: Bool { store.actionInProgressTrackerId == trackerId }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.lg) {
                    if let tracker {
                        infoSection(tracker)
                        actionSection(tracker)
                        runsSection
                    } else if let error = store.detailErrorByTrackerId[trackerId] {
                        detailErrorState(error)
                    } else {
                        ProgressView("加载自动化任务详情…")
                            .frame(maxWidth: .infinity, minHeight: 320)
                    }
                }
                .padding(TTSpacing.lg)
            }
            .onChange(of: runs.map(\.id)) { _, ids in
                guard let initialRunId, ids.contains(initialRunId) else { return }
                withAnimation { proxy.scrollTo(initialRunId, anchor: .center) }
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(tracker?.name ?? "自动化")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsCloseButton {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { onClose() }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if let tracker {
                    Menu {
                        Button {
                            onRequestEdit(tracker)
                        } label: {
                            Label("编辑自动化", systemImage: "slider.horizontal.3")
                        }
                        .disabled(tracker.capabilities?.canEdit != true)

                        Divider()

                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Label("删除自动化", systemImage: "trash")
                        }
                        .disabled(tracker.capabilities?.canEdit != true)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("自动化操作")
                }
            }
        }
        .task(id: trackerId) {
            async let detailLoad: Void = store.loadTrackerDetail(trackerId)
            async let runsLoad: Void = store.loadRuns(trackerId: trackerId)
            _ = await (detailLoad, runsLoad)
        }
        .refreshable {
            async let detailLoad: Void = store.loadTrackerDetail(trackerId)
            async let runsLoad: Void = store.loadRuns(trackerId: trackerId)
            _ = await (detailLoad, runsLoad)
        }
        .alert("操作失败", isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button("好", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .confirmationDialog("删除这个自动化？", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                Task { await performDelete() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("自动化将停止触发并从列表隐藏，运行历史保留。")
        }
    }

    private func infoSection(_ tracker: Tracker) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(spacing: TTSpacing.sm) {
                Image(systemName: tracker.triggerType.displayIcon)
                    .foregroundStyle(.tt.iconAccent)
                Text(tracker.triggerType.displayLabel)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                Spacer(minLength: 0)
                TrackerStatusBadge(status: tracker.status)
            }
            if let spaceName = tracker.spaceName, !spaceName.isEmpty {
                statLine(icon: "square.grid.2x2", text: spaceName)
            }
            if !tracker.description.isEmpty {
                Text(tracker.description)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                if let next = TrackerDateFormatting.display(tracker.nextRunAt) {
                    statLine(icon: "arrow.right.circle", text: "下次运行：\(next)")
                }
                if let last = TrackerDateFormatting.display(tracker.lastRunAt) {
                    statLine(icon: "clock.arrow.circlepath", text: "上次运行：\(last)")
                }
                statLine(
                    icon: "chart.bar",
                    text: "共运行 \(tracker.totalRuns) 次 · 成功 \(tracker.successRuns) · 失败 \(tracker.failRuns)"
                )
            }
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func statLine(icon: String, text: String) -> some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: icon)
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(.tt.textTertiary)
            Text(text)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
        }
    }

    @ViewBuilder
    private func actionSection(_ tracker: Tracker) -> some View {
        let lifecycleAction = TrackerActionPolicy.lifecycleAction(for: tracker)
        let triggerBlockedByActiveRun = !TrackerRunExecutionPolicy.canTrigger(latestRun: runs.first)

        if tracker.capabilities == nil {
            Label("服务端尚未提供操作权限，本机以只读方式展示。", systemImage: "lock")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .padding(TTSpacing.sm)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        }

        if TrackerActionPolicy.canTrigger(tracker) || lifecycleAction != nil {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: TTSpacing.sm) {
                    trackerActionButtons(
                        tracker,
                        lifecycleAction: lifecycleAction,
                        triggerBlockedByActiveRun: triggerBlockedByActiveRun
                    )
                }
                VStack(spacing: TTSpacing.sm) {
                    trackerActionButtons(
                        tracker,
                        lifecycleAction: lifecycleAction,
                        triggerBlockedByActiveRun: triggerBlockedByActiveRun
                    )
                }
            }
            .frame(maxWidth: .infinity)
            .disabled(isActing)
        }

        if triggerBlockedByActiveRun, TrackerActionPolicy.canTrigger(tracker) {
            Label(TrackerRunExecutionPolicy.activeRunExplanation, systemImage: "info.circle")
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textSecondary)
        }
    }

    @ViewBuilder
    private func trackerActionButtons(
        _ tracker: Tracker,
        lifecycleAction: TrackerLifecycleAction?,
        triggerBlockedByActiveRun: Bool
    ) -> some View {
        if TrackerActionPolicy.canTrigger(tracker) {
            Button {
                Task { await performTrigger() }
            } label: {
                Label("立即运行", systemImage: "play.fill")
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(.tt.bgAccent)
            .disabled(triggerBlockedByActiveRun)
            .accessibilityHint(
                triggerBlockedByActiveRun ? TrackerRunExecutionPolicy.activeRunExplanation : ""
            )
        }

        if let lifecycleAction {
            lifecycleButton(lifecycleAction)
        }
    }

    private func lifecycleButton(_ action: TrackerLifecycleAction) -> some View {
        Button {
            Task {
                switch action {
                case .pause:
                    await performAction { try await store.pauseTracker(trackerId) }
                case .resume:
                    await performAction { try await store.resumeTracker(trackerId) }
                case .activate:
                    await performAction { try await store.activateTracker(trackerId) }
                }
            }
        } label: {
            Label(lifecycleTitle(action), systemImage: lifecycleIcon(action))
                .fixedSize(horizontal: true, vertical: false)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
    }

    private func lifecycleTitle(_ action: TrackerLifecycleAction) -> String {
        switch action {
        case .pause: return "暂停"
        case .resume: return "恢复"
        case .activate: return "激活"
        }
    }

    private func lifecycleIcon(_ action: TrackerLifecycleAction) -> String {
        switch action {
        case .pause: return "pause.fill"
        case .resume: return "play.circle"
        case .activate: return "bolt"
        }
    }

    private var runsSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack {
                Label("最近运行", systemImage: "list.bullet.rectangle")
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                Spacer()
                Text("最近 50 条")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }

            if store.isLoadingRuns(for: trackerId) && runs.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 88)
            } else if runs.isEmpty {
                Text("还没有运行记录")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(maxWidth: .infinity, minHeight: 88)
            } else {
                // 时间线：左侧一条竖线把多次运行串起来，节点用状态色。
                // 单看每条卡片只知道「这次怎么样」，串起来才看得出「这个自动化最近稳不稳」。
                VStack(spacing: 0) {
                    ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
                        HStack(alignment: .top, spacing: TTSpacing.sm) {
                            timelineRail(
                                status: run.status,
                                isFirst: index == 0,
                                isLast: index == runs.count - 1
                            )
                            runRow(run)
                                .padding(.bottom, TTSpacing.xs)
                        }
                        .id(run.id)
                    }
                }
            }
        }
    }

    /// 时间线左轨：节点 + 上下连接线。首条不画上半段、末条不画下半段，
    /// 否则线会从空白里冒出来、又断在空白里。
    private func timelineRail(status: TrackerRunStatus, isFirst: Bool, isLast: Bool) -> some View {
        let color = runStatusColor(status)
        return VStack(spacing: 0) {
            Rectangle()
                .fill(isFirst ? Color.clear : Color.tt.borderLight)
                .frame(width: 1, height: 10)
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Rectangle()
                .fill(isLast ? Color.clear : Color.tt.borderLight)
                .frame(width: 1)
                .frame(maxHeight: .infinity)
        }
        .frame(width: 8)
        .accessibilityHidden(true)
    }

    private func runRow(_ run: TrackerRun) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: run.status.displayIcon)
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(runStatusColor(run.status))
                Text(run.status.displayLabel)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(runStatusColor(run.status))
                Spacer(minLength: 0)
                if let created = TrackerDateFormatting.display(run.createdAt) {
                    Text(created)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            if !run.status.isTerminal, !run.progressMessage.isEmpty {
                Text(run.progressMessage)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)
            }
            if run.status == .completed, !run.resultSummary.isEmpty {
                Text(run.resultSummary)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(4)
            }
            if !run.errorSummary.isEmpty {
                Text(run.errorSummary)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textCritical)
                    .lineLimit(3)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: TTSpacing.sm) {
                    runMetadata(run)
                    Spacer(minLength: 0)
                    runActions(run)
                }

                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    runMetadata(run)
                    runActions(run)
                }
            }
        }
        .padding(TTSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            initialRunId == run.id ? Color.tt.bgAccent.opacity(0.1) : Color.tt.bgSubtle,
            in: RoundedRectangle(cornerRadius: TTRadius.sm)
        )
        .overlay {
            if initialRunId == run.id {
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .stroke(.tt.borderFocused, lineWidth: 1)
            }
        }
    }

    @ViewBuilder
    private func runMetadata(_ run: TrackerRun) -> some View {
        if let duration = run.duration, duration > 0 {
            metaText("耗时 \(formatDuration(duration))")
        }
        if run.tokensUsed > 0 {
            metaText("\(run.tokensUsed) tokens")
        }
        if run.maxCycles > 1 {
            metaText("第 \(run.currentCycle)/\(run.maxCycles) 轮")
        }
    }

    @ViewBuilder
    private func runActions(_ run: TrackerRun) -> some View {
        if run.chatSessionId != nil {
            Button {
                Task { await openConversation(for: run) }
            } label: {
                Label("打开会话", systemImage: "bubble.left")
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(minHeight: 44)
            }
            .font(.tt.captionMedium)
            .buttonStyle(.plain)
            .foregroundStyle(.tt.textAccent)
        }
        if TrackerActionPolicy.canCancel(run) {
            Button("取消") {
                Task { await performCancel(runId: run.id) }
            }
            .font(.tt.captionMedium)
            .foregroundStyle(.tt.textCritical)
            .frame(minHeight: 44)
            .disabled(isActing)
        }
    }

    private func metaText(_ text: String) -> some View {
        Text(text)
            .font(.tt.captionMedium)
            .foregroundStyle(.tt.textTertiary)
            .fixedSize(horizontal: true, vertical: false)
    }

    private func runStatusColor(_ status: TrackerRunStatus) -> Color {
        switch status {
        case .completed: return .tt.textSuccess
        case .failed, .partialFailed: return .tt.textCritical
        case .running: return .tt.textAccent
        case .cancelled, .pending, .waitingDevice, .waitingCheckpoint, .unknown:
            return .tt.textTertiary
        }
    }

    private func formatDuration(_ seconds: Double) -> String {
        if seconds < 60 { return "\(Int(seconds.rounded()))秒" }
        let minutes = Int(seconds) / 60
        let remain = Int(seconds) % 60
        return remain > 0 ? "\(minutes)分\(remain)秒" : "\(minutes)分钟"
    }

    private func detailErrorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("无法加载自动化任务详情", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("重试") {
                Task { await store.loadTrackerDetail(trackerId) }
            }
            .buttonStyle(.borderedProminent)
            .tint(.tt.bgAccent)
            .frame(minHeight: 44)
        }
        .frame(maxWidth: .infinity, minHeight: 320)
    }

    private func performTrigger() async {
        do {
            _ = try await store.triggerTracker(trackerId)
            await store.loadRuns(trackerId: trackerId)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func performAction(_ action: () async throws -> Void) async {
        do {
            try await action()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func performCancel(runId: String) async {
        do {
            try await store.cancelRun(trackerId: trackerId, runId: runId)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func openConversation(for run: TrackerRun) async {
        do {
            onOpenConversation(try await store.conversationTarget(for: run))
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func performDelete() async {
        do {
            try await store.deleteTracker(trackerId)
            onDeleted()
        } catch {
            actionError = error.localizedDescription
        }
    }
}
