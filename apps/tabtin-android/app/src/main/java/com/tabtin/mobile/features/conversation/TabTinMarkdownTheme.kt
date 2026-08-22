package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.compose.components.MarkdownComponents
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownCodeBlock
import com.mikepenz.markdown.compose.elements.MarkdownCodeFence
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.MarkdownColors
import com.mikepenz.markdown.model.MarkdownDimens
import com.mikepenz.markdown.model.MarkdownPadding
import com.mikepenz.markdown.model.MarkdownTypography
import com.mikepenz.markdown.model.markdownDimens
import com.mikepenz.markdown.model.markdownPadding
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.ttColor

public object TabTinMarkdownTheme {

    @Composable
    public fun colors(): MarkdownColors = markdownColor(
        text = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        codeBackground = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
        inlineCodeBackground = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
        dividerColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
        tableBackground = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
    )

    @Composable
    public fun typography(): MarkdownTypography {
        val textColor = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
        val accentColor = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
        val secondaryColor = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
        val baseText = ConversationTypography.body.copy(color = textColor)
        val headingBase = baseText.copy(fontWeight = FontWeight.SemiBold)

        return markdownTypography(
            // 对齐 Electron ：H1 20 / H2 18 / H3+ 与正文同字号靠字重分层。
            h1 = headingBase.copy(
                fontSize = ConversationTypography.HEADING_1_SIZE_SP.sp,
                lineHeight = 26.sp,
            ),
            h2 = headingBase.copy(
                fontSize = ConversationTypography.HEADING_2_SIZE_SP.sp,
                lineHeight = ConversationTypography.HEADING_2_LINE_HEIGHT_SP.sp,
            ),
            h3 = headingBase,
            h4 = headingBase,
            h5 = headingBase,
            h6 = headingBase,
            text = baseText,
            code = TTFonts.codeSM.copy(color = textColor),
            inlineCode = baseText.copy(
                fontFamily = FontFamily.Monospace,
                fontSize = TTFonts.Role.META.size.sp,
                color = accentColor,
            ),
            quote = baseText.copy(color = secondaryColor),
            paragraph = baseText,
            ordered = baseText,
            bullet = baseText,
            list = baseText,
            textLink = TextLinkStyles(
                style = baseText.copy(
                    color = accentColor,
                    fontWeight = FontWeight.Medium,
                    textDecoration = TextDecoration.Underline,
                ).toSpanStyle(),
            ),
            table = baseText,
        )
    }

    @Composable
    public fun padding(): MarkdownPadding = markdownPadding(
        block = 4.dp,
        list = 2.dp,
        listItemTop = 2.dp,
        listItemBottom = 2.dp,
        listIndent = 8.dp,
        codeBlock = PaddingValues(12.dp),
        blockQuote = PaddingValues(horizontal = 16.dp, vertical = 0.dp),
        blockQuoteText = PaddingValues(vertical = 4.dp),
        blockQuoteBar = PaddingValues.Absolute(left = 4.dp, top = 2.dp, right = 4.dp, bottom = 2.dp),
    )

    @Composable
    public fun dimens(): MarkdownDimens = markdownDimens(
        dividerThickness = 1.dp,
        codeBackgroundCornerSize = 8.dp,
        blockQuoteThickness = 3.dp,
        tableCellPadding = 12.dp,
        tableCornerSize = 8.dp,
    )

    /**
     * 自定义代码块组件：把库内置的 codeBlock / codeFence 替换为 [CodeBlockView]，
     * 接管语法高亮 + 复制按钮 + 长代码折叠（对齐 iOS Highlightr / Electron rehype-highlight）。
     *
     * @param animateCodeBlockSize 流式稳定区应传 false，避免代码块长高被 180ms 动画放大成跳动。
     */
    @Composable
    public fun components(animateCodeBlockSize: Boolean = true): MarkdownComponents = markdownComponents(
        codeFence = { model ->
            MarkdownCodeFence(
                content = model.content,
                node = model.node,
                style = model.typography.code,
                block = { code, lang, _ ->
                    if (lang?.lowercase() == "mermaid") {
                        MermaidBlockView(code = code) {
                            CodeBlockView(
                                code = code,
                                language = lang,
                                animateContentSize = animateCodeBlockSize,
                            )
                        }
                    } else {
                        CodeBlockView(
                            code = code,
                            language = lang,
                            animateContentSize = animateCodeBlockSize,
                        )
                    }
                },
            )
        },
        codeBlock = { model ->
            MarkdownCodeBlock(
                content = model.content,
                node = model.node,
                style = model.typography.code,
                block = { code, lang, _ ->
                    if (lang?.lowercase() == "mermaid") {
                        MermaidBlockView(code = code) {
                            CodeBlockView(
                                code = code,
                                language = lang,
                                animateContentSize = animateCodeBlockSize,
                            )
                        }
                    } else {
                        CodeBlockView(
                            code = code,
                            language = lang,
                            animateContentSize = animateCodeBlockSize,
                        )
                    }
                },
            )
        },
    )
}
