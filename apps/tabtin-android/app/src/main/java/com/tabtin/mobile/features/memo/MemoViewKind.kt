package com.tabtin.mobile.features.memo

import com.tabtin.mobile.data.model.memo.MemoAppHomeFeatureFlags
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Organization Memo App 首页预设视图。 */
public enum class MemoViewKind {
    ALL,
    TODAY,
    AGENT_DIARY,
    ;

    public companion object {
        /** 生产可见预设；Agent 日记受 [MemoAppHomeFeatureFlags] 门禁。 */
        public fun visibleKinds(): List<MemoViewKind> = buildList {
            add(ALL)
            add(TODAY)
            if (MemoAppHomeFeatureFlags.IS_ORGANIZATION_AGENT_DIARY_ENABLED) {
                add(AGENT_DIARY)
            }
        }
    }
}

/**
 * 列表查询参数快照：搜索 / 筛选 / load-more 共用同一份，
 * 避免翻页时混入中途变更的筛选条件。
 */
public data class MemoListQuerySnapshot(
    val organizationId: String,
    val spaceId: String,
    val viewKind: MemoViewKind,
    val status: String,
    val search: String,
    val color: String,
    val collectionId: String,
    val tags: String,
    val createdAfter: String?,
    val createdBefore: String?,
) {
    public companion object {
        public fun forView(
            organizationId: String,
            spaceId: String,
            viewKind: MemoViewKind,
            status: String,
            search: String = "",
            color: String = "",
            collectionId: String = "",
            tags: String = "",
            zoneId: ZoneId = ZoneId.systemDefault(),
            today: LocalDate = LocalDate.now(zoneId),
        ): MemoListQuerySnapshot {
            val (after, before) = when (viewKind) {
                MemoViewKind.TODAY -> {
                    val start = today.atStartOfDay(zoneId).toOffsetDateTime().format(ISO_OFFSET)
                    val end = today.plusDays(1).atStartOfDay(zoneId).toOffsetDateTime().format(ISO_OFFSET)
                    start to end
                }
                MemoViewKind.ALL, MemoViewKind.AGENT_DIARY -> null to null
            }
            return MemoListQuerySnapshot(
                organizationId = organizationId,
                spaceId = spaceId,
                viewKind = viewKind,
                status = status,
                search = search.trim(),
                color = color,
                collectionId = collectionId,
                tags = tags.trim(),
                createdAfter = after,
                createdBefore = before,
            )
        }

        private val ISO_OFFSET: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX")
    }
}
