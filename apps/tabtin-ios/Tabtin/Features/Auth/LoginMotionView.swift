import SwiftUI
import WebKit

// MARK: - 登录页 hero 品牌动画
//
// 三幕品牌动画（共同现场 → 付诸行动 → 成果展开，循环），
// 随包在 Resources/LoginMotion/login-motion.html，WKWebView 离线内嵌播放：
// - 纯装饰：禁交互、禁滚动、对无障碍隐藏
// - 所有图形和时间轴自包含，不依赖网络；文案走 ?lang= 透传应用内语言
// - 页面隐藏时暂停，重新可见后原位继续；减少动态效果时展示静态执行幕
// - 内容进程终止走 WebContentProcessGuard 统一口径；自愈一次失败后
//   落回无底色品牌字样，不留白屏或旧版吉祥物

struct LoginMotionView: View {
    let isActive: Bool

    @State private var recovery = WebContentProcessRecovery()
    @State private var showsStaticFallback = false

    init(isActive: Bool = true) {
        self.isActive = isActive
    }

    /// 当前应用内语言（登录页语言切换与 L10n 同源），透传给动画页选 slogan 文案。
    private static var currentLang: String {
        LanguageManager.shared.effectiveLocale.identifier.lowercased().hasPrefix("zh") ? "zh" : "en"
    }

    var body: some View {
        Group {
            if showsStaticFallback {
                Text("TabTin")
                    .font(.system(size: 40, weight: .black))
                    .foregroundStyle(
                        Color(red: 32 / 255, green: 32 / 255, blue: 28 / 255)
                    )
            } else {
                LoginMotionWebView(
                    lang: Self.currentLang,
                    isActive: isActive,
                    onContentProcessTerminated: handleTermination
                )
                    // 语言切换时重建 WKWebView，确保本地页重新读取 ?lang=。
                    .id("\(recovery.instanceId)-\(Self.currentLang)")
            }
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }

    @MainActor
    private func handleTermination() {
        WebContentProcessGuard.handleTermination(host: .loginMotion)
        if !recovery.recoverAutomaticallyIfPossible() {
            showsStaticFallback = true
        }
    }
}

// MARK: - WKWebView 桥

private struct LoginMotionWebView: UIViewRepresentable {
    let lang: String
    let isActive: Bool
    let onContentProcessTerminated: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            isActive: isActive,
            onContentProcessTerminated: onContentProcessTerminated
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isUserInteractionEnabled = false
        webView.navigationDelegate = context.coordinator
        if let url = Self.pageURL {
            // 动画文案语言走 query 透传，页面内 URLSearchParams 读取。
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.queryItems = [URLQueryItem(name: "lang", value: lang)]
            webView.loadFileURL(components?.url ?? url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            // 资源缺失等同加载失败：直接走终止路径落静态图。
            context.coordinator.onContentProcessTerminated()
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.setActive(isActive, on: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.setActive(false, on: webView)
        webView.stopLoading()
        webView.navigationDelegate = nil
    }

    /// 随包动画页。XcodeGen 以 group 引用打包，子目录资源实际平铺在 bundle 根，
    /// 与 Mermaid 一致做带/不带 subdirectory 的双 fallback。
    private static let pageURL: URL? = {
        Bundle.main.url(
            forResource: "login-motion", withExtension: "html", subdirectory: "LoginMotion"
        ) ?? Bundle.main.url(forResource: "login-motion", withExtension: "html")
    }()

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private var isActive: Bool
        let onContentProcessTerminated: () -> Void

        init(
            isActive: Bool,
            onContentProcessTerminated: @escaping () -> Void
        ) {
            self.isActive = isActive
            self.onContentProcessTerminated = onContentProcessTerminated
        }

        func setActive(_ isActive: Bool, on webView: WKWebView) {
            self.isActive = isActive
            applyPlaybackState(to: webView)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            applyPlaybackState(to: webView)
        }

        /// 系统回收了 Web 内容进程：WebView 已永久空白，交宿主重建或降级。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onContentProcessTerminated()
        }

        private func applyPlaybackState(to webView: WKWebView) {
            webView.evaluateJavaScript(
                "window.tabtinMotion?.setActive(\(isActive ? "true" : "false"))",
                completionHandler: nil
            )
        }
    }
}

#if DEBUG
#Preview("登录页品牌动画") {
    LoginMotionView()
        .frame(width: 300, height: 246)
        .background(Color(.systemGray6))
}
#endif
