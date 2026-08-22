package com.tabtin.mobile

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回归：部分 Android 16 OEM 的 SplashScreenViewProvider 没有 iconView。 */
class MainActivitySplashSourceTest {
    @Test
    fun `splash exit animation never dereferences the optional system icon`() {
        val source = File("src/main/java/com/tabtin/mobile/MainActivity.kt").readText()
        val exitAnimation = source.substringAfter("setOnExitAnimationListener")
            .substringBefore("super.onCreate")

        assertFalse(exitAnimation.contains("provider.iconView"))
        assertTrue(exitAnimation.contains("provider.remove()"))
    }
}
