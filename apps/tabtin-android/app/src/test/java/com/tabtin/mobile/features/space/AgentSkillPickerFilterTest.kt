package com.tabtin.mobile.features.space

import com.tabtin.mobile.data.model.VisibleSkillEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentSkillPickerFilterTest {

    @Test
    fun `excludes already attached skills`() {
        val catalog = listOf(
            VisibleSkillEntry(skillKey = "a", name = "Alpha"),
            VisibleSkillEntry(skillKey = "b", name = "Beta"),
        )
        val result = AgentSkillPickerFilter.available(
            catalog = catalog,
            attachedKeys = setOf("a"),
        )
        assertEquals(listOf("b"), result.map { it.canonicalKey })
    }

    @Test
    fun `search filters by name`() {
        val catalog = listOf(
            VisibleSkillEntry(skillKey = "a", name = "写文档", description = "doc"),
            VisibleSkillEntry(skillKey = "b", name = "抓数据", description = "data"),
        )
        val result = AgentSkillPickerFilter.available(
            catalog = catalog,
            attachedKeys = emptySet(),
            query = "文档",
        )
        assertEquals(listOf("a"), result.map { it.canonicalKey })
    }

    @Test
    fun `search does not match hidden canonical key`() {
        val catalog = listOf(
            VisibleSkillEntry(
                skillKey = "app:private-namespace/hidden-keyword",
                name = "写文档",
                description = "修改正文",
            ),
        )
        val result = AgentSkillPickerFilter.available(
            catalog = catalog,
            attachedKeys = emptySet(),
            query = "hidden-keyword",
        )
        assertEquals(emptyList<VisibleSkillEntry>(), result)
    }
}
