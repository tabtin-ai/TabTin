package com.tabtin.mobile.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class IdentityAvatarTest {
    @Test
    fun `hue matches shared identity-avatar fixtures`() {
        assertEquals(225, IdentityAvatar.hue("user-1"))
        assertEquals(224, IdentityAvatar.hue("user-2"))
        assertEquals(323, IdentityAvatar.hue("05a81772-b342-4590-a4a1-ed423f5e1a4d"))
        assertEquals(150, IdentityAvatar.hue("吴瑞源"))
        assertEquals(63, IdentityAvatar.hue(null))
    }

    @Test
    fun `color seed prefers user id over display name`() {
        val userId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        assertEquals(userId, IdentityAvatar.colorSeed(userId, "吴瑞源"))
        assertEquals(userId, IdentityAvatar.colorSeed(userId, "吴瑞源（已离职）"))
        assertEquals(IdentityAvatar.hue(userId), IdentityAvatar.hue(IdentityAvatar.colorSeed(userId, "我")))
        assertNotEquals(IdentityAvatar.hue(userId), IdentityAvatar.hue("吴瑞源"))
        assertEquals("吴瑞源", IdentityAvatar.colorSeed("", "吴瑞源"))
        assertEquals("?", IdentityAvatar.colorSeed("  ", "  "))
    }

    @Test
    fun `Chinese names use last two characters`() {
        assertEquals("瑞源", IdentityAvatar.initials("吴瑞源"))
        assertEquals("李雷", IdentityAvatar.initials("李雷"))
    }

    @Test
    fun `English names use first and last initials`() {
        assertEquals("TS", IdentityAvatar.initials("Taylor Swift"))
        assertEquals("TS", IdentityAvatar.initials("Taylor Alison Swift"))
        assertEquals("t", IdentityAvatar.initials("taylor"))
        assertEquals("ts", IdentityAvatar.initials("taylor swift"))
        assertEquals("m", IdentityAvatar.initials("m"))
        assertEquals("M", IdentityAvatar.initials("M"))
        assertEquals("M", IdentityAvatar.initials("Mm"))
    }
}
