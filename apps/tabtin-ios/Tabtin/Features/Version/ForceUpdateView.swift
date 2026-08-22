import SwiftUI

/// 强制更新全屏拦截页：不可关闭、无返回，只能点「立即更新」跳转商店/落地页。
/// 通过 RootView 的 fullScreenCover 呈现；binding 的 set 为 no-op 保证无法被用户关闭。
struct ForceUpdateView: View {
    let decision: VersionGateDecision
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "arrow.up.circle.fill")
                .font(.tt.iconEmptySplash)
                .foregroundStyle(.tint)

            Text(decision.title.isEmpty ? "需要更新" : decision.title)
                .font(.tt.title)
                .fontWeight(.bold)
                .multilineTextAlignment(.center)

            Text(decision.message.isEmpty ? "当前版本过旧，请更新后继续使用。" : decision.message)
                .font(.tt.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            if !decision.latestVersion.isEmpty {
                Text("最新版本 \(decision.latestVersion)")
                    .font(.tt.meta)
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            Button {
                if let url = URL(string: decision.resolvedStoreURL) {
                    openURL(url)
                }
            } label: {
                Text("立即更新")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        // 双保险：fullScreenCover 本身无下滑关闭，这里再显式禁用交互式关闭。
        .interactiveDismissDisabled(true)
    }
}
