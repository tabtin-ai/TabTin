package com.tabtin.mobile.features.doc.editor.core

import android.graphics.Color
import android.graphics.drawable.Drawable
import android.text.Annotation
import android.text.Editable
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.SubscriptSpan
import android.text.style.SuperscriptSpan
import android.text.style.TypefaceSpan
import android.text.style.URLSpan
import android.text.style.UnderlineSpan

/**
 * Derived from anytype-kotlin core-ui Markup.kt (common).
 * Converts TabDocMarkup marks to Android Spannable for rendering.
 * Removed: Mention, Object, Emoji handling (not needed for TabDoc).
 */

public fun TabDocMarkup.toSpannable(
    textColor: Int,
    underlineHeight: Float = 2f,
    inlineImageProvider: InlineImageProvider? = null,
    formulaProvider: FormulaProvider? = null,
): SpannableStringBuilder {
    return SpannableStringBuilder(body).apply {
        applyMarks(
            marks = marks,
            textColor = textColor,
            underlineHeight = underlineHeight,
            inlineImageProvider = inlineImageProvider,
            formulaProvider = formulaProvider,
        )
    }
}

/**
 * 提供一张已经加载完成的行内图片。返回 null 表示这张图当前拿不到（还在下载、下载失败、
 * 或这条渲染路径没有加载生命周期），呈现层就保持底下那句可读的 alt 占位不动。
 */
public typealias InlineImageProvider = (TabDocMarkup.Mark.InlineImage) -> Drawable?

public fun Editable.setMarkup(
    markup: TabDocMarkup,
    textColor: Int,
    underlineHeight: Float = 2f,
    inlineImageProvider: InlineImageProvider? = null,
    formulaProvider: FormulaProvider? = null,
) {
    val built = SpannableStringBuilder(markup.body).apply {
        applyMarks(
            marks = markup.marks,
            textColor = textColor,
            underlineHeight = underlineHeight,
            inlineImageProvider = inlineImageProvider,
            formulaProvider = formulaProvider,
        )
    }

    val newText = built.toString()
    if (newText != toString()) {
        clear()
        append(newText)
    }

    removeSpans<DocSpan>()
    getSpans(0, length, Annotation::class.java)
        .filter { DocSpan.MarkIdentity.isIdentityKey(it.key) }
        .forEach { removeSpan(it) }

    // 清理剪贴板粘贴残留的标准 Android 格式 span，防止与新 DocSpan 产生重复 marks
    getSpans(0, length, StyleSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, UnderlineSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, StrikethroughSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, URLSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, ForegroundColorSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, BackgroundColorSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, SubscriptSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, SuperscriptSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, RelativeSizeSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, AbsoluteSizeSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }
    getSpans(0, length, TypefaceSpan::class.java).filter { it !is DocSpan }.forEach { removeSpan(it) }

    val spans = built.getSpans(0, built.length, Any::class.java)
    spans.forEach { span ->
        val start = built.getSpanStart(span)
        val end = built.getSpanEnd(span)
        val flags = built.getSpanFlags(span)
        if (start in 0..length && end in 0..length) {
            setSpan(span, start, end, flags)
        }
    }
}

public fun isRangeValid(mark: TabDocMarkup.Mark, textLength: Int): Boolean {
    return mark.from >= 0 && mark.to >= 0 && mark.from < mark.to && mark.to <= textLength
}

