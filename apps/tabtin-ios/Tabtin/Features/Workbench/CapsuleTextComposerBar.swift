import SwiftUI

/// 胶囊菜单选「文字」后贴底展开的迷你输入条：自动聚焦键盘，发送走会话既有入队路径。
struct CapsuleTextComposerBar: View {
    var disabledReason: String?
    var onSend: (String) -> Void
    var onCancel: () -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        !trimmed.isEmpty && disabledReason == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            if let disabledReason {
                Text(disabledReason)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textWarning)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel(disabledReason)
            }

            HStack(alignment: .bottom, spacing: TTSpacing.sm) {
                TextField(
                    L10n.Agent.capsuleTextComposerPlaceholder,
                    text: $text,
                    axis: .vertical
                )
                .font(ConversationTypography.composerFont)
                .lineSpacing(ConversationTypography.composerLineSpacing)
                .foregroundStyle(disabledReason == nil ? .tt.textPrimary : .tt.textTertiary)
                .lineLimit(1...5)
                .focused($focused)
                .disabled(disabledReason != nil)
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .accessibilityLabel(L10n.Agent.capsuleTextComposerPlaceholder)

                Button {
                    guard canSend else { return }
                    onSend(trimmed)
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.tt.iconSubtitle)
                        .foregroundStyle(canSend ? .tt.textAccent : .tt.textTertiary)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel(L10n.Agent.capsuleTextComposerSendA11y)

                Button(L10n.Common.cancel) {
                    onCancel()
                }
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.Common.cancel)
            }
        }
        .padding(TTSpacing.md)
        .background(.tt.bgCanvasDefault.opacity(0.98), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        }
        .shadow(color: Color.black.opacity(0.12), radius: 16, y: 4)
        .onAppear {
            guard disabledReason == nil else { return }
            // 下一帧再聚焦，避免菜单收起动画吞掉键盘。
            DispatchQueue.main.async {
                focused = true
            }
        }
        .accessibilityElement(children: .contain)
    }
}
