package com.tabtin.mobile.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 需要编辑多项内容的手机表单。
 *
 * 它使用 [TTBottomSheet] 的稳定键盘避让，而不是把可滚动长表单放进居中 Dialog。
 * 这样输入框的自动定位只会作用于唯一的表单滚动容器，不会与窗口 resize 抢位置。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TTFormSheet(
    onDismissRequest: () -> Unit,
    title: @Composable () -> Unit,
    dismissEnabled: Boolean = true,
    scrollable: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
    actions: @Composable RowScope.() -> Unit,
) {
    TTBottomSheet(
        onDismissRequest = { if (dismissEnabled) onDismissRequest() },
        sheetState = rememberTTSheetState(confirmValueChange = { dismissEnabled }),
    ) {
        TTSheetColumn(
            scrollable = scrollable,
            modifier = Modifier
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xxxl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            title()
            content()
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                content = actions,
            )
        }
    }
}
