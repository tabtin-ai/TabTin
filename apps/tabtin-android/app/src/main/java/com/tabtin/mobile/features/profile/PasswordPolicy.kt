package com.tabtin.mobile.features.profile

/** 与 Electron / 后端 SSOT 对齐的新密码输入策略。 */
public object PasswordPolicy {
    public const val minimumLength: Int = 8
    public const val minimumCharacterClasses: Int = 3

    public enum class ValidationError {
        REQUIRED,
        CONTAINS_CJK,
        CONTAINS_WHITESPACE,
        TOO_SHORT,
        NOT_COMPLEX,
        MISMATCH,
    }

    public data class SanitizedInput(
        val value: String,
        val hadWhitespace: Boolean,
        val hadCjk: Boolean,
    )

    public fun sanitize(raw: String): SanitizedInput {
        val hadWhitespace = raw.any(Char::isWhitespace)
        val withoutWhitespace = raw.filterNot(Char::isWhitespace)
        val hadCjk = withoutWhitespace.any(::isCjk)
        return SanitizedInput(
            value = if (hadCjk) "" else withoutWhitespace,
            hadWhitespace = hadWhitespace,
            hadCjk = hadCjk,
        )
    }

    public fun validate(newPassword: String, confirmation: String): ValidationError? {
        if (newPassword.isBlank()) return ValidationError.REQUIRED
        if (newPassword.any(::isCjk)) return ValidationError.CONTAINS_CJK
        if (newPassword.any(Char::isWhitespace)) return ValidationError.CONTAINS_WHITESPACE
        if (newPassword.length < minimumLength) return ValidationError.TOO_SHORT
        if (characterClassCount(newPassword) < minimumCharacterClasses) {
            return ValidationError.NOT_COMPLEX
        }
        if (newPassword != confirmation) return ValidationError.MISMATCH
        return null
    }

    private fun characterClassCount(password: String): Int {
        var count = 0
        if (password.any(Char::isUpperCase)) count++
        if (password.any(Char::isLowerCase)) count++
        if (password.any(Char::isDigit)) count++
        if (password.any { !it.isLetterOrDigit() && !it.isWhitespace() }) count++
        return count
    }

    private fun isCjk(char: Char): Boolean =
        char in '\u3400'..'\u4DBF' ||
            char in '\u4E00'..'\u9FFF' ||
            char in '\uF900'..'\uFAFF'
}
