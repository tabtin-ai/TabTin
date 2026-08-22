package com.tabtin.mobile.features.doc.editor

import android.content.Context
import androidx.annotation.StringRes
import com.tabtin.mobile.R

/** Keeps schema type names out of the user-visible unsupported-block surface. */
internal object UnsupportedContentLocalization {
    private val productTypes = setOf(
        "tabwhiteboard",
        "tabdataBlock",
        "htmlBlock",
        "youtube",
    )

    private val titleKeys = listOf("title", "name", "alt", "label")
    private val sensitiveValueKeys = listOf(
        "tableId",
        "viewId",
        "canvasId",
        "fileId",
        "src",
        "href",
        "url",
    )

    fun label(context: Context, rawType: String?): String =
        context.getString(stringResource(rawType))

    /**
     * Projects a display-only title from a known embedded block's preserved source tree.
     * Identifier and URL fields are never fallbacks, and aliases of those implementation
     * values are skipped even when they appear in a title candidate.
     */
    fun title(rawType: String?, rawNode: Map<String, Any?>?): String? {
        if (rawType !in productTypes) return null
        val attrs = rawNode?.get("attrs") as? Map<*, *> ?: return null
        val sensitiveValues = sensitiveValueKeys.mapNotNullTo(mutableSetOf()) { key ->
            (attrs[key] as? String)?.trim()?.takeIf(String::isNotEmpty)
        }
        return titleKeys.firstNotNullOfOrNull { key ->
            (attrs[key] as? String)
                ?.trim()
                ?.takeIf(String::isNotEmpty)
                ?.takeUnless { candidate ->
                    candidate == rawType || candidate in sensitiveValues
                }
        }
    }

    @StringRes
    private fun stringResource(rawType: String?): Int = when (rawType) {
        "tabwhiteboard" -> R.string.doc_block_kind_tabwhiteboard
        "tabdataBlock" -> R.string.doc_block_kind_tabdata_block
        "htmlBlock" -> R.string.doc_block_kind_html_block
        "youtube" -> R.string.doc_block_kind_youtube
        else -> R.string.doc_unsupported_content_generic
    }
}
