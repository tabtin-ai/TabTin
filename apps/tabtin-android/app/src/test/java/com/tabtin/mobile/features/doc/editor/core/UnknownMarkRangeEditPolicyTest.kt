package com.tabtin.mobile.features.doc.editor.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UnknownMarkRangeEditPolicyTest {
    @Test
    fun `adjacent insert and full range delete are allowed`() {
        assertTrue(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 5, 5))
        assertTrue(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 8, 8))
        assertTrue(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 0, 2))
        assertTrue(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 5, 8))
        assertTrue(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 4, 9))
    }

    @Test
    fun `interior insert or partial delete is rejected`() {
        assertFalse(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 6, 6))
        assertFalse(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 5, 6))
        assertFalse(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 6, 8))
        assertFalse(UnknownMarkRangeEditPolicy.allowsEdit(5, 8, 4, 7))
    }
}
