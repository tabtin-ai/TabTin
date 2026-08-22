package com.tabtin.mobile.features.tabchat

internal data class ImTextLink(
    val url: String,
    val start: Int,
    val endExclusive: Int,
)

private val httpUrlPattern = Regex(
    pattern = "(?i)(?<![A-Za-z0-9_])https?://[^\\s<>\"'。，！？；：、…]+",
)

private val sentenceEndingPunctuation = setOf(
    '.', ',', '!', '?', ';', ':',
    '。', '，', '！', '？', '；', '：', '、', '…',
    '”', '’', '»',
)

private val closingPairs = mapOf(
    ')' to '(',
    ']' to '[',
    '}' to '{',
    '）' to '（',
    '】' to '【',
    '》' to '《',
    '〉' to '〈',
)

/** Finds explicit HTTP(S) links while preserving their exact ranges in the original message. */
internal fun findImTextLinks(content: String): List<ImTextLink> =
    httpUrlPattern.findAll(content).mapNotNull { match ->
        val raw = match.value
        val trimmedLength = raw.urlLengthWithoutTrailingPunctuation()
        if (trimmedLength == 0) return@mapNotNull null

        val endExclusive = match.range.first + trimmedLength
        ImTextLink(
            url = content.substring(match.range.first, endExclusive),
            start = match.range.first,
            endExclusive = endExclusive,
        )
    }.toList()

private fun String.urlLengthWithoutTrailingPunctuation(): Int {
    var end = length
    while (end > 0) {
        val last = this[end - 1]
        when {
            last in sentenceEndingPunctuation -> end -= 1
            last in closingPairs && hasUnmatchedClosing(last, end) -> end -= 1
            else -> return end
        }
    }
    return end
}

private fun String.hasUnmatchedClosing(closing: Char, endExclusive: Int): Boolean {
    val opening = closingPairs.getValue(closing)
    var balance = 0
    for (index in 0 until endExclusive) {
        when (this[index]) {
            opening -> balance += 1
            closing -> balance -= 1
        }
    }
    return balance < 0
}
