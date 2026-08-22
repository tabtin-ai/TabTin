import Foundation
import AVKit
import os
import PDFKit
import QuickLook
import SwiftUI
import UIKit

// MARK: - Checkpoint UI

enum RewindPreviewIntent: Equatable {
    case rollback
    case editAndResend
}

struct CheckpointBadge: View {
    let record: ChatCheckpointRecord
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.tt.iconCaption)
                    .frame(width: 16, height: 16)
                Text(label)
                    .font(.tt.caption)
            }
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .background(Capsule().fill(color.opacity(0.1)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var color: Color {
        switch record.normalizedStatus {
        case .ready: return .tt.textSuccess
        case .degraded: return .tt.textWarning
        case .unavailable: return .tt.textTertiary
        }
    }

    private var label: String {
        switch record.normalizedStatus {
        case .ready: return "可回退"
        case .degraded: return "部分可回退"
        case .unavailable: return "不可回退"
        }
    }

    private var icon: String {
        switch record.normalizedStatus {
        case .ready: return "arrow.uturn.backward.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .unavailable: return "minus.circle.fill"
        }
    }
}

struct RewindPreviewSheet: View {
    let sessionId: String
    let preview: ChatCheckpointRollbackPreview
    var intent: RewindPreviewIntent = .rollback
    var onConfirm: (String, [ChatCheckpointResourcePlanItem], Bool) -> Void
    var onDismiss: () -> Void
    var onRetry: () -> Void = {}

    private let checkpointService = ChatCheckpointService.shared
    @State private var reason = ""
    @State private var excludedResources: Set<String> = []
    @State private var showDiffSheet = false
    @State private var acknowledgesConversationOnly = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.lg) {
                    if intent == .editAndResend {
                        editResendSummary
                    }
                    impactSection
                    messagesSection
                    resourcesSection
                    capabilitySection
                    unrestorableItemsSection
                    if let reasons = preview.degradedReasons, !reasons.isEmpty {
                        warningSection(reasons)
                    }
                    if let lastError = checkpointService.lastError, !lastError.isEmpty {
                        operationErrorSection(lastError)
                    }
                    if confirmationBlockingDetail != nil {
                        filePreviewBlockedSection
                    } else if editResendRisk.requiresConversationOnlyAcknowledgement {
                        conversationOnlyAcknowledgement
                    }
                    if intent == .rollback {
                        TextField("回退原因（可选）", text: $reason, axis: .vertical)
                            .font(.tt.body)
                            .lineLimit(2...4)
                            .padding(TTSpacing.md)
                            .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtle))
                    }
                }
                .padding(TTSpacing.lg)
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle(intent == .editAndResend ? "编辑并重发" : "回退预览")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", action: onDismiss)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(intent == .editAndResend ? "确认并重发" : "确认回退") {
                        guard confirmationEligibility.isEnabled else { return }
                        onConfirm(
                            intent == .editAndResend ? "编辑用户消息" : reason,
                            confirmedResourcePlan,
                            acknowledgesConversationOnly
                        )
                    }
                        .foregroundStyle(.tt.textCritical)
                        .disabled(!confirmationEligibility.isEnabled)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sheet(isPresented: $showDiffSheet) {
            CheckpointDiffSheet(
                fileSummary: preview.effectiveCheckpoint?.impactSummary?.fileSummary,
                onDismiss: { showDiffSheet = false }
            )
        }
    }

    private var editResendSummary: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Text("发送前会先重写这段对话")
                .font(.tt.bodySemibold)
            Text("当前消息及其后的对话会从当前时间线移除，再以修改后的内容重新发送。工作区文件和文档只会按下方可用版本恢复。")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        }
        .checkpointSectionStyle()
    }

    private var impactSection: some View {
        let fileDiffEligibility = CheckpointPresentationPolicy.eligibility(
            for: .viewFileDiff,
            preview: preview,
            isSubmitting: checkpointService.isReverting
        )
        return VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Label("影响范围", systemImage: "arrow.uturn.backward.circle")
                .font(.tt.bodySemibold)
            infoRow("将移除消息", "\(preview.impact?.messages?.toRemove ?? preview.messagesToRemove ?? 0) 条")
            infoRow("文档和表格", editResendRisk.resourceDetail)
            infoRow("工作区文件", editResendRisk.detail)
            if let paths = preview.affectedPaths, !paths.isEmpty {
                ForEach(Array(paths.prefix(5)), id: \.self) { path in
                    Label(path, systemImage: "doc")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if paths.count > 5 {
                    Text("还有 \(paths.count - 5) 个文件")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            if let unrestorableFiles = preview.unrestorableFiles, !unrestorableFiles.isEmpty {
                Text("预览已确认以下 \(unrestorableFiles.count) 个文件不会恢复")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textWarning)
                ForEach(Array(unrestorableFiles.prefix(5)), id: \.path) { item in
                    Label(item.path, systemImage: "exclamationmark.triangle")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textWarning)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if preview.impact?.files?.available == true || preview.filePreviewStatus == "available" {
                if fileDiffEligibility.isEnabled {
                    Button {
                        showDiffSheet = true
                    } label: {
                        Label("查看文件变更", systemImage: "doc.text.magnifyingglass")
                            .font(.tt.meta)
                    }
                    .frame(minHeight: 44)
                    .disabled(!fileDiffEligibility.isEnabled)
                }
            }
        }
        .checkpointSectionStyle()
    }

    private var conversationOnlyAcknowledgement: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Label("部分内容不会恢复", systemImage: "exclamationmark.triangle.fill")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textWarning)
            Text(editResendRisk.acknowledgementDetail ?? editResendRisk.detail)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
            Toggle("我已了解这些内容不会恢复，仅重写对话", isOn: $acknowledgesConversationOnly)
                .font(.tt.meta)
                .tint(.tt.textAccent)
        }
        .checkpointSectionStyle()
    }

    private var filePreviewBlockedSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Label(
                intent == .editAndResend ? "暂时不能安全重发" : "暂时不能安全回退",
                systemImage: "exclamationmark.shield.fill"
            )
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textWarning)
            Text(confirmationBlockingDetail ?? editResendRisk.detail)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
            Button(action: onRetry) {
                Label(
                    checkpointService.isLoadingPreview ? "正在重新检查…" : "重新检查影响范围",
                    systemImage: "arrow.clockwise"
                )
                .font(.tt.metaSemibold)
                .frame(minHeight: 44)
            }
            .disabled(checkpointService.isLoadingPreview)
        }
        .checkpointSectionStyle()
    }

    private var messagesSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text("受影响消息").font(.tt.bodySemibold)
            ForEach((preview.messagesPreview ?? []).prefix(5)) { item in
                HStack(alignment: .top, spacing: TTSpacing.sm) {
                    Image(systemName: item.role == "assistant" ? "sparkles" : "person")
                        .foregroundStyle(.tt.textTertiary)
                    Text(item.contentPreview ?? "")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
            }
        }
        .checkpointSectionStyle()
    }

    @ViewBuilder
    private var resourcesSection: some View {
        let resources = preview.resourceRestorePlan ?? []
        if !resources.isEmpty {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                Text("资源恢复计划").font(.tt.bodySemibold)
                ForEach(resources) { item in
                    let key = item.id
                    let isExcluded = excludedResources.contains(key)
                    let eligibility = CheckpointPresentationPolicy.eligibility(
                        for: .selectResourceRestore,
                        preview: preview,
                        resource: item,
                        isSubmitting: checkpointService.isReverting
                    )
                    HStack(spacing: TTSpacing.sm) {
                        if eligibility.isEnabled {
                            Button {
                                if isExcluded { excludedResources.remove(key) } else { excludedResources.insert(key) }
                            } label: {
                                Image(systemName: isExcluded ? "square" : "checkmark.square.fill")
                                    .foregroundStyle(isExcluded ? .tt.textTertiary : .tt.iconAccent)
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .disabled(!eligibility.isEnabled)
                        } else {
                            Image(systemName: "minus.circle")
                                .foregroundStyle(.tt.textTertiary)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.resourceName ?? "未命名资源")
                                .font(.tt.meta)
                                .foregroundStyle(isExcluded ? .tt.textTertiary : .tt.textPrimary)
                            Text(isExcluded ? "跳过恢复" : item.actionLabel ?? item.action ?? "skip")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                            if !isExcluded,
                               item.canRestore == true,
                               let versionTime = item.restoreToVersionTime,
                               !versionTime.isEmpty {
                                Text("将恢复到 \(formattedVersionTime(versionTime)) 的版本")
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textSecondary)
                            }
                            if let disabledReason = eligibility.disabledReason {
                                Text(disabledReason)
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textWarning)
                            }
                        }
                        Spacer()
                        if let count = item.changeCount, count > 0 {
                            Text("\(count) 处变更")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                        }
                    }
                    .opacity(isExcluded ? 0.6 : 1)
                }
            }
            .checkpointSectionStyle()
        }
    }

    private func warningSection(_ reasons: [String]) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label("能力降级", systemImage: "exclamationmark.triangle")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textWarning)
            ForEach(reasons, id: \.self) { reason in
                Text(reason)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }
        }
        .checkpointSectionStyle()
    }

    private func operationErrorSection(_ message: String) -> some View {
        Label {
            Text(message)
                .font(.tt.meta)
        } icon: {
            Image(systemName: "xmark.octagon.fill")
        }
        .foregroundStyle(.tt.textCritical)
        .checkpointSectionStyle()
    }

    private var capabilitySection: some View {
        let notices = CheckpointPresentationPolicy.capabilityNotices(for: preview)
        return VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Text("恢复边界").font(.tt.bodySemibold)
            ForEach(notices) { notice in
                HStack(alignment: .top, spacing: TTSpacing.xs) {
                    Image(systemName: notice.isAvailable ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(notice.isAvailable ? .tt.textSuccess : .tt.textWarning)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(notice.title).font(.tt.meta)
                        Text(notice.detail)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
            }
            if let disabledReason = confirmationEligibility.disabledReason {
                Text(disabledReason)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textWarning)
            }
        }
        .checkpointSectionStyle()
    }

    @ViewBuilder
    private var unrestorableItemsSection: some View {
        if let items = preview.unrestorableItems, !items.isEmpty {
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                Text("不可自动恢复项").font(.tt.bodySemibold)
                ForEach(items, id: \.self) { item in
                    Label(item, systemImage: "exclamationmark.triangle")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textWarning)
                }
            }
            .checkpointSectionStyle()
        }
    }

    private func infoRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(.tt.textSecondary)
            Spacer()
            Text(value).foregroundStyle(.tt.textPrimary)
        }
        .font(.tt.meta)
    }

    /// v2 编辑重发需要对预览计划中的每一项给出明确决策。可恢复且仍勾选的项
    /// 保持服务端给出的 action/version；排除项与不可恢复项显式改为 skip。
    private var confirmedResourcePlan: [ChatCheckpointResourcePlanItem] {
        (preview.resourceRestorePlan ?? []).map { item in
            let eligibility = CheckpointPresentationPolicy.eligibility(
                for: .selectResourceRestore,
                preview: preview,
                resource: item,
                isSubmitting: checkpointService.isReverting
            )
            guard eligibility.isEnabled, !excludedResources.contains(item.id) else {
                var skipped = item
                skipped.action = "skip"
                skipped.restoreToVersionId = nil
                return skipped
            }
            return item
        }
    }

    private var confirmationEligibility: CheckpointActionEligibility {
        let base = CheckpointPresentationPolicy.eligibility(
            for: .confirmRollback,
            preview: preview,
            isSubmitting: checkpointService.isReverting
        )
        guard base.isEnabled else { return base }
        if let confirmationBlockingDetail {
            return .init(
                isEnabled: false,
                disabledReason: confirmationBlockingDetail
            )
        }
        if editResendRisk.requiresConversationOnlyAcknowledgement,
           !acknowledgesConversationOnly {
            return .init(
                isEnabled: false,
                disabledReason: "请先确认是否仅重写对话"
            )
        }
        return base
    }

    private var editResendRisk: CheckpointEditResendRisk {
        CheckpointPresentationPolicy.editResendRisk(for: preview)
    }

    private var confirmationBlockingDetail: String? {
        if intent == .editAndResend,
           let revisionDetail = CheckpointPresentationPolicy.editResendRevisionBlockingDetail(
               previewRevision: preview.previewRevision,
               filePreviewRevision: preview.filePreviewRevision
           ) {
            return revisionDetail
        }
        return editResendRisk.blocksExecution ? editResendRisk.blockingDetail ?? editResendRisk.detail : nil
    }

    private func formattedVersionTime(_ rawValue: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        guard let date = fractional.date(from: rawValue) ?? basic.date(from: rawValue) else {
            return rawValue
        }
        return date.formatted(
            Date.FormatStyle(date: .abbreviated, time: .shortened)
                .locale(Locale(identifier: "zh_CN"))
        )
    }
}

