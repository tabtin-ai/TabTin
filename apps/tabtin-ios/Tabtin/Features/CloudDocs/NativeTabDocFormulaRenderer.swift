import Foundation
import JavaScriptCore
import UIKit

/// 桌面正典 KaTeX 0.16.28 的移动端调用层。
///
/// 只负责 `katex.renderToString`，选项与 `packages/tabdoc-ui/src/editor/math-serializer.ts`
/// 对齐：`throwOnError: false`。呈现层再决定把 HTML 画进附件还是块级 WebView。
enum NativeTabDocFormulaRenderer {
    static let katexVersion = "0.16.28"

    struct Descriptor: Hashable, Sendable {
        var latex: String
        var displayMode: Bool
        var fontSize: CGFloat
        var textColorHex: String

        var cacheKey: String {
            "\(displayMode ? "d" : "i")|\(fontSize)|\(textColorHex)|\(latex)"
        }
    }

    /// 公式身份上的 LaTeX 源。解析后源码在 `sourceText`（attrs 已被抽走）；
    /// 测试/粘贴路径仍可能把源码留在 attrs。空串表示没有可画的公式。
    static func latex(from mathematics: NativeTabDocInlineMathematics) -> String {
        let raw = mathematics.attrs[mathematics.valueAttribute]?.value
            ?? mathematics.attrs["latex"]?.value
            ?? mathematics.attrs["text"]?.value
        let fromAttrs = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !fromAttrs.isEmpty { return fromAttrs }
        return mathematics.sourceText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func displayMode(from mathematics: NativeTabDocInlineMathematics) -> Bool {
        switch mathematics.attrs["display"]?.value {
        case let value as Bool:
            return value
        case let value as String:
            return value == "true"
        default:
            return false
        }
    }

    static func blockLatex(in rawNode: [String: AnyCodable]) -> String {
        let attrs = rawNode["attrs"]?.dictValue ?? [:]
        return (attrs["latex"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    static func isMathematicsBlock(_ rawType: String) -> Bool {
        rawType == "mathematicsBlock"
    }

    /// 同步产出 KaTeX HTML。库缺失、空 latex 或 JS 异常都返回 nil，调用方必须降级。
    @MainActor
    static func renderHTML(latex: String, displayMode: Bool) -> String? {
        let trimmed = latex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let katex = sharedContext?.objectForKeyedSubscript("katex"),
              let render = katex.objectForKeyedSubscript("renderToString")
        else { return nil }
        let options: [String: Any] = [
            "throwOnError": false,
            "displayMode": displayMode,
        ]
        guard let result = render.call(withArguments: [trimmed, options]),
              !result.isUndefined,
              !result.isNull,
              let html = result.toString(),
              !html.isEmpty
        else { return nil }
        return html
    }

    static func looksRendered(_ html: String) -> Bool {
        html.contains("katex") && !html.localizedCaseInsensitiveContains("mathematicsBlock")
    }

    static func resourceBaseURL() -> URL? {
        Bundle.main.url(forResource: "katex.min", withExtension: "css", subdirectory: "Katex")?
            .deletingLastPathComponent()
            ?? Bundle.main.resourceURL?.appendingPathComponent("Katex")
    }

    static func pageHTML(textColorHex: String, fontSize: CGFloat) -> String {
        """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <link rel="stylesheet" href="katex.min.css">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          #formula { color: \(textColorHex); font-size: \(fontSize)px; display: inline-block; }
        </style>
        </head>
        <body>
        <div id="formula"></div>
        <script src="katex.min.js"></script>
        <script>
          window.renderFormula = function(latex, displayMode) {
            try {
              if (typeof katex === 'undefined') {
                return { ok: false, error: 'katex missing' };
              }
              const html = katex.renderToString(String(latex), {
                throwOnError: false,
                displayMode: !!displayMode
              });
              const el = document.getElementById('formula');
              el.innerHTML = html;
              return { ok: true, html: html };
            } catch (e) {
              return { ok: false, error: String(e) };
            }
          };
        </script>
        </body>
        </html>
        """
    }

    /// 行内快照页：只铺 CSS，HTML 由 JSContext 先算好再注入。
    static func paintPageHTML(textColorHex: String, fontSize: CGFloat) -> String {
        """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <link rel="stylesheet" href="katex.min.css">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          #formula { color: \(textColorHex); font-size: \(fontSize)px; display: inline-block; }
        </style>
        </head>
        <body>
        <div id="formula"></div>
        </body>
        </html>
        """
    }

    @MainActor
    private static let sharedContext: JSContext? = {
        let context = JSContext()
        context?.exceptionHandler = { _, _ in }
        context?.evaluateScript("var window = this; var globalThis = this; var module = undefined;")
        guard let url = Bundle.main.url(
            forResource: "katex.min",
            withExtension: "js",
            subdirectory: "Katex"
        ) ?? Bundle.main.url(forResource: "katex.min", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8)
        else { return nil }
        context?.evaluateScript(source)
        return context
    }()
}

enum NativeTabDocFormulaL10n {
    static var unavailable: String {
        String(localized: String.LocalizationValue("tabDoc.formula.unavailable"), table: "TabDoc")
    }
}
