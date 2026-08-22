package com.tabtin.mobile.features.clouddocs

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.ui.theme.TTRadius

/** 有白底完整 icon vs 无白底内容字形。 */
internal enum class TabTinAppIconVariant {
    /** 工作台磁贴等：自带白底圆角底座。 */
    APP,
    /** 列表 / App Home 行：无白底字形（缺字形时回退 APP）。 */
    GLYPH,
}

/**
 * TabTin 品牌图标。始终用 [Image] 保留彩色资产，禁止 [Icon]+tint 抹成单色。
 */
@Composable
internal fun TabTinAppIcon(
    appId: String,
    variant: TabTinAppIconVariant,
    size: Dp,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = TTRadius.sm,
) {
    val resId = when (variant) {
        TabTinAppIconVariant.APP -> AppIconResolver.resolveAppIcon(appId)
        TabTinAppIconVariant.GLYPH -> AppIconResolver.resolveListIcon(appId)
    }
    if (resId != null) {
        Image(
            painter = painterResource(resId),
            contentDescription = null,
            modifier = modifier
                .size(size)
                .then(
                    if (variant == TabTinAppIconVariant.APP) {
                        Modifier.clip(RoundedCornerShape(cornerRadius))
                    } else {
                        Modifier
                    },
                ),
            contentScale = ContentScale.Fit,
        )
    } else {
        Icon(
            imageVector = Icons.Filled.Apps,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = modifier.size(size),
        )
    }
}