struct CheckpointDiffSheet: View {
    let fileSummary: ChatCheckpointFileSummary?
    var onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.lg) {
                    if let summary = fileSummary, (summary.changed ?? 0) > 0 || !(summary.files ?? []).isEmpty {
                        VStack(alignment: .leading, spacing: TTSpacing.sm) {
                            Text("\(summary.changed ?? summary.files?.count ?? 0) 个文件有变更")
                                .font(.tt.bodySemibold)
                            HStack(spacing: TTSpacing.md) {
                                if (summary.insertions ?? 0) > 0 {
                                    Text("+\(summary.insertions ?? 0)")
                                        .font(.tt.bodySemibold)
                                        .foregroundStyle(.tt.textSuccess)
                                }
                                if (summary.deletions ?? 0) > 0 {
                                    Text("-\(summary.deletions ?? 0)")
                                        .font(.tt.bodySemibold)
                                        .foregroundStyle(.tt.textCritical)
                                }
                            }
                        }
                        .checkpointSectionStyle()

                        VStack(alignment: .leading, spacing: TTSpacing.xs) {
                            Text("变更文件").font(.tt.bodySemibold)
                            ForEach(summary.files ?? []) { file in
                                HStack(spacing: TTSpacing.sm) {
                                    Text(statusLabel(file))
                                        .font(.tt.codeSM)
                                        .foregroundStyle(statusColor(file))
                                        .frame(width: 20)
                                    Text(file.file)
                                        .font(.tt.codeSM)
                                        .foregroundStyle(.tt.textPrimary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    Spacer()
                                    if (file.insertions ?? 0) > 0 {
                                        Text("+\(file.insertions ?? 0)")
                                            .font(.tt.codeXS)
                                            .foregroundStyle(.tt.textSuccess)
                                    }
                                    if (file.deletions ?? 0) > 0 {
                                        Text("-\(file.deletions ?? 0)")
                                            .font(.tt.codeXS)
                                            .foregroundStyle(.tt.textCritical)
                                    }
                                }
                                .padding(.vertical, TTSpacing.xxs)
                            }
                        }
                        .checkpointSectionStyle()

                        Label("完整 diff 请在桌面端查看。", systemImage: "desktopcomputer")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    } else {
                        ContentUnavailableView("暂无文件变更数据", systemImage: "doc.text.magnifyingglass")
                    }
                }
                .padding(TTSpacing.lg)
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle("文件变更")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", action: onDismiss)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func statusLabel(_ file: ChatCheckpointDiffFileSummary) -> String {
        if (file.deletions ?? 0) > 0 && (file.insertions ?? 0) == 0 { return "D" }
        if (file.insertions ?? 0) > 0 && (file.deletions ?? 0) == 0 { return "A" }
        return "M"
    }

    private func statusColor(_ file: ChatCheckpointDiffFileSummary) -> Color {
        switch statusLabel(file) {
        case "A": return .tt.textSuccess
        case "D": return .tt.textCritical
        default: return .tt.textAccent
        }
    }
}

