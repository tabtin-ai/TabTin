package com.tabtin.mobile.features.skills

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 连接器列表用品牌标；未命中批准品牌时回落 Lucide Plug。
 * 匹配规则在 `connector_brand_manifest.json`，不要在调用方写死 slug。
 */
@Composable
public fun ConnectorBrandGlyph(
    query: ConnectorBrandIconResolver.Query,
    size: Dp = 38.dp,
    cornerRadius: Dp = 10.dp,
    padded: Boolean = true,
) {
    val context = LocalContext.current
    val resolved = remember(query, context) {
        ConnectorBrandIconResolver.resolve(context, query)
    }
    // 单层芯片：与 Plug 同底同圆角，避免灰底套白底。
    val glyphModifier = Modifier
        .size(size)
        .clip(RoundedCornerShape(cornerRadius))
        .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
        .then(if (padded) Modifier.padding(8.dp) else Modifier)

    if (resolved != null) {
        Image(
            painter = painterResource(resolved.drawableRes),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = glyphModifier,
        )
    } else {
        Icon(
            painter = painterResource(R.drawable.lucide_plug),
            contentDescription = null,
            tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            modifier = glyphModifier,
        )
    }
}
