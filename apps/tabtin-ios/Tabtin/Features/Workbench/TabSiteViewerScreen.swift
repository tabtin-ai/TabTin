import SwiftUI
import WebKit

/// TabSite 只读预览（Phase 5 首个内嵌 App）。已发布站点 → WKWebView 加载 published_url；
/// 未发布 → 空状态。纯只读、无独立 Service（URL 来自 context-item metadata）。
struct TabSiteViewerScreen: View {
    let siteId: String
    let siteUrl: String?
    let siteName: String

    @State private var isLoading = true
    @State private var loadError: String?
    @State private var reloadToken = UUID()
    @State private var recovery = WebContentProcessRecovery()
    @State private var showCopiedToast = false
    @Environment(\.openURL) private var openURL

    private var resolvedURL: URL? {
        guard let urlStr = siteUrl, !urlStr.isEmpty else { return nil }
        return URL(string: urlStr)
    }

    var body: some View {
        Group {
            if let url = resolvedURL {
                ZStack {
                    TabSiteWebView(url: url, isLoading: $isLoading,
                                   loadError: $loadError, reloadToken: reloadToken,
                                   onContentProcessTerminated: handleContentProcessTermination)
                        // 内容进程终止后同一实例救不回来，重试靠换 id 让 SwiftUI 整个重建。
                        .id(recovery.instanceId)
                    if let error = loadError {
                        WebHostLoadErrorView(message: error, onRetry: retry)
                    }
                }
            } else {
                unpublishedState
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(siteName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .overlay(alignment: .top) {
            if showCopiedToast {
                copiedToast.transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: TTSpacing.sm) {
                if isLoading && resolvedURL != nil {
                    ProgressView().scaleEffect(0.7)
                }
                Menu {
                    if resolvedURL != nil {
                        Button { copyLink() } label: { Label("复制链接", systemImage: "doc.on.doc") }
                        Button { openInBrowser() } label: { Label("在浏览器打开", systemImage: "safari") }
                        if loadError != nil {
                            Button { retry() } label: { Label("重试", systemImage: "arrow.clockwise") }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(.tt.iconAccent)
                }
                .disabled(resolvedURL == nil)
            }
        }
    }

    private var unpublishedState: some View {
        VStack(spacing: TTSpacing.md) {
            Image(systemName: "globe")
                .font(.tt.iconEmptyLG)
                .foregroundStyle(.tt.textTertiary)
            Text("站点尚未发布").font(.tt.bodySemibold).foregroundStyle(.tt.textSecondary)
            Text("发布后即可在此预览。")
                .font(.tt.body)
                .foregroundStyle(.tt.textTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(TTSpacing.lg)
    }

    private var copiedToast: some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.tt.bgSuccess)
            Text("链接已复制").font(.tt.meta).foregroundStyle(.tt.textPrimary)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
        .background(Capsule().fill(.tt.bgSubtle).shadow(color: .black.opacity(0.08), radius: 8, y: 4))
        .padding(.top, TTSpacing.md)
    }

    private func retry() {
        loadError = nil
        isLoading = true
        if recovery.isTerminated {
            // 内容进程没了之后 reload() / load() 打在旧实例上常常没反应，必须重建。
            recovery.recreate()
        } else {
            reloadToken = UUID()
        }
    }

    /// Web 内容进程被系统回收：上报 + 切「加载失败 + 重试」降级 UI，不留白屏。
    private func handleContentProcessTermination() {
        WebContentProcessGuard.handleTermination(host: .tabsiteViewer)
        recovery.markTerminated()
        isLoading = false
        loadError = WebContentProcessGuard.terminatedMessage
    }

    private func copyLink() {
        guard let urlStr = siteUrl else { return }
        UIPasteboard.general.string = urlStr
        withAnimation(.spring(duration: 0.3)) { showCopiedToast = true }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.spring(duration: 0.3)) { showCopiedToast = false }
        }
    }

    private func openInBrowser() {
        guard let url = resolvedURL else { return }
        openURL(url)
    }
}

/// WKWebView 只读包装。reloadToken 变更触发重载（重试用）。
struct TabSiteWebView: UIViewRepresentable {
    let url: URL
    @Binding var isLoading: Bool
    @Binding var loadError: String?
    let reloadToken: UUID
    let onContentProcessTerminated: @MainActor () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.currentToken = reloadToken
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard reloadToken != context.coordinator.currentToken else { return }
        context.coordinator.currentToken = reloadToken
        webView.load(URLRequest(url: url))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: TabSiteWebView
        var currentToken: UUID?

        init(parent: TabSiteWebView) { self.parent = parent }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            Task { @MainActor in parent.isLoading = true }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                parent.isLoading = false
                parent.loadError = nil
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in
                parent.isLoading = false
                parent.loadError = error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in
                parent.isLoading = false
                parent.loadError = error.localizedDescription
            }
        }

        /// 系统回收了 Web 内容进程：视图已经永久变白，且不会再有任何 `didFail*` 回调。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            Task { @MainActor in parent.onContentProcessTerminated() }
        }
    }
}