struct RevertBanner: View {
    let state: ChatCheckpointSessionRollbackState
    var onUnrevert: () -> Void
    var onHistory: () -> Void
    var onRetryResources: () -> Void
    var onDismiss: () -> Void

    private let checkpointService = ChatCheckpointService.shared

    var body: some View {
        let presentation = CheckpointPresentationPolicy.rollbackStatePresentation(
            state: state,
            receipt: checkpointService.lastOperationReceipt
        )
        let retryEligibility = CheckpointPresentationPolicy.eligibility(
            for: .retryResources,
            rollbackState: state,
            isSubmitting: checkpointService.isReverting
        )
        let unrevertEligibility = CheckpointPresentationPolicy.eligibility(
            for: .unrevert,
            rollbackState: state,
            isSubmitting: checkpointService.isReverting
        )
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                Image(systemName: presentation.isPartial ? "exclamationmark.triangle.fill" : "arrow.uturn.backward.circle.fill")
                    .font(.tt.iconSubtitle)
                    .foregroundStyle(presentation.isPartial ? .tt.textWarning : .tt.textAccent)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(presentation.title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Text(presentation.detail)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                    if let reason = state.lastRollbackReason, !reason.isEmpty {
                        Text(reason)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                Spacer()
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.tt.iconCaptionMedium)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭回退通知")
            }
            HStack(spacing: TTSpacing.sm) {
                Spacer()
                Button("查看历史", action: onHistory)
                    .font(.tt.caption)
                    .frame(minHeight: 44)
                if !state.retryableItems.isEmpty {
                    Button("重试资源", action: onRetryResources).font(.tt.caption)
                        .frame(minHeight: 44)
                        .disabled(!retryEligibility.isEnabled)
                }
                if state.canUnrevert == true {
                    Button("撤销回退", action: onUnrevert).font(.tt.caption)
                        .frame(minHeight: 44)
                        .disabled(!unrevertEligibility.isEnabled)
                }
            }
            if let disabledReason = retryEligibility.disabledReason, !state.retryableItems.isEmpty {
                Text(disabledReason).font(.tt.caption).foregroundStyle(.tt.textTertiary)
            }
            if let disabledReason = unrevertEligibility.disabledReason, state.canUnrevert == true {
                Text(disabledReason).font(.tt.caption).foregroundStyle(.tt.textTertiary)
            }
            if state.resourceRestoredCount > 0
                || state.resourceFailedCount > 0
                || state.hasFileRestoreOutcome {
                HStack(spacing: TTSpacing.xs) {
                    chip("会话", "已回退", .tt.textSuccess)
                    if state.hasFileRestoreOutcome {
                        chip(
                            "文件",
                            state.fileRestoreBadgeDetail,
                            state.hasFileFailure ? .tt.textCritical : .tt.textSuccess
                        )
                    }
                    if state.resourceRestoredCount > 0 || state.resourceFailedCount > 0 {
                        chip("资源", "\(state.resourceRestoredCount)/\(state.resourceRestoredCount + state.resourceFailedCount)", state.resourceFailedCount > 0 ? .tt.textWarning : .tt.textSuccess)
                    }
                }
            }
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
        .background(
            (presentation.isPartial ? Color.tt.bgWarning : Color.tt.bgAccent).opacity(0.08)
        )
    }

