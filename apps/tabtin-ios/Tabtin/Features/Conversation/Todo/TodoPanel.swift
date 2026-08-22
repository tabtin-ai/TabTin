import Foundation
import AVKit
import os
import PDFKit
import QuickLook
import SwiftUI
import UIKit

// MARK: - Todo

struct AgentTodoItem: Identifiable, Hashable, Sendable {
    let id: String
    let content: String
    let status: String

    var isTerminal: Bool {
        switch status.lowercased() {
        case "completed", "cancelled":
            return true
        default:
            return false
        }
    }

    static func decode(envelope: WSEnvelope) -> [AgentTodoItem] {
        let rawItems = envelope.payload["todos"]?.arrayValue
            ?? envelope.payload["items"]?.arrayValue
            ?? (envelope.payload["todo"]?.dictValue?["items"] as? [Any])
            ?? []
        return rawItems.enumerated().compactMap { index, item in
            guard let dict = item as? [String: Any] else { return nil }
            let content = (dict["content"] as? String)
                ?? (dict["text"] as? String)
                ?? (dict["title"] as? String)
                ?? ""
            guard !content.isEmpty else { return nil }
            return AgentTodoItem(
                id: (dict["id"] as? String) ?? "todo-\(index)",
                content: content,
                status: (dict["status"] as? String) ?? "pending"
            )
        }
    }
}

/// 对齐 Electron `createTodoStripView`：收起条只报当前任务和 `done/total`，不写百分比。
enum TodoStripPresentation {
    enum LabelKind: Equatable {
        case allDone
        case awaitingSubagents
        case pausedCurrent
        case current
    }

    enum IconKind: Equatable {
        case complete
        case paused
        case inProgress
        case idle
    }

    struct View: Equatable {
        var done: Int
        var total: Int
        var labelKind: LabelKind
        var currentContent: String?
        var iconKind: IconKind
        var isRunning: Bool
        var progressScale: Double

        var progressText: String { "\(done)/\(total)" }

        var label: String {
            switch labelKind {
            case .allDone:
                return "待办已完成"
            case .awaitingSubagents:
                return "等待子任务：\(currentContent ?? "")"
            case .pausedCurrent:
                return "已暂停：\(currentContent ?? "")"
            case .current:
                return "当前：\(currentContent ?? "")"
            }
        }
    }

    static func make(
        items: [AgentTodoItem],
        paused: Bool,
        awaitingSubagents: Bool
    ) -> View? {
        guard !items.isEmpty else { return nil }
        let active = items.filter { $0.status.lowercased() != "cancelled" }
        let done = active.filter { $0.status.lowercased() == "completed" }.count
        let current = active.first { $0.status.lowercased() == "in_progress" }
            ?? active.first { $0.status.lowercased() == "paused" }
            ?? active.first { $0.status.lowercased() == "pending" }
            ?? active.last
        let total = active.count
        let isComplete = total > 0 && done == total
        let isInProgress = current?.status.lowercased() == "in_progress"
        let isAwaiting = awaitingSubagents && isInProgress
        let isPausedCurrent = current?.status.lowercased() == "paused"
            || (paused && isInProgress && !isAwaiting)
        let isRunning = isInProgress && !paused && !isAwaiting && !isComplete
        let labelKind: LabelKind
        if isComplete {
            labelKind = .allDone
        } else if isAwaiting {
            labelKind = .awaitingSubagents
        } else if isPausedCurrent {
            labelKind = .pausedCurrent
        } else {
            labelKind = .current
        }
        let iconKind: IconKind
        if isComplete {
            iconKind = .complete
        } else if isPausedCurrent {
            iconKind = .paused
        } else if isInProgress {
            iconKind = .inProgress
        } else {
            iconKind = .idle
        }
        return View(
            done: done,
            total: total,
            labelKind: labelKind,
            currentContent: current?.content,
            iconKind: iconKind,
            isRunning: isRunning,
            progressScale: total > 0 ? Double(done) / Double(total) : 0
        )
    }

    static func awaitingSubagents(_ runs: [SubagentRun]) -> Bool {
        runs.contains {
            $0.status == .pending || $0.status == .queued || $0.status == .running
        }
    }
}

struct TodoPanel: View {
    let items: [AgentTodoItem]
    var paused: Bool = false
    var awaitingSubagents: Bool = false
    @State private var isExpanded = false

    var body: some View {
        if let strip = TodoStripPresentation.make(
            items: items,
            paused: paused,
            awaitingSubagents: awaitingSubagents
        ) {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: TTSpacing.sm) {
                        Image(systemName: "checklist")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                        stripStatusIcon(strip)
                        Text(strip.label)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(strip.progressText)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .monospacedDigit()
                            .fixedSize()
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.tt.iconCaption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.vertical, TTSpacing.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("查看全部待办，已完成 \(strip.done) / \(strip.total)")

                Rectangle()
                    .fill(.tt.borderLight)
                    .frame(height: 2)
                    .overlay(alignment: .leading) {
                        GeometryReader { geo in
                            Rectangle()
                                .fill(strip.iconKind == .complete ? Color.tt.textSuccess : Color.tt.bgAccent)
                                .frame(width: geo.size.width * strip.progressScale)
                        }
                    }

                if isExpanded {
                    ScrollView {
                        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                            ForEach(items) { item in
                                HStack(spacing: TTSpacing.sm) {
                                    todoIcon(item.status)
                                    Text(item.content)
                                        .font(.tt.meta)
                                        .foregroundStyle(item.status == "completed" ? .tt.textTertiary : .tt.textPrimary)
                                        .strikethrough(item.status == "cancelled", color: .tt.textTertiary)
                                        .lineLimit(2)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .padding(.horizontal, TTSpacing.md)
                                .padding(.vertical, TTSpacing.xxs)
                            }
                        }
                        .padding(.bottom, TTSpacing.sm)
                    }
                    .frame(maxHeight: 200)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                    .fill(.tt.bgSubtle)
            )
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                    .strokeBorder(.tt.borderLight, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous))
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, TTSpacing.lg)
            .padding(.vertical, TTSpacing.xxs)
        }
    }

    @ViewBuilder
    private func stripStatusIcon(_ strip: TodoStripPresentation.View) -> some View {
        switch strip.iconKind {
        case .complete:
            Image(systemName: "checkmark.circle.fill")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textSuccess)
        case .paused:
            Image(systemName: "pause.circle")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
        case .inProgress:
            ProgressView()
                .controlSize(.mini)
                .frame(width: 14, height: 14)
                .tint(.tt.iconAccent)
        case .idle:
            Image(systemName: "circle")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
        }
    }

    @ViewBuilder
    private func todoIcon(_ status: String) -> some View {
        switch status {
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textSuccess)
        case "in_progress":
            ProgressView().controlSize(.mini).frame(width: 14, height: 14)
        case "cancelled":
            Image(systemName: "xmark.circle")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textTertiary)
        default:
            Image(systemName: "circle")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textTertiary)
        }
    }
}
