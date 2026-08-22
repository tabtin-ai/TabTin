package com.tabtin.mobile.features.space

import com.tabtin.mobile.data.model.Agent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentListSearchTest {
    @Test
    fun `search only matches the name visible in the list`() {
        val agents = listOf(
            SearchItem(visibleName = "小Tin", hiddenName = "assistant"),
            SearchItem(visibleName = "代码版", hiddenName = "小Tin内部名"),
        )

        val result = filterByVisibleAgentName(agents, "小") { it.visibleName }

        assertEquals(listOf("小Tin"), result.map { it.visibleName })
    }

    @Test
    fun `active and deactivated lists share trimmed case insensitive matching`() {
        val active = filterByVisibleAgentName(listOf("Code Agent", "Writer"), " code ") { it }
        val deactivated = filterByVisibleAgentName(listOf("CODE Archive", "Researcher"), " code ") { it }

        assertEquals(listOf("Code Agent"), active)
        assertEquals(listOf("CODE Archive"), deactivated)
    }

    @Test
    fun `visible name prefers display name and only falls back when it is blank`() {
        val displayed = agent(name = "小Tin内部名", displayName = "代码版")
        val fallback = agent(name = "小Tin", displayName = "  ")

        assertEquals("代码版", displayed.visibleName())
        assertFalse(displayed.visibleName().contains("小"))
        assertEquals("小Tin", fallback.visibleName())
        assertTrue(fallback.visibleName().contains("小"))
    }

    private fun agent(name: String, displayName: String?): Agent = Agent(
        id = name,
        organizationId = "org-1",
        name = name,
        displayName = displayName,
    )

    private data class SearchItem(
        val visibleName: String,
        val hiddenName: String,
    )
}