    private func chip(_ title: String, _ detail: String, _ color: Color) -> some View {
        HStack(spacing: 3) {
            Text(title)
            Text(detail).opacity(0.8)
        }
        .font(.tt.caption)
        .foregroundStyle(color)
        .padding(.horizontal, TTSpacing.xs)
        .padding(.vertical, 3)
        .background(Capsule().fill(color.opacity(0.1)))
    }
}

struct RevertHistorySheet: View {
    let service: ChatCheckpointService
    let sessionId: String
    var onClose: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if service.isLoadingHistory {
                    ProgressView("加载历史…")
                } else if service.revertHistory.isEmpty {
                    ContentUnavailableView("暂无回退历史", systemImage: "clock.arrow.circlepath")
                } else {
                    List(service.revertHistory) { entry in
                        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                            Text(entry.type == "unrevert" ? "撤销回退" : "回退")
                                .font(.tt.bodySemibold)
                            Text(historyDetail(entry))
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                            if let createdAt = entry.createdAt {
                                Text(createdAt)
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                        }
                        .padding(.vertical, TTSpacing.xxs)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("回退历史")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", action: onClose)
                }
            }
            .task { await service.fetchRevertHistory(sessionId: sessionId) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func historyDetail(_ entry: ChatCheckpointRevertHistoryEntry) -> String {
        var parts: [String] = []
        if let removed = entry.messagesRemoved { parts.append("移除 \(removed) 条消息") }
        if let restored = entry.restoredCount { parts.append("恢复 \(restored) 个资源") }
        if let failed = entry.failedCount, failed > 0 { parts.append("\(failed) 个失败") }
        return parts.isEmpty ? (entry.applyResult ?? "已完成") : parts.joined(separator: "，")
    }
}

struct RestoreOverlay: View {
    let phase: String

    var body: some View {
        ZStack {
            Color.black.opacity(0.25).ignoresSafeArea()
            VStack(spacing: TTSpacing.md) {
                ProgressView().controlSize(.large).tint(.white)
                Text(text)
                    .font(.tt.body)
                    .foregroundStyle(.white)
            }
            .padding(TTSpacing.xl)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md))
        }
    }

    private var text: String {
        switch phase {
        case "files": return "正在恢复文件…"
        case "resources": return "正在恢复资源…"
        case "finalizing": return "正在收尾…"
        default: return "准备回退…"
        }
    }
}

private extension View {
    func checkpointSectionStyle() -> some View {
        padding(TTSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            )
    }
}
