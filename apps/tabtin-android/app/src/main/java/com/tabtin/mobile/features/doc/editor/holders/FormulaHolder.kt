package com.tabtin.mobile.features.doc.editor.holders

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.view.isVisible
import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockFormulaBinding
import com.tabtin.mobile.features.doc.editor.core.KatexFormulaHtml
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.web.WebViewRenderProcessGuard
import com.tabtin.mobile.ui.web.releaseSafely

/**
 * 块级公式只读真渲染。成功画 KaTeX，失败退回可读 LaTeX，不露节点类型名。
 */
public class FormulaHolder(
    private val binding: DocBlockFormulaBinding,
    private val onBlockLongPress: (id: String) -> Unit = {},
) : DocBlockViewHolder(binding.root) {

    private var blockId: String = ""
    private var webView: WebView? = null
    private var boundLatex: String = ""

    init {
        binding.root.setOnLongClickListener {
            onBlockLongPress(blockId)
            true
        }
    }

    override fun bind(item: TabDocBlockView) {
        val block = item as? TabDocBlockView.Formula ?: return
        blockId = block.id
        applySelectionState(block.isSelected)
        bindLatex(block.latex)
    }

    override fun onRecycled() {
        releaseWebView()
        super.onRecycled()
    }

    private fun bindLatex(latex: String) {
        boundLatex = latex
        val fallback = latex.ifEmpty {
            binding.root.context.getString(R.string.doc_formula_unavailable)
        }
        binding.fallback.text = fallback
        binding.fallback.isVisible = true
        binding.webContainer.isVisible = false
        if (latex.isEmpty()) {
            releaseWebView()
            return
        }
        ensureWebView().loadFormula(latex)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebView(): WebView {
        webView?.let { return it }
        val context = binding.root.context
        val created = WebView(context).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.setSupportZoom(false)
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): Boolean = true

                override fun onPageFinished(view: WebView?, url: String?) {
                    val latex = boundLatex
                    if (latex.isEmpty()) return
                    view?.evaluateJavascript(
                        "JSON.stringify(window.renderFormula(\"${escapeJs(latex)}\", true))",
                    ) { result ->
                        val ok = result.contains("\"ok\":true") || result.contains("\\\"ok\\\":true")
                        if (ok && boundLatex == latex) {
                            binding.fallback.isVisible = false
                            binding.webContainer.isVisible = true
                        }
                    }
                }

                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: RenderProcessGoneDetail?,
                ): Boolean = WebViewRenderProcessGuard.handle(
                    host = "tabdoc_formula",
                    view = view,
                    detail = detail,
                    onGone = {
                        webView = null
                        binding.webContainer.removeAllViews()
                        binding.fallback.isVisible = true
                        binding.webContainer.isVisible = false
                    },
                )
            }
        }
        binding.webContainer.removeAllViews()
        binding.webContainer.addView(
            created,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        webView = created
        return created
    }

    private fun WebView.loadFormula(latex: String) {
        val textColor = runCatching {
            String.format(
                "#%06X",
                0xFFFFFF and binding.fallback.currentTextColor,
            )
        }.getOrElse { "#1A1A1A" }
        val fontSize = TTFonts.Role.BODY.size
        loadDataWithBaseURL(
            KatexFormulaHtml.ASSET_BASE_URL,
            KatexFormulaHtml.page(textColorHex = textColor, fontSizePx = fontSize),
            "text/html",
            "utf-8",
            null,
        )
    }

    private fun releaseWebView() {
        webView?.releaseSafely()
        webView = null
        binding.webContainer.removeAllViews()
    }

    private fun escapeJs(value: String): String = buildString {
        value.forEach { ch ->
            when (ch) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                else -> append(ch)
            }
        }
    }
}
