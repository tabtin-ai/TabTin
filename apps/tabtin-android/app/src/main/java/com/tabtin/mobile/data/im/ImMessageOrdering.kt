package com.tabtin.mobile.data.im

import java.time.Instant

/**
 * 将消息按用户可见的发送时间排序。
 *
 * `seq` 是服务端传输游标，不能当作跨历史页、跨设备的唯一时间线顺序；
 * 群聊的 seq 仍可作为没有时间戳时的兼容兜底。时间相同则保留输入顺序，
 * 避免把同一秒内的 C2C 消息重新排列。
 */
internal fun imChronologicallySortedMessages(messages: List<ImMessage>): List<ImMessage> {
    return messages.withIndex().sortedWith { left, right ->
        val leftDate = parseImMessageInstant(left.value.createdAt)
        val rightDate = parseImMessageInstant(right.value.createdAt)
        when {
            leftDate != null && rightDate != null -> {
                val byTime = leftDate.compareTo(rightDate)
                if (byTime != 0) byTime else left.index.compareTo(right.index)
            }
            // 缺少时间戳的记录放在有时间戳记录之前，确保 takeLast 保留最新消息。
            leftDate != null -> 1
            rightDate != null -> -1
            else -> {
                val bySeq = left.value.seq.compareTo(right.value.seq)
                if (bySeq != 0) bySeq else left.index.compareTo(right.index)
            }
        }
    }.map { it.value }
}

internal fun parseImMessageInstant(raw: String?): Instant? {
    val value = raw?.trim().orEmpty()
    if (value.isEmpty()) return null
    return runCatching { Instant.parse(value) }.getOrNull()
}
