package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TabDataEmptyPolicyTest {
    @Test
    fun `kind matches ios empty states`() {
        assertEquals(
            TabDataEmptyKind.NO_VIEWS,
            TabDataEmptyPolicy.kind(
                hasViews = false,
                isKanban = false,
                recordCount = 0,
                hasActiveQuery = false,
            ),
        )
        assertEquals(
            TabDataEmptyKind.NO_RECORDS,
            TabDataEmptyPolicy.kind(
                hasViews = true,
                isKanban = false,
                recordCount = 0,
                hasActiveQuery = false,
            ),
        )
        assertEquals(
            TabDataEmptyKind.NO_MATCHES,
            TabDataEmptyPolicy.kind(
                hasViews = true,
                isKanban = false,
                recordCount = 0,
                hasActiveQuery = true,
            ),
        )
        assertEquals(
            TabDataEmptyKind.EMPTY_KANBAN,
            TabDataEmptyPolicy.kind(
                hasViews = true,
                isKanban = true,
                recordCount = 0,
                hasActiveQuery = true,
            ),
        )
        assertNull(
            TabDataEmptyPolicy.kind(
                hasViews = true,
                isKanban = false,
                recordCount = 2,
                hasActiveQuery = true,
            ),
        )
    }
}
