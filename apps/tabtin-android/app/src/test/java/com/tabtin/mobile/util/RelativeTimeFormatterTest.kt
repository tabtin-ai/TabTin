package com.tabtin.mobile.util

import org.junit.Assert.assertNotNull
import org.junit.Test

class RelativeTimeFormatterTest {
    @Test
    fun parse_acceptsDjangoOffsetAndZuluTimestamps() {
        assertNotNull(RelativeTimeFormatter.parse("2026-07-20T00:00:00+00:00"))
        assertNotNull(RelativeTimeFormatter.parse("2026-07-20T00:00:00.123456Z"))
        assertNotNull(RelativeTimeFormatter.parse("2026-07-20T00:00:00Z"))
        assertNotNull(RelativeTimeFormatter.parse("2026-07-20T00:00:00.000Z"))
    }
}
