package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

public class TabDataMemberPickerPolicyTest {
    @Test
    public fun `page size and server cap stay distinct`() {
        assertEquals(50, TabDataUserFieldPolicy.SEARCH_PAGE_LIMIT)
        assertEquals(200, TabDataUserFieldPolicy.SEARCH_MAX_LIMIT)
        assertTrue(TabDataUserFieldPolicy.SEARCH_PAGE_LIMIT < TabDataUserFieldPolicy.SEARCH_MAX_LIMIT)
    }

    @Test
    public fun `searchQuery matches iOS nickname mode and clamps limit`() {
        val named = TabDataUserFieldPolicy.searchQuery(search = "  林  ", offset = 20, limit = 500)
        assertEquals("林", named.search)
        assertEquals("nickname", named.searchMode)
        assertEquals(20, named.offset)
        assertEquals(TabDataUserFieldPolicy.SEARCH_MAX_LIMIT, named.limit)

        val blank = TabDataUserFieldPolicy.searchQuery(search = "   ", offset = -3)
        assertNull(blank.search)
        assertNull(blank.searchMode)
        assertEquals(0, blank.offset)
        assertEquals(TabDataUserFieldPolicy.SEARCH_PAGE_LIMIT, blank.limit)
    }

    @Test
    public fun `searchOffset resets to first page or continues from loaded count`() {
        assertEquals(0, TabDataUserFieldPolicy.searchOffset(reset = true, loadedCount = 80))
        assertEquals(80, TabDataUserFieldPolicy.searchOffset(reset = false, loadedCount = 80))
        assertEquals(0, TabDataUserFieldPolicy.searchOffset(reset = false, loadedCount = -4))
    }

    @Test
    public fun `canLoadMore stops when loaded count reaches total`() {
        assertTrue(TabDataUserFieldPolicy.canLoadMore(loadedCount = 50, total = 80))
        assertFalse(TabDataUserFieldPolicy.canLoadMore(loadedCount = 80, total = 80))
        assertFalse(TabDataUserFieldPolicy.canLoadMore(loadedCount = 90, total = 80))
        assertFalse(TabDataUserFieldPolicy.canLoadMore(loadedCount = 0, total = 80))
        assertFalse(TabDataUserFieldPolicy.canLoadMore(loadedCount = 50, total = 0))
    }

    @Test
    public fun `mergeSearchPage replaces on reset and appends unique user ids`() {
        val first = listOf(member("a"), member("b"))
        val second = listOf(member("b"), member("c"), member("a"), member(""))
        assertEquals(
            listOf(member("x")),
            TabDataUserFieldPolicy.mergeSearchPage(first, listOf(member("x")), reset = true),
        )
        assertEquals(
            listOf(member("a"), member("b"), member("c")),
            TabDataUserFieldPolicy.mergeSearchPage(first, second, reset = false),
        )
    }

    @Test
    public fun `stale search generation does not replace newer results`() {
        val current = listOf(member("new-1"))
        val generation = TabDataUserFieldPolicy.nextSearchGeneration(3)
        assertEquals(4, generation)
        assertFalse(TabDataUserFieldPolicy.shouldApplySearchResponse(3, generation))
        assertTrue(TabDataUserFieldPolicy.shouldApplySearchResponse(generation, generation))

        val applied = if (TabDataUserFieldPolicy.shouldApplySearchResponse(3, generation)) {
            TabDataUserFieldPolicy.mergeSearchPage(current, listOf(member("stale")), reset = true)
        } else {
            current
        }
        assertEquals(listOf(member("new-1")), applied)
    }

    private fun member(userId: String): TabDataDirectoryMember =
        TabDataDirectoryMember(userId = userId, displayName = userId)
}
