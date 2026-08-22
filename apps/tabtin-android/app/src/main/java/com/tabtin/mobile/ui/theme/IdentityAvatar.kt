package com.tabtin.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.absoluteValue

/**
 * 对齐 `@tabtin/shared` `identity-avatar.ts`：默认头像色只由稳定身份 ID 决定。
 * AI Agent 也可复用同一套哈希色（产品口径，不必走 Electron IM 的固定 `--type-agent`）。
 */
public object IdentityAvatar {
    /** `identityAvatarHue`：32-bit 串哈希后取模 360。 */
    public fun hue(identity: String?): Int {
        val value = identity?.trim().orEmpty().ifEmpty { "?" }
        var hash = 0
        for (ch in value) {
            hash = ((hash shl 5) - hash + ch.code)
        }
        return hash.absoluteValue % 360
    }

    /** `identityAvatarColor`：`hsl(hue, 55%, 55%)`。 */
    public fun color(identity: String?): Color {
        val h = hue(identity).toFloat()
        return Color.hsl(h, 0.55f, 0.55f)
    }

    /** 有稳定 ID 就用 ID；否则才用显示名。名称变化不能改颜色。 */
    public fun colorSeed(identity: String?, fallbackName: String?): String {
        val id = identity?.trim().orEmpty()
        if (id.isNotEmpty()) return id
        return fallbackName?.trim().orEmpty().ifEmpty { "?" }
    }

    /** 中文名取最后两个字；英文名取首词与末词首字母并保留原始大小写，最多显示两个字符。 */
    public fun initials(name: String?): String {
        val trimmed = name?.trim().orEmpty()
        if (trimmed.isEmpty()) return "?"
        val visible = trimmed.filterNot(Char::isWhitespace)
        if (visible.any(::isHanCharacter)) return visible.takeLast(2)

        val words = trimmed.split(Regex("\\s+")).filter(String::isNotEmpty)
        if (words.isEmpty()) return "?"
        if (words.size == 1) return words.first().take(1)
        return "${words.first().first()}${words.last().first()}"
    }

    public fun initial(name: String?): String = initials(name)

    private fun isHanCharacter(character: Char): Boolean =
        character.code in 0x3400..0x4DBF ||
            character.code in 0x4E00..0x9FFF ||
            character.code in 0xF900..0xFAFF
}
