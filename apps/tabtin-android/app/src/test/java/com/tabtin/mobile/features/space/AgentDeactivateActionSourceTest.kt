package com.tabtin.mobile.features.space

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AgentDeactivateActionSourceTest {
    @Test
    fun `deactivate action is not hidden inside recent tasks tab`() {
        val source = File(
            "src/main/java/com/tabtin/mobile/features/space/AgentDetailScreen.kt",
        ).readText()
        val detailBody = source.substringAfter("private fun AgentDetailContent(")
            .substringBefore("@Composable\nprivate fun AgentDetailTabRow")

        assertTrue(detailBody.contains("if (agent.isDefault != true)"))
        assertFalse(detailBody.contains("AgentDetailSection.RECENT_TASKS -> {"))
    }
}
