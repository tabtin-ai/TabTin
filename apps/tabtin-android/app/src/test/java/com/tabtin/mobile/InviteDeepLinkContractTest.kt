package com.tabtin.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class InviteDeepLinkContractTest {

    @Test
    fun `production and preprod invite schemes reach the activity`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()

        assertTrue(manifest.contains("android:scheme=\"tabtin\" android:host=\"invite\""))
        assertTrue(manifest.contains("android:scheme=\"tabtin-preprod\" android:host=\"invite\""))
    }

    @Test
    fun `invite handler accepts only installed mobile invite schemes`() {
        assertTrue(isSupportedInviteDeepLinkScheme("tabtin"))
        assertTrue(isSupportedInviteDeepLinkScheme("TABTIN-PREPROD"))
        assertFalse(isSupportedInviteDeepLinkScheme("tabtin-dev"))
        assertFalse(isSupportedInviteDeepLinkScheme("https"))
        assertFalse(isSupportedInviteDeepLinkScheme(null))
    }
}
