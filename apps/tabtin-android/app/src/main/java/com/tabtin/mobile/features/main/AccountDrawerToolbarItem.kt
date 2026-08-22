package com.tabtin.mobile.features.main

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 一级顶栏左侧三横杠：打开账户侧栏（资料、组织、设置等）。
 * 对齐 iOS `AccountDrawerToolbarButton`；用 [IconButton] 保留按钮底。
 */
@Composable
public fun AccountDrawerToolbarItem(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    IconButton(
        onClick = onClick,
        modifier = modifier.size(48.dp),
    ) {
        Icon(
            imageVector = Icons.Default.Menu,
            contentDescription = stringResource(R.string.account_drawer_open_menu),
            modifier = Modifier.size(21.dp),
            tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
        )
    }
}
