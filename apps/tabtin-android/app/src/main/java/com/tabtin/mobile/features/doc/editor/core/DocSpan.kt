package com.tabtin.mobile.features.doc.editor.core

import com.tabtin.mobile.features.doc.DocLinkActivationPolicy
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.provider.Browser
import android.text.Annotation
import android.text.TextPaint
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.CharacterStyle
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.SubscriptSpan
import android.text.style.SuperscriptSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.text.style.UpdateAppearance
import android.util.Log
import android.view.View
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.math.roundToInt

/**
 * Derived from anytype-kotlin core-ui Span.
 * Custom Span types with marker interface for identification during markup processing.
 * Removed: ObjectLink, Emoji (anytype-specific).
 */
public interface DocSpan {

    public class Bold : StyleSpan(Typeface.BOLD), DocSpan
    public class Italic : StyleSpan(Typeface.ITALIC), DocSpan
    public class Strikethrough : StrikethroughSpan(), DocSpan
    public class Underline : UnderlineSpan(), DocSpan
    public class Subscript : SubscriptSpan(), DocSpan
    public class Superscript : SuperscriptSpan(), DocSpan

    /** 上下标配套的字号缩放；独立成 DocSpan 以便 setMarkup 清理/提取时识别。 */
    public class RelativeSize(proportion: Float) : RelativeSizeSpan(proportion), DocSpan
    public class TextColor(color: Int, public val value: String) : ForegroundColorSpan(color), DocSpan
    public class Background(color: Int, public val value: String) : BackgroundColorSpan(color), DocSpan
    public class FontSize(size: Int, public val value: String) : AbsoluteSizeSpan(size), DocSpan

