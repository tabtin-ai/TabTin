package com.tabtin.mobile.features.doc.editor.core

/**
 * 桌面正典 KaTeX 0.16.28 的离线 HTML 页。
 *
 * 选项对齐 `packages/tabdoc-ui/src/editor/math-serializer.ts`：`throwOnError: false`。
 * 资源在 `assets/katex/`，WebView 以 `file:///android_asset/katex/` 为 base。
 */
public object KatexFormulaHtml {
    public const val KATEX_VERSION: String = "0.16.28"
    public const val ASSET_BASE_URL: String = "file:///android_asset/katex/"

    public fun latex(attrs: Map<String, Any?>, valueAttribute: String = "latex"): String {
        val raw = attrs[valueAttribute] ?: attrs["latex"] ?: attrs["text"]
        return raw?.toString()?.trim().orEmpty()
    }

    /**
     * 解析后 LaTeX 在正文切片里，attrs 只留 `display` 等附加键。
     * 行内画公式必须走这条，不能只读 attrs，否则永远拿不到源码。
     */
    public fun sourceLatex(
        mark: TabDocMarkup.Mark.Mathematics,
        sourceText: String,
    ): String {
        val fromAttrs = latex(mark.attrs, mark.valueAttribute)
        if (fromAttrs.isNotEmpty()) return fromAttrs
        if (mark.from in 0..sourceText.length && mark.to in mark.from..sourceText.length) {
            return sourceText.substring(mark.from, mark.to).trim()
        }
        return ""
    }

    public fun displayMode(attrs: Map<String, Any?>): Boolean = when (val value = attrs["display"]) {
        is Boolean -> value
        is String -> value == "true"
        else -> false
    }

    public fun blockLatex(rawNode: Map<String, Any?>?): String {
        val attrs = rawNode?.get("attrs") as? Map<*, *> ?: return ""
        return attrs["latex"]?.toString()?.trim().orEmpty()
    }

    public fun looksRendered(html: String): Boolean =
        html.contains("katex") && !html.contains("mathematicsBlock", ignoreCase = true)

    /**
     * 正文 [android.widget.TextView.getTextSize] 是像素，KaTeX 页的 `px` 是 CSS 像素。
     * 高分屏上两者差一个 density，直接把 textSize 写进 CSS 会让行内公式大出两三倍。
     */
    public fun cssFontSizePx(textSizePx: Float, density: Float): Float {
        val safeDensity = if (density > 0f) density else 1f
        return textSizePx / safeDensity
    }

    /**
     * 行内附件的屏幕像素。入参是网页量到的 CSS 像素，不是裁切位图的边长。
     * 再拿裁切结果去乘 density 会把已经对齐正文的图再放大两三倍。
     */
    public fun snapshotDisplaySize(
        cssWidth: Int,
        cssHeight: Int,
        density: Float,
    ): Pair<Int, Int> {
        val scale = if (density > 0f) density else 1f
        return maxOf(1, kotlin.math.round(cssWidth * scale).toInt()) to
            maxOf(1, kotlin.math.round(cssHeight * scale).toInt())
    }

    /**
     * 解析 `evaluateJavascript` 回传的量测 JSON。
     * 系统会再包一层引号，块级公式用的同步写法也要认。
     */

    public fun measuredSize(evaluateJavascriptResult: String?): Pair<Int, Int>? {
        if (evaluateJavascriptResult.isNullOrBlank() || evaluateJavascriptResult == "null") {
            return null
        }
        var decoded = evaluateJavascriptResult.trim()
        repeat(2) {
            if (decoded.startsWith("\"") && decoded.endsWith("\"") && decoded.length >= 2) {
                decoded = decoded.substring(1, decoded.length - 1)
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
            }
        }
        if (!decoded.contains("\"ok\":true") && !decoded.contains("ok\":true")) return null
        val width = Regex("\"width\"\\s*:\\s*(\\d+)").find(decoded)?.groupValues?.get(1)?.toIntOrNull()
        val height = Regex("\"height\"\\s*:\\s*(\\d+)").find(decoded)?.groupValues?.get(1)?.toIntOrNull()
        if (width == null || height == null || width <= 0 || height <= 0) return null
        return width to height
    }

    public fun page(textColorHex: String, fontSizePx: Float): String = """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <link rel="stylesheet" href="katex.min.css">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          #formula { color: $textColorHex; font-size: ${fontSizePx}px; display: inline-block; }
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
              document.getElementById('formula').innerHTML = html;
              return { ok: true, html: html };
            } catch (e) {
              return { ok: false, error: String(e) };
            }
          };
        </script>
        </body>
        </html>
    """.trimIndent()
}
