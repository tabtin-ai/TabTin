package com.tabtin.mobile.features.doc.editor.core

import android.graphics.drawable.Drawable
import android.util.LruCache

/**
 * 行内公式的解码缓存。
 *
 * 与 [DocInlineImageLoader] 同口径：只有已经就绪的图才盖住 LaTeX 源码；
 * 还在渲染或失败时返回 null，正文继续诚实显示源码。测试可 [prime]。
 */
public class DocFormulaLoader(
    maxEntries: Int = DEFAULT_CACHE_ENTRIES,
) {
    private val drawables = LruCache<String, Drawable>(maxEntries)
    private val failed = mutableSetOf<String>()

    public fun cacheKey(
        mark: TabDocMarkup.Mark.Mathematics,
        fontSizePx: Float,
        textColor: Int,
        sourceText: String = "",
    ): String {
        val latex = KatexFormulaHtml.sourceLatex(mark, sourceText)
        val display = KatexFormulaHtml.displayMode(mark.attrs)
        return "${if (display) "d" else "i"}|$fontSizePx|$textColor|$latex"
    }

    public fun prime(key: String, drawable: Drawable) {
        drawables.put(key, drawable)
        failed.remove(key)
    }

    public fun drawable(
        mark: TabDocMarkup.Mark.Mathematics,
        fontSizePx: Float,
        textColor: Int,
        sourceText: String = "",
    ): Drawable? {
        val latex = KatexFormulaHtml.sourceLatex(mark, sourceText)
        if (latex.isEmpty()) return null
        return drawables.get(cacheKey(mark, fontSizePx, textColor, sourceText))
    }

    public fun markFailed(key: String) {
        failed.add(key)
    }

    public fun requestMissing(
        context: android.content.Context,
        marks: List<TabDocMarkup.Mark.Mathematics>,
        fontSizePx: Float,
        textColor: Int,
        body: String = "",
        onReady: () -> Unit,
    ) {
        marks.forEach { mark ->
            val latex = KatexFormulaHtml.sourceLatex(mark, body)
            if (latex.isEmpty()) return@forEach
            val key = cacheKey(mark, fontSizePx, textColor, body)
            if (drawables.get(key) != null || key in failed) return@forEach
            DocFormulaSnapshotter.request(
                context = context,
                latex = latex,
                displayMode = KatexFormulaHtml.displayMode(mark.attrs),
                fontSizePx = fontSizePx,
                textColor = textColor,
            ) { drawable ->
                if (drawable == null) {
                    if (DocFormulaPaintHost.isAttached) {
                        failed.add(key)
                    }
                } else {
                    drawables.put(key, drawable)
                    onReady()
                }
            }
        }
    }

    public companion object {
        private const val DEFAULT_CACHE_ENTRIES: Int = 64
    }
}

public typealias FormulaProvider = (TabDocMarkup.Mark.Mathematics) -> Drawable?
