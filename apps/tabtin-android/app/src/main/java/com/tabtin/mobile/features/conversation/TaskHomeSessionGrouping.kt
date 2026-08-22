package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * 任务列表分段：置顶 / 需要你 / 按时间落桶。对齐 iOS `TaskHomeSessionGrouping`。
 *
 * 时间是用户回忆一条任务的第一索引——「昨天那个爬数据的」比「第 14 条」好找得多。
 * 平铺一长条列表时，滚过三屏就失去坐标；分段让每一屏都自带时间锚点。
 *
 * 置顶与「需要你」是语义段，永远压在时间段之上：它们回答的是「现在该管哪条」，
 * 优先级高于「什么时候动过」。
 */
internal object TaskHomeSessionGrouping {

    internal enum class Band {
        PINNED,
        NEEDS_YOU,
        TODAY,
        YESTERDAY,
        LAST_7_DAYS,
        LAST_30_DAYS,
        EARLIER,
        ;

        /** 置顶段带图钉字形，和行尾的图钉呼应；时间段不带任何装饰。 */
        val showsPinGlyph: Boolean get() = this == PINNED
    }

    internal data class Group(
        val band: Band,
        val sessions: List<AllChatSession>,
    )

    private val TIME_BANDS = listOf(
        Band.TODAY, Band.YESTERDAY, Band.LAST_7_DAYS, Band.LAST_30_DAYS, Band.EARLIER,
    )

    /**
     * @param pinned/needsYou 已由调用方按语义挑出且互斥的两段，保持传入顺序。
     * @param rest 其余会话，已按活跃时间倒序；这里只落时间桶，不重新排序。
     */
    fun groups(
        pinned: List<AllChatSession>,
        needsYou: List<AllChatSession>,
        rest: List<AllChatSession>,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<Group> {
        val result = mutableListOf<Group>()
        if (pinned.isNotEmpty()) result += Group(Band.PINNED, pinned)
        if (needsYou.isNotEmpty()) result += Group(Band.NEEDS_YOU, needsYou)

        val buckets = rest.groupBy { timeBand(it, now, zone) }
        TIME_BANDS.forEach { band ->
            buckets[band]?.takeIf { it.isNotEmpty() }?.let { result += Group(band, it) }
        }
        return result
    }

    /**
     * 时间戳解析不出来时归入「更早」——宁可排在最后，也不要伪造成「今天」把最新一屏搅乱。
     *
     * 一律以传入的 `now` 为基准，不读系统当下：否则注入时间的场景（单测 / 回放）会静默错桶。
     */
    fun timeBand(
        session: AllChatSession,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): Band {
        val date = activityInstant(session) ?: return Band.EARLIER
        val today = now.atZone(zone).toLocalDate()
        val day = date.atZone(zone).toLocalDate()
        return when {
            day == today -> Band.TODAY
            day == today.minusDays(1) -> Band.YESTERDAY
            date.isAfter(now.minus(7, ChronoUnit.DAYS)) -> Band.LAST_7_DAYS
            date.isAfter(now.minus(30, ChronoUnit.DAYS)) -> Band.LAST_30_DAYS
            else -> Band.EARLIER
        }
    }

    /**
     * 与列表排序依据同源（`lastMessageAt ?: updatedAt ?: createdAt`）：分段依据和排序
     * 依据必须一致，否则会出现「排在今天段里、时间显示三天前」的错位。
     */
    fun activityInstant(session: AllChatSession): Instant? {
        val raw = session.lastMessageAt ?: session.updatedAt ?: session.createdAt
        if (raw.isNullOrBlank()) return null
        return runCatching { Instant.parse(raw) }.getOrElse {
            // 后端也发过不带毫秒 / 带时区偏移的写法，交给 OffsetDateTime 兜一层。
            runCatching { java.time.OffsetDateTime.parse(raw).toInstant() }.getOrNull()
        }
    }
}