    public class Url(
        public val url: String,
        public val color: Int,
        private val underlineHeight: Float
    ) : ClickableSpan(), DocSpan {

        override fun updateDrawState(ds: TextPaint) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val alphaText = (Color.alpha(color) * 0.65f).roundToInt()
                val alphaUnderline = (Color.alpha(color) * 0.35f).roundToInt()
                ds.color = Color.argb(alphaText, Color.red(color), Color.green(color), Color.blue(color))
                ds.underlineColor = Color.argb(alphaUnderline, Color.red(color), Color.green(color), Color.blue(color))
                ds.underlineThickness = underlineHeight
            } else {
                ds.color = color
                super.updateDrawState(ds)
            }
        }

        override fun onClick(widget: View) {
            if (!DocLinkActivationPolicy.canActivate(url)) return
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    putExtra(Browser.EXTRA_APPLICATION_ID, widget.context.packageName)
                }
                widget.context.startActivity(intent)
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "Could not open URL: $url", e)
                tryNormalizedUrl(widget.context, url)
            } catch (e: Exception) {
                Log.w(TAG, "Error opening URL: $url", e)
            }
        }

        private fun tryNormalizedUrl(context: Context, url: String) {
            val normalized = if (!url.startsWith("http://") && !url.startsWith("https://")) {
                "https://$url"
            } else url
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(normalized)))
            } catch (e: Exception) {
                Log.w(TAG, "Could not open normalized URL: $normalized", e)
            }
        }
    }

    public class Font(family: String) : TypefaceSpan(family), DocSpan

    public class Keyboard(value: String) : Annotation(KEYBOARD_KEY, value), DocSpan {
        public companion object {
            public const val KEYBOARD_KEY: String = "keyboard"
        }
    }

    public class Highlight(color: String) : Annotation(HIGHLIGHT_KEY, color), DocSpan {
        public companion object {
            public const val HIGHLIGHT_KEY: String = "highlight"
        }
    }

    /**
     * Android 的 TextUtils parcel 只保证框架 [Annotation] 的 key/value 可恢复。
     * 这些 key 是富文本 mark 的稳定身份层，视觉 span 只负责绘制，不再承载序列化真相。
     */
    public object MarkIdentity {
        public const val LINK_KEY: String = "tabdoc_mark_link"
        public const val LINK_V2_KEY: String = "tabdoc_mark_link_v2"
        public const val TEXT_STYLE_KEY: String = "tabdoc_mark_text_style"

        public data class TextStyle(
            val color: String,
            val backgroundColor: String,
            val fontSize: String,
            val fontFamily: String,
        )

        public data class Link(
            val url: String,
            val target: String?,
        )

        public fun code(): Annotation = Annotation(Keyboard.KEYBOARD_KEY, VALUE_ROUNDED)

        public fun link(url: String, target: String? = null): Annotation = Annotation(
            LINK_V2_KEY,
            buildJsonObject {
                put("href", url)
                if (target != null) put("target", target)
            }.toString(),
        )

        public fun linkFrom(annotation: Annotation): Link? {
            if (annotation.key == LINK_KEY) {
                return Link(url = annotation.value, target = null)
            }
            if (annotation.key != LINK_V2_KEY) return null
            val payload = runCatching {
                kotlinx.serialization.json.Json.parseToJsonElement(annotation.value).jsonObject
            }.getOrNull() ?: return null
            val href = (payload["href"] as? JsonPrimitive)
                ?.takeIf { it.isString }
                ?.contentOrNull
                ?: return null
            val targetElement = payload["target"]
            val target = when (targetElement) {
                null, JsonNull -> null
                is JsonPrimitive -> targetElement.takeIf { it.isString }?.contentOrNull
                    ?: return null
                else -> return null
            }
            return Link(url = href, target = target)
        }

        public fun textStyle(
            color: String,
            backgroundColor: String,
            fontSize: String,
            fontFamily: String,
        ): Annotation = Annotation(
            TEXT_STYLE_KEY,
            buildJsonObject {
                put("color", color)
                put("backgroundColor", backgroundColor)
                put("fontSize", fontSize)
                put("fontFamily", fontFamily)
            }.toString(),
        )

        public fun highlight(color: String): Annotation = Annotation(Highlight.HIGHLIGHT_KEY, color)

        public fun textStyleFrom(annotation: Annotation): TextStyle? {
            if (annotation.key != TEXT_STYLE_KEY) return null
            return runCatching {
                val payload = kotlinx.serialization.json.Json
                    .parseToJsonElement(annotation.value)
                    .jsonObject
                TextStyle(
                    color = (payload["color"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                    backgroundColor = (payload["backgroundColor"] as? JsonPrimitive)
                        ?.contentOrNull
                        .orEmpty(),
                    fontSize = (payload["fontSize"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                    fontFamily = (payload["fontFamily"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                )
            }.getOrNull()
        }

        public fun isIdentityKey(key: String): Boolean = key == Keyboard.KEYBOARD_KEY ||
            key == LINK_KEY ||
            key == LINK_V2_KEY ||
            key == TEXT_STYLE_KEY ||
            key == Highlight.HIGHLIGHT_KEY ||
            key == Mathematics.MATH_KEY ||
            key == InlineImage.IMAGE_KEY ||
            key == UnknownMark.KEY
    }

    /** 公式源码回退态的视觉斜体，不参与 parcel，也不得回收为用户的 italic mark。 */
    public class MathematicsStyle : CharacterStyle(), UpdateAppearance, DocSpan {
        override fun updateDrawState(textPaint: TextPaint) {
            textPaint.typeface = Typeface.create(textPaint.typeface, Typeface.ITALIC)
        }
    }

    /**
     * 行内图片的真实排版：把整段 alt 占位文字盖成一张图。
     *
     * 只在图片确实加载出来后才挂上，因此不存在"空框"状态——加载中和加载失败时这个 span
     * 不存在，用户看到的仍是底下那句可读的 alt 占位。图片身份始终由同范围的
     * [InlineImage] Annotation 承载，与是否挂了本 span 无关。
     */
    public class InlineImageDrawable(
        drawable: android.graphics.drawable.Drawable,
        public val atomId: String,
    ) : android.text.style.ImageSpan(drawable, ALIGN_BOTTOM), DocSpan

    /**
     * 行内公式的真实排版：把整段 LaTeX 源码盖成一张 KaTeX 图。
     *
     * 只在公式确实渲染出来后才挂上。身份始终由同范围的 [Mathematics] Annotation 承载。
     */
    public class MathematicsDrawable(
        drawable: android.graphics.drawable.Drawable,
        public val atomId: String,
    ) : android.text.style.ImageSpan(drawable, ALIGN_BASELINE), DocSpan

    /**
     * 行内公式写入 Editable 的完整运行期载荷。
     *
     * 必须使用基础 [Annotation] 承载编码后的全部字段，而不是把字段仅存在 Annotation
     * 子类属性里：Android 通过 TextUtils parcel 恢复富文本时只保证 Annotation 的 key/value，
     * 自定义子类字段会丢失。
     */
    public data class Mathematics(
        public val nodeType: String = "mathematics",
        public val valueAttribute: String = "latex",
        public val attrs: Map<String, Any?> = emptyMap(),
        public val atomId: String,
    ) {
        public fun toAnnotation(): Annotation = Annotation(MATH_KEY, encodeMathematics(this))

        public companion object {
            public const val MATH_KEY: String = "mathematics"

            public fun fromAnnotation(annotation: Annotation): Mathematics? {
                if (annotation.key != MATH_KEY) return null
                return decodeMathematics(annotation.value)
            }
        }
    }

    /**
     * 行内图片写入 Editable 的完整运行期载荷，约束与 [Mathematics] 相同：
     * 全部字段必须编码进基础 [Annotation] 的 value，parcel 才能恢复。
     */
    public data class InlineImage(
        public val nodeType: String = "image",
        public val attrs: Map<String, Any?> = emptyMap(),
        public val atomId: String,
    ) {
        public fun toAnnotation(): Annotation = Annotation(IMAGE_KEY, encodeInlineImage(this))

        public companion object {
            public const val IMAGE_KEY: String = "tabdoc_inline_image"

            public fun fromAnnotation(annotation: Annotation): InlineImage? {
                if (annotation.key != IMAGE_KEY) return null
                return decodeInlineImage(annotation.value)
            }
        }
    }

    /**
     * 未知 mark 的范围身份。不产生任何视觉 span，只把 type + attrs 编码进
     * [Annotation]，让编辑、parcel 和写回都能原样回收这段不透明标记。
     */
    public data class UnknownMark(
        public val type: String,
        public val attrs: Map<String, Any?> = emptyMap(),
    ) {
        public fun toAnnotation(): Annotation = Annotation(KEY, encodeUnknownMark(this))

        public companion object {
            public const val KEY: String = "tabdoc_unknown_mark"

            public fun fromAnnotation(annotation: Annotation): UnknownMark? {
                if (annotation.key != KEY) return null
                return decodeUnknownMark(annotation.value)
            }
        }
    }

    public companion object {
        private const val TAG = "DocSpan"
        public const val VALUE_ROUNDED: String = "rounded"
        public const val SPAN_MONOSPACE: String = "monospace"
    }
}

private fun encodeMathematics(mathematics: DocSpan.Mathematics): String = buildJsonObject {
    put("nodeType", mathematics.nodeType)
    put("valueAttribute", mathematics.valueAttribute)
    put("atomId", mathematics.atomId)
    put("attrs", mapToJsonObject(mathematics.attrs))
}.toString()

private fun decodeMathematics(value: String): DocSpan.Mathematics? = runCatching {
    val payload = kotlinx.serialization.json.Json.parseToJsonElement(value).jsonObject
    val nodeType = (payload["nodeType"] as? JsonPrimitive)?.contentOrNull ?: return null
    val valueAttribute = (payload["valueAttribute"] as? JsonPrimitive)?.contentOrNull ?: return null
    val atomId = (payload["atomId"] as? JsonPrimitive)?.contentOrNull ?: return null
    val attrs = (payload["attrs"] as? JsonObject)?.let(::jsonObjectToMap).orEmpty()
    DocSpan.Mathematics(
        nodeType = nodeType,
        valueAttribute = valueAttribute,
        attrs = attrs,
        atomId = atomId,
    )
}.getOrNull()

private fun encodeInlineImage(image: DocSpan.InlineImage): String = buildJsonObject {
    put("nodeType", image.nodeType)
    put("atomId", image.atomId)
    put("attrs", mapToJsonObject(image.attrs))
}.toString()

private fun decodeInlineImage(value: String): DocSpan.InlineImage? = runCatching {
    val payload = kotlinx.serialization.json.Json.parseToJsonElement(value).jsonObject
    val nodeType = (payload["nodeType"] as? JsonPrimitive)?.contentOrNull ?: return null
    val atomId = (payload["atomId"] as? JsonPrimitive)?.contentOrNull ?: return null
    val attrs = (payload["attrs"] as? JsonObject)?.let(::jsonObjectToMap).orEmpty()
    DocSpan.InlineImage(nodeType = nodeType, attrs = attrs, atomId = atomId)
}.getOrNull()

private fun encodeUnknownMark(mark: DocSpan.UnknownMark): String = buildJsonObject {
    put("type", mark.type)
    if (mark.attrs.isNotEmpty()) {
        put("attrs", mapToJsonObject(mark.attrs))
    }
}.toString()

private fun decodeUnknownMark(value: String): DocSpan.UnknownMark? = runCatching {
    val payload = kotlinx.serialization.json.Json.parseToJsonElement(value).jsonObject
    val type = (payload["type"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
        ?: return null
    val attrs = (payload["attrs"] as? JsonObject)?.let(::jsonObjectToMap).orEmpty()
    DocSpan.UnknownMark(type = type, attrs = attrs)
}.getOrNull()

private fun mapToJsonObject(map: Map<String, Any?>): JsonObject = buildJsonObject {
    map.forEach { (key, value) -> put(key, anyToJsonElement(value)) }
}

private fun anyToJsonElement(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is Boolean -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is String -> JsonPrimitive(value)
    is List<*> -> buildJsonArray { value.forEach { add(anyToJsonElement(it)) } }
    is Map<*, *> -> buildJsonObject {
        value.forEach { (key, nestedValue) ->
            if (key is String) put(key, anyToJsonElement(nestedValue))
        }
    }
    else -> JsonPrimitive(value.toString())
}

private fun jsonObjectToMap(value: JsonObject): Map<String, Any?> =
    value.mapValues { (_, element) -> jsonElementToAny(element) }

private fun jsonElementToAny(element: JsonElement): Any? = when (element) {
    JsonNull -> null
    is JsonPrimitive -> when {
        element.isString -> element.content
        element.content == "true" -> true
        element.content == "false" -> false
        element.content.contains('.') -> element.content.toDoubleOrNull()
        else -> element.content.toLongOrNull() ?: element.content
    }
    is JsonArray -> element.map(::jsonElementToAny)
    is JsonObject -> jsonObjectToMap(element)
}
