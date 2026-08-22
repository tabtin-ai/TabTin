import SwiftUI
@preconcurrency import MarkdownUI

/// Plan 草稿提案 inline 卡（非阻断）。交互与 Electron 对齐：
/// 默认展示前三项待办；可打开 Plan 继续编辑；执行时明确展示执行中、成功和失败可重试。
struct PlanProposalCard: View {
    let message: ChatMessage
    let proposal: PlanProposal
    let onExecute: (PlanProposal) async -> PlanExecutionResult
    let onOpen: (PlanProposal) -> Void

    @State private var expanded = false
    @State private var execution = PlanExecutionTransaction()

    private var isExecuted: Bool {
        message.proposalResolved || execution.isSucceeded
    }

    private var canExpand: Bool {
        proposal.todos.count > 3
            || !proposal.descriptionMarkdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var visibleTodos: [PlanProposalEventPayloadTodosItem] {
        expanded ? proposal.todos : Array(proposal.todos.prefix(3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(alignment: .top, spacing: TTSpacing.xs) {
                Image(systemName: "list.bullet.clipboard")
                    .foregroundStyle(.tt.iconAccent)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text("执行计划")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                    Text(proposal.planName.isEmpty ? "未命名计划" : proposal.planName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(2)
                }
                Spacer(minLength: TTSpacing.xs)
                Button {
                    onOpen(proposal)
                } label: {
                    Label("打开", systemImage: "arrow.up.right.square")
                        .font(.tt.captionMedium)
                }
                .buttonStyle(.bordered)
                .tint(.tt.textAccent)
                .disabled(execution.isExecuting)

                Button {
                    Task { await execute() }
                } label: {
                    Group {
                        if execution.isExecuting {
                            HStack(spacing: TTSpacing.xxs) {
                                ProgressView().controlSize(.mini).tint(.white)
                                Text("执行中")
                            }
                        } else if isExecuted {
                            Label("已执行", systemImage: "checkmark")
                        } else if execution.errorMessage != nil {
                            Label("重试", systemImage: "arrow.clockwise")
                        } else {
                            Text("执行")
                        }
                    }
                    .font(.tt.captionMedium)
                }
                .buttonStyle(.borderedProminent)
                .tint(isExecuted ? .tt.bgSuccess : .tt.bgAccent)
                .disabled(execution.isExecuting || isExecuted)
            }

            if !proposal.overview.isEmpty {
                Text(proposal.overview)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }

            if !proposal.todos.isEmpty {
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    Text("\(proposal.todos.count) 项待办")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                    ForEach(visibleTodos, id: \.id) { todo in
                        HStack(alignment: .top, spacing: TTSpacing.xs) {
                            Circle()
                                .fill(todoStatusColor(todo.status))
                                .frame(width: 6, height: 6)
                                .padding(.top, 6)
                            Text(todo.content)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textPrimary)
                        }
                    }
                    if !expanded, proposal.todos.count > 3 {
                        Text("还有 \(proposal.todos.count - 3) 项…")
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .padding(.leading, TTSpacing.sm)
                    }
                }
            }

            if expanded,
               !proposal.descriptionMarkdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Divider().overlay(.tt.borderLight)
                Markdown(proposal.descriptionMarkdown)
                    .markdownTheme(.tabtinSystemNotice)
            }

            if canExpand {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                } label: {
                    HStack(spacing: TTSpacing.xs) {
                        Text(expanded ? "收起详情" : "查看详情")
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    }
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textAccent)
                }
                .buttonStyle(.plain)
            }

            if let error = execution.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textCritical)
                    .fixedSize(horizontal: false, vertical: true)
            } else if isExecuted {
                Text("Plan 已进入待发送队列，Agent 会按最新内容开始执行。")
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSuccess)
            }
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .strokeBorder(.tt.borderInteractive, lineWidth: 0.5)
        )
    }

    @MainActor
    private func execute() async {
        guard execution.begin() else { return }
        // 先让 SwiftUI 提交「执行中」帧，再进入入队事务。
        await Task.yield()
        let result = await onExecute(proposal)
        execution.finish(result)
    }

    private func todoStatusColor(_ status: String) -> Color {
        switch status {
        case "completed": return .tt.textSuccess
        case "in_progress": return .tt.textWarning
        case "cancelled": return .tt.textCritical.opacity(0.6)
        default: return .tt.textTertiary
        }
    }
}

/// 模式切换提案 inline 卡（非阻断）。Agent 在 plan 模式请求切到 agent 模式时 emit。
/// 「切到 Agent 模式」等价手动切模式 + 续聊（见 ConversationViewModel.approveModeSwitch）。
struct ModeSwitchProposalCard: View {
    let message: ChatMessage
    let proposal: ModeSwitchProposal
    let onApprove: (ModeSwitchProposal) -> Void
    let onIgnore: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundStyle(.tt.iconAccent)
                Text("切换到 Agent 模式")
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
            }
            if !proposal.reason.isEmpty {
                Text(proposal.reason)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }
            if !message.proposalResolved {
                HStack(spacing: TTSpacing.sm) {
                    Button { onApprove(proposal) } label: {
                        Text("切到 Agent 模式").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.tt.bgAccent)
                    Button("忽略") { onIgnore(message.id) }
                        .buttonStyle(.bordered)
                        .tint(.tt.textSecondary)
                }
                .padding(.top, TTSpacing.xxs)
            } else {
                Label("已处理", systemImage: "checkmark.circle.fill")
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSuccess)
            }
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .strokeBorder(.tt.borderInteractive, lineWidth: 0.5)
        )
    }
}
