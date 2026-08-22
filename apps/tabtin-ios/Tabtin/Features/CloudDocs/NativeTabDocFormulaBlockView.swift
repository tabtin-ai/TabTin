import SwiftUI
import UIKit
import WebKit

/// 块级公式只读真渲染。对齐桌面 `mathematicsBlock` 的 KaTeX displayMode。
///
/// 成功：独立一块公式。失败 / 内容进程回收：退回可读 LaTeX 源码，不露
/// `mathematicsBlock`，也不走通用「不支持的内容」。
struct NativeTabDocFormulaBlockView: View {
    let latex: String

    @State private var state: FormulaRenderState = .rendering
    @State private var recovery = WebContentProcessRecovery()
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .center) {
            if case .success(let height) = state {
                FormulaWebView(
                    latex: latex,
                    displayMode: true,
                    textColorHex: colorScheme == .dark ? "#EDEDED" : "#1A1A1A",
                    fontSize: TTFonts.Role.body.size,
                    state: $state,
                    onContentProcessTerminated: handleContentProcessTermination
                )
                .frame(height: height)
                .frame(maxWidth: .infinity)
                .id(recovery.instanceId)
                .accessibilityLabel(latex)
            } else {
                fallback
                FormulaWebView(
                    latex: latex,
                    displayMode: true,
                    textColorHex: colorScheme == .dark ? "#EDEDED" : "#1A1A1A",
                    fontSize: TTFonts.Role.body.size,
                    state: $state,
                    onContentProcessTerminated: handleContentProcessTermination
                )
                .frame(width: 1, height: 1)
                .opacity(0.001)
                .allowsHitTesting(false)
                .id(recovery.instanceId)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, TTSpacing.sm)
    }

    private var fallback: some View {
        Text(latex.isEmpty ? NativeTabDocFormulaL10n.unavailable : latex)
            .font(.tt.codeSM)
            .foregroundStyle(.tt.textSecondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
            .accessibilityLabel(latex.isEmpty ? NativeTabDocFormulaL10n.unavailable : latex)
    }

    @MainActor
    private func handleContentProcessTermination() {
        WebContentProcessGuard.handleTermination(host: .formulaBlock)
        if recovery.recoverAutomaticallyIfPossible() {
            state = .rendering
        } else {
            state = .failure
        }
    }
}

enum FormulaRenderState: Equatable {
    case rendering
    case success(height: CGFloat)
    case failure
}

private struct FormulaWebView: UIViewRepresentable {
    let latex: String
    let displayMode: Bool
    let textColorHex: String
    let fontSize: CGFloat
    @Binding var state: FormulaRenderState
    let onContentProcessTerminated: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(state: $state, onContentProcessTerminated: onContentProcessTerminated)
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: Coordinator.bridgeName)
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.loadHTMLString(
            NativeTabDocFormulaRenderer.pageHTML(textColorHex: textColorHex, fontSize: fontSize),
            baseURL: NativeTabDocFormulaRenderer.resourceBaseURL()
        )
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.render(latex: latex, displayMode: displayMode)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: Coordinator.bridgeName)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        static let bridgeName = "formulaBridge"

        weak var webView: WKWebView?
        private var state: Binding<FormulaRenderState>
        private let onContentProcessTerminated: @MainActor () -> Void
        private var pageReady = false
        private var pending: (latex: String, displayMode: Bool)?
        private var lastRendered: (latex: String, displayMode: Bool)?

        init(
            state: Binding<FormulaRenderState>,
            onContentProcessTerminated: @escaping @MainActor () -> Void
        ) {
            self.state = state
            self.onContentProcessTerminated = onContentProcessTerminated
        }

        func render(latex: String, displayMode: Bool) {
            guard pageReady else {
                pending = (latex, displayMode)
                return
            }
            guard lastRendered?.latex != latex || lastRendered?.displayMode != displayMode else {
                return
            }
            lastRendered = (latex, displayMode)
            guard let latexJSON = jsonString(latex) else {
                state.wrappedValue = .failure
                return
            }
            webView?.evaluateJavaScript(
                """
                (function() {
                  const result = window.renderFormula(\(latexJSON), \(displayMode));
                  const el = document.getElementById('formula');
                  const height = el ? Math.ceil(el.getBoundingClientRect().height) : 0;
                  window.webkit.messageHandlers.\(Self.bridgeName).postMessage({
                    ok: !!(result && result.ok && height > 0),
                    height: height
                  });
                })()
                """,
                completionHandler: nil
            )
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageReady = true
            if let pending {
                self.pending = nil
                render(latex: pending.latex, displayMode: pending.displayMode)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            decisionHandler(navigationAction.navigationType == .other ? .allow : .cancel)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onContentProcessTerminated()
        }

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

        private func jsonString(_ value: String) -> String? {
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return String(data: data, encoding: .utf8)
        }
    }
}