private fun SpannableStringBuilder.applyMarks(
    marks: List<TabDocMarkup.Mark>,
    textColor: Int,
    underlineHeight: Float,
    inlineImageProvider: InlineImageProvider? = null,
    formulaProvider: FormulaProvider? = null,
) {
    marks.forEach { mark ->
        if (!isRangeValid(mark, length)) return@forEach

        when (mark) {
            is TabDocMarkup.Mark.Bold -> setSpan(
                DocSpan.Bold(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG
            )
            is TabDocMarkup.Mark.Italic -> setSpan(
                DocSpan.Italic(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG
            )
            is TabDocMarkup.Mark.Strikethrough -> setSpan(
                DocSpan.Strikethrough(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG
            )
            is TabDocMarkup.Mark.Underline -> setSpan(
                DocSpan.Underline(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG
            )
            is TabDocMarkup.Mark.Code -> {
                setSpan(
                    DocSpan.Font(DocSpan.SPAN_MONOSPACE), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG
                )
                setSpan(
                    DocSpan.MarkIdentity.code(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG
                )
            }
            is TabDocMarkup.Mark.Link -> {
                setSpan(
                    DocSpan.Url(url = mark.url, color = textColor, underlineHeight = underlineHeight),
                    mark.from, mark.to, DEFAULT_SPANNABLE_FLAG
                )
                setSpan(
                    DocSpan.MarkIdentity.link(mark.url, mark.target),
                    mark.from,
                    mark.to,
                    DEFAULT_SPANNABLE_FLAG,
                )
            }
            is TabDocMarkup.Mark.TextColor -> {
                var hasVisualStyle = false
                val parsed = parseHexColor(mark.color)
                if (parsed != null) {
                    setSpan(DocSpan.TextColor(parsed, mark.color), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                    hasVisualStyle = true
                }
                val bgParsed = parseHexColor(mark.backgroundColor)
                if (bgParsed != null) {
                    setSpan(DocSpan.Background(bgParsed, mark.backgroundColor), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                    hasVisualStyle = true
                }
                if (mark.fontSize.isNotBlank()) {
                    val sizeInPx = parseFontSizePx(mark.fontSize)
                    if (sizeInPx != null) {
                        setSpan(DocSpan.FontSize(sizeInPx, mark.fontSize), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                        hasVisualStyle = true
                    }
                }
                if (mark.fontFamily.isNotBlank()) {
                    setSpan(DocSpan.Font(mark.fontFamily), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                    hasVisualStyle = true
                }
                if (hasVisualStyle) {
                    setSpan(
                        DocSpan.MarkIdentity.textStyle(
                            color = mark.color,
                            backgroundColor = mark.backgroundColor,
                            fontSize = mark.fontSize,
                            fontFamily = mark.fontFamily,
                        ),
                        mark.from,
                        mark.to,
                        DEFAULT_SPANNABLE_FLAG,
                    )
                }
            }
            is TabDocMarkup.Mark.Highlight -> {
                val parsed = parseHexColor(mark.color)
                if (parsed != null) {
                    setSpan(DocSpan.Background(parsed, mark.color), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                    setSpan(
                        DocSpan.MarkIdentity.highlight(mark.color),
                        mark.from,
                        mark.to,
                        DEFAULT_SPANNABLE_FLAG,
                    )
                }
            }
            is TabDocMarkup.Mark.Subscript -> {
                setSpan(DocSpan.Subscript(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                setSpan(DocSpan.RelativeSize(SCRIPT_SIZE_PROPORTION), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
            }
            is TabDocMarkup.Mark.Superscript -> {
                setSpan(DocSpan.Superscript(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                setSpan(DocSpan.RelativeSize(SCRIPT_SIZE_PROPORTION), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
            }
            is TabDocMarkup.Mark.Mathematics -> {
                // 身份 span 供编辑链路还原，与这张公式当前画成什么样无关。
                setSpan(
                    DocSpan.Mathematics(
                        mark.nodeType,
                        mark.valueAttribute,
                        mark.attrs,
                        mark.atomId,
                    ).toAnnotation(),
                    mark.from,
                    mark.to,
                    MATHEMATICS_SPANNABLE_FLAG,
                )
                val drawable = formulaProvider?.invoke(mark)
                if (drawable != null) {
                    setSpan(
                        DocSpan.MathematicsDrawable(drawable, mark.atomId),
                        mark.from,
                        mark.to,
                        DEFAULT_SPANNABLE_FLAG,
                    )
                } else {
                    setSpan(DocSpan.Font(DocSpan.SPAN_MONOSPACE), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                    setSpan(DocSpan.MathematicsStyle(), mark.from, mark.to, DEFAULT_SPANNABLE_FLAG)
                }
            }
            is TabDocMarkup.Mark.InlineImage -> {
                // 身份 span 供编辑链路还原，与这张图当前画成什么样无关。
                setSpan(
                    DocSpan.InlineImage(
                        mark.nodeType,
                        mark.attrs,
                        mark.atomId,
                    ).toAnnotation(),
                    mark.from,
                    mark.to,
                    INLINE_IMAGE_SPANNABLE_FLAG,
                )
                val drawable = inlineImageProvider?.invoke(mark)
                if (drawable != null) {
                    // 图片已经在手上才盖住占位串，所以永远不会出现空框。
                    setSpan(
                        DocSpan.InlineImageDrawable(drawable, mark.atomId),
                        mark.from,
                        mark.to,
                        DEFAULT_SPANNABLE_FLAG,
                    )
                } else {
                    // 加载中或加载失败：保持诚实 alt 占位，绝不显示空白、破图或原始地址。
                    setSpan(
                        DocSpan.Font(DocSpan.SPAN_MONOSPACE),
                        mark.from,
                        mark.to,
                        DEFAULT_SPANNABLE_FLAG,
                    )
                }
            }
            is TabDocMarkup.Mark.Unknown -> {
                // 不画任何样式。身份 annotation 让编辑回采能把 type + attrs 原样写回。
                setSpan(
                    DocSpan.UnknownMark(mark.type, mark.attrs).toAnnotation(),
                    mark.from,
                    mark.to,
                    UNKNOWN_MARK_SPANNABLE_FLAG,
                )
            }
        }
    }
}

/** 上下标相对正文的字号比例（对齐 Web 端 sup/sub 默认 ~0.75em）。 */
private const val SCRIPT_SIZE_PROPORTION = 0.75f

private fun parseHexColor(hex: String): Int? {
    if (hex.isBlank()) return null
    return try { Color.parseColor(hex) } catch (_: IllegalArgumentException) { null }
}

private fun parseFontSizePx(sizeStr: String): Int? {
    val numericPart = sizeStr.replace(Regex("[^0-9.]"), "")
    val value = numericPart.toFloatOrNull() ?: return null
    return when {
        sizeStr.endsWith("px") -> value.toInt()
        sizeStr.endsWith("pt") -> (value * 1.333f).toInt()
        sizeStr.endsWith("em") || sizeStr.endsWith("rem") -> (value * 16).toInt()
        else -> value.toInt()
    }
}

private const val DEFAULT_SPANNABLE_FLAG = Spannable.SPAN_EXCLUSIVE_INCLUSIVE

/** 光标停在公式末尾继续输入时，新文本不得被公式身份吸收。 */
private const val MATHEMATICS_SPANNABLE_FLAG = Spannable.SPAN_EXCLUSIVE_EXCLUSIVE

/** 图片占位相邻处继续输入时，新文本不得被图片身份吸收成第二张图片。 */
private const val INLINE_IMAGE_SPANNABLE_FLAG = Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
private const val UNKNOWN_MARK_SPANNABLE_FLAG = Spannable.SPAN_EXCLUSIVE_EXCLUSIVE

/**
 * TabDoc markup model — maps to our InlineMark system.
 */
public interface TabDocMarkup {
    public val body: String
    public val marks: List<Mark>

    public sealed class Mark {
        public abstract val from: Int
        public abstract val to: Int

        public data class Bold(override val from: Int, override val to: Int) : Mark()
        public data class Italic(override val from: Int, override val to: Int) : Mark()
        public data class Strikethrough(override val from: Int, override val to: Int) : Mark()
        public data class Underline(override val from: Int, override val to: Int) : Mark()
        public data class Code(override val from: Int, override val to: Int) : Mark()
        public data class Link(
            override val from: Int,
            override val to: Int,
            val url: String,
            val target: String? = null,
        ) : Mark()
        public data class TextColor(
            override val from: Int,
            override val to: Int,
            val color: String,
            val backgroundColor: String = "",
            val fontSize: String = "",
            val fontFamily: String = "",
        ) : Mark()
        public data class Highlight(override val from: Int, override val to: Int, val color: String) : Mark()
        public data class Subscript(override val from: Int, override val to: Int) : Mark()
        public data class Superscript(override val from: Int, override val to: Int) : Mark()

        /** 行内公式：批次 1a 先保证不丢、可辨认（等宽+斜体），批次 4 做公式渲染。 */
        public data class Mathematics(
            override val from: Int,
            override val to: Int,
            val nodeType: String = "mathematics",
            val valueAttribute: String = "latex",
            val attrs: Map<String, Any?> = emptyMap(),
            val atomId: String,
        ) : Mark()

        /** 行内图片：图片就绪时与文字同行真排版，拿不到图时退回可读的 alt 占位。 */
        public data class InlineImage(
            override val from: Int,
            override val to: Int,
            val nodeType: String = "image",
            val attrs: Map<String, Any?> = emptyMap(),
            val atomId: String,
        ) : Mark()

        /**
         * 未识别 mark 的范围身份：不产生视觉样式，但必须随编辑链路往返。
         * 对这段范围套格式或在内部打字会被拒绝，前后普通字仍可改。
         */
        public data class Unknown(
            override val from: Int,
            override val to: Int,
            val type: String,
            val attrs: Map<String, Any?> = emptyMap(),
        ) : Mark()
    }
}
