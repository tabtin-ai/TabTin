package com.tabtin.mobile.features.clouddocs

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/** 云文档资源类型图标：无白底字形优先（对齐 iOS AppGlyph）；不用 emoji。 */
@Composable
internal fun CloudDocsAppIcon(
    itemType: String,
    modifier: Modifier = Modifier,
    size: Dp = CloudDocsRowDefaults.iconSize,
) {
    val normalizedType = SpaceResource.normalizedType(itemType)
    val background = if (normalizedType == "tabdata") {
        ttColor(TTColors.CloudTableIconBackground, TTColors.Dark.CloudTableIconBackground)
    } else {
        ttColor(TTColors.CloudDocIconBackground, TTColors.Dark.CloudDocIconBackground)
    }
    Box(
        modifier = modifier
            .size(size)
            .background(background, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        TabTinAppIcon(
            appId = normalizedType,
            variant = TabTinAppIconVariant.GLYPH,
            size = size * 0.55f,
        )
    }
}


/**
 * 云文档列表统一行。三个分段共用。
 *
 * - 知识树：传 [depth] / [isExpandable] / [isExpanded]
 * - 最近 / 分享：[reservesDisclosureSpace] = false，图标贴左
 * - [meta] 放行尾「最近修改：时间」，不要塞进 [subtitle]
 * - [sharer] 只给「分享给我」：排成「由 [头像] 名字 分享」
 */
@Composable
internal fun CloudDocsRow(
    title: String,
    itemType: String,
    subtitle: String?,
    meta: String?,
    sharer: CloudDocsSharerAvatar? = null,
    modifier: Modifier = Modifier,
    depth: Int = 0,
    isPinned: Boolean = false,
    isExpandable: Boolean = false,
    isExpanded: Boolean = false,
    isLoadingChildren: Boolean = false,
    reservesDisclosureSpace: Boolean = true,
    onToggleExpand: (() -> Unit)? = null,
) {
    val indent = TTSpacing.lg * depth
    val rotation by animateFloatAsState(
        targetValue = if (isExpanded) 90f else 0f,
        label = "cloudDocsChevron",
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = CloudDocsRowDefaults.minRowHeight)
            .padding(horizontal = CloudDocsRowDefaults.horizontalPadding)
            .padding(start = indent),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        when {
            isExpandable -> {
                IconButton(
                    onClick = { onToggleExpand?.invoke() },
                    modifier = Modifier.size(CloudDocsRowDefaults.minHitSize),
                ) {
                    if (isLoadingChildren) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Default.ChevronRight,
                            contentDescription = stringResource(
                                if (isExpanded) R.string.cloud_docs_collapse else R.string.cloud_docs_expand,
                            ),
                            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            modifier = Modifier
                                .size(16.dp)
                                .rotate(rotation),
                        )
                    }
                }
            }
            reservesDisclosureSpace -> {
                Spacer(modifier = Modifier.width(CloudDocsRowDefaults.disclosureWidth))
            }
        }

        CloudDocsAppIcon(itemType = itemType)

        Column(
            modifier = Modifier
                .weight(1f)
                .padding(vertical = TTSpacing.xs),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
            ) {
                if (isPinned) {
                    Icon(
                        imageVector = Icons.Default.PushPin,
                        contentDescription = stringResource(R.string.cloud_docs_action_pin),
                        tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                        modifier = Modifier.size(12.dp),
                    )
                }
                Text(
                    text = title,
                    style = TTFonts.subtitleSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            if (sharer != null) {
                CloudDocsSharedByLine(sharer = sharer)
            } else if (!subtitle.isNullOrEmpty()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelMedium,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (!meta.isNullOrEmpty()) {
            Text(
                text = meta,
                style = MaterialTheme.typography.labelSmall,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = CloudDocsRowDefaults.metaMaxWidth),
            )
        }
    }
}

@Composable
private fun CloudDocsSharedByLine(sharer: CloudDocsSharerAvatar) {
    val tertiary = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    val suffix = stringResource(R.string.cloud_docs_shared_by_suffix)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
    ) {
        Text(
            text = stringResource(R.string.cloud_docs_shared_by_prefix),
            style = MaterialTheme.typography.labelMedium,
            color = tertiary,
            maxLines = 1,
        )
        IdentityColorAvatar(
            name = sharer.name,
            seed = sharer.seed,
            imageUrl = sharer.imageUrl,
            size = CloudDocsRowDefaults.sharerAvatarSize,
        )
        Text(
            text = sharer.name,
            style = MaterialTheme.typography.labelMedium,
            color = tertiary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (suffix.isNotEmpty()) {
            Text(
                text = suffix,
                style = MaterialTheme.typography.labelMedium,
                color = tertiary,
                maxLines = 1,
            )
        }
    }
}

internal object CloudDocsRowDefaults {
    val iconSize = 40.dp
    val minRowHeight = 64.dp
    val minHitSize = 44.dp
    val disclosureWidth = 20.dp
    val horizontalPadding = TTSpacing.md
    val sharerAvatarSize = 18.dp
    val metaMaxWidth = 176.dp
}