/// 行内出图：独立不透明窗口里的 WKWebView。不要挂进 SwiftUI overlay，
/// 透明度会让 takeSnapshot 拍到空图，正文只剩源码，左上角还会漏出最后一道公式。
enum NativeTabDocFormulaSnapshotter {
    @MainActor
    static func snapshot(
        descriptor: NativeTabDocFormulaRenderer.Descriptor
    ) async -> UIImage? {
        await NativeTabDocFormulaPaintController.shared.snapshot(descriptor)
    }
}

@MainActor
final class NativeTabDocFormulaPaintController: NSObject, WKNavigationDelegate {
    static let shared = NativeTabDocFormulaPaintController()

    private var hostWindow: UIWindow?
    private var webView: WKWebView?
    private var pageReady = false
    private var busy = false
    private var queue: [(NativeTabDocFormulaRenderer.Descriptor, CheckedContinuation<UIImage?, Never>)] = []

    func snapshot(
        _ descriptor: NativeTabDocFormulaRenderer.Descriptor
    ) async -> UIImage? {
        ensureHost()
        guard webView != nil else { return nil }
        return await withCheckedContinuation { continuation in
            queue.append((descriptor, continuation))
            pump()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        pump()
    }

    private func ensureHost() {
        if let hostWindow {
            hostWindow.isHidden = false
            return
        }
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else {
            return
        }
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 360, height: 180))
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.isUserInteractionEnabled = false
        webView.navigationDelegate = self

        let host = UIViewController()
        host.view.backgroundColor = .clear
        host.view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: host.view.leadingAnchor),
            webView.topAnchor.constraint(equalTo: host.view.topAnchor),
            webView.widthAnchor.constraint(equalToConstant: 360),
            webView.heightAnchor.constraint(equalToConstant: 180),
        ])

        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 360, height: 180)
        window.windowLevel = .statusBar + 1
        window.backgroundColor = .clear
        window.isUserInteractionEnabled = false
        window.rootViewController = host
        window.isHidden = false

        self.webView = webView
        self.hostWindow = window
        webView.loadHTMLString(
            NativeTabDocFormulaRenderer.paintPageHTML(textColorHex: "#1A1A1A", fontSize: 16),
            baseURL: NativeTabDocFormulaRenderer.resourceBaseURL()
        )
    }

    private func pump() {
        guard !busy, pageReady, let webView, !queue.isEmpty else { return }
        hostWindow?.isHidden = false
        let (descriptor, continuation) = queue.removeFirst()
        busy = true
        guard let html = NativeTabDocFormulaRenderer.renderHTML(
            latex: descriptor.latex,
            displayMode: descriptor.displayMode
        ), let htmlJSON = jsonString(html) else {
            finish(nil, continuation)
            return
        }
        webView.evaluateJavaScript(
            """
            Promise.resolve(document.fonts && document.fonts.ready).then(function() {
              const el = document.getElementById('formula');
              if (!el) return { ok: false, width: 0, height: 0 };
              el.style.color = \(jsonString(descriptor.textColorHex) ?? "\"#1A1A1A\"");
              el.style.fontSize = '\(Int(descriptor.fontSize))px';
              el.innerHTML = \(htmlJSON);
              const rect = el.getBoundingClientRect();
              return {
                ok: rect.width > 0 && rect.height > 0,
                width: Math.ceil(rect.width),
                height: Math.ceil(rect.height)
              };
            })
            """
        ) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                DispatchQueue.main.async {
                    self.paint(webView, continuation)
                }
            }
        }
    }

    private func paint(
        _ webView: WKWebView,
        _ continuation: CheckedContinuation<UIImage?, Never>
    ) {
        let size = webView.bounds.size.width > 0
            ? webView.bounds.size
            : CGSize(width: 360, height: 180)
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(origin: .zero, size: size)
        config.afterScreenUpdates = true
        webView.takeSnapshot(with: config) { [weak self] image, _ in
            Task { @MainActor in
                guard let self else { return }
                self.finish(
                    image.flatMap { NativeTabDocFormulaSnapshotCrop.cropped($0) },
                    continuation
                )
            }
        }
    }

    private func finish(
        _ image: UIImage?,
        _ continuation: CheckedContinuation<UIImage?, Never>
    ) {
        continuation.resume(returning: image)
        busy = false
        if queue.isEmpty {
            webView?.evaluateJavaScript(
                "var el=document.getElementById('formula'); if(el) el.innerHTML='';"
            )
            hostWindow?.isHidden = true
        }
        pump()
    }

    private func jsonString(_ value: String) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
