package com.tabtin.mobile.data.model

import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/**
 * 「分享给我」聚合失败：两个来源都不可用时向上抛，让分段显示加载失败，
 * 而不是假装「没人分享给我」。
 */
public class SharedResourcesLoadException(
    message: String = "shared-with-me load failed",
) : Exception(message)

/**
 * 后端时间戳带小数秒 / offset 时都要能解析，否则会被当成「无时间」排到最后。
 */
public object Iso8601DateParser {
    public fun epochMillis(from: String): Long? {
        return try {
            Instant.parse(from).toEpochMilli()
        } catch (_: DateTimeParseException) {
            try {
                OffsetDateTime.parse(from).toInstant().toEpochMilli()
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

/**
 * 聚合「分享给我」的文档与表格的纯逻辑：降级判定与合并排序。
 *
 * 网络并发 / 取消由 Repository 层负责；这里只吃「已解码响应或 null」。
 */
public object SharedResourcesAggregator {
    /**
     * 判定降级：任一来源活着就用它，两边都挂才向上抛。
     *
     * [docs] / [tables] 为 null 表示该来源失败；非 null（哪怕 documents/tables 为空）表示来源活着。
     */
    public fun resolve(
        docs: SharedDocsResponse?,
        tables: SharedTablesResponse?,
    ): List<SharedResourceItem> {
        if (docs == null && tables == null) {
            throw SharedResourcesLoadException()
        }
        return merged(
            docs = (docs?.documents ?: emptyList()).map { it.asSharedResourceItem() },
            tables = (tables?.tables ?: emptyList()).map { it.asSharedResourceItem() },
        )
    }

    /** 合并两个来源并按更新时间倒序；没有时间的排最后；时间相同按标题升序。 */
    public fun merged(
        docs: List<SharedResourceItem>,
        tables: List<SharedResourceItem>,
    ): List<SharedResourceItem> =
        (docs + tables).sortedWith(
            compareByDescending<SharedResourceItem> { item ->
                item.updatedAt?.let { Iso8601DateParser.epochMillis(it) } ?: 0L
            }.thenBy { it.title },
        )
}
