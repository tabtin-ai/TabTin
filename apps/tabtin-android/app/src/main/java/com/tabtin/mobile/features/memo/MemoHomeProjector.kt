package com.tabtin.mobile.features.memo

import com.tabtin.mobile.data.model.memo.MemoHeatmapBucket
import com.tabtin.mobile.data.model.memo.MemoSummary
import com.tabtin.mobile.util.RelativeTimeFormatter
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

public enum class MemoHomeSectionKind {
    PINNED,
    TODAY,
    YESTERDAY,
    THIS_WEEK,
    EARLIER,
}

public data class MemoHomeSection(
    val kind: MemoHomeSectionKind,
    val memos: List<MemoSummary>,
)

public data class MemoHomeHeatmapProjection(
    val buckets: List<MemoHeatmapBucket>,
    val monthCount: Int,
    val days: Int,
)

/**
 * 纯投影：置顶 / 今天 / 昨天 / 本周 / 更早；热力图当月合计。
 * 不改服务端游标分页顺序，只重组当前页客户端视图。
 */
public object MemoHomeProjector {
    public fun projectSections(
        memos: List<MemoSummary>,
        zoneId: ZoneId = ZoneId.systemDefault(),
        today: LocalDate = LocalDate.now(zoneId),
    ): List<MemoHomeSection> {
        val pinned = memos.filter { it.isPinned }
        val unpinned = memos.filter { !it.isPinned }
        val yesterday = today.minusDays(1)
        val weekStart = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

        val todayItems = mutableListOf<MemoSummary>()
        val yesterdayItems = mutableListOf<MemoSummary>()
        val weekItems = mutableListOf<MemoSummary>()
        val earlierItems = mutableListOf<MemoSummary>()

        for (memo in unpinned) {
            val date = memoLocalDate(memo.createdAt, zoneId)
            when {
                date == null || date == today -> todayItems.add(memo)
                date == yesterday -> yesterdayItems.add(memo)
                !date.isBefore(weekStart) -> weekItems.add(memo)
                else -> earlierItems.add(memo)
            }
        }

        return buildList {
            if (pinned.isNotEmpty()) add(MemoHomeSection(MemoHomeSectionKind.PINNED, pinned))
            if (todayItems.isNotEmpty()) add(MemoHomeSection(MemoHomeSectionKind.TODAY, todayItems))
            if (yesterdayItems.isNotEmpty()) add(MemoHomeSection(MemoHomeSectionKind.YESTERDAY, yesterdayItems))
            if (weekItems.isNotEmpty()) add(MemoHomeSection(MemoHomeSectionKind.THIS_WEEK, weekItems))
            if (earlierItems.isNotEmpty()) add(MemoHomeSection(MemoHomeSectionKind.EARLIER, earlierItems))
        }
    }

    public fun projectHeatmap(
        buckets: List<MemoHeatmapBucket>,
        days: Int,
        zoneId: ZoneId = ZoneId.systemDefault(),
        today: LocalDate = LocalDate.now(zoneId),
    ): MemoHomeHeatmapProjection {
        val month = today.monthValue
        val year = today.year
        val monthCount = buckets.sumOf { bucket ->
            val date = runCatching { LocalDate.parse(bucket.date) }.getOrNull()
            if (date != null && date.year == year && date.monthValue == month) bucket.count else 0
        }
        return MemoHomeHeatmapProjection(buckets = buckets, monthCount = monthCount, days = days)
    }

    private fun memoLocalDate(createdAt: String, zoneId: ZoneId): LocalDate? {
        runCatching {
            return java.time.OffsetDateTime.parse(createdAt).atZoneSameInstant(zoneId).toLocalDate()
        }
        runCatching {
            return java.time.Instant.parse(createdAt).atZone(zoneId).toLocalDate()
        }
        val legacy = RelativeTimeFormatter.parse(createdAt) ?: return null
        return legacy.toInstant().atZone(zoneId).toLocalDate()
    }
}

