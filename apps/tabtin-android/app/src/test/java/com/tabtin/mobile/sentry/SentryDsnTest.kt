package com.tabtin.mobile.sentry

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class SentryDsnTest {
    @Test
    fun emptyDsnIsValid() {
        assertTrue(SentryDsn.isValid(""))
        assertTrue(SentryDsn.isValid("   "))
    }

    @Test
    fun httpsDsnWithPublicKeyIsValid() {
        assertTrue(SentryDsn.isValid("https://public@sentry.example.com/1"))
    }

    @Test
    fun dsnWithoutPublicKeyIsInvalid() {
        assertFalse(SentryDsn.isValid("https://sentry.example.com/1"))
    }
}
