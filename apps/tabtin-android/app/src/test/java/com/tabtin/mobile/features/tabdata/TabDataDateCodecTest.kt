package com.tabtin.mobile.features.tabdata

import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 与 iOS `NativeTabDataDateCodec` 同口径：date 只走 `yyyy-MM-dd`。
 */
class TabDataDateCodecTest {
    @Test
    fun `date 编码只保留年月日`() {
        assertEquals("2026-08-18", TabDataDateCodec.encodeDate(LocalDate.of(2026, 8, 18)))
        assertEquals("2026-01-02", TabDataDateCodec.encodeDate(LocalDate.of(2026, 1, 2)))
    }

    @Test
    fun `date 解码只取前十位，带时间的串也能落到当天`() {
        assertEquals(LocalDate.of(2026, 8, 18), TabDataDateCodec.decodeDate("2026-08-18"))
        assertEquals(LocalDate.of(2026, 8, 18), TabDataDateCodec.decodeDate("2026-08-18T15:30:00Z"))
        assertEquals(LocalDate.of(2026, 8, 18), TabDataDateCodec.decodeDate("  2026-08-18  "))
    }

    @Test
    fun `date 解码拒绝非日期串而不是抛异常`() {
        assertNull(TabDataDateCodec.decodeDate(""))
        assertNull(TabDataDateCodec.decodeDate("下周三"))
        assertNull(TabDataDateCodec.decodeDate("2026-13-45"))
    }

    @Test
    fun `编解码往返稳定`() {
        val date = LocalDate.of(2026, 8, 18)
        assertEquals(date, TabDataDateCodec.decodeDate(TabDataDateCodec.encodeDate(date)))
    }
}
