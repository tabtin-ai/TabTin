import SwiftUI
import WebKit

// MARK: - Mermaid 离线渲染（对齐 Electron MermaidBlock）
//
// Electron 聊天里 `language=mermaid` 的代码块用 mermaid.js 客户端渲成 SVG；
// iOS 此前只降级显示源码。这里用 WKWebView + 随包 mermaid.min.js（与桌面同版本，
// Resources/Mermaid/）离线渲染，无网络依赖：
// - 成功：SVG 图，按内容自适应高度，宽度超出时等比缩放
// - 失败 / 渲染中：调用方自己的回退视图（通常是原代码块）——流式中间态语法
//   不完整属常态，不弹错误
// - securityLevel: strict，与 Electron 相同；WebView 禁滚动、禁导航跳转

/// 渲染结果状态。fallback 的显隐由调用方按此状态决定。
enum MermaidRenderState: Equatable {
    case rendering
    case success(height: CGFloat)
    case failure
}

/// mermaid 代码块视图：成功前显示 `fallback`，成功后切换为渲染出的图。
/// 流式期间代码不断增长，用 350ms 防抖过滤中间态，避免反复渲染失败闪烁。
struct MermaidBlockView<Fallback: View>: View {
    let code: String
    @ViewBuilder var fallback: () -> Fallback

    @State private var state: MermaidRenderState = .rendering
    /// 防抖后真正提交给 WebView 的代码；nil 表示还没稳定过。
    @State private var settledCode: String?
    @State private var recovery = WebContentProcessRecovery()
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .topLeading) {
            if case .success(let height) = state, let settledCode {
                // 阅读体验优先：图表像文章插图一样融入正文流，
                // 不加装饰性边框 / 卡片壳（design-system §3 对话阅读层）。
                MermaidWebView(
                    code: settledCode,
                    theme: colorScheme == .dark ? "dark" : "default",
                    state: $state,
                    onContentProcessTerminated: handleContentProcessTermination
                )
                .frame(height: height)
                .frame(maxWidth: .infinity)
                .id(recovery.instanceId)
            } else {
                fallback()
                // 隐藏探针：在后台渲染，成功后才切换主视图，避免占位闪烁。
                if let settledCode {
                    MermaidWebView(
                        code: settledCode,
                        theme: colorScheme == .dark ? "dark" : "default",
                        state: $state,
                        onContentProcessTerminated: handleContentProcessTermination
                    )
                    .frame(width: 1, height: 1)
                    .opacity(0.001)
                    .allowsHitTesting(false)
                    .id(recovery.instanceId)
                }
            }
        }
        .task(id: code) {
            // 流式防抖：代码停止变化 350ms 后才尝试渲染。
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            if settledCode != code {
                state = .rendering
                settledCode = code
            }
        }
    }

    /// Web 内容进程被系统回收：图表所在的 WebView 已经永久变白。
    ///
    /// 这里是聊天流里的内嵌图，没有放「重试」按钮的位置，降级路径换成两级：先静默重建一次
    /// （多数是一次性的内存尖峰，重建就能好）；再次终止就落到 `fallback`——用户看到的是
    /// 原始 mermaid 源码，内容仍然可读，不是白屏。
    @MainActor
    private func handleContentProcessTermination() {
        WebContentProcessGuard.handleTermination(host: .mermaidBlock)
        if recovery.recoverAutomaticallyIfPossible() {
            state = .rendering
        } else {
            state = .failure
        }
    }
}

// MARK: - WKWebView 桥

