package com.tabtin.mobile.data.im

/** Django `SendMessageRequest.content` 的传输无关契约，按 Unicode code point 计数。 */
internal const val IM_MESSAGE_CONTENT_MAX_LENGTH: Int = 10_000

internal fun getImMessageContentLength(content: String): Int =
    content.codePointCount(0, content.length)

internal fun isImMessageContentWithinLimit(content: String): Boolean =
    getImMessageContentLength(content) <= IM_MESSAGE_CONTENT_MAX_LENGTH
