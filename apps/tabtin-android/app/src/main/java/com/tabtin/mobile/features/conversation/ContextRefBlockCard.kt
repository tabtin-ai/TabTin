package com.tabtin.mobile.features.conversation

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun ContextRefBlockCard(
    block: BlockItem,
    onOpenInWorkbench: ((WorkbenchResourceOpenRequest) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val presented = remember(block) { ContextRefBlockPolicy.present(block) }
    val typeLabel = stringResource(typeLabelRes(presented.kind))
    val fallbackTitle = stringResource(R.string.chat_context_ref_generic)
    val title = presented.title.ifBlank { fallbackTitle }
    val locationHint = contextRefLocationHint(presented)
    val openRequest = presented.openRequest(locationHint)
    val context = LocalContext.current
    val canNavigate = presented.canNavigate

    Row(
        modifier = modifier
            .widthIn(max = 280.dp)
            .background(
                ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
                TTRadius.Shapes.sm,
            )
            .then(
                if (canNavigate) {
                    Modifier.clickable(role = Role.Button) {
                        when {
                            openRequest != null && onOpenInWorkbench != null ->
                                onOpenInWorkbench(openRequest)
                            !presented.externalUrl.isNullOrBlank() -> {
                                runCatching {
                                    context.startActivity(
                                        Intent(Intent.ACTION_VIEW, Uri.parse(presented.externalUrl)),
                                    )
                                }
                            }
                            openRequest != null ->
                                navigateToResource(
                                    context = context,
                                    resourceType = openRequest.resourceType,
                                    resourceId = openRequest.resourceId,
                                    title = openRequest.title ?: title,
                                    locationHint = openRequest.locationHint,
                                )
                        }
                    }
                } else {
                    Modifier
                },
            )
            .padding(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        ContextResourceIcon(
            itemType = presented.iconType,
            title = title,
            size = 22.dp,
        )
        Column(
            modifier = Modifier.weight(1f, fill = false),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
        ) {
            Text(
                text = typeLabel,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
            Text(
                text = title,
                style = TTFonts.metaSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            presented.displayPreview()?.let { preview ->
                Text(
                    text = preview,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            locationHint?.let { hint ->
                Text(
                    text = hint,
                    style = TTFonts.codeXS,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (canNavigate) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = stringResource(R.string.chat_context_ref_open_hint),
                modifier = Modifier.size(16.dp),
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun contextRefLocationHint(presented: ContextRefPresentation): String? {
    presented.explicitLocationHint?.let { return it }
    val parts = buildList {
        if (presented.rowIds.isNotEmpty()) {
            add(
                if (presented.rowIds.size == 1) {
                    stringResource(R.string.chat_context_ref_row_one, presented.rowIds.first())
                } else {
                    stringResource(R.string.chat_context_ref_row_many, presented.rowIds.size)
                },
            )
        }
        if (presented.fieldIds.isNotEmpty()) {
            add(
                if (presented.fieldIds.size == 1) {
                    stringResource(R.string.chat_context_ref_field_one, presented.fieldIds.first())
                } else {
                    stringResource(R.string.chat_context_ref_field_many, presented.fieldIds.size)
                },
            )
        }
    }
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

private fun typeLabelRes(kind: ContextRefKind): Int = when (kind) {
    ContextRefKind.WEB -> R.string.chat_context_ref_web
    ContextRefKind.TABLE -> R.string.chat_context_ref_table
    ContextRefKind.DOC -> R.string.chat_context_ref_doc
    ContextRefKind.SLIDE -> R.string.chat_context_ref_slide
    ContextRefKind.DESIGN -> R.string.chat_context_ref_design
    ContextRefKind.VIDEO -> R.string.chat_context_ref_video
    ContextRefKind.SITE -> R.string.chat_context_ref_site
    ContextRefKind.FOLDER -> R.string.chat_context_ref_folder
    ContextRefKind.CODE -> R.string.chat_context_ref_code
    ContextRefKind.MEMO -> R.string.chat_context_ref_memo
    ContextRefKind.GOAL -> R.string.chat_context_ref_goal
    ContextRefKind.CANVAS -> R.string.chat_context_ref_canvas
    ContextRefKind.FILE -> R.string.chat_context_ref_file
    ContextRefKind.GENERIC -> R.string.chat_context_ref_generic
}
