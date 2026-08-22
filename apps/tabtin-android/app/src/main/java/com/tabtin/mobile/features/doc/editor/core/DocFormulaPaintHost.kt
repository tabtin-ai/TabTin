package com.tabtin.mobile.features.doc.editor.core

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import kotlin.math.ceil
import kotlin.math.max

/**
 * 编辑器里常驻的行内出图面。和块级公式一样挂在当前页上，
 * 量完再拍成 ImageSpan。不要另开窗口、也不要塞进 Activity content。
 */
public object DocFormulaPaintHost {
    private var surface: DocFormulaPaintView? = null
    private val waiting = ArrayDeque<(DocFormulaPaintView) -> Unit>()

    public val isAttached: Boolean
        get() = surface != null

    public fun attach(view: DocFormulaPaintView) {
        surface = view
        while (waiting.isNotEmpty()) {
            waiting.removeFirst().invoke(view)
        }
    }

    public fun detach(view: DocFormulaPaintView) {
        if (surface === view) surface = null
    }

    public fun request(
        context: Context,
        latex: String,
        displayMode: Boolean,
        fontSizePx: Float,
        textColor: Int,
        onDone: (Drawable?) -> Unit,
    ) {
        if (latex.isEmpty()) {
            onDone(null)
            return
        }
        val run: (DocFormulaPaintView) -> Unit = { view ->
            view.enqueue(context, latex, displayMode, fontSizePx, textColor, onDone)
        }
        val current = surface
        if (current != null) {
            current.post { run(current) }
        } else {
            waiting.add(run)
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
public class DocFormulaPaintView(context: Context) : FrameLayout(context) {
    private val webView: WebView
    private var pageReady = false
    private var busy = false
    private val jobs = ArrayDeque<Job>()

    private data class Job(
        val context: Context,
        val latex: String,
        val displayMode: Boolean,
        val fontSizePx: Float,
        val textColor: Int,
        val onDone: (Drawable?) -> Unit,
    )

    init {
        webView = WebView(context).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            settings.javaScriptEnabled = true
            settings.setSupportZoom(false)
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    pageReady = true
                    pump()
                }
            }
        }
        addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        webView.loadDataWithBaseURL(
            KatexFormulaHtml.ASSET_BASE_URL,
            KatexFormulaHtml.page(textColorHex = "#1A1A1A", fontSizePx = 16f),
            "text/html",
            "utf-8",
            null,
        )
    }

    public fun enqueue(
        context: Context,
        latex: String,
        displayMode: Boolean,
        fontSizePx: Float,
        textColor: Int,
        onDone: (Drawable?) -> Unit,
    ) {
        jobs.add(Job(context, latex, displayMode, fontSizePx, textColor, onDone))
        pump()
    }

    private fun pump() {
        if (busy || !pageReady) return
        val job = jobs.removeFirstOrNull() ?: return
        busy = true
        val color = String.format("#%06X", 0xFFFFFF and job.textColor)
        val cssPx = KatexFormulaHtml.cssFontSizePx(
            job.fontSizePx,
            job.context.resources.displayMetrics.density,
        )
        val js = """
            JSON.stringify((function() {
              const el = document.getElementById('formula');
              if (el) {
                el.style.color = ${jsString(color)};
                el.style.fontSize = '${cssPx}px';
              }
              const result = window.renderFormula(${jsString(job.latex)}, ${job.displayMode});
              const rect = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
              return {
                ok: !!(result && result.ok && rect.width > 0 && rect.height > 0),
                width: Math.ceil(rect.width),
                height: Math.ceil(rect.height)
              };
            })())
        """.trimIndent()
        webView.evaluateJavascript(js) { result ->
            val cssSize = KatexFormulaHtml.measuredSize(result)
            if (cssSize == null) {
                finish(job, null)
                return@evaluateJavascript
            }
            webView.post {
                finish(job, capture(job.context, cssSize.first, cssSize.second))
            }
        }
    }

    private fun finish(job: Job, drawable: Drawable?) {
        job.onDone(drawable)
        busy = false
        pump()
    }

    private fun capture(context: Context, cssWidth: Int, cssHeight: Int): Drawable? {
        return runCatching {
            val width = max(webView.width, 1)
            val height = max(webView.height, 1)
            val bitmap = Bitmap.createBitmap(
                max(ceil(width.toDouble()).toInt(), 1),
                max(ceil(height.toDouble()).toInt(), 1),
                Bitmap.Config.ARGB_8888,
            )
            webView.draw(Canvas(bitmap))
            val cropped = DocFormulaSnapshotCrop.cropped(bitmap) ?: return@runCatching null
            val density = context.resources.displayMetrics.density
            val display = KatexFormulaHtml.snapshotDisplaySize(cssWidth, cssHeight, density)
            val shown = if (display.first == cropped.width && display.second == cropped.height) {
                cropped
            } else {
                Bitmap.createScaledBitmap(cropped, display.first, display.second, true)
            }
            shown.density = context.resources.displayMetrics.densityDpi
            BitmapDrawable(context.resources, shown).apply {
                setBounds(0, 0, display.first, display.second)
            }
        }.getOrNull()
    }
}

private fun jsString(value: String): String = buildString {
    append('"')
    value.forEach { ch ->
        when (ch) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            else -> append(ch)
        }
    }
    append('"')
}
