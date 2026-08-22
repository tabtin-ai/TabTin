package com.tabtin.mobile.features.doc.editor.core

import android.content.Context
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.util.Log
import android.util.LruCache
import coil.imageLoader
import coil.request.ImageRequest
import coil.request.SuccessResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * 行内图片的解码缓存与在途请求合并。
 *
 * 同一张图会在 RecyclerView 复用、滚动和重绑定中被反复请求，缓存以 `fileId` 为主键
 * （签名地址会过期漂移）。失败结果同样记账，避免对着一张坏图无限重试；
 * 记账后调用方拿不到 drawable，正文就保持底下那句可读的 alt 占位。
 *
 * 与 iOS `NativeTabDocInlineImageStore` 同口径：优先用 fileId 换新签名地址，
 * 换不到才退回文档里带的渲染期 src。
 */
public class DocInlineImageLoader(
    private val context: Context,
    private val scope: CoroutineScope,
    private val resolveDisplayUrl: suspend (fileId: String) -> String?,
    maxBitmapBytes: Int = DEFAULT_CACHE_BYTES,
) {
    private val bitmaps = object : LruCache<String, Bitmap>(maxBitmapBytes) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val failed = mutableSetOf<String>()
    private val inFlight = mutableSetOf<String>()

    /**
     * 拿一张已经就绪的行内图片。返回 null 表示还在下载、下载失败或没有可加载地址，
     * 呈现层必须保持诚实 alt 占位。
     */
    public fun drawable(
        mark: TabDocMarkup.Mark.InlineImage,
        lineHeight: Int,
        availableWidth: Int,
    ): Drawable? {
        val descriptor = DocInlineImagePresentation.descriptor(mark.attrs)
        val key = DocInlineImagePresentation.cacheKey(descriptor) ?: return null
        val bitmap = bitmaps.get(key) ?: return null
        val size = DocInlineImagePresentation.displaySize(
            intrinsicWidth = descriptor.intrinsicWidth,
            intrinsicHeight = descriptor.intrinsicHeight,
            loadedWidth = bitmap.width,
            loadedHeight = bitmap.height,
            lineHeight = lineHeight,
            availableWidth = availableWidth,
        )
        return BitmapDrawable(context.resources, bitmap).apply {
            setBounds(0, 0, size.width, size.height)
        }
    }

    /** 对还没就绪、也没失败过的图片各发一次请求；全部就绪时不会回调。 */
    public fun requestMissing(
        marks: List<TabDocMarkup.Mark.InlineImage>,
        onReady: () -> Unit,
    ) {
        marks.forEach { mark ->
            val descriptor = DocInlineImagePresentation.descriptor(mark.attrs)
            if (!descriptor.canLoad) return@forEach
            val key = DocInlineImagePresentation.cacheKey(descriptor) ?: return@forEach
            if (bitmaps.get(key) != null || key in failed || key in inFlight) return@forEach
            inFlight.add(key)
            scope.launch {
                val bitmap = try {
                    loadBitmap(descriptor)
                } catch (e: CancellationException) {
                    inFlight.remove(key)
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "Inline image load failed: ${e.message}")
                    null
                }
                inFlight.remove(key)
                if (bitmap == null) {
                    failed.add(key)
                    return@launch
                }
                bitmaps.put(key, bitmap)
                failed.remove(key)
                onReady()
            }
        }
    }

    /** 直接放入已解码图片，跳过网络。用于本地上传后立即可见，以及测试注入。 */
    public fun prime(
        bitmap: Bitmap,
        descriptor: DocInlineImagePresentation.Descriptor,
    ) {
        val key = DocInlineImagePresentation.cacheKey(descriptor) ?: return
        bitmaps.put(key, bitmap)
        failed.remove(key)
    }

    /** 会话切换或用户重试时清账，让坏图有机会重新加载。 */
    public fun reset() {
        bitmaps.evictAll()
        failed.clear()
        inFlight.clear()
    }

    private suspend fun loadBitmap(
        descriptor: DocInlineImagePresentation.Descriptor,
    ): Bitmap? {
        val url = resolveUrl(descriptor) ?: return null
        val request = ImageRequest.Builder(context)
            .data(url)
            // ImageSpan 要拿到真实 Bitmap 画进 Canvas，硬件位图取不到像素。
            .allowHardware(false)
            .build()
        val result = context.imageLoader.execute(request)
        return (result as? SuccessResult)
            ?.drawable
            ?.let { it as? BitmapDrawable }
            ?.bitmap
    }

    /** fileId 是稳定引用，优先换取新签名；换不到才退回文档里的渲染期 src。 */
    private suspend fun resolveUrl(
        descriptor: DocInlineImagePresentation.Descriptor,
    ): String? {
        if (descriptor.fileId.isNotEmpty()) {
            val resolved = try {
                resolveDisplayUrl(descriptor.fileId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Inline image url resolve failed: ${e.message}")
                null
            }
            if (!resolved.isNullOrBlank()) return resolved
        }
        return descriptor.source.takeIf(String::isNotBlank)
    }

    public companion object {
        private const val TAG: String = "DocInlineImage"
        private const val DEFAULT_CACHE_BYTES: Int = 32 * 1024 * 1024
    }
}
