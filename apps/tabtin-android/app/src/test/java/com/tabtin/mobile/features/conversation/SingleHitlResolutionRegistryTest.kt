package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SingleHitlResolutionRegistryTest {
    @Test
    fun `resolved request rejects late required event in the same session`() {
        val registry = SingleHitlResolutionRegistry()

        assertTrue(registry.shouldAccept("session-1", "request-1"))
        registry.record("session-1", "request-1")

        assertFalse(registry.shouldAccept("session-1", "request-1"))
        assertTrue(registry.shouldAccept("session-2", "request-1"))
        assertTrue(registry.shouldAccept("session-1", "request-2"))
    }

    @Test
    fun `registry evicts oldest terminal key at bounded capacity`() {
        val registry = SingleHitlResolutionRegistry(maxEntries = 2)
        registry.record("session-1", "request-1")
        registry.record("session-1", "request-2")
        registry.record("session-1", "request-3")

        assertTrue(registry.shouldAccept("session-1", "request-1"))
        assertFalse(registry.shouldAccept("session-1", "request-2"))
        assertFalse(registry.shouldAccept("session-1", "request-3"))
    }
}
