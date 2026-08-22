package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

private data class RefStyle(val accentLight: Color, val accentDark: Color)

private val REF_STYLES = mapOf(
    "tabdata" to RefStyle(Color(0xFF2F9461), Color(0xFF4EC374)),
    "tabdoc" to RefStyle(Color(0xFF3B82F6), Color(0xFF60A5FA)),
    "tabslide" to RefStyle(Color(0xFFF59E0B), Color(0xFFFBBF24)),
)
private val DEFAULT_REF_STYLE = RefStyle(Color(0xFF6B7280), Color(0xFF9CA3AF))

@Composable
internal fun ResourceReferenceBar(
    references: List<ResourceReference>,
    onRemove: (String) -> Unit,
    /** 只有宿主声明可打开的资源才接收卡片点击，其他引用维持纯上下文标签。 */
    canOpen: (ResourceReference) -> Boolean = { false },
    onOpen: ((ResourceReference) -> Unit)? = null,
) {
    LazyRow(
        modifier = Modifier
            .fillMaxWidth()
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        items(references, key = { it.id }) { ref ->
            val style = REF_STYLES[ref.normalizedType] ?: DEFAULT_REF_STYLE
            val accent = ttColor(style.accentLight, style.accentDark)
            val openReference = onOpen
            val openable = openReference != null && canOpen(ref)
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(TTRadius.full))
                    .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                    .border(0.5.dp, accent.copy(alpha = 0.2f), RoundedCornerShape(TTRadius.full))
                    .then(if (openable) Modifier.clickable { openReference.invoke(ref) } else Modifier)
                    .padding(start = TTSpacing.sm, top = TTSpacing.xxs, bottom = TTSpacing.xxs, end = TTSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ContextResourceIcon(
                    itemType = ref.normalizedType,
                    title = ref.title,
                    size = 14.dp,
                )
                Spacer(Modifier.width(TTSpacing.xxs))
                Text(
                    text = ref.title,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 120.dp),
                )
                Spacer(Modifier.width(TTSpacing.xxs))
                Text(
                    text = ref.resourceType,
                    style = TTFonts.caption,
                    color = accent.copy(alpha = 0.8f),
                )
                IconButton(
                    onClick = { onRemove(ref.id) },
                    modifier = Modifier.size(20.dp),
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = stringResource(R.string.common_remove),
                        modifier = Modifier.size(12.dp),
                        tint = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }
        }
    }
}
