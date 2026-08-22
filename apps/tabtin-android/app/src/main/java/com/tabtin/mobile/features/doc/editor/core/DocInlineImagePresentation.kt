package com.tabtin.mobile.features.doc.editor.core

import com.tabtin.mobile.features.doc.model.InlineMark
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * 行内图片的呈现决策。
 *
 * 身份与写回由 [InlineMark.InlineImage.attrs] 独立承担，本对象只回答「这张图应该以
 * 什么形态出现在正文里」，不改写任何 attrs，也不生成新的引用地址。
 * 与 iOS `NativeTabDocInlineImagePresentation` 保持同一口径，双端排版结果必须一致。
 */
public object DocInlineImagePresentation {

    /** 行内图最多占据的行高倍数。再高就会把一行正文撑成一屏，读者失去上下文。 */
    public const val MAXIMUM_HEIGHT_IN_LINES: Float = 8f

    /** 缺少内在尺寸时锁定的高度（相对行高）。 */
    public const val FALLBACK_HEIGHT_IN_LINES: Float = 3f

    /** 从 attrs 抽出的呈现输入。[fileId] 是稳定引用，[source] 只是渲染期地址。 */
    public data class Descriptor(
        val fileId: String = "",
        val source: String = "",
        val alt: String = "",
        val title: String = "",
        val intrinsicWidth: Int? = null,
        val intrinsicHeight: Int? = null,
    ) {
        /** 没有任何可加载的地址时不必发起请求，直接走降级。 */
        val canLoad: Boolean get() = fileId.isNotEmpty() || source.isNotEmpty()
    }

    public data class DisplaySize(val width: Int, val height: Int)

    public fun descriptor(attrs: Map<String, Any?>): Descriptor = Descriptor(
        fileId = string(attrs["fileId"]).ifEmpty { string(attrs["file_id"]) },
        source = string(attrs["src"]),
        alt = string(attrs["alt"]),
        title = string(attrs["title"]),
        intrinsicWidth = positiveInt(attrs["width"]),
        intrinsicHeight = positiveInt(attrs["height"]),
    )

    /** 缓存键优先用 `fileId`：签名地址会过期漂移，同一张图会因此反复重下。 */
    public fun cacheKey(descriptor: Descriptor): String? = when {
        descriptor.fileId.isNotEmpty() -> "file:${descriptor.fileId}"
        descriptor.source.isNotEmpty() -> "src:${descriptor.source}"
        else -> null
    }

    /**
     * 图片异步到了之后，只有正文还是当时那一份才能用绑定快照重刷。
     * 用户已经改过字时必须放弃这次回调，否则会把正在输入的内容盖掉。
     */
    public fun canRefreshRenderedImages(boundBody: String, currentBody: String): Boolean =
        boundBody == currentBody

    /** 图片加载不出来时显示的诚实文案：只暴露 alt/title，不暴露签名地址或 fileId。 */
    public fun fallbackText(attrs: Map<String, Any?>): String =
        InlineMark.InlineImage.placeholderText(attrs)

    /** 无障碍标签始终可用，即使真图已经渲染出来。 */
    public fun accessibilityLabel(attrs: Map<String, Any?>, default: String): String {
        val descriptor = descriptor(attrs)
        return listOf(descriptor.alt, descriptor.title)
            .firstOrNull { it.trim().isNotEmpty() }
            ?.trim()
            ?: default
    }

    /**
     * 行内排版尺寸：按内在宽高比等比缩放，同时受正文宽度与最大行高双重约束。
     *
     * [intrinsicWidth]/[intrinsicHeight] 是 attrs 声明的尺寸，也是布局真源——它在图片下载
     * 之前就已知，因此加载前后的占位框与真图完全同尺寸，行高不会跳变。只有文档没声明尺寸
     * 时才退而求其次：锁定一个与行高成比例的高度，仅用实际解码尺寸决定宽高比。
     */
    public fun displaySize(
        intrinsicWidth: Int?,
        intrinsicHeight: Int?,
        loadedWidth: Int? = null,
        loadedHeight: Int? = null,
        lineHeight: Int,
        availableWidth: Int,
    ): DisplaySize {
        val safeLineHeight = max(lineHeight, 1)
        val maximumHeight = (safeLineHeight * MAXIMUM_HEIGHT_IN_LINES).toInt().coerceAtLeast(1)
        val maximumWidth = max(availableWidth, 1)

        if (intrinsicWidth != null && intrinsicHeight != null &&
            intrinsicWidth > 0 && intrinsicHeight > 0
        ) {
            return fitted(
                intrinsicWidth.toFloat(),
                intrinsicHeight.toFloat(),
                maximumWidth,
                maximumHeight,
            )
        }

        val lockedHeight = min(
            (safeLineHeight * FALLBACK_HEIGHT_IN_LINES).toInt(),
            maximumHeight,
        ).coerceAtLeast(1)
        if (loadedWidth == null || loadedHeight == null || loadedWidth <= 0 || loadedHeight <= 0) {
            val side = min(lockedHeight, maximumWidth).coerceAtLeast(1)
            return DisplaySize(side, side)
        }
        val aspect = loadedWidth.toFloat() / loadedHeight.toFloat()
        return fitted(lockedHeight * aspect, lockedHeight.toFloat(), maximumWidth, lockedHeight)
    }

    private fun fitted(
        width: Float,
        height: Float,
        maximumWidth: Int,
        maximumHeight: Int,
    ): DisplaySize {
        val scale = min(1f, min(maximumWidth / width, maximumHeight / height))
        return DisplaySize(
            width = min(max((width * scale).roundToInt(), 1), maximumWidth),
            height = min(max((height * scale).roundToInt(), 1), maximumHeight),
        )
    }

    private fun string(value: Any?): String = (value as? String).orEmpty()

    private fun positiveInt(value: Any?): Int? = when (value) {
        is Int -> value.takeIf { it > 0 }
        is Number -> value.toInt().takeIf { it > 0 }
        is String -> value.toIntOrNull()?.takeIf { it > 0 }
        else -> null
    }
}
