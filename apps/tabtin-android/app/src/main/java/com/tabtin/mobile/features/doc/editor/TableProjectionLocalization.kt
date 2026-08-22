package com.tabtin.mobile.features.doc.editor

import android.content.Context
import androidx.annotation.StringRes
import com.tabtin.mobile.R
import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableContentSummaryKind
import com.tabtin.mobile.features.doc.model.TableData

/** Resolves semantic complex-cell projections at the visible UI/clipboard boundary. */
internal object TableProjectionLocalization {
    fun cellText(context: Context, cell: TableCell): String =
        cell.projection?.render { kind -> context.getString(kind.stringResource) }
            ?: cell.text

    fun tableText(context: Context, table: TableData): String =
        table.copyText { cell -> cellText(context, cell) }

    @get:StringRes
    private val TableContentSummaryKind.stringResource: Int
        get() = when (this) {
            TableContentSummaryKind.WHITEBOARD -> R.string.doc_block_kind_tabwhiteboard
            TableContentSummaryKind.EMBEDDED_TABLE -> R.string.doc_block_kind_tabdata_block
            TableContentSummaryKind.EMBEDDED_HTML -> R.string.doc_block_kind_html_block
            TableContentSummaryKind.VIDEO -> R.string.doc_block_kind_youtube
            TableContentSummaryKind.COMPLEX_CONTENT -> R.string.doc_unsupported_content_generic
        }
}
