package com.tabtin.mobile.features.clouddocs

import androidx.annotation.DrawableRes
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SpaceResource

/**
 * TabTin App 图标解析。与 iOS `AppIconResolver` 对齐。
 *
 * - [resolveAppIcon]：有白底底座的完整 App icon（工作台磁贴 / 「全部应用」）
 * - [resolveContentGlyph]：无白底内容字形（列表行 / App Home 资源行 / 对话资源卡）
 * - [resolveListIcon]：列表优先字形，缺字形时回退完整 icon（对齐 iOS）
 */
internal object AppIconResolver {
    private val bundledAppIcons = mapOf(
        "tabdoc" to R.drawable.app_icon_tabdoc,
        "tabdata" to R.drawable.app_icon_tabdata,
        "tabmemo" to R.drawable.app_icon_tabmemo,
        "tabfiles" to R.drawable.app_icon_tabfiles,
        "tabfolder" to R.drawable.app_icon_tabfolder,
        "tabcode" to R.drawable.app_icon_tabcode,
        "tabweb" to R.drawable.app_icon_tabweb,
        "tabslide" to R.drawable.app_icon_tabslide,
        "tabtracker" to R.drawable.app_icon_tabtracker,
        "tabwhiteboard" to R.drawable.app_icon_tabwhiteboard,
        "terminal" to R.drawable.app_icon_terminal,
    )

    private val bundledContentGlyphs = mapOf(
        "tabdoc" to R.drawable.app_glyph_tabdoc,
        "tabdata" to R.drawable.app_glyph_tabdata,
        "tabmemo" to R.drawable.app_glyph_tabmemo,
        "tabfiles" to R.drawable.app_glyph_tabfiles,
        "tabfolder" to R.drawable.app_glyph_tabfolder,
        "tabcode" to R.drawable.app_glyph_tabcode,
        "tabweb" to R.drawable.app_glyph_tabweb,
        "tabslide" to R.drawable.app_glyph_tabslide,
        "tabtracker" to R.drawable.app_glyph_tabtracker,
        "tabwhiteboard" to R.drawable.app_glyph_tabwhiteboard,
        "terminal" to R.drawable.app_glyph_terminal,
    )

    /** 无白底内容字形（列表 / App Home 行）。 */
    @DrawableRes
    fun resolveContentGlyph(itemType: String): Int? {
        val key = SpaceResource.normalizedType(itemType)
        return bundledContentGlyphs[key]
    }

    /** 带白底底座的完整 App icon（工作台磁贴）。 */
    @DrawableRes
    fun resolveAppIcon(itemType: String): Int? {
        val key = SpaceResource.normalizedType(itemType)
        return bundledAppIcons[key]
    }

    /**
     * 列表 / 资源行：优先无白底字形；没有字形时回退完整 icon。
     * 对齐 iOS `resolveContentGlyph` 对非 tabdoc/tabdata 的 fallback。
     */
    @DrawableRes
    fun resolveListIcon(itemType: String): Int? =
        resolveContentGlyph(itemType) ?: resolveAppIcon(itemType)

    /** 工作台磁贴：完整品牌 icon。 */
    @DrawableRes
    fun resolveWorkbenchIcon(itemType: String): Int? = resolveAppIcon(itemType)

    /** @deprecated 语义模糊；列表请用 [resolveListIcon]，磁贴用 [resolveAppIcon]。 */
    @DrawableRes
    fun resolve(itemType: String): Int? = resolveListIcon(itemType)
}
