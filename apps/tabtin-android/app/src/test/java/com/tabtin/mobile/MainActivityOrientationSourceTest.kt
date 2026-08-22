package com.tabtin.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MainActivityOrientationSourceTest {

    @Test
    fun `manifest does not force every device into portrait`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()

        assertFalse(manifest.contains("android:screenOrientation=\"portrait\""))
    }

    @Test
    fun `activity maps device policy to portrait or user orientation`() {
        val source = File("src/main/java/com/tabtin/mobile/MainActivity.kt").readText()

        assertTrue(source.contains("resolveMainActivityOrientationPolicy"))
        assertTrue(source.contains("stableDeviceMetrics()"))
        assertFalse(source.contains("configuration.smallestScreenWidthDp"))
        assertTrue(source.contains("ActivityInfo.SCREEN_ORIENTATION_PORTRAIT"))
        assertTrue(source.contains("ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED"))
    }
}
