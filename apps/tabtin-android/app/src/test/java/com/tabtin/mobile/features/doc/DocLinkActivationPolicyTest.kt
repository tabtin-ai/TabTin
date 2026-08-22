package com.tabtin.mobile.features.doc

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DocLinkActivationPolicyTest {
    @Test
    fun `only http https mailto and tel activate`() {
        assertTrue(DocLinkActivationPolicy.canActivate("https://tabtin.ai"))
        assertTrue(DocLinkActivationPolicy.canActivate("http://example.com"))
        assertTrue(DocLinkActivationPolicy.canActivate("mailto:a@b.com"))
        assertTrue(DocLinkActivationPolicy.canActivate("tel:+8613800138000"))
        assertFalse(DocLinkActivationPolicy.canActivate("javascript:alert(1)"))
        assertFalse(DocLinkActivationPolicy.canActivate("file:///etc/passwd"))
        assertFalse(DocLinkActivationPolicy.canActivate("/relative/path"))
        assertFalse(DocLinkActivationPolicy.canActivate("ftp://files.example"))
    }

    @Test
    fun `malformed href returns false without throwing`() {
        assertFalse(DocLinkActivationPolicy.canActivate("https://example.com/path with space"))
        assertFalse(DocLinkActivationPolicy.canActivate("http://["))
        assertFalse(DocLinkActivationPolicy.canActivate(""))
    }
}
