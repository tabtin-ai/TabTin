package com.tabtin.mobile.sentry

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class DiagnosticRuntimeTest {
    @Test
    public fun `clean shutdown is not reported as an unclean previous session`() {
        assertFalse(DiagnosticRuntime.shouldCapturePreviousSession("clean"))
        assertFalse(DiagnosticRuntime.shouldCapturePreviousSession(null))
        assertTrue(DiagnosticRuntime.shouldCapturePreviousSession("running"))
    }
}
