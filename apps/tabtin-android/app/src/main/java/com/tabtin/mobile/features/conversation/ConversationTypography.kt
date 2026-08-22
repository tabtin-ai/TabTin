package com.tabtin.mobile.features.conversation

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.tabtin.mobile.ui.theme.TTFonts

/**
 * 会话阅读排版，对齐 Electron `chatDesignTokens`：
 * `CHAT_MESSAGE_TEXT_*` / `CHAT_STEP_TEXT` / `COMPOSER_TEXT_*`。
 *
 * App chrome（导航、列表、设置）走 [TTFonts] 的 14sp `body`；
 * **本对象只服务对话阅读面**，避免长文与控件密度抢同一档。
 *
 * 正典：`apps/tabtin-android/docs/design-system.md` §3。
 */
public object ConversationTypography {

    /** 消息正文 / Markdown：15sp（Electron `CHAT_MESSAGE_TEXT_BODY_BASE`）。 */
    public const val BODY_SIZE_SP: Float = 15f

    /** 一级标题（Electron `CHAT_MARKDOWN_HEADING_1` / `text-title`）。 */
    public const val HEADING_1_SIZE_SP: Float = 20f

    /** 二级标题（Electron `CHAT_MARKDOWN_HEADING_2`）。 */
    public const val HEADING_2_SIZE_SP: Float = 18f

    /** 二级标题行高（Electron `leading-[26px]`）。 */
    public const val HEADING_2_LINE_HEIGHT_SP: Float = 26f

    /** 步骤行固定行高 22sp（Electron `CHAT_STEP_TEXT`）。 */
    public const val STEP_LINE_HEIGHT_SP: Float = 22f

    /** Markdown / 纯文本目标行高倍数（Electron `leading-[1.7]`）。 */
    public const val BODY_LINE_HEIGHT_MULTIPLE: Float = 1.7f

    /** Markdown 段落相对行距 em（在 Markdown 主题中换算）。 */
    public const val MARKDOWN_PARAGRAPH_LINE_SPACING_EM: Float = 0.38f

    private val bodyLineHeightSp: Float = BODY_SIZE_SP * BODY_LINE_HEIGHT_MULTIPLE

    /** 消息正文 / Markdown 基础样式。 */
    public val body: TextStyle = TextStyle(
        fontSize = BODY_SIZE_SP.sp,
        lineHeight = bodyLineHeightSp.sp,
        fontWeight = FontWeight.Normal,
    )

    public val bodySemibold: TextStyle = body.copy(fontWeight = FontWeight.SemiBold)

    /** 思考 / 工具步骤行。 */
    public val step: TextStyle = TextStyle(
        fontSize = BODY_SIZE_SP.sp,
        lineHeight = STEP_LINE_HEIGHT_SP.sp,
        fontWeight = FontWeight.Normal,
    )

    public val stepSemibold: TextStyle = step.copy(fontWeight = FontWeight.SemiBold)

    /** Composer 主输入（同步骤行 metrics）。 */
    public val composer: TextStyle = step

    /** Agent 身份牌 / Composer meta：走 UI 字号体系的 `meta`（13sp）。 */
    public val meta: TextStyle = TTFonts.meta
}
