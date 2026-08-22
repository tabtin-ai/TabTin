package com.tabtin.mobile.data.automation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionPermissionApprovalCacheTest {

    @Test
    fun putGetAndClear() {
        val cache = SessionPermissionApprovalCache()
        assertNull(cache.get("screen_tap"))

        cache.put("screen_tap", allowed = true)
        assertEquals(true, cache.get("screen_tap"))
        assertNull(cache.get("read_contacts"))

        cache.put("read_contacts", allowed = false)
        assertEquals(false, cache.get("read_contacts"))
        assertEquals(2, cache.size())

        cache.clear()
        assertNull(cache.get("screen_tap"))
        assertNull(cache.get("read_contacts"))
        assertEquals(0, cache.size())
    }
}
