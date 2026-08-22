import SwiftUI

/// WKWebView 宿主的「加载失败」态：网络失败（`didFail*`）与 Web 内容进程终止
/// （[WebContentProcessGuard]）共用同一个出口。
///
/// **为什么这一处值得收成共享组件**，而全 App 其他 errorState 各写各的：内容进程终止后
/// 页面永久空白、不会自愈、也不再有任何回调，这个按钮是用户**唯一**的恢复入口。
/// 两份手抄已经走偏过——一处漏了 44pt 触达尺寸，两处都硬编码了「重试」（英文环境下
/// 会漏出中文）。唯一出口上的这类偏差，代价不是不好看，是降级路径直接失效。
struct WebHostLoadErrorView: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: TTSpacing.md) {
            Image(systemName: "wifi.exclamationmark")
                .font(.tt.iconEmptyLG)
                .foregroundStyle(.tt.textCritical)
            Text(L10n.ErrorRecovery.webHostLoadFailed)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textSecondary)
            Text(message)
                .font(.tt.body)
                .foregroundStyle(.tt.textTertiary)
                .multilineTextAlignment(.center)
            Button(L10n.Common.retry, action: onRetry)
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)
                // HIG 最小触达尺寸。白屏降级时这是唯一出口，点不准就等于没有降级。
                .frame(minWidth: 44, minHeight: 44)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(TTSpacing.lg)
        .background(.tt.bgCanvasDefault)
    }
}

#if DEBUG
#Preview("WebView 加载失败态") {
    WebHostLoadErrorView(message: WebContentProcessGuard.terminatedMessage) {}
}
#endif
