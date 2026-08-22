package com.tabtin.mobile.features.doc

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

public class DocEditorNightPaletteSourceTest {

    @Test
    public fun `native doc view palette has a night override for every editor color`() {
        val projectDir = findAndroidProjectDir()
        val dayColors = File(projectDir, "app/src/main/res/values/colors.xml").readText()
        val nightColors = File(projectDir, "app/src/main/res/values-night/colors.xml").readText()
        val editorColorNames = Regex("name=\"(doc_editor_[^\"]+)\"")
            .findAll(dayColors)
            .map { it.groupValues[1] }
            .toList()

        for (colorName in editorColorNames) {
            assertTrue(
                "Native TabDoc Android Views must not keep the light palette in dark mode: $colorName",
                nightColors.contains("name=\"$colorName\""),
            )
        }
    }

    private fun findAndroidProjectDir(): File {
        val workingDirectory = requireNotNull(System.getProperty("user.dir")) {
            "JVM did not expose user.dir"
        }
        var candidate = File(workingDirectory).canonicalFile
        repeat(8) {
            if (File(candidate, "app/src/main/res/values/colors.xml").isFile) return candidate
            candidate = requireNotNull(candidate.parentFile) {
                "Could not locate apps/tabtin-android from ${System.getProperty("user.dir")}"
            }
        }
        error("Could not locate apps/tabtin-android from ${System.getProperty("user.dir")}")
    }
}
