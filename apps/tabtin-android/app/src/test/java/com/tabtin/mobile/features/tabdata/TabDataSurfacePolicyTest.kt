package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.tabtin.mobile.data.model.tabdata.TabDataView

class TabDataSurfacePolicyTest {
    @Test
    fun `only grid list and kanban stay native`() {
        assertEquals(TabDataSurfaceKind.CARDS, TabDataSurfacePolicy.kind("grid"))
        assertEquals(TabDataSurfaceKind.CARDS, TabDataSurfacePolicy.kind("list"))
        assertEquals(TabDataSurfaceKind.KANBAN, TabDataSurfacePolicy.kind("kanban"))
        assertEquals(TabDataSurfaceKind.SUMMARY, TabDataSurfacePolicy.kind("calendar"))
        assertEquals(TabDataSurfaceKind.SUMMARY, TabDataSurfacePolicy.kind("gallery"))
        assertEquals(TabDataSurfaceKind.SUMMARY, TabDataSurfacePolicy.kind("form"))
        assertEquals(TabDataSurfaceKind.SUMMARY, TabDataSurfacePolicy.kind("flashcard"))
        assertEquals(TabDataSurfaceKind.SUMMARY, TabDataSurfacePolicy.kind("GANTT"))
        assertEquals(TabDataSurfaceKind.SUMMARY, TabDataSurfacePolicy.kind("pivot"))
    }

    @Test
    fun `supportsNativeCards follows cards and kanban only`() {
        assertTrue(view("grid").supportsNativeCards)
        assertTrue(view("list").supportsNativeCards)
        assertTrue(view("kanban").supportsNativeCards)
        assertTrue(view("  Grid  ").supportsNativeCards)
        assertFalse(view("calendar").supportsNativeCards)
        assertFalse(view("gallery").supportsNativeCards)
        assertFalse(view("form").supportsNativeCards)
        assertFalse(view("flashcard").supportsNativeCards)
        assertFalse(view("pivot").supportsNativeCards)
        assertFalse(view("gantt").supportsNativeCards)
    }

    private fun view(viewType: String): TabDataView =
        TabDataView(id = "view-1", name = "视图", viewType = viewType)
}
