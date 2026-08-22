package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

/** 任务列表分段：语义段永远压时间段，时间桶与排序依据同源。对齐 iOS 同名单测。 */
class TaskHomeSessionGroupingTest {
    private val zone: ZoneId = ZoneId.of("Asia/Shanghai")
    /** 钉在本地时间正午：用小时级偏移造「今天」的样本时不会跨过午夜。 */
    private val now: Instant = Instant.parse("2026-02-02T04:00:00Z") // 12:00 +08

    private fun session(id: String, hoursAgo: Double? = null, raw: String? = null) = AllChatSession(
        id = id,
        lastMessageAt = raw ?: hoursAgo?.let {
            now.minusSeconds((it * 3600).toLong()).toString()
        },
    )

    @Test
    fun `semantic bands come before time bands`() {
        val groups = TaskHomeSessionGrouping.groups(
            pinned = listOf(session("p", 20 * 24.0)),
            needsYou = listOf(session("n", 20 * 24.0)),
            rest = listOf(session("r", 1.0)),
            now = now, zone = zone,
        )
        assertEquals(
            listOf(
                TaskHomeSessionGrouping.Band.PINNED,
                TaskHomeSessionGrouping.Band.NEEDS_YOU,
                TaskHomeSessionGrouping.Band.TODAY,
            ),
            groups.map { it.band },
        )
    }

    @Test
    fun `empty bands are dropped`() {
        val groups = TaskHomeSessionGrouping.groups(
            pinned = emptyList(), needsYou = emptyList(),
            rest = listOf(session("r", 1.0)), now = now, zone = zone,
        )
        assertEquals(listOf(TaskHomeSessionGrouping.Band.TODAY), groups.map { it.band })
    }

    @Test
    fun `rest falls into time buckets in fixed order`() {
        val groups = TaskHomeSessionGrouping.groups(
            pinned = emptyList(), needsYou = emptyList(),
            rest = listOf(
                session("earlier", 90 * 24.0),
                session("today", 1.0),
                session("month", 20 * 24.0),
                session("yesterday", 24.0),
                session("week", 4 * 24.0),
            ),
            now = now, zone = zone,
        )
        assertEquals(
            listOf(
                TaskHomeSessionGrouping.Band.TODAY,
                TaskHomeSessionGrouping.Band.YESTERDAY,
                TaskHomeSessionGrouping.Band.LAST_7_DAYS,
                TaskHomeSessionGrouping.Band.LAST_30_DAYS,
                TaskHomeSessionGrouping.Band.EARLIER,
            ),
            groups.map { it.band },
        )
        assertEquals(
            listOf(listOf("today"), listOf("yesterday"), listOf("week"), listOf("month"), listOf("earlier")),
            groups.map { g -> g.sessions.map { it.id } },
        )
    }

    /** 同一桶内保持调用方传入的活跃倒序，分段不重排。 */
    @Test
    fun `order inside band is preserved`() {
        val groups = TaskHomeSessionGrouping.groups(
            pinned = emptyList(), needsYou = emptyList(),
            rest = listOf(session("a", 1.0), session("b", 2.0), session("c", 3.0)),
            now = now, zone = zone,
        )
        assertEquals(listOf("a", "b", "c"), groups.first().sessions.map { it.id })
    }

    /** 解析不出时间的会话宁可沉底，也不能伪装成「今天」污染最新一屏。 */
    @Test
    fun `unparsable timestamp sinks to earlier`() {
        assertEquals(
            TaskHomeSessionGrouping.Band.EARLIER,
            TaskHomeSessionGrouping.timeBand(session("bad", raw = "not-a-date"), now, zone),
        )
        assertEquals(
            TaskHomeSessionGrouping.Band.EARLIER,
            TaskHomeSessionGrouping.timeBand(AllChatSession(id = "none"), now, zone),
        )
    }

    /** 带偏移量的 ISO-8601 也要认，后端两种都发过。 */
    @Test
    fun `activity instant accepts offset form`() {
        assertEquals(
            Instant.parse("2026-02-01T10:00:00Z"),
            TaskHomeSessionGrouping.activityInstant(session("off", raw = "2026-02-01T18:00:00+08:00")),
        )
    }

    /** 分段依据必须和列表排序依据同源。 */
    @Test
    fun `activity instant follows sort key precedence`() {
        val s = AllChatSession(
            id = "s",
            createdAt = "2026-01-01T00:00:00Z",
            updatedAt = "2026-01-15T00:00:00Z",
            lastMessageAt = "2026-02-01T00:00:00Z",
        )
        assertEquals(Instant.parse("2026-02-01T00:00:00Z"), TaskHomeSessionGrouping.activityInstant(s))
    }
}
