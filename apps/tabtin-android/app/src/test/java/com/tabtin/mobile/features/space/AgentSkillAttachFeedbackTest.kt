package com.tabtin.mobile.features.space

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentSkillAttachFeedbackTest {

    @Test
    fun `empty names yields null`() {
        assertNull(AgentSkillAttachFeedback.fromNames(emptyList()))
        assertNull(AgentSkillAttachFeedback.fromNames(listOf("  ", "")))
    }

    @Test
    fun `single name`() {
        val feedback = AgentSkillAttachFeedback.fromNames(listOf("写文档"))
        assertTrue(feedback is AgentSkillAttachFeedback.Single)
        assertEquals("写文档", (feedback as AgentSkillAttachFeedback.Single).name)
    }

    @Test
    fun `batch uses first name and total count`() {
        val feedback = AgentSkillAttachFeedback.fromNames(listOf("写文档", "抓数据", "画图"))
        assertTrue(feedback is AgentSkillAttachFeedback.Batch)
        val batch = feedback as AgentSkillAttachFeedback.Batch
        assertEquals("写文档", batch.firstName)
        assertEquals(3, batch.count)
    }
}
