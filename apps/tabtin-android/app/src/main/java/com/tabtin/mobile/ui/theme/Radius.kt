package com.tabtin.mobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

public object TTRadius {
    public val xs: Dp = 4.dp
    public val sm: Dp = 8.dp
    /** 交互控件默认圆角，对齐 Electron `rounded-interactive`。 */
    public val interactive: Dp = sm
    public val md: Dp = 12.dp
    public val lg: Dp = 16.dp
    public val xl: Dp = 20.dp
    /** 完全圆角，效果等价于 CircleShape；保留数值以与 iOS TTRadius.full 对齐 */
    public val full: Dp = 9999.dp

    public object Shapes {
        public val xs: RoundedCornerShape = RoundedCornerShape(TTRadius.xs)
        public val sm: RoundedCornerShape = RoundedCornerShape(TTRadius.sm)
        public val md: RoundedCornerShape = RoundedCornerShape(TTRadius.md)
        public val lg: RoundedCornerShape = RoundedCornerShape(TTRadius.lg)
        public val xl: RoundedCornerShape = RoundedCornerShape(TTRadius.xl)
        public val full: RoundedCornerShape = RoundedCornerShape(TTRadius.full)
    }
}

/**
 * 对话气泡专用形状令牌（非对称圆角）。
 *
 * 用户气泡右下角、AI 气泡左下角使用 [TTRadius.xs] 小圆角，其余三角为 [TTRadius.lg]。
 * 与 iOS `TTBubbleShape` 对齐。
 */
public object TTBubbleShape {
    public val outgoing: RoundedCornerShape = RoundedCornerShape(
        topStart = TTRadius.lg, topEnd = TTRadius.lg,
        bottomStart = TTRadius.lg, bottomEnd = TTRadius.xs,
    )
    public val incoming: RoundedCornerShape = RoundedCornerShape(
        topStart = TTRadius.lg, topEnd = TTRadius.lg,
        bottomStart = TTRadius.xs, bottomEnd = TTRadius.lg,
    )
}
