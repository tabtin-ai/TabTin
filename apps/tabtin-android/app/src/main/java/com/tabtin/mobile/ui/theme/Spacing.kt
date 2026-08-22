package com.tabtin.mobile.ui.theme

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

public object TTSpacing {

    // region 统一命名（与 iOS TTSpacing 一致）

    public val xxs: Dp = 2.dp
    public val xs: Dp = 4.dp
    public val sm: Dp = 8.dp
    public val md: Dp = 12.dp
    public val lg: Dp = 16.dp
    public val xl: Dp = 20.dp
    public val xxl: Dp = 24.dp
    public val xxxl: Dp = 32.dp
    public val huge: Dp = 48.dp

    // endregion

    // region 场景间距（对齐 iOS TTSpacing.ListRow / Screen）

    public object ListRow {
        public val horizontal: Dp = 16.dp
        public val vertical: Dp = 12.dp
        public val insets: PaddingValues = PaddingValues(horizontal = 16.dp, vertical = 12.dp)
    }

    public object Screen {
        public val horizontal: Dp = 16.dp
        public val vertical: Dp = 16.dp
        public val insets: PaddingValues = PaddingValues(horizontal = 16.dp, vertical = 16.dp)
    }

    // endregion
}
