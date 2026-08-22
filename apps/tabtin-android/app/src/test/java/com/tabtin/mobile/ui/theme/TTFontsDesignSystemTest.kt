package com.tabtin.mobile.ui.theme

import com.tabtin.mobile.features.conversation.ConversationTypography
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 钉死 Android 字号档与 Electron §2 / chatDesignTokens 的映射。 */
class TTFontsDesignSystemTest {

    @Test
    fun uiRolesMatchElectronTypographyScale() {
        assertEquals(12f, TTFonts.Role.CAPTION.size)
        assertEquals(18f, TTFonts.Role.CAPTION.lineHeight)

        assertEquals(14f, TTFonts.Role.BODY.size)
        assertEquals(22f, TTFonts.Role.BODY.lineHeight)

        assertEquals(16f, TTFonts.Role.SUBTITLE.size)
        assertEquals(24f, TTFonts.Role.SUBTITLE.lineHeight)

        assertEquals(20f, TTFonts.Role.TITLE.size)
        assertEquals(28f, TTFonts.Role.TITLE.lineHeight)

        assertEquals(24f, TTFonts.Role.HEADING.size)
        assertEquals(32f, TTFonts.Role.HEADING.lineHeight)

        assertEquals(32f, TTFonts.Role.DISPLAY.size)
        assertEquals(40f, TTFonts.Role.DISPLAY.lineHeight)
    }

    @Test
    fun metaRoleMatchesComposerMeta() {
        assertEquals(13f, TTFonts.Role.META.size)
        assertEquals(18f, TTFonts.Role.META.lineHeight)
    }

    @Test
    fun conversationReadingMetricsMatchChatDesignTokens() {
        assertEquals(15f, ConversationTypography.BODY_SIZE_SP)
        assertEquals(20f, ConversationTypography.HEADING_1_SIZE_SP)
        assertEquals(18f, ConversationTypography.HEADING_2_SIZE_SP)
        assertEquals(22f, ConversationTypography.STEP_LINE_HEIGHT_SP)
        assertEquals(1.7f, ConversationTypography.BODY_LINE_HEIGHT_MULTIPLE, 0.001f)
        assertTrue(ConversationTypography.body.lineHeight.value > ConversationTypography.body.fontSize.value)
    }

    @Test
    fun interactiveRadiusMatchesElectron() {
        assertEquals(TTRadius.sm, TTRadius.interactive)
        assertEquals(8, TTRadius.interactive.value.toInt())
    }

    @Test
    fun iconAndDecorativeSizesArePinned() {
        assertEquals(12f, TTFonts.Role.CAPTION.size)
        assertEquals(14f, TTFonts.Role.BODY.size)
        assertEquals(16f, TTFonts.Role.SUBTITLE.size)

        assertEquals(22f, TTFonts.DecorativeIcon.FEATURE.size)
        assertEquals(28f, TTFonts.DecorativeIcon.EMPTY.size)
        assertEquals(34f, TTFonts.DecorativeIcon.EMPTY_MD.size)
        assertEquals(40f, TTFonts.DecorativeIcon.EMPTY_LG.size)
        assertEquals(48f, TTFonts.DecorativeIcon.HERO.size)
        assertEquals(64f, TTFonts.DecorativeIcon.SPLASH.size)
    }
}
