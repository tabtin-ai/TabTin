package com.tabtin.mobile.features.workbench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkbenchWebNavigationTest {

    @Test
    fun `canonical origin omits browser-default ports`() {
        assertEquals(
            "https://web.example.com",
            canonicalWorkbenchOrigin("HTTPS://web.example.com:443/resources/1"),
        )
        assertEquals(
            "http://web.example.com",
            canonicalWorkbenchOrigin("http://web.example.com:80/resources/1"),
        )
    }

    @Test
    fun `canonical origin preserves non-default ports and IPv6 brackets`() {
        assertEquals(
            "https://web.example.com:8443",
            canonicalWorkbenchOrigin("https://web.example.com:8443/resources/1"),
        )
        assertEquals(
            "https://[2001:db8::1]:8443",
            canonicalWorkbenchOrigin("https://[2001:DB8::1]:8443/resources/1"),
        )
        assertEquals(
            "https://[2001:db8::1]",
            canonicalWorkbenchOrigin("https://[2001:DB8::1]:443/resources/1"),
        )
    }

    @Test
    fun `canonical origin rejects malformed or hostless URLs`() {
        assertNull(canonicalWorkbenchOrigin("not a URL"))
        assertNull(canonicalWorkbenchOrigin("file:///tmp/index.html"))
    }

    @Test
    fun `blob URL stays in the WebView`() {
        assertFalse(
            shouldOpenWorkbenchUrlExternally(
                scheme = "blob",
                origin = null,
                expectedOrigin = "https://web.example.com",
            ),
        )
    }

    @Test
    fun `same-origin URL stays in the WebView`() {
        assertFalse(
            shouldOpenWorkbenchUrlExternally(
                scheme = "https",
                origin = "https://web.example.com",
                expectedOrigin = "https://web.example.com",
            ),
        )
    }

    @Test
    fun `external URL opens outside the WebView`() {
        assertTrue(
            shouldOpenWorkbenchUrlExternally(
                scheme = "https",
                origin = "https://example.com",
                expectedOrigin = "https://web.example.com",
            ),
        )
    }
}