private struct MermaidWebView: UIViewRepresentable {
    let code: String
    let theme: String
    @Binding var state: MermaidRenderState
    let onContentProcessTerminated: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(state: $state, onContentProcessTerminated: onContentProcessTerminated)
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: MermaidHTML.bridgeName)
        if let library = MermaidHTML.libraryScript {
            controller.addUserScript(library)
        }
        controller.addUserScript(MermaidHTML.runnerScript)

        let config = WKWebViewConfiguration()
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.loadHTMLString(MermaidHTML.page, baseURL: nil)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.render(code: code, theme: theme)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: MermaidHTML.bridgeName)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        private var state: Binding<MermaidRenderState>
        private let onContentProcessTerminated: @MainActor () -> Void
        private var pageReady = false
        private var pendingRender: (code: String, theme: String)?
        private var lastRendered: (code: String, theme: String)?

        init(
            state: Binding<MermaidRenderState>,
            onContentProcessTerminated: @escaping @MainActor () -> Void
        ) {
            self.state = state
            self.onContentProcessTerminated = onContentProcessTerminated
        }

        func render(code: String, theme: String) {
            guard pageReady else {
                pendingRender = (code, theme)
                return
            }
            guard lastRendered?.code != code || lastRendered?.theme != theme else { return }
            lastRendered = (code, theme)
            guard
                let codeJSON = MermaidHTML.jsonString(code),
                let themeJSON = MermaidHTML.jsonString(theme)
            else {
                state.wrappedValue = .failure
                return
            }
            webView?.evaluateJavaScript(
                "window.renderMermaid(\(codeJSON), \(themeJSON))",
                completionHandler: nil
            )
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageReady = true
            if let pending = pendingRender {
                pendingRender = nil
                render(code: pending.code, theme: pending.theme)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            // 只允许初始 loadHTMLString；图内链接一律拦截。
            decisionHandler(navigationAction.navigationType == .other ? .allow : .cancel)
        }

        /// 系统回收了 Web 内容进程：图已经没了，且不会再有任何回调。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onContentProcessTerminated()
        }

        // MARK: WKScriptMessageHandler

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any] else { return }
            if body["ok"] as? Bool == true, let height = body["height"] as? Double, height > 0 {
                state.wrappedValue = .success(height: CGFloat(height))
            } else {
                state.wrappedValue = .failure
            }
        }
    }
}

// MARK: - HTML / JS 模板

private enum MermaidHTML {
    static let bridgeName = "mermaidBridge"

    static let page = """
    <!doctype html>
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      #container { display: flex; justify-content: center; padding: 4px 0; box-sizing: border-box; }
      #container svg { max-width: 100%; height: auto; }
    </style>
    </head>
    <body><div id="container"></div></body>
    </html>
    """

    /// 随包 mermaid.min.js（与 Electron 同版本）。找不到资源时返回 nil，渲染走失败回退。
    @MainActor
    static let libraryScript: WKUserScript? = {
        let url = Bundle.main.url(
            forResource: "mermaid.min", withExtension: "js", subdirectory: "Mermaid"
        ) ?? Bundle.main.url(forResource: "mermaid.min", withExtension: "js")
        guard let url, let source = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }()

    @MainActor
    static let runnerScript = WKUserScript(
        source: """
        window.renderMermaid = async function(code, theme) {
          const post = (payload) => {
            window.webkit.messageHandlers.\(bridgeName).postMessage(payload);
          };
          try {
            if (typeof mermaid === 'undefined') {
              post({ ok: false, error: 'mermaid library missing' });
              return;
            }
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme });
            const { svg } = await mermaid.render('m' + Math.floor(Math.random() * 1e9), code);
            const el = document.getElementById('container');
            el.innerHTML = svg;
            requestAnimationFrame(() => {
              post({ ok: true, height: Math.ceil(el.getBoundingClientRect().height) });
            });
          } catch (e) {
            post({ ok: false, error: String(e) });
          }
        };
        """,
        injectionTime: .atDocumentEnd,
        forMainFrameOnly: true
    )

    static func jsonString(_ value: String) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

#if DEBUG
#Preview("Mermaid 渲染") {
    ScrollView {
        MermaidBlockView(
            code: """
            graph LR
                A[开始] --> B{判断}
                B -->|条件 1| C[处理 A]
                B -->|条件 2| D[处理 B]
                C --> E[结束]
                D --> E
            """
        ) {
            Text("graph LR …")
                .font(.tt.codeSM)
                .padding()
        }
        .padding(TTSpacing.lg)
    }
}
#endif
