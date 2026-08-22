import SwiftUI

/// 输入框上方的统一「资料」反馈。它只描述已有的照片、相机、文件和上下文引用，
/// 不把桌面端的 Skill、MCP、Preset 或跨会话引用伪装成移动端可用能力。
struct AttachmentSummaryView: View {
    let summary: ComposerMaterialSummary
    let onCancelAllUploads: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: TTSpacing.xs) {
            Image(systemName: summary.sendingBlocker == nil ? "tray.full" : "arrow.up.circle")
                .font(.tt.iconCaption)
                .foregroundStyle(statusColor)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                Text(detail)
                    .font(.tt.caption)
                    .foregroundStyle(detailColor)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            if summary.cancellableUploadCount > 0 {
                Button("取消全部上传", action: onCancelAllUploads)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textCritical)
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("取消全部上传并移除未完成附件")
                    .accessibilityHint("停止未完成上传，并移除这些附件")
            }
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                .fill(backgroundColor)
        )
    }

    private var title: String {
        "资料 \(summary.totalCount) 项 · 已就绪 \(summary.readyCount) 项"
    }

    private var detail: String {
        switch summary.sendingBlocker {
        case .uploading(let count):
            return "\(count) 个附件正在上传，完成后才能发送"
        case .failed(let count):
            return "\(count) 个附件上传失败，请重试或移除后发送"
        case nil:
            if summary.contextReferenceCount > 0 && summary.attachmentCount == 0 {
                return "\(summary.contextReferenceCount) 条上下文引用已准备好"
            }
            return "附件与上下文已准备好，可随本条消息发送"
        }
    }

    private var statusColor: Color {
        switch summary.sendingBlocker {
        case .uploading: return .tt.iconAccent
        case .failed: return .tt.textCritical
        case nil: return .tt.textSuccess
        }
    }

    private var detailColor: Color {
        switch summary.sendingBlocker {
        case .failed: return .tt.textCritical
        case .uploading, .none: return .tt.textTertiary
        }
    }

    private var backgroundColor: Color {
        switch summary.sendingBlocker {
        case .failed: return .tt.bgCritical.opacity(0.07)
        case .uploading: return .tt.bgAccent.opacity(0.07)
        case nil: return .tt.bgSuccess.opacity(0.06)
        }
    }
}
