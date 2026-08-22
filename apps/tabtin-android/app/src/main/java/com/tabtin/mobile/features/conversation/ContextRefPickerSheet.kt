package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 「添加上下文」资源选择 sheet（对齐 iOS ContextRefPickerSheet）。
 * 列出当前 Space 可引用的资源，点击一条加入 Composer 的 context ref chips。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ContextRefPickerSheet(
    resources: List<SpaceResource>,
    isLoading: Boolean,
    onSelect: (SpaceResource) -> Unit,
    onDismiss: () -> Unit,
) {
    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Text(
            text = stringResource(R.string.chat_add_context),
            style = TTFonts.subtitleSemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        )
        when {
            isLoading && resources.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xxl),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(TTSpacing.sm))
                        Text(
                            stringResource(R.string.chat_context_picker_loading),
                            style = TTFonts.caption,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                }
            }

            resources.isEmpty() -> {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = TTSpacing.xxl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        Icons.Default.Link,
                        contentDescription = null,
                        modifier = Modifier.size(28.dp),
                        tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                    Spacer(Modifier.height(TTSpacing.sm))
                    Text(
                        stringResource(R.string.chat_context_picker_empty),
                        style = TTFonts.body,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }

            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(bottom = TTSpacing.xxl),
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    items(resources, key = { it.id }) { resource ->
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            onClick = { onSelect(resource) },
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                ContextResourceIcon(resource = resource)
                                Spacer(Modifier.size(TTSpacing.md))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = resource.displayTitle,
                                        style = TTFonts.body,
                                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        text = resource.typeLabel,
                                        style = TTFonts.caption,
                                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
