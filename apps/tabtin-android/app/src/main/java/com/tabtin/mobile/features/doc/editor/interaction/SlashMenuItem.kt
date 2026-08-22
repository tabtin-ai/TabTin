package com.tabtin.mobile.features.doc.editor.interaction

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.FormatListNumbered
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.HorizontalRule
import androidx.compose.material.icons.outlined.Title
import androidx.compose.ui.graphics.vector.ImageVector
import com.tabtin.mobile.R
import com.tabtin.mobile.features.doc.model.BlockKind

/**
 * Slash 菜单项数据模型。
 * 每一项对应一种可插入的块类型（BlockKind）。
 */
public data class SlashMenuItem(
    val blockKind: BlockKind,
    @StringRes val titleRes: Int,
    @StringRes val subtitleRes: Int,
    val icon: ImageVector,
    val searchTerms: List<String>,
)

/**
 * 预定义的 Slash 菜单项列表，涵盖所有常用块类型。
 * searchTerms 同时包含中英文关键词以支持双语过滤。
 */
public val SLASH_MENU_ITEMS: List<SlashMenuItem> = listOf(
    SlashMenuItem(
        blockKind = BlockKind.PARAGRAPH,
        titleRes = R.string.doc_slash_text,
        subtitleRes = R.string.doc_slash_subtitle_text,
        icon = Icons.AutoMirrored.Outlined.Notes,
        searchTerms = listOf("text", "paragraph", "p", "文本", "段落", "正文"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.HEADING1,
        titleRes = R.string.doc_slash_heading1,
        subtitleRes = R.string.doc_slash_subtitle_h1,
        icon = Icons.Outlined.Title,
        searchTerms = listOf("heading", "h1", "title", "标题", "大标题"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.HEADING2,
        titleRes = R.string.doc_slash_heading2,
        subtitleRes = R.string.doc_slash_subtitle_h2,
        icon = Icons.Outlined.Title,
        searchTerms = listOf("heading", "h2", "subtitle", "标题", "中标题"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.HEADING3,
        titleRes = R.string.doc_slash_heading3,
        subtitleRes = R.string.doc_slash_subtitle_h3,
        icon = Icons.Outlined.Title,
        searchTerms = listOf("heading", "h3", "标题", "小标题"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.BULLET_ITEM,
        titleRes = R.string.doc_slash_bullet,
        subtitleRes = R.string.doc_slash_subtitle_bullet,
        icon = Icons.AutoMirrored.Outlined.FormatListBulleted,
        searchTerms = listOf("bullet", "list", "unordered", "列表", "无序", "圆点"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.ORDERED_ITEM,
        titleRes = R.string.doc_slash_ordered,
        subtitleRes = R.string.doc_slash_subtitle_numbered,
        icon = Icons.Outlined.FormatListNumbered,
        searchTerms = listOf("ordered", "number", "list", "有序", "编号", "数字"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.TODO_ITEM,
        titleRes = R.string.doc_slash_todo,
        subtitleRes = R.string.doc_slash_subtitle_todo,
        icon = Icons.Outlined.CheckBox,
        searchTerms = listOf("todo", "task", "check", "待办", "任务", "复选"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.BLOCKQUOTE,
        titleRes = R.string.doc_slash_quote,
        subtitleRes = R.string.doc_slash_subtitle_quote,
        icon = Icons.Outlined.FormatQuote,
        searchTerms = listOf("quote", "blockquote", "引用"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.CODE_BLOCK,
        titleRes = R.string.doc_slash_code,
        subtitleRes = R.string.doc_slash_subtitle_code,
        icon = Icons.Outlined.Code,
        searchTerms = listOf("code", "codeblock", "代码", "代码块"),
    ),
    SlashMenuItem(
        blockKind = BlockKind.DIVIDER,
        titleRes = R.string.doc_slash_divider,
        subtitleRes = R.string.doc_slash_subtitle_divider,
        icon = Icons.Outlined.HorizontalRule,
        searchTerms = listOf("divider", "hr", "line", "分割线", "分隔符"),
    ),
)

/**
 * 根据过滤文本筛选菜单项。
 * 匹配逻辑：过滤文本去除开头的 '/' 后，与 searchTerms 做包含匹配。
 */
public fun filterSlashMenuItems(filter: String): List<SlashMenuItem> {
    val query = filter.removePrefix("/").lowercase().trim()
    if (query.isEmpty()) return SLASH_MENU_ITEMS
    return SLASH_MENU_ITEMS.filter { item ->
        item.searchTerms.any { term -> term.contains(query) }
    }
}
