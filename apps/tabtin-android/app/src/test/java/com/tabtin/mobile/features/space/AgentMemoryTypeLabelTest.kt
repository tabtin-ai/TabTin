package com.tabtin.mobile.features.space

import com.tabtin.mobile.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

public class AgentMemoryTypeLabelTest {
    @Test
    public fun `memory types never expose backend enum names`() {
        assertEquals(R.string.my_agents_memory_type_about_you, agentMemoryTypeLabelRes("about_you"))
        assertEquals(R.string.my_agents_memory_type_insight, agentMemoryTypeLabelRes("insight"))
        assertEquals(R.string.my_agents_memory_type_task_summary, agentMemoryTypeLabelRes("task_summary"))
        assertEquals(R.string.my_agents_memory_type_diary, agentMemoryTypeLabelRes("diary"))
        assertEquals(R.string.my_agents_memory_type_about_you, agentMemoryTypeLabelRes(" ABOUT_YOU "))
        assertEquals(R.string.my_agents_memory, agentMemoryTypeLabelRes("future_type"))
    }

    @Test
    public fun `blank or internal memory titles use localized type labels`() {
        assertTrue(shouldUseAgentMemoryTypeLabel("about_you", ""))
        assertTrue(shouldUseAgentMemoryTypeLabel("about_you", "  ABOUT_YOU  "))
        assertTrue(shouldUseAgentMemoryTypeLabel(" task_summary ", "task_summary"))
    }

    @Test
    public fun `custom memory titles remain visible`() {
        assertFalse(shouldUseAgentMemoryTypeLabel("about_you", "用户偏好"))
    }
}
